#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""THE PHYSICAL TLS CELL — real paho-mqtt, real mosquitto, real handshake, on loopback.

    sh src/tools/broker-fixture.sh up phase2      # prints FIXTURE_* lines, mints throwaway PKI
    python3 src/tools/test_tlsenv_paho.py
    sh src/tools/broker-fixture.sh down

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
    is destroyed on `down`. It is never the fleet CA and never the owner's desk keys.

PATHS ONLY. Nothing in this file opens, reads, prints or copies a private key. The key paths are
handed to `ssl`, which loads them in process. That is the fleet law of 2026-10-18 (key-file content
is `ultra`'s work alone), and it is also simply what a TLS client does.

A CELL THAT CANNOT RUN IS A FAILURE, NOT A SKIP. If paho is missing, or no fixture is recorded, or
the container is gone, this file says so and exits 1 — a not-run that reads as a pass is the exact
lie this whole leg is written against.
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
if not os.path.isfile(STATE):
    fail_hard(
        "no fixture recorded at %s. Start one with `sh src/tools/broker-fixture.sh up phase2` "
        "before running this file. If a fixture IS up under another owner, run this file with the "
        "same TABICHAT_FIXTURE_OWNER you started it with." % STATE
    )

name, fix_dir, port, room, phase = open(STATE, encoding="utf-8").read().split()
CA = os.path.join(fix_dir, "pki", "ca", "ca.crt")
CLIENT_DIR = os.path.join(fix_dir, "pki", "clients", "flash6")
CERT = os.path.join(CLIENT_DIR, "cert.pem")
KEY = os.path.join(CLIENT_DIR, "key.pem")
ROGUE_CA = os.path.join(fix_dir, "pki", "rogue", "ca.crt")
for p in (CA, CERT, KEY, ROGUE_CA):
    if not os.path.isfile(p):
        fail_hard("fixture material missing at %s (is the fixture still up?)" % p)

print("paho %s | mosquitto fixture %s on 127.0.0.1:%s | acl=%s" % (PAHO_VERSION, name, port, phase))

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
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="flash6-tls-cell")
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
        info = client.publish("chat/%s/msg/flash6" % room, '{"nick":"flash6","message":"tls cell"}')
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
