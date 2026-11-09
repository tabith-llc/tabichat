#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for src/src/tlsenv.py — the transport rules the HUMAN clients obey.

    python3 src/tools/test_tlsenv.py        (exit 1 on any failure)

NO BROKER NEEDED, AND THAT IS DELIBERATE. The decision module is pure: every rule below is about
what the client is ALLOWED to do with a socket, which is exactly the part that must not drift between
the python and the agent side. WHAT CHANGED: this file used to say "no paho needed" and then
check `apply_to_client` against a FAKE that accepted any kwargs it was handed — which is how a
string where paho wants an int (`tls_version="TLSv1.3"`) passed the whole suite and killed every real
TLS connect. The fake is now STRICT (tls_set raises, only tls_set_context is accepted, and the
ssl.SSLContext it receives is INSPECTED), and the real-paho proof lives in
`tools/test_tlsenv_paho.py` plus the physical mosquitto fixture in `tools/broker-fixture.sh`. A cell
that can only run against a fake proves STRUCTURE, and this file says so out loud in the one place it
still needs a fake: the "paho with no tls_set_context" negative.

The negatives are the point. A transport module that always returns "connect" passes every positive
cell and ships the silent plaintext fallback the feature row exists to prevent.
"""

import atexit
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import tlsenv  # noqa: E402
from tlsenv import (  # noqa: E402
    TransportBlocked,
    TransportRefusal,
    apply_to_client,
    build_ssl_context,
    redact_url,
    scheme_of,
    split_target,
    transport_kwargs,
)

failed = 0
ran = 0


def check(name, got, want):
    global failed, ran
    ran += 1
    if got != want:
        failed += 1
        print(f"FAIL  {name}: got {got!r}, want {want!r}")
    else:
        print(f"ok    {name}: {got!r}")


skipped = []


def skip(name):
    """A check this host cannot run, SAID BY NAME. It never touches the counters: a skipped check is
    not a pass and not a failure, and `all N checks pass` must keep counting only what ran. The
    standard is the one src/tools/test_paho_skip.sh states for the deployer's skip — a skipped gate
    must never read as a passed one — applied inside a harness that decides for itself."""
    skipped.append(name)
    print(f"NOT APPLICABLE  {name}: openssl is absent on this host, so this check could not be driven")


# GUARDED-REGION DRIFT. Every check that a guarded block can skip must have a skip of the same name,
# or the absent path reports a check that no longer exists, or stays silent about one that does. This
# reads the two directions out of THIS file's own source between the markers, so a check added to a
# guarded block without its skip line fails on any host, openssl present or not — the shape
# test_paho_skip.sh uses when it derives the exempt set instead of carrying it.
GUARD_START = "# GUARDED-BEGIN"
GUARD_END = "# GUARDED-END"


def guarded_names(text):
    """-> (check names, skip names) asserted inside every GUARDED-BEGIN/END region of `text`."""
    checks, skips = [], []
    inside = False
    for line in text.splitlines():
        # A line STARTING with the marker is the marker. Matching it anywhere would catch this file's
        # own prose about the markers — including the line that reads the source to plant a face — and
        # the detector would count checks that live outside every guarded block. Measured at this leg's
        # first run: the CONTROL cell reported itself as an unpaired guarded check.
        stripped = line.strip()
        if stripped.startswith(GUARD_START):
            inside = True
            continue
        if stripped.startswith(GUARD_END):
            inside = False
            continue
        if not inside:
            continue
        # The closing quote is a BACKREFERENCE, not "either quote": a check name legitimately contains
        # an apostrophe (`… on the context's sni_hostname …`), and a character-class close matched the
        # apostrophe mid-name. Measured: the source-derived name and the printed skip name disagreed by
        # the truncation, which is exactly the drift this cell exists to catch — caught here by the
        # absent-host run disagreeing with itself, not by a reading.
        m = re.match(r'\s*(check|skip)\(\s*f?(["\'])(.+?)\2', line)
        if not m:
            continue
        (checks if m.group(1) == "check" else skips).append(m.group(3))
    return checks, skips


def refuses(name, url, env, needle=""):
    """The cell that must RAISE. Returns the message so a follow-up can assert on its text."""
    global failed, ran
    ran += 1
    try:
        plan = transport_kwargs(url, env, readable=PRESENT)
    except TransportRefusal as e:
        msg = str(e)
        if needle and needle not in msg:
            failed += 1
            print(f"FAIL  {name}: refused, but the message does not name {needle!r}: {msg}")
        else:
            print(f"ok    {name}: refused")
        return msg
    failed += 1
    print(f"FAIL  {name}: CONNECTED ANYWAY — plan was {plan}")
    return ""


# The injectable readability check (see `transport_kwargs(..., readable=...)`). Cells that do not
# care about file readability pass this and keep using the `/k/...` placeholder paths; the ones that
# DO care mint real material below. This is the python mirror of `makePemReader` on the agent side,
# and it is why no cell in this file needs to read a real key: PATHS are what the product handles.
def PRESENT(path):
    return 1


def ABSENT(path):
    raise FileNotFoundError(2, "No such file or directory", path)


def ZERO(path):
    return 0


print("== scheme and target parsing (paho needs host and port apart, the URL keeps them joined) ==")
check("mqtt:// is not TLS", scheme_of("mqtt://broker.example:1883"), "mqtt://")
check("mqtts:// is TLS", scheme_of("mqtts://broker.example:8883"), "mqtts://")
check("scheme case is not meaningful", scheme_of("MQTTS://H:8883"), "mqtts://")
check("split host:port + tls", split_target("mqtts://broker:8883"), ("broker", 8883, True))
check("plain default port is 1883", split_target("mqtt://broker.example"), ("broker.example", 1883, False))
check("tls default port is 8883", split_target("mqtts://broker.example"), ("broker.example", 8883, True))
check("an IPv6 literal keeps its brackets out of the host", split_target("mqtts://[::1]:8883"), ("::1", 8883, True))
check("a path suffix does not become part of the host", split_target("mqtts://h:8883/mqtt"), ("h", 8883, True))
try:
    split_target("mqtt://h:notaport")
    check("a non-numeric port is a refusal, not a silent default", False, True)
except TransportRefusal:
    check("a non-numeric port is a refusal, not a silent default", True, True)

print("\n== the no-TLS path is UNCHANGED, and there is NO shipped address to fall back to ==")
p = transport_kwargs("mqtt://broker.example:1883", {}, readable=PRESENT)
check("plaintext stays plaintext", (p["tls"], p["host"], p["port"], p["kwargs"]), (False, "broker.example", 1883, {}))
check("a plaintext plan carries no ssl_options", p["ssl_options"], None)
# SITE-AGNOSTIC by design: "no default, must be set". A `DEFAULT_URL` used to
# sit in tlsenv.py and answer this cell; it is gone, and an empty URL is a refusal on BOTH sides of
# the repo (tlsopts.ts refuses an empty url the same way). A transport module that invents an address
# is a second path to a broker nobody configured, and the broker layer's own refusal would be a lie.
msg = refuses("no URL at all refuses", "", {}, "refusing to guess")
check("and it names the site config door", "mqttUrl" in msg, True)
check("and it names the env door", "MQTT_URL" in msg, True)
refuses("None (unset) refuses too", None, {}, "refusing to guess")
refuses("a whitespace-only URL refuses as well", "   ", {}, "refusing to guess")

print("\n== AC4 positive: a TLS URL with a CA named produces a real TLS plan ==")
t = transport_kwargs("mqtts://broker.example:8883", {"MQTT_TLS_CAFILE": "/k/ca.crt"}, readable=PRESENT)
check("tls", t["tls"], True)
check("ca_certs is the PATH, not a secret value", t["kwargs"]["ca_certs"], "/k/ca.crt")
check("verification is ON by default", "insecure" not in t["kwargs"], True)
check("no warnings armed on the good path", t["warnings"], [])
pair = transport_kwargs(
    "mqtts://broker.example:8883",
    {"MQTT_TLS_CAFILE": "/k/ca.crt", "MQTT_TLS_CERTFILE": "/k/c.pem", "MQTT_TLS_KEYFILE": "/k/k.pem"},
    readable=PRESENT,
)
check("a full pair is carried", (pair["kwargs"]["certfile"], pair["kwargs"]["keyfile"]), ("/k/c.pem", "/k/k.pem"))

print("\n== AC4 negative: no CA configured refuses to start and says why ==")
m = refuses("mqtts with no CA", "mqtts://broker.example:8883", {}, "MQTT_TLS_CAFILE")
check("and it does not echo a secret", "hunter2" not in m, True)
refuses("cert without key", "mqtts://h:8883", {"MQTT_TLS_CAFILE": "/k/ca.crt", "MQTT_TLS_CERTFILE": "/k/c.pem"}, "pair")
refuses("key without cert", "mqtts://h:8883", {"MQTT_TLS_CAFILE": "/k/ca.crt", "MQTT_TLS_KEYFILE": "/k/k.pem"}, "pair")

print("\n== the fleet lock: MQTT_TLS_REQUIRED must never fall back to plaintext ==")
refuses("required + plain URL", "mqtt://broker.example:1883", {"MQTT_TLS_REQUIRED": "1"}, "mqtts://")
ok = transport_kwargs("mqtts://broker.example:8883", {"MQTT_TLS_REQUIRED": "1", "MQTT_TLS_CAFILE": "/k/ca.crt"}, readable=PRESENT)
check("required + TLS URL connects (a lock is not a ban)", ok["tls"], True)

print("\n== TLS material named against a plaintext URL is a misconfiguration, not a no-op ==")
refuses("plain URL + CA set", "mqtt://broker.example:1883", {"MQTT_TLS_CAFILE": "/k/ca.crt"}, "IGNORED")

print("\n== an unknown scheme is never inferred to be plaintext ==")
refuses("foo:// is a refusal", "foo://h:1883", {}, "not recognised")
refuses("empty-ish URL after defaults is not a guess", "mqtt://h:abc", {}, "non-numeric")

print("\n== credentials in the URL are refused, and the refusal hides them ==")
secret = "hunter2"
msg = refuses("userinfo in MQTT_URL", f"mqtts://lane11:{secret}@h:8883", {"MQTT_TLS_CAFILE": "/k/ca.crt"}, "userinfo")
check("the refusal does not repeat the secret", secret not in msg, True)
check("redact_url hides it", redact_url(f"mqtts://lane11:{secret}@h:8883"), "mqtts://lane11:***@h:8883")
check("redact_url leaves a clean URL byte-identical", redact_url("mqtt://broker.example:1883"), "mqtt://broker.example:1883")
check("redact_url is not confused by an @ in the path", redact_url("mqtt://h:1883/a@b"), "mqtt://h:1883/a@b")

print("\n== rejectUnauthorized off ONLY by the named opt-in, and then it warns every connect ==")
ins = transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": "/k/ca.crt", "MQTT_TLS_INSECURE": "1"}, readable=PRESENT)
check("opt-in is honoured when asked for by name", ins["kwargs"].get("insecure"), True)
check("one per-connect warning", len(ins["warnings"]), 1)
check("the warning names the variable", "MQTT_TLS_INSECURE" in ins["warnings"][0], True)
refuses("a typo in the insecure flag is a refusal, not a silent off", "mqtts://h:8883",
        {"MQTT_TLS_CAFILE": "/k/ca.crt", "MQTT_TLS_INSECURE": "0"}, "MQTT_TLS_INSECURE")
plain_insec = transport_kwargs("mqtt://h:1883", {"MQTT_TLS_INSECURE": "1"}, readable=PRESENT)
check("insecure on a plaintext URL: nothing to insecure, connects as today", plain_insec["tls"], False)
check("and it says the flag did nothing here", len(plain_insec["warnings"]), 1)

print("\n== a TLS path that cannot be READ is refused at plan time, not at the socket ==")
# The class this leg found: `transport_kwargs` used to accept ANY string in MQTT_TLS_CAFILE, hand it
# to paho, and let `FileNotFoundError` surface at connect time as something that reads like a network
# fault. The agent side (tlsopts.ts) already checked before connecting; now both halves do.
try:
    transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": "/k/nope.crt"}, readable=ABSENT)
    check("an unreadable CA refuses at PLAN time", False, True)
except TransportRefusal as e:
    check("an unreadable CA refuses at PLAN time, naming the variable",
          "MQTT_TLS_CAFILE" in str(e) and "cannot be read" in str(e), True)
    check("and it says it will not fall back to system roots", "system roots" in str(e), True)
try:
    transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": "/k/empty.crt"}, readable=ZERO)
    check("a ZERO-BYTE CA refuses too", False, True)
except TransportRefusal as e:
    check("a ZERO-BYTE CA refuses too", "EMPTY" in str(e), True)


def _ca_ok_cert_missing(path):
    return 1 if path.endswith("ca.crt") else (_ for _ in ()).throw(FileNotFoundError())


try:
    transport_kwargs("mqtts://h:8883",
                     {"MQTT_TLS_CAFILE": "/k/ca.crt", "MQTT_TLS_KEYFILE": "/k/nope.key"},
                     readable=_ca_ok_cert_missing)
    check("an unreadable client KEY refuses, not just the CA", False, True)
except TransportRefusal as e:
    check("an unreadable client KEY refuses, not just the CA", "MQTT_TLS_KEYFILE" in str(e), True)

print("\n== REAL MATERIAL: a minted CA and client pair load into a real ssl.SSLContext ==")
# Everything above proves the SHAPE of a plan. This proves the plan is LOADABLE, with throwaway
# material minted here into a temp dir — paths handled, contents never printed. A suite that only
# ever used `/k/ca.crt` could not tell a working TLS configuration from a decorative one.
# ABSENT AND BROKEN ARE NOT THE SAME STATE, and this decides it by LOOKING rather than by catching:
# `shutil.which` is the same lookup src/tools/test_paho_skip.sh:71 makes for `bun`, and it runs BEFORE
# anything is minted. Present-but-broken is NOT skipped: `check=True` below still raises, the run dies,
# and a refusing openssl is a failure worth stopping a deploy for. Absent means this section cannot
# mint, so every check it would have run is NAMED as NOT APPLICABLE and the file still exits 0 — an
# openssl-less host deploys tabichat and mints its PKI elsewhere, and a deploy stopped here is the
# assumption 0.1.3 retired for the checks that came before it.
REAL = shutil.which("openssl") is not None
if REAL:
    SCRATCH = tempfile.mkdtemp(prefix="tabichat-tlsenv-")
    # The throwaway CA and its client pair are this run's scratch, so this run destroys them — the
    # FAILING path included, not only the tidy one, which is what `atexit` buys over an epilogue line.
    # A minted key left in /tmp after the harness finished proves nothing about the run that made it
    # and cannot be verified after a reboot, so there is none left to find. Paths only: the contents
    # were never printed here and are not printed by the cleanup.
    atexit.register(lambda: shutil.rmtree(SCRATCH, ignore_errors=True))


def mint(name, cn, is_ca=False, sn=None):
    d = os.path.join(SCRATCH, name)
    os.makedirs(d, exist_ok=True)
    key, crt = os.path.join(d, "key.pem"), os.path.join(d, "cert.pem")
    cmd = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
           "-days", "1", "-subj", f"/CN={cn}",
           "-addext", "basicConstraints=" + ("critical,CA:TRUE" if is_ca else "critical,CA:FALSE")]
    if sn:
        cmd += ["-addext", f"subjectAltName={sn}"]
    subprocess.run(cmd, check=True, capture_output=True)
    os.chmod(key, 0o600)
    return key, crt


# GUARDED-BEGIN  every check( inside a guarded block must have a skip( of the same name
if REAL:
    _ca_key, ca_crt = mint("ca", "tabichat-test-ca-only", is_ca=True)
    _leaf_key, _leaf_crt = mint("leaf", "tabichat-broker", sn="DNS:localhost,IP:127.0.0.1")
    client_key, client_crt = mint("client", "tabichat-client", sn="DNS:localhost")
    real = transport_kwargs("mqtts://localhost:8883", {
        "MQTT_TLS_CAFILE": ca_crt, "MQTT_TLS_CERTFILE": client_crt, "MQTT_TLS_KEYFILE": client_key})
    check("a REAL CA path plans without refusing", real["tls"], True)
    real_ctx = build_ssl_context(real)
    check("and the real context loads the pinned CA and the client pair",
          (real_ctx.verify_mode.name, real_ctx.check_hostname), ("CERT_REQUIRED", True))
    _trusted = [c.get("subject", "") for c in real_ctx.get_ca_certs()]
    check("the trust store holds EXACTLY the one CA we minted — no system roots",
          (len(_trusted), "tabichat-test-ca-only" in str(_trusted[0])), (1, True))
    check("the version bar survived the load",
          (real_ctx.minimum_version.name, real_ctx.maximum_version.name), ("TLSv1_2", "TLSv1_3"))

    # A NON-PEM FILE in the CA variable: readable, so the readability gate passes, and the loader is
    # the one that must refuse. This is the "paho raised a bare errno at connect time" class, second
    # half. It needs no minted material, but it writes its fixture into the same scratch dir, so it
    # belongs to this block and is reported with it.
    _bad_dir = os.path.join(SCRATCH, "bad")
    os.makedirs(_bad_dir, exist_ok=True)
    _bad_ca = os.path.join(_bad_dir, "not-a-pem.crt")
    with open(_bad_ca, "w") as _fh:
        _fh.write("this is not a certificate\n")
    try:
        build_ssl_context(transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": _bad_ca}))
        check("a file that is not a PEM is refused LOUDLY, with the variable named", False, True)
    except (TransportRefusal, TransportBlocked) as e:
        check("a file that is not a PEM is refused LOUDLY, with the variable named",
              "MQTT_TLS_CAFILE" in str(e), True)
else:
    skip("a REAL CA path plans without refusing")
    skip("and the real context loads the pinned CA and the client pair")
    skip("the trust store holds EXACTLY the one CA we minted — no system roots")
    skip("the version bar survived the load")
    skip("a file that is not a PEM is refused LOUDLY, with the variable named")
# GUARDED-END

print("\n== apply_to_client against a STRICT fake paho (real paho: test_tlsenv_paho.py) ==")


class FakePaho:
    """A stand-in that refuses what real paho refuses. The old fake recorded ANY kwargs handed to
    `tls_set`, which is precisely why a string where paho wants an int sailed through the whole
    suite. This one accepts only the call the product actually makes — `tls_set_context` with OUR
    `ssl.SSLContext` — and `tls_set` now raises, so if the old shape comes back it is a failure."""

    def __init__(self):
        self.tls_set_calls = []
        self.insecure_calls = []
        self.context_calls = []

    def tls_set(self, **kw):
        self.tls_set_calls.append(kw)
        raise AssertionError("the product must not use tls_set(); its tls_version is int-only")

    def tls_set_context(self, context=None):
        self.context_calls.append(context)

    def tls_insecure_set(self, v):
        self.insecure_calls.append(v)


class OldPahoWithoutContext:
    """A paho that has no `tls_set_context`. The plan must be BLOCKED, not improvised with tls_set."""

    def tls_set(self, **kw):
        raise AssertionError("must not be reached")


f = FakePaho()
apply_to_client(f, transport_kwargs("mqtt://broker.example:1883", {}, readable=PRESENT))
check("a plaintext plan touches no TLS call at all",
      (f.tls_set_calls, f.insecure_calls, f.context_calls), ([], [], []))

blocked = OldPahoWithoutContext()
try:
    apply_to_client(blocked, transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": "/k/ca.crt"}, readable=PRESENT))
    check("a paho that cannot carry a context is a LOUD block, never a tls_set improvisation", False, True)
except TransportBlocked as e:
    check("a paho that cannot carry a context is a LOUD block, never a tls_set improvisation",
          "tls_set_context" in str(e), True)

# GUARDED-BEGIN  these cells are handed the minted pair by NAME, so they are the same section
# `apply_to_client` builds a REAL `ssl.SSLContext` from the paths it is given and the checks below
# inspect THAT object. With no `openssl` there is no material to build it from, and a context loaded
# from decorative placeholder bytes would be the false corroboration this file's header refuses — so
# the cells are skipped and named, never re-aimed at a fake path.
if not REAL:
    skip("a TLS plan calls tls_set_context once, and never tls_set")
    skip("the thing handed to paho IS an ssl.SSLContext")
    skip("with verification REQUIRED")
    skip("hostname checking ON")
    skip("and the version bar is a real range, not a string")
    skip("the insecure opt-in takes verification off on the CONTEXT, both halves")
    skip("MQTT_TLS_SERVERNAME is CARRIED on the context's sni_hostname, not silently dropped")
    skip("and it still verifies the pinned CA while doing so")
else:
  f2 = FakePaho()
  apply_to_client(f2, transport_kwargs("mqtts://broker.example:8883", {
      "MQTT_TLS_CAFILE": ca_crt, "MQTT_TLS_CERTFILE": client_crt, "MQTT_TLS_KEYFILE": client_key}))
  # THE INSTRUMENT THAT WAS BLIND. The old cell asserted `tls_set` was called with
  # ["ca_certs","certfile","keyfile","tls_version"] and the fake accepted the whole shape — including
  # the STRING "TLSv1.3" that real paho refuses with TypeError. Two changes: paho is handed OUR
  # ssl.SSLContext through tls_set_context (the only correct way to express a version range), and the
  # context is then INSPECTED, so the check is about the transport, not about the fake's memory.
  check("a TLS plan calls tls_set_context once, and never tls_set", (len(f2.context_calls), f2.tls_set_calls), (1, []))
  ctx = f2.context_calls[0]
  check("the thing handed to paho IS an ssl.SSLContext", type(ctx).__name__, "SSLContext")
  check("with verification REQUIRED", ctx.verify_mode.name, "CERT_REQUIRED")
  check("hostname checking ON", ctx.check_hostname, True)
  check("and the version bar is a real range, not a string",
        (ctx.minimum_version.name, ctx.maximum_version.name), ("TLSv1_2", "TLSv1_3"))

  f3 = FakePaho()
  apply_to_client(f3, transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": ca_crt, "MQTT_TLS_INSECURE": "1"}))
  check("the insecure opt-in takes verification off on the CONTEXT, both halves",
        (f3.context_calls[0].check_hostname, f3.context_calls[0].verify_mode.name), (False, "CERT_NONE"))

  f4 = FakePaho()
  apply_to_client(f4, transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": ca_crt, "MQTT_TLS_SERVERNAME": "broker.example"}))
  check("MQTT_TLS_SERVERNAME is CARRIED on the context's sni_hostname, not silently dropped",
        f4.context_calls[0].sni_hostname, "broker.example")
  check("and it still verifies the pinned CA while doing so", f4.context_calls[0].verify_mode.name, "CERT_REQUIRED")
# GUARDED-END

print("\n== THE OLD DEFECT, KEPT AS A CELL: real paho refuses a string version ==")
# It is not enough to stop passing the string; the suite must say LOUDLY that passing it fails, so
# nobody "restores" it because the fake no longer complains. Needs real paho — with none importable
# this cell reports NOT RUN in words and does NOT pretend to pass.
try:
    import paho.mqtt.client as _rp

    _c = _rp.Client(_rp.CallbackAPIVersion.VERSION2)
    try:
        _c.tls_set(ca_certs=None, tls_version="TLSv1.3")
        check("real paho REFUSES a string tls_version (the old shape must never come back)", False, True)
    except TypeError as _e:
        check("real paho REFUSES a string tls_version with TypeError", "integer" in str(_e), True)
    except Exception as _e:
        check(f"real paho refused the string, with {type(_e).__name__} not TypeError", False, True)
    # GUARDED-BEGIN  this cell builds a context from the minted CA, so it belongs to that section
    if REAL:
        _c2 = _rp.Client(_rp.CallbackAPIVersion.VERSION2)
        _c2.tls_set_context(build_ssl_context(
            transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": ca_crt})))
        check("real paho ACCEPTS our ssl.SSLContext and marks the socket TLS", _c2._ssl, True)
    else:
        skip("real paho ACCEPTS our ssl.SSLContext and marks the socket TLS")
    # GUARDED-END
except ImportError:
    print("NOT RUN  real-paho cells: paho-mqtt is not importable on this box. This file does NOT "
          "claim they ran; tools/test_tlsenv_paho.py is the file that must, and it reports its own "
          "absence as a failure, not a pass.")

print("\n== the env surface is the same NAMES the agent side uses ==")
tsrc = open(os.path.join(os.path.dirname(__file__), "..", "extensions", "tabichat", "tlsopts.ts")).read()
for k, v in tlsenv.TLS_ENV.items():
    check(f"{v} is spelled identically in tlsopts.ts", f'"{v}"' in tsrc, True)
check("and the agent side ships NO default address either", "DEFAULT_URL" in tsrc, False)

# GUARDED-REGION DRIFT, asserted from this file's own source. It runs whatever `openssl` does, because
# the claim is about the source, not about the host: every check a guarded block can skip must have a
# skip of the same name. A check added inside a guarded block with no skip line would fail here on any
# box; a skip left behind by a check that was deleted fails here too, which is the direction
# test_paho_skip.sh calls "a stale exemption names nothing".
_here = open(os.path.abspath(__file__)).read()
_gchecks, _gsks = guarded_names(_here)
check("every guarded check has a skip of the same name (no silent pass on an openssl-less host)",
      sorted(set(_gchecks) - set(_gsks)), [])
check("and every guarded skip names a check that still exists (no skip of a deleted cell)",
      sorted(set(_gsks) - set(_gchecks)), [])
if not REAL:
    check("the skip lines printed match, name for name, the checks the guarded blocks report",
          sorted(skipped), sorted(set(_gsks)))
# THE PLANT, assembled at run time so the repo holds no broken copy of its own guard: an extra check
# added inside a guarded region WITHOUT a skip must be reported by the detector above. A cell that
# cannot return non-zero is not a cell.
_src = _here.split("\n")
for _i, _l in enumerate(_src):
    if _l.strip().startswith(GUARD_START):
        _src.insert(_i + 1, '    check("a PLANTED check with no skip line", True, True)')
        break
else:
    _i = -1
check("CONTROL — the plant landed inside a guarded region (the detector has regions to read)", _i >= 0, True)
check("CONTROL — the detector finds a planted unpaired check (exactly 1)",
      sorted(set(guarded_names("\n".join(_src))[0]) - set(guarded_names("\n".join(_src))[1])),
      ["a PLANTED check with no skip line"])

if skipped:
    # Said in words, in the deployer's own shape (`... did NOT RUN`), so a skip is never read as a pass
    # by whoever reads the tail of the run: the tally below counts only the checks that actually ran.
    print(f"test-tlsenv: {len(skipped)} REAL-MATERIAL checks did NOT RUN on this host — openssl is "
          f"absent. They are named above, one per line, not counted as passes.")
print(f"\n{failed} FAILED of {ran}" if failed else f"all {ran} checks pass")
sys.exit(1 if failed else 0)
