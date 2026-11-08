#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""THE PHYSICAL TLS CELL — real paho-mqtt, real mosquitto, real handshake, on loopback.

    sh src/tools/broker-fixture.sh up phase2      # prints FIXTURE_* lines, mints throwaway PKI
    python3 src/tools/test_tlsenv_paho.py
    sh src/tools/broker-fixture.sh down

IT IS SELF-CONTAINED ON A COLD BOX. With no `TABICHAT_FIXTURE_OWNER` in the env and no record at the
`default` path, this file starts its OWN phase-2 fixture under owner `tls-paho-<pid>` and tears it down
at exit, so `deploy-tabichat.sh --physical` needs no operator staging to be run — a release gate whose
green depends on an unstated precondition is a gate that goes red on a clean box. The three steps above
still work: an operator who names an owner is served the record that owner has, and if that record is
missing the file still refuses instead of inventing a broker under someone else's name.

WHY THIS FILE EXISTS SEPARATELY. `test_tlsenv.py` is a pure truth table and it is honest about that:
it proves the DECISION. But the decision was checked against a FAKE paho for a whole round, and the
fake accepted `tls_version="TLSv1.3"` — a string where paho wants an int — so a TLS configuration
that died on every real connect read GREEN in the suite. That is the defect this leg fixes, and a
second pure test file cannot fix the blindness of the instrument. Only a real client against a real
broker can.

WHAT IS REAL HERE, ALL THREE:
  * the client is `paho.mqtt.client.Client` from the installed paho-mqtt, configured through
    `apply_to_client()` — the exact function the shipped CLI calls, no reimplementation;
  * the broker is the eclipse-mosquitto container the project's own fixture starts, running
    `docs/broker/tabichat.conf` with paths and the room name substituted and NOTHING else;
  * the trust material is the throwaway PKI `broker-fixture.sh` minted into its own temp dir, and it
    is destroyed on `down`. It is never a certificate authority and never a person's own keys.

PATHS ONLY. Nothing in this file opens, reads, prints or copies a private key. The key paths are
handed to `ssl`, which loads them in process. Key-file content is one designated lane's work
alone, and this cell keeps to its own material; it is also simply what a TLS client does.

A CELL THAT CANNOT RUN IS A FAILURE, NOT A SKIP. If paho is missing, or our own fixture cannot start,
or a record the caller named is not there, or the container is gone mid-run, this file says so and
exits 1 — a not-run that reads as a pass is the exact lie this whole leg is written against. Being
able to start a broker is not the same as having proved against one: only the FIRST case is ours to
fix, and the other three stay refusals.
"""

import atexit
import os
import shutil
import socket
import ssl
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from broker import resolve_broker_url  # noqa: E402
from tlsenv import (  # noqa: E402
    TLS_MAX_VERSION,
    TLS_MIN_VERSION,
    TransportBlocked,
    TransportRefusal,
    apply_to_client,
    build_ssl_context,
    transport_kwargs,
)

FAILED = []
RAN = []


def check(name, got, want):
    RAN.append(name)
    if got != want:
        FAILED.append(name)
        print("FAIL  %s: got %r, want %r" % (name, got, want))
    else:
        print("ok    %s: %r" % (name, got))


def fail_hard(why):
    print("NOT RUN — %s" % why)
    print("This file does NOT report a pass when it could not run.")
    sys.exit(1)


# --- 0. the two things this cell needs, or it stops ---------------------------------------------
try:
    import paho.mqtt.client as mqtt
    import paho.mqtt

    PAHO_VERSION = getattr(paho.mqtt, "__version__", "unknown")
except ImportError as exc:
    fail_hard("paho-mqtt is not importable here (%s). Install it or do not run this file." % exc)

# THE RECORD NAME MUST MATCH WHAT `broker-fixture.sh` WRITES, owner and all. The path used to be one
# global name, so a neighbour test's `down` could stop the broker this file is about to prove against
# and delete the record from under it — the victim then read NOT RUN, which looks like a product fault
# and is not. Owner defaults to `default`, so `up phase2` and this file agree when neither names one.
OWNER = os.environ.get("TABICHAT_FIXTURE_OWNER", "default")
STATE = os.path.join(os.environ.get("TMPDIR", "/tmp"), "tabichat-fixture-%s.state" % OWNER)
MY_FIXTURE_OWNER = None  # non-None ONLY when this process started the fixture it is about to read


def start_own_fixture():
    """Cold box: bring up a phase-2 fixture this run owns, and say what to do about it at exit.

    The owner name is run-scoped (`tls-paho-<pid>`) because `broker-fixture.sh up` clears the
    predecessor recorded under the SAME owner: a shared name would let this run stop a neighbour's
    broker, and `down` at teardown would destroy material another seat is proving against. Written
    the same way `test_broker_auth.ts` and `test_ack_watch_broker.ts` name theirs.
    """
    global MY_FIXTURE_OWNER, STATE
    MY_FIXTURE_OWNER = "tls-paho-%d" % os.getpid()
    print(
        "[paho-cell] no fixture recorded at %s — starting our own (owner=%s phase2)"
        % (STATE, MY_FIXTURE_OWNER)
    )
    env = dict(os.environ, TABICHAT_FIXTURE_OWNER=MY_FIXTURE_OWNER)
    try:
        r = subprocess.run(
            ["sh", os.path.join(HERE, "broker-fixture.sh"), "up", "phase2"],
            env=env, capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        fail_hard("the fixture this run started did not finish coming up within 300s")
    if "FIXTURE_PORT=" not in r.stdout:
        # Its own words come out, then the refusal: a fixture that would not start is NOT RUN, and
        # this file must not turn that into a skip or a pass.
        print((r.stdout + r.stderr).strip()[-600:])
        fail_hard(
            "the fixture this run started (owner=%s) did not come up (rc %d) — docker and the "
            "eclipse-mosquitto:2 image are the two things it needs" % (MY_FIXTURE_OWNER, r.returncode)
        )
    # The record is the same owner-scoped path the fixture writes; re-derive it here rather than
    # parsing stdout, so reader and writer agree by construction (see test_fixture_isolation.py).
    STATE = os.path.join(os.environ.get("TMPDIR", "/tmp"), "tabichat-fixture-%s.state" % MY_FIXTURE_OWNER)
    if not os.path.isfile(STATE):
        fail_hard("the fixture came up but left no record at %s" % STATE)


def stop_own_fixture():
    if MY_FIXTURE_OWNER:
        subprocess.run(
            ["sh", os.path.join(HERE, "broker-fixture.sh"), "down"],
            env=dict(os.environ, TABICHAT_FIXTURE_OWNER=MY_FIXTURE_OWNER),
            capture_output=True, text=True,
        )


if not os.path.isfile(STATE):
    if "TABICHAT_FIXTURE_OWNER" in os.environ:
        # An operator named an owner and nothing is recorded under it. Starting one under THEIR name
        # would launder a missing precondition into a pass, so this stays a refusal.
        fail_hard(
            "no fixture recorded at %s. Start one with `sh src/tools/broker-fixture.sh up phase2` "
            "before running this file. If a fixture IS up under another owner, run this file with the "
            "same TABICHAT_FIXTURE_OWNER you started it with." % STATE
        )
    start_own_fixture()

atexit.register(stop_own_fixture)

name, fix_dir, port, room, phase = open(STATE, encoding="utf-8").read().split()


def fixture_nick():
    """Which client the fixture actually minted, read from the material rather than typed here.

    The harness used to mint a live lane's nick and this file spelled that name out; the fixture now
    mints a site-neutral pair unless a caller declares names in ``TABICHAT_FIXTURE_NICKS``, so a
    spelled-out name stops describing the tree. ``pki/clients/<nick>/`` is where the mint records what
    it produced — the state line carries name, dir, port, room and phase, and no nick. A declaration that
    names nothing the fixture minted refuses rather than quietly proving on some other lane's
    certificate: which client a run spoke as is a fact the caller should have to be right about.
    """
    clients = os.path.join(fix_dir, "pki", "clients")
    minted = (
        sorted(
            d
            for d in os.listdir(clients)
            if os.path.isfile(os.path.join(clients, d, "cert.pem")) and os.path.isfile(os.path.join(clients, d, "key.pem"))
        )
        if os.path.isdir(clients)
        else []
    )
    if not minted:
        fail_hard("the fixture minted no client cert/key pair under %s (is the fixture still up?)" % clients)
    requested = [n for n in (os.environ.get("TABICHAT_FIXTURE_NICKS") or "").split() if n]
    if requested and not (set(requested) & set(minted)):
        fail_hard(
            "TABICHAT_FIXTURE_NICKS declares %s but this fixture minted %s under %s — start the fixture "
            "with the same declaration, or run this file without one."
            % (requested, minted, clients)
        )
    declared = [n for n in requested if n in minted]
    return declared[0] if declared else minted[0]


NICK = fixture_nick()
CA = os.path.join(fix_dir, "pki", "ca", "ca.crt")
CLIENT_DIR = os.path.join(fix_dir, "pki", "clients", NICK)
CERT = os.path.join(CLIENT_DIR, "cert.pem")
KEY = os.path.join(CLIENT_DIR, "key.pem")
ROGUE_CA = os.path.join(fix_dir, "pki", "rogue", "ca.crt")
for p in (CA, CERT, KEY, ROGUE_CA):
    if not os.path.isfile(p):
        fail_hard("fixture material missing at %s (is the fixture still up?)" % p)

print(
    "paho %s | mosquitto fixture %s on 127.0.0.1:%s | acl=%s | client=%s"
    % (PAHO_VERSION, name, port, phase, NICK)
)

PLAIN_PORT = None
PLAIN_CONTAINER = None


def cleanup():
    global PLAIN_CONTAINER, PLAIN_PORT
    if PLAIN_CONTAINER:
        subprocess.run(["docker", "stop", PLAIN_CONTAINER], capture_output=True)
        subprocess.run(["docker", "rm", "-f", PLAIN_CONTAINER], capture_output=True)
        PLAIN_CONTAINER = None


atexit.register(cleanup)


def publish_and_expect(host, port, env, want_connected=True, label=""):
    """One real paho connect through the SHIPPED code path, and what the broker did with it.

    Returns (connected, reason). Uses the CLI's own functions: transport_kwargs -> build_ssl_context
    -> apply_to_client -> connect. Nothing here re-derives the TLS options, because the point is to
    test the shipped ones.
    """
    url = "mqtts://%s:%s" % (host, port) if env.get("MQTT_TLS_CAFILE") else "mqtt://%s:%s" % (host, port)
    try:
        plan = transport_kwargs(url, env)
    except (TransportRefusal, TransportBlocked) as exc:
        return "refused-at-plan", str(exc)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="%s-tls-cell" % NICK)
    try:
        apply_to_client(client, plan)
    except (TransportRefusal, TransportBlocked) as exc:
        return "refused-at-apply", str(exc)
    rc_box = []
    try:
        rc_box.append(client.connect(host, plan["port"], keepalive=10))
    except Exception as exc:  # the handshake/errno IS the observation
        return "connect-raised", "%s: %s" % (type(exc).__name__, exc)
    try:
        client.loop_start()
        deadline = time.time() + 6
        while not client.is_connected() and time.time() < deadline:
            time.sleep(0.05)
        if not client.is_connected():
            return "not-connected", "no connection within 6s (rc=%r)" % (rc_box[0],)
        # Own topic, the nick the broker minted this certificate for: the phase-2 ACL carries a
        # client on its OWN topic and drops another's, so the publish has to name the same lane.
        info = client.publish("chat/%s/msg/%s" % (room, NICK), '{"nick":"%s","message":"tls cell"}' % NICK)
        info.wait_for_publish(timeout=5)
        return "connected", "published rc=%r" % (rc_box[0],)
    finally:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass


# --- 1. THE HEADLINE: a real paho reaches the real TLS listener ----------------------------------
env = {
    "MQTT_TLS_CAFILE": CA,
    "MQTT_TLS_CERTFILE": CERT,
    "MQTT_TLS_KEYFILE": KEY,
}
outcome, detail = publish_and_expect("127.0.0.1", port, env, label="mtls")
check("REAL PAHO over REAL TLS: connected and published to the fixture broker", outcome, "connected")
print("      (%s)" % detail)

# --- 2. THE VERSION BAR WAS ACTUALLY NEGOTIATED, not merely configured ---------------------------
# `apply_to_client` sets our context; the context carries the bar. Now show the socket that came up
# used a version INSIDE it, and that the peer is really TLS (not a plaintext session that "worked").
plan = transport_kwargs("mqtts://127.0.0.1:%s" % port, env)
ctx = build_ssl_context(plan)
raw = socket.create_connection(("127.0.0.1", int(port)), timeout=6)
wrapped = ctx.wrap_socket(raw, server_hostname="localhost")
peer = wrapped.version()
check("the negotiated protocol is one this repo's bar allows",
      peer in ("TLSv1.2", "TLSv1.3"), True)
check("and the certificate the broker presented verifies against the PINNED CA (not system roots)",
      bool(wrapped.getpeercert()), True)
check("cipher negotiated", bool(wrapped.cipher()), True)
wrapped.close()

# --- 3. NEGATIVE HALVES — what a WRONG answer must refuse ----------------------------------------
# (a) the wrong CA. A REAL second CA that signs nothing the broker trusts: a refusal here proves the
#     client is checking, which a test with a nonexistent path never proves.
outcome, detail = publish_and_expect("127.0.0.1", port, {**env, "MQTT_TLS_CAFILE": ROGUE_CA})
check("a WRONG CA is REFUSED, and it is refused before any publish",
      outcome in ("refused-at-apply", "connect-raised"), True)
check("and the reason is a certificate verification failure, not a mystery",
      any(k in detail.lower() for k in ("certificate", "verify", "sslv3 alert", "unknown ca", "bad handshake", "handshake")),
      True)
print("      (%s -> %s)" % (outcome, detail[:200]))

# (a2) NO CLIENT CERTIFICATE AT ALL — leg 1131's reason this cell exists. The fixture runs the
#      artifact's `require_certificate true`, so a client that pins the RIGHT CA but carries no pair
#      must be refused. `transport_kwargs` deliberately allows that shape (rule 5 refuses only HALF a
#      pair, and a CA-only TLS client is a legitimate reading of the variables), so NO pure truth table
#      can see this state — only a real broker can. THE CONTROL IS CELL 1 ABOVE: same listener, same CA,
#      WITH a pair, connected and published; the only difference below is the certificate.
#      MEASURED, and the measurement is the finding: the refusal carries no certificate word at all —
#      the handshake simply never completes and paho reports `not-connected` after 6 s, which reads
#      exactly like a down broker. That is why the human client names the missing pair BEFORE the
#      socket (write_plan in src/tabichat_cli.py, cell (v) of tools/test_tabichat_cli.py).
out_certless, det_certless = publish_and_expect("127.0.0.1", port, {"MQTT_TLS_CAFILE": CA})
check("a TLS client with NO certificate pair never reaches the require_certificate listener",
      out_certless != "connected", True)
check("and the refusal is SILENT — a timeout with no certificate word in it, which is why the client "
      "has to say the missing pair before the socket and not after it",
      (out_certless, "certificate" in det_certless.lower()), ("not-connected", False))
print("      (%s -> %s)" % (out_certless, det_certless[:200]))

# (b) a nonexistent CA path: the class the old code turned into a bare FileNotFoundError at connect.
try:
    transport_kwargs("mqtts://127.0.0.1:%s" % port, {"MQTT_TLS_CAFILE": os.path.join(fix_dir, "nope.crt")})
    check("an unreadable CA refuses at PLAN time (never reaches a socket)", False, True)
except TransportRefusal as exc:
    check("an unreadable CA refuses at PLAN time (never reaches a socket)", "cannot be read" in str(exc), True)

# (c) THE SILENT-DOWNGRADE HALF: a plaintext client must NOT be able to talk to the TLS port, and a
#     TLS-only client must NOT be able to talk to a plaintext port. Both directions, or the lock is
#     one-way and a mis-set variable still lands a session on the wrong wire.
outcome, detail = publish_and_expect("127.0.0.1", port, {})
check("a PLAINTEXT client is refused by the TLS listener", outcome != "connected", True)
print("      (%s -> %s)" % (outcome, detail[:160]))

# a throwaway ANONYMOUS PLAINTEXT mosquitto, on a port this cell owns, for the other direction.
if shutil.which("docker") is None:
    fail_hard("docker is absent, so the plaintext-listener half cannot run")
PLAIN_PORT = int(port) + 1
for _try in range(40):
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", PLAIN_PORT)) != 0:
            break
    PLAIN_PORT += 1
PLAIN_CONTAINER = "tabichat-plain-paho-%d" % PLAIN_PORT
plain_dir = os.path.join(fix_dir, "plain")
os.makedirs(os.path.join(plain_dir, "config"), exist_ok=True)
with open(os.path.join(plain_dir, "config", "mosquitto.conf"), "w") as fh:
    fh.write("listener 1883 0.0.0.0\nallow_anonymous true\n")
subprocess.run(["docker", "rm", "-f", PLAIN_CONTAINER], capture_output=True)
r = subprocess.run(
    ["docker", "run", "-d", "--rm", "--name", PLAIN_CONTAINER,
     "-p", "127.0.0.1:%d:1883" % PLAIN_PORT, "-v", "%s:/fixture:ro" % plain_dir,
     "eclipse-mosquitto:2", "mosquitto", "-c", "/fixture/config/mosquitto.conf"],
    capture_output=True, text=True)
if r.returncode != 0:
    fail_hard("the throwaway plaintext broker did not start: %s" % r.stderr[:200])
ready = False
for _ in range(60):
    with socket.socket() as s:
        s.settimeout(0.2)
        if s.connect_ex(("127.0.0.1", PLAIN_PORT)) == 0:
            ready = True
            break
    time.sleep(0.1)
if not ready:
    fail_hard("the throwaway plaintext broker never bound on %d" % PLAIN_PORT)

outcome, detail = publish_and_expect("127.0.0.1", PLAIN_PORT, env)
check("a TLS-configured client against a PLAINTEXT listener does not silently go plaintext",
      outcome != "connected", True)
print("      (%s -> %s)" % (outcome, detail[:160]))
check("and MQTT_TLS_REQUIRED=1 on a plaintext URL refuses at the PLAN, before any socket", True, True)
try:
    transport_kwargs("mqtt://127.0.0.1:%d" % PLAIN_PORT, {"MQTT_TLS_REQUIRED": "1"})
    check("MQTT_TLS_REQUIRED=1 on a plaintext URL refuses at the PLAN", False, True)
except TransportRefusal as exc:
    check("MQTT_TLS_REQUIRED=1 on a plaintext URL refuses at the PLAN", "refusing" in str(exc).lower(), True)

cleanup()

# --- 4. THE DEFECT, STATED AS A PHYSICAL FACT -----------------------------------------------------
# The old shape, kept as a cell so nobody restores it: a STRING version handed to real paho.
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
try:
    c.tls_set(ca_certs=CA, tls_version="TLSv1.3")
    check("real paho REFUSES the string the old code passed", False, True)
except TypeError as exc:
    check("real paho REFUSES the string the old code passed (TypeError, at the call)", "integer" in str(exc), True)
# and the OTHER wrong int: ssl.TLSVersion is not a PROTOCOL constant, so `tls_set` is not a door to
# a version RANGE at all — which is the reason build_ssl_context exists.
c2 = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
try:
    c2.tls_set(ca_certs=CA, tls_version=ssl.TLSVersion.TLSv1_3)
    check("ssl.TLSVersion is refused by tls_set too (so a range CANNOT be expressed there)", False, True)
except (TypeError, ValueError) as exc:
    check("ssl.TLSVersion is refused by tls_set too (so a range CANNOT be expressed there)", True, True)
c3 = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
c3.tls_set_context(build_ssl_context(transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": CA})))
check("the shipped path (our SSLContext via tls_set_context) is ACCEPTED by real paho", c3._ssl, True)
check("and the bar is on the context paho now holds",
      (c3._ssl_context.minimum_version, c3._ssl_context.maximum_version),
      (TLS_MIN_VERSION, TLS_MAX_VERSION))

# --- 5. THE SITE-AGNOSTIC DOOR, PROVEN ON THE REAL RESOLVER -------------------------------------
# This leg merged the TLS work onto the site-agnostic `main`, so the transport must be built from
# what `resolve_broker_url` answers, with the scheme kept. On an UNconfigured box the resolver
# refuses and the transport refuses with it — two loud doors, no default in either.
os.environ["TABICHAT_CONFIG"] = os.path.join(fix_dir, "absent-site-config.json")
os.environ.pop("MQTT_URL", None)
os.environ.pop("MQTT_HOST", None)
os.environ.pop("MQTT_PORT", None)
try:
    resolve_broker_url()
    check("an unconfigured box REFUSES at the broker layer", False, True)
except Exception as exc:
    check("an unconfigured box REFUSES at the broker layer", "refusing to guess" in str(exc), True)
try:
    transport_kwargs("", {})
    check("and the transport refuses an empty URL rather than inventing one", False, True)
except TransportRefusal as exc:
    check("and the transport refuses an empty URL rather than inventing one", "refusing to guess" in str(exc), True)
# with the fixture written into a site config, the SCHEME survives resolution — which is the whole
# reason resolve_broker_url exists next to resolve_broker.
with open(os.environ["TABICHAT_CONFIG"], "w") as fh:
    import json as _json

    _json.dump({"mqttUrl": "mqtts://127.0.0.1:%s" % port}, fh)
url, source = resolve_broker_url()
check("a site file with an mqtts:// URL keeps its SCHEME through the resolver",
      (url, "site file" in source), ("mqtts://127.0.0.1:%s" % port, True))
check("and the transport built from THAT url is a TLS plan",
      transport_kwargs(url, {"MQTT_TLS_CAFILE": CA})["tls"], True)
os.environ.pop("TABICHAT_CONFIG", None)
os.remove(os.path.join(fix_dir, "absent-site-config.json"))

print()
if FAILED:
    print("%d check(s) FAILED of %d" % (len(FAILED), len(RAN)))
    sys.exit(1)
print("all %d PHYSICAL checks pass (real paho %s, real mosquitto fixture)" % (len(RAN), PAHO_VERSION))
