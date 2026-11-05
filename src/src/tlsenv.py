#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Transport decision for the tabichat human clients — pure, no paho, no filesystem.

Why this is a separate file rather than inline in each client: the pi extension makes the same
decision in `src/extensions/tabichat/tlsopts.ts`, and the rules there are refusal rules — a TLS
URL with no readable CA must STOP, not fall back to plaintext. Two copies of a refusal rule drift,
and the drift is invisible because the client that got it wrong still connects. So one file holds
the human side, one holds the agent side, and `tools/test_tlsenv.py` (pure python, no paho) and
`tools/test_tlsopts.ts` state the same rules on both.

WHAT THIS COVERS: `MQTT_URL`-style input split into host/port/scheme, plus the three credential
PATHS a mTLS client needs. It returns a dict of the keyword arguments `paho` takes; the CALLER does
the socket work. Nothing here reads a file — that is the point, so this is testable on a box with
no paho and no broker, which any development machine is.

NO SECRET IS EVER RETURNED OR PRINTED. Values are paths. A password would be a secret in a launch
line, and shape (B) was chosen over a shared password precisely so the sheet stays path-only
(features/tabichat-mqtt-broker-auth.md). `redact_url()` exists because an exception message from the
mqtt library carries the URL, and that message is printed into the terminal and any report that
quotes it.
"""

from __future__ import annotations

import os
import re
import ssl

TLS_ENV = {
    "cafile": "MQTT_TLS_CAFILE",
    "certfile": "MQTT_TLS_CERTFILE",
    "keyfile": "MQTT_TLS_KEYFILE",
    "servername": "MQTT_TLS_SERVERNAME",
    "require_tls": "MQTT_TLS_REQUIRED",
    "insecure": "MQTT_TLS_INSECURE",
}

TLS_SCHEMES = ("mqtts://", "wss://", "tcps://", "ssl://")
PLAIN_SCHEMES = ("mqtt://", "tcp://", "ws://")

# THE VERSION BAR, AND WHY IT IS AN INT AND NOT A STRING. paho's `tls_set(tls_version=...)` is
# annotated `int | None` and passes it straight to `ssl.SSLContext(tls_version)`, which wants an
# `ssl.PROTOCOL_*` constant. A mosquitto-style name like "TLSv1.3" is a STRING, and a string is not
# an int: measured on this box against the real paho-mqtt 2.1.0,
# `client.tls_set(ca_certs=..., tls_version="TLSv1.3")` dies with
# `TypeError: 'str' object cannot be interpreted as an integer` — and `ssl.TLSVersion.TLSv1_3`
# (772) is ALSO refused there with `ValueError: invalid or unsupported protocol version`, because
# `ssl.SSLContext()` takes a PROTOCOL constant, not a TLSVersion. So the version *range* cannot be
# expressed through `tls_set` at all: the only correct door is our own `ssl.SSLContext` handed to
# `tls_set_context()`. That is what `build_ssl_context()` below makes, and the bar is a RANGE
# (1.2 floor, 1.3 ceiling) rather than a single version because a 1.3-only client cannot reach a
# broker that ships 1.2, and a silent 1.2-only fall back is the downgrade this module exists to stop.
TLS_MIN_VERSION = ssl.TLSVersion.TLSv1_2
TLS_MAX_VERSION = ssl.TLSVersion.TLSv1_3

# NO SHIPPED BROKER ADDRESS (site-agnostic by design: "no default, must be set"; the merge
# onto site-agnostic `main` deleted the `DEFAULT_URL` that used to sit here). A default in
# a transport module is a second, unruled path to a broker: the broker layer refuses an unconfigured
# box, and a transport default would answer instead — connecting to an address nobody configured
# while the refusal text said it would not guess. Nothing here guesses: `transport_kwargs` refuses
# an empty URL and its refusal names the same doors broker.py names.


class TransportRefusal(Exception):
    """The client must NOT connect. Raised instead of returning a weakened option set."""


def redact_url(url: str) -> str:
    """Hide a password in URL userinfo. A clean URL comes back byte-identical."""
    m = re.match(r"^([a-zA-Z][a-zA-Z0-9+.\-]*://)([^@/?#]*)@(.*)$", url or "", re.S)
    if not m:
        return url or ""
    userinfo = m.group(2)
    user = userinfo.rsplit(":", 1)[0] if ":" in userinfo else userinfo
    return f"{m.group(1)}{user}:***@{m.group(3)}"


def has_userinfo(url: str) -> bool:
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://[^@/?#]+@", url or ""))


def scheme_of(url: str) -> str:
    m = re.match(r"^\s*([a-zA-Z][a-zA-Z0-9+.\-]*://)", url or "")
    return m.group(1).lower() if m else ""


def split_target(url: str):
    """(host, port, tls) from `mqtts://host:port` — paho wants them apart, mqtt.js wants them joined."""
    s = scheme_of(url)
    rest = url[len(s):] if s else url
    rest = rest.split("/", 1)[0].split("?", 1)[0]
    # an IPv6 literal: [::1]:8883
    if rest.startswith("["):
        host, _, tail = rest.partition("]")
        host = host[1:]
        port = tail.lstrip(":")
    elif rest.count(":") == 1:
        host, _, port = rest.partition(":")
    else:
        host, port = rest, ""
    default_port = "8883" if s in TLS_SCHEMES else "1883"
    try:
        p = int(port) if port else int(default_port)
    except ValueError:
        raise TransportRefusal(f"MQTT_URL has a non-numeric port: {redact_url(url)!r}")
    return host, p, s in TLS_SCHEMES


def _flag(env, key):
    return str(env.get(key, "")).strip() == "1"


def transport_kwargs(url: str | None = None, env=None, readable=None):
    """Return the transport plan for the URL the broker layer resolved, or raise TransportRefusal.

    `readable` is the injectable "can this path be read?" check, mirroring the injected PEM reader on
    the agent side (`makePemReader` in tlsopts.ts). It exists so the truth table runs headless, and
    so a cell can prove the refusal for an unreadable CA without touching a key file: PATHS ONLY
    are ever handled here, never content.

    The plan is DATA, not a paho call: `{"tls", "host", "port", "kwargs", "ssl_options", "warnings"}`.
    `kwargs` carries only PATHS and flags; `ssl_options` carries the version bar and the SNI name as
    data so the whole truth table runs with no broker, no certificates and no network. The one
    function that talks to paho, `apply_to_client`, turns `ssl_options` into a real
    `ssl.SSLContext` (see `build_ssl_context`) — which is the fix for the defect this file used to
    carry: it handed paho `tls_version="TLSv1.3"`, a string where paho wants an int, and the fake
    client in the old test accepted anything, so the suite read green while every real TLS connect
    died at the call. That is now checked against REAL paho in `tools/test_tlsenv_paho.py`.

    The rules, and the reason each one is a refusal rather than a warning:
      0. NO URL AT ALL                       -> refuse, naming the config file and the variables.
         There is no shipped default to fall back to and no guess to make.
      1. credentials in the URL userinfo     -> refuse. paho has no URL at all, so a URL with
         userinfo in a launch line means somebody will put the same secret in a `password=` line;
         and an mqtt error object carrying that URL reaches a terminal and then a report.
      2. MQTT_TLS_REQUIRED=1 + plain         -> refuse. A flag named REQUIRED that silently permits
         plaintext is a flag that does nothing, and this is the exact silent-downgrade class.
      3. plain URL + a TLS path set          -> refuse. The operator meant TLS; connecting plaintext
         would IGNORE the pinned CA, which is worse than failing.
      4. TLS URL, no CA file                 -> refuse. tabichat pins a dedicated CA, so there is
         nothing to verify the broker against; trusting system roots would just fail later, at the
         handshake, as a message that reads like a network fault.
      5. TLS URL, cert without key           -> refuse. Half a pair is a broker-side refusal you
         cannot tell apart from a down broker.
      6. MQTT_TLS_INSECURE set to anything
         other than "1"                      -> refuse. The variable that turns off verification is
         not one to leave half-typed.
      7. MQTT_TLS_INSECURE=1                 -> ALLOWED, verification off, and the caller must print
         `warnings` on EVERY connect, not once at boot.
    """
    env = os.environ if env is None else env
    readable = os.path.getsize if readable is None else readable
    raw = (url if url is not None else env.get("MQTT_URL", "")) or ""
    if raw.strip() == "":
        # the broker layer refused, or nobody configured anything. Refuse in the SAME words so a
        # human and a lane read one message from two doors, and never reach for a default.
        raise TransportRefusal(
            "no broker URL to build a transport from — refusing to guess one. Set \"mqttUrl\" in the "
            "site config at ~/.pi/agent/tabichat.json (move it with TABICHAT_CONFIG), or export "
            "MQTT_URL=mqtt://<your-broker-host>:1883 (MQTT_HOST + MQTT_PORT also work). tabichat "
            "ships no broker address."
        )
    if has_userinfo(raw):
        raise TransportRefusal(
            f"MQTT_URL must not carry credentials in the URL userinfo ({redact_url(raw)}). "
            f"Authenticate with {TLS_ENV['certfile']}/{TLS_ENV['keyfile']} paths — never a secret "
            "in a URL that error messages print."
        )
    host, port, tls = split_target(raw)
    s = scheme_of(raw)
    if s and s not in TLS_SCHEMES and s not in PLAIN_SCHEMES:
        raise TransportRefusal(
            f"MQTT_URL scheme {s!r} is not recognised; expected one of "
            f"{', '.join(PLAIN_SCHEMES + TLS_SCHEMES)}. Treating an unknown scheme as plaintext "
            "would be a silent downgrade."
        )
    cafile = (env.get(TLS_ENV["cafile"]) or "").strip()
    certfile = (env.get(TLS_ENV["certfile"]) or "").strip()
    keyfile = (env.get(TLS_ENV["keyfile"]) or "").strip()
    servername = (env.get(TLS_ENV["servername"]) or "").strip()
    insecure_raw = env.get(TLS_ENV["insecure"], "")
    warnings: list[str] = []

    if _flag(env, TLS_ENV["require_tls"]) and not tls:
        raise TransportRefusal(
            f"{TLS_ENV['require_tls']}=1 but MQTT_URL is plaintext ({redact_url(raw)}). Point it at "
            f"mqtts://<broker>:8883 or unset the flag. Refusing rather than connecting plaintext is "
            "the entire point of the flag."
        )
    if not tls and (cafile or certfile or keyfile):
        raise TransportRefusal(
            f"{TLS_ENV['cafile']}/{TLS_ENV['certfile']}/{TLS_ENV['keyfile']} are set but MQTT_URL is "
            f"plaintext ({redact_url(raw)}), so the pinned CA and client certificate would be IGNORED "
            "and the session would be readable by anyone on the path. Set MQTT_URL to mqtts://... "
            "or unset the TLS variables."
        )
    if tls:
        if not cafile:
            raise TransportRefusal(
                f"MQTT_URL asks for TLS ({redact_url(raw)}) and no {TLS_ENV['cafile']} is set. "
                "tabichat pins a dedicated CA rather than trusting system roots, so there is nothing "
                "to verify the broker against. Point it at the tabichat CA PEM — never a venya core "
                "CA (the #536/#541 boundary)."
            )
        if bool(certfile) != bool(keyfile):
            raise TransportRefusal(
                f"{'cert' if certfile else 'key'} file given without its pair "
                f"({TLS_ENV['certfile']} / {TLS_ENV['keyfile']}). A client certificate and its key "
                "are a pair; half a pair is refused by a require_certificate broker in a way that "
                "looks like a network fault."
            )
        if str(insecure_raw).strip() and str(insecure_raw).strip() != "1":
            raise TransportRefusal(
                f"{TLS_ENV['insecure']}={insecure_raw!r} is set to something other than \"1\". The "
                "variable that disables certificate verification is not one to leave half-typed."
            )
        insecure = str(insecure_raw).strip() == "1"
        # A NAMED BUT UNREADABLE CA IS A REFUSAL AT PLAN TIME, not a socket error later. This is the
        # half the agent side already had (`tlsopts.ts` checks the PEM before connecting) and the
        # python side did not: a path that does not exist reaches paho, and paho raises
        # FileNotFoundError from inside `tls_set` at connect time — which reads like a network fault
        # and hides the one line the operator actually needs (which variable, which path).
        for _name, _path in ((TLS_ENV["cafile"], cafile),
                             (TLS_ENV["certfile"], certfile),
                             (TLS_ENV["keyfile"], keyfile)):
            if not _path:
                continue
            try:
                if readable(_path) == 0:
                    raise TransportRefusal(
                        f"{_name} points at an EMPTY file ({_path}). A zero-byte PEM verifies "
                        "nothing, and a client that connects while its pinned CA is empty is a "
                        "client that believes in an encryption it never asked for."
                    )
            except OSError:
                raise TransportRefusal(
                    f"{_name} cannot be read ({_path}). Refusing to connect rather than falling back "
                    "to system roots or to plaintext: the whole point of pinning a CA is that this "
                    "file, and nothing else, decides who the broker is."
                )
        if insecure:
            warnings.append(
                f"TLS VERIFICATION DISABLED ({TLS_ENV['insecure']}=1): accepting ANY certificate for "
                f"{redact_url(raw)}. Nothing about this session is private against an on-path peer."
            )
        # THE kwargs dict is what a caller may print or record: paths, and no secret. `ca_certs` is
        # spelled the way paho spells it so the shape stays comparable across the two halves.
        kw = {"ca_certs": cafile, "certfile": certfile or None, "keyfile": keyfile or None}
        if insecure:
            kw["insecure"] = True
        # SERVERNAME IS NOT SILENTLY DROPPED. It used to be refused outright on the grounds that
        # paho's kwarg spelling is version-dependent and unprovable on a box with no paho — that
        # reasoning died when paho 2.1.0 got installed here, and the measurement is in this file's
        # header: `Client.tls_set()` in paho 2.1.0 has NO `server_hostname` parameter at all, so it
        # would be a TypeError, not a silent drop. The correct carrier is the context's own
        # `sni_hostname`, which `build_ssl_context` sets, and `tools/test_tlsenv_paho.py` proves a
        # real paho carries it through to a real handshake against the fixture broker.
        ssl_options = {
            "min_version": TLS_MIN_VERSION,
            "max_version": TLS_MAX_VERSION,
            "servername": servername or None,
            "insecure": insecure,
        }
        return {"tls": True, "host": host, "port": port, "kwargs": kw,
                "ssl_options": ssl_options, "warnings": warnings}
    if str(insecure_raw).strip():
        warnings.append(f"{TLS_ENV['insecure']} is set but the URL is plaintext; it does nothing here.")
    return {"tls": False, "host": host, "port": port, "kwargs": {},
            "ssl_options": None, "warnings": warnings}


class TransportBlocked(Exception):
    """A step the caller cannot take on this paho version. Loud, never improvised."""


def build_ssl_context(plan):
    """Turn a TLS plan into a real `ssl.SSLContext`. Pure stdlib — no paho, no network.

    THIS IS THE FIX for the defect the old code shipped: it put `tls_version="TLSv1.3"` in the kwarg
    dict and handed it to `client.tls_set(**kw)`, and paho passes that value to `ssl.SSLContext()`,
    which wants a PROTOCOL constant — a string is a `TypeError`, so every real TLS connect died at
    the call while the suite stayed green against a fake that accepts anything.

    What the context guarantees, and why each line is here:
      * `PROTOCOL_TLS_CLIENT` — the client-side default method, and the one that turns on
        hostname checking and `CERT_REQUIRED` by itself. A bare `SSLContext()` would not.
      * `minimum_version`/`maximum_version` — the bar as a RANGE. This is the only way to express
        it: `ssl.SSLContext(tls_version)` takes a PROTOCOL constant, and `TLSVersion` members are
        not accepted there (measured: `ValueError: invalid or unsupported protocol version 772`).
      * `check_hostname = True` + `verify_mode = CERT_REQUIRED` — set EXPLICITLY, not left to the
        constructor's defaults, because a verification posture you cannot point at in three lines is
        a posture a future edit will quietly weaken.
      * `load_verify_locations(cafile)` — the PINNED CA. Never `load_default_certs()`, never system
        roots: that is the whole reason rule 4 above is a refusal instead of a warning.
      * `sni_hostname` — `MQTT_TLS_SERVERNAME`, carried by the standard-library field rather than by
        a paho kwarg that does not exist in 2.1.0. It also fixes the hostname we verify against,
        which is what makes a broker reached by IP address verifiable.
      * `insecure` — the ONLY way verification comes off, and it takes BOTH `check_hostname=False`
        and `verify_mode=CERT_NONE`, because setting one without the other is a half-configured
        context whose behaviour depends on which library reads it first.
    """
    if not plan.get("tls"):
        raise TransportRefusal("build_ssl_context called on a plaintext plan — there is no TLS to configure")
    kw = plan["kwargs"]
    opts = plan.get("ssl_options") or {}
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = opts.get("min_version") or TLS_MIN_VERSION
    ctx.maximum_version = opts.get("max_version") or TLS_MAX_VERSION
    ca_certs = kw.get("ca_certs")
    if not ca_certs:
        # belt and braces: transport_kwargs already refused this, but a plan built by hand must not
        # be able to reach a socket with system roots quietly loaded.
        raise TransportRefusal("no pinned CA in the plan; refusing to verify against system roots")
    insecure = bool(opts.get("insecure")) or bool(kw.get("insecure"))
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    else:
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
    try:
        ctx.load_verify_locations(cafile=ca_certs)
    except OSError as exc:
        raise TransportRefusal(
            f"the pinned CA could not be loaded into a TLS context ({TLS_ENV['cafile']}={ca_certs}): "
            f"{exc}. Nothing was connected and nothing was published."
        ) from exc
    if kw.get("certfile"):
        try:
            ctx.load_cert_chain(kw["certfile"], kw.get("keyfile"))
        except (OSError, ValueError) as exc:
            # transport_kwargs has already refused an unreadable or half-set pair, so getting here
            # means the file exists and is not loadable (a passphrase, a non-PEM, a cert and key
            # that do not pair). Say WHICH, naming the variables — never let a bare errno reach a room.
            raise TransportBlocked(
                f"the client certificate pair could not be loaded ({TLS_ENV['certfile']}="
                f"{kw['certfile']}, {TLS_ENV['keyfile']}={kw.get('keyfile')}): {exc}. Nothing was "
                "connected and nothing was published."
            ) from exc
    sni = opts.get("servername")
    if sni:
        ctx.sni_hostname = sni
    return ctx


def apply_to_client(client, plan):
    """Hand the plan to a paho client. Kept separate from the decision so the RULES above are
    testable without paho installed, and executed against real paho in `test_tlsenv_paho.py`.

    Uses `tls_set_context()` with OUR context — not `tls_set(**kwargs)`. Two reasons, both
    measured against the installed paho-mqtt 2.1.0:
      1. `tls_set(tls_version=...)` wants an `ssl.PROTOCOL_*` int and cannot express a version
         RANGE at all, and the string this module used to pass raised `TypeError` at every call;
      2. `tls_set()` with no `cert_reqs` silently loads SYSTEM ROOT certificates
         (`context.load_default_certs()`), which is exactly the verification posture rule 4 refuses
         to accept. Our context pins one CA and nothing else.
    A paho that has no `tls_set_context` is a LOUD `TransportBlocked`, never a fall-through to
    `tls_set` with a shape we have not proven: a client that cannot carry the plan does not connect.
    """
    if not plan["tls"]:
        return plan
    setter = getattr(client, "tls_set_context", None)
    if setter is None:
        raise TransportBlocked(
            "this paho client has no tls_set_context(); refusing to fall back to tls_set() with an "
            "unproven kwarg shape. Nothing was connected and nothing was published."
        )
    setter(build_ssl_context(plan))
    return plan

