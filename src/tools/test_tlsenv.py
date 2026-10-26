#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for src/src/tlsenv.py — the transport rules the HUMAN clients obey.

    python3 src/tools/test_tlsenv.py        (exit 1 on any failure)

NO BROKER NEEDED, AND THAT IS DELIBERATE. The decision module is pure: every rule below is about
what the client is ALLOWED to do with a socket, which is exactly the part that must not drift between
the python and the agent side. WHAT CHANGED AT s140: this file used to say "no paho needed" and then
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

import os
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
msg = refuses("userinfo in MQTT_URL", f"mqtts://wren:{secret}@h:8883", {"MQTT_TLS_CAFILE": "/k/ca.crt"}, "userinfo")
check("the refusal does not repeat the secret", secret not in msg, True)
check("redact_url hides it", redact_url(f"mqtts://wren:{secret}@h:8883"), "mqtts://wren:***@h:8883")
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
SCRATCH = tempfile.mkdtemp(prefix="tabichat-tlsenv-")


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

# A NON-PEM FILE in the CA variable: readable, so the readability gate passes, and the loader is the
# one that must refuse. This is the "paho raised a bare errno at connect time" class, second half.
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
    _c2 = _rp.Client(_rp.CallbackAPIVersion.VERSION2)
    _c2.tls_set_context(build_ssl_context(
        transport_kwargs("mqtts://h:8883", {"MQTT_TLS_CAFILE": ca_crt})))
    check("real paho ACCEPTS our ssl.SSLContext and marks the socket TLS", _c2._ssl, True)
except ImportError:
    print("NOT RUN  real-paho cells: paho-mqtt is not importable on this box. This file does NOT "
          "claim they ran; tools/test_tlsenv_paho.py is the file that must, and it reports its own "
          "absence as a failure, not a pass.")

print("\n== the env surface is the same NAMES the agent side uses ==")
tsrc = open(os.path.join(os.path.dirname(__file__), "..", "extensions", "tabichat", "tlsopts.ts")).read()
for k, v in tlsenv.TLS_ENV.items():
    check(f"{v} is spelled identically in tlsopts.ts", f'"{v}"' in tsrc, True)
check("and the agent side ships NO default address either", "DEFAULT_URL" in tsrc, False)

print(f"\n{failed} FAILED of {ran}" if failed else f"all {ran} checks pass")
sys.exit(1 if failed else 0)
