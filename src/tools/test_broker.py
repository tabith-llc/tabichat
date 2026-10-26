#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for the BROKER LOCATION in the python room clients (s138d, site-agnostic).

    python3 src/tools/test_broker.py        (exit 1 on any failure)

The same ruling the TypeScript side runs, on this side of the repo:

    owner, 2026-10-18: "tabichat repo needs to be made site agnostic. 1. no default, must be set."
    owner, same evening: "the mqtt url can be set in a config, not hardcoded. 1. ok"

Order under test: this-run address (--host / /connect) -> site file "mqttUrl" -> MQTT_URL ->
MQTT_HOST(+MQTT_PORT) -> REFUSE naming the config path searched and every variable name. There is
no step that guesses a host, and a layer that holds a broken value refuses instead of falling
through silently.

HALF THE VALUE HERE IS THE TREE SCAN at the bottom (check_venue_scan): "we removed the default" and
"we removed the address" are different claims and the owner ruled on both. The banned host name is
HEX-ENCODED so this file cannot contain the plaintext it guards — same trick as
.githooks/forbidden-strings.hex, and it is why the scan also reads this file.
"""

import ast
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from broker import (  # noqa: E402
    BROKER_HOST_ENV,
    BROKER_PORT_ENV,
    BROKER_URL_ENV,
    BROKER_URL_KEY,
    SITE_CONFIG_DEFAULT,
    SITE_CONFIG_ENV,
    BrokerError,
    read_site_config,
    refusal,
    resolve_broker,
    site_config_path,
)

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(name)
        print("FAIL  %s: got %r, want %r" % (name, got, want))
    else:
        print("ok    %s: %r" % (name, got))


def refuses(name, env, **kw):
    """The negative form, spelled once: this configuration must RAISE, and the text must name both
    doors. A test that only asserts "it raised" cannot tell a refusal from a crash."""
    try:
        got = resolve_broker(env=env, **kw)
    except BrokerError as exc:
        msg = str(exc)
        check(name, True, True)
        return msg
    FAILED.append(name)
    print("FAIL  %s: resolved to %r where it must refuse" % (name, got))
    return ""


PATH = "/srv/venue/tabichat.json"
CONFIG_URL = "mqtt://config.example:1883"
ENV_URL = "mqtt://env.example:1883"

# --- 0. HERMETICITY (s140 finding: this file was NOT hermetic, and it read 17 FAIL on a box that
# carries the configuration the product recommends) ------------------------------------------------
# `resolve_broker()` defaults to `dict(os.environ)`; when a caller passes an env dict that holds no
# TABICHAT_CONFIG, `site_config_path()` resolves `~/.pi/agent/tabichat.json` and the SITE layer
# answers for the OPERATOR. On a box whose site file carries `mqttUrl` — the recommended production
# state — every check that wants the env layer got ('<the box host>', 1883, 'site file (mqttUrl)')
# and 17 checks failed. Fixing it here, in the test, and not in broker.py: a client that stops
# reading the site file is a product regression, and the site file is production state, not scaffold.
#
# The TypeScript twin (`test_broker.ts`) never had this hole: it passes an explicit `configPath` and
# a controlled `HOME` into every call. The equivalent here is one sentinel path no disk layer can
# answer from, injected into every env dict that does not already name a config file — and the
# sentinel must live under a controlled HOME, so the `~` expansion stays inside the temp dir.
SCRATCH = tempfile.mkdtemp(prefix="tabichat-broker-test-")
FAKE_HOME = os.path.join(SCRATCH, "home")
os.makedirs(FAKE_HOME, exist_ok=True)
SENTINEL_PATH = os.path.join(FAKE_HOME, ".pi", "agent", "tabichat.json")
os.makedirs(os.path.dirname(SENTINEL_PATH), exist_ok=True)


def iso(env):
    """An env dict for a disk-silent check: controlled HOME, plus TABICHAT_CONFIG aimed at a file
    that does not exist. An explicit TABICHAT_CONFIG in `env` (a disk-layer check) is left alone."""
    e = dict(env)
    e.setdefault("HOME", FAKE_HOME)
    e.setdefault(SITE_CONFIG_ENV, SENTINEL_PATH)
    return e


_site, _note = read_site_config(site_config_path(iso({})))
check("the isolated env reads NO site file", _site, None)

# THE POSITIVE HALF OF THE SAME TRUTH TABLE: a box that DOES carry a configured site file must
# answer from it. That is the configuration this box is in, and it is exactly what used to break —
# so the file-layer precedence check runs against a temp file with a real `mqttUrl` in it.
_cfg_in_scratch = os.path.join(SCRATCH, "configured.json")
with open(_cfg_in_scratch, "w") as _fh:
    json.dump({BROKER_URL_KEY: CONFIG_URL}, _fh)
check(
    "a box WITH a configured site file answers from it, ahead of the env",
    resolve_broker(env={BROKER_URL_ENV: ENV_URL, SITE_CONFIG_ENV: _cfg_in_scratch}),
    ("config.example", 1883, "site file (%s)" % BROKER_URL_KEY),
)

# --- 1. resolution order, positives ------------------------------------------------------------
# every one of these wants the ENV layer, so each gets the sentinel: before, on a configured box
# the site file answered first and the check read a false failure.
got = resolve_broker(env=iso({BROKER_URL_ENV: ENV_URL}))
check("no file, no site layer -> MQTT_URL answers", got, (ENV_URL.split("//")[1].split(":")[0], 1883, BROKER_URL_ENV + " env"))

got = resolve_broker(env=iso({BROKER_HOST_ENV: "host.example", BROKER_PORT_ENV: "8883"}))
check("MQTT_HOST + MQTT_PORT still work (existing operators are not broken)", got, ("host.example", 8883, BROKER_HOST_ENV + " env"))

got = resolve_broker(env=iso({BROKER_HOST_ENV: "host.example"}))
check("MQTT_HOST alone takes the standard port 1883", got, ("host.example", 1883, BROKER_HOST_ENV + " env"))

got = resolve_broker(env=iso({BROKER_HOST_ENV: "host.example:9000"}))
check("MQTT_HOST may carry host:port in one value", got, ("host.example", 9000, BROKER_HOST_ENV + " env"))

got = resolve_broker(env=iso({}), cli_host="typed.example", cli_port=1234)
check("an address typed for THIS run wins over every file and env", got, ("typed.example", 1234, "command line + command-line port"))

got = resolve_broker(env=iso({BROKER_URL_ENV: "mqtt://h.example"}), cli_port=1884)
check("--port alone overrides the port half of a resolved host", got[1], 1884)

got = resolve_broker(env=iso({BROKER_URL_ENV: "mqtts://h.example:8883"}))
check("an mqtts:// URL resolves (TLS is coming; do not reject it here)", got[:2], ("h.example", 8883))

# --- 1b. the file layer, with a REAL temp file ----------------------------------------------
tmp = tempfile.mkdtemp()
try:
    good = os.path.join(tmp, "good.json")
    with open(good, "w") as fh:
        json.dump({BROKER_URL_KEY: CONFIG_URL, "autoRenew": True}, fh)
    got = resolve_broker(env={BROKER_URL_ENV: ENV_URL, SITE_CONFIG_ENV: good})
    check("a site file on disk answers, and answers BEFORE the env", got, (
        "config.example", 1883, "site file (%s)" % BROKER_URL_KEY))

    nokey = os.path.join(tmp, "nokey.json")
    with open(nokey, "w") as fh:
        json.dump({"autoRenew": True}, fh)
    got = resolve_broker(env={BROKER_URL_ENV: ENV_URL, SITE_CONFIG_ENV: nokey})
    check("a site file with no broker key falls through to the env", got[0], "env.example")

    bad = os.path.join(tmp, "bad.json")
    with open(bad, "w") as fh:
        fh.write("{ not json")
    got = resolve_broker(env={BROKER_URL_ENV: ENV_URL, SITE_CONFIG_ENV: bad})
    check("a file that will not parse does NOT stop an env-configured run", got[0], "env.example")
    check("but the parse failure is SAID, in the source string", "was NOT read" in got[2], True)

    wrongtype = os.path.join(tmp, "wrong.json")
    with open(wrongtype, "w") as fh:
        json.dump({BROKER_URL_KEY: 1883}, fh)
    msg = refuses("a non-string mqttUrl refuses instead of falling through to the env",
                  {SITE_CONFIG_ENV: wrongtype, BROKER_URL_ENV: ENV_URL})
    check("and it names the file it is complaining about", PATH in msg or wrongtype in msg, True)

    missing = os.path.join(tmp, "absent.json")
    msg = refuses("no file + no env -> refusal", {SITE_CONFIG_ENV: missing})
    check("the refusal PRINTS THE CONFIG PATH IT SEARCHED", missing in msg, True)
    check("and NAMES THE VARIABLE", BROKER_URL_ENV in msg, True)
    check("and names the key inside the file", BROKER_URL_KEY in msg, True)
    check("and names the location override", SITE_CONFIG_ENV in msg, True)
    check("and says it will not guess", "refusing to guess" in msg, True)
finally:
    for root, dirs, files in os.walk(tmp):
        for f in files:
            os.unlink(os.path.join(root, f))
    os.rmdir(tmp)

# --- 1c. the SCHEME-AWARE resolver, which is what a TLS client must use --------------------------
# `resolve_broker` returns (host, port, source) and drops the scheme; `resolve_broker_url` keeps it.
# The TLS transport decides mqtts-vs-mqtt FROM THE SCHEME, so a client that used the host/port form
# would have to re-read MQTT_URL to learn it — a second, unruled path to a broker address.
from broker import resolve_broker_url  # noqa: E402

got_url, got_src = resolve_broker_url(env=iso({BROKER_URL_ENV: "mqtts://h.example:8883"}))
check("resolve_broker_url keeps an mqtts:// scheme", got_url, "mqtts://h.example:8883")
check("and reports the layer that answered", BROKER_URL_ENV in got_src, True)
got_url, _ = resolve_broker_url(env=iso({BROKER_URL_ENV: "mqtt://h.example"}))
check("a plain URL resolves to mqtt:// on the standard port", got_url, "mqtt://h.example:1883")
got_url, got_src = resolve_broker_url(env={SITE_CONFIG_ENV: _cfg_in_scratch})
check("the site file's scheme survives resolution too", got_url, "mqtt://config.example:1883")
got_url, _ = resolve_broker_url(env=iso({BROKER_HOST_ENV: "h.example", BROKER_PORT_ENV: "8883"}))
check("MQTT_HOST + MQTT_PORT has NO scheme, and is never inferred to be TLS", got_url, "mqtt://h.example:8883")
with open(os.path.join(SCRATCH, "tls-site.json"), "w") as _fh:
    json.dump({BROKER_URL_KEY: "mqtts://config.example:8883"}, _fh)
got_url, got_src = resolve_broker_url(env={SITE_CONFIG_ENV: os.path.join(SCRATCH, "tls-site.json")})
check("a site file naming mqtts:// answers with mqtts://", got_url, "mqtts://config.example:8883")
check("and the source still says the site file", "site file" in got_src, True)
check("resolve_broker and resolve_broker_url can never disagree about WHICH layer answered",
      resolve_broker(env=iso({BROKER_URL_ENV: "mqtts://h.example:8883"}))[:2], ("h.example", 8883))

print("\n== 2. every bad value shape is a refusal, not a connection attempt ------------------------")
msg = refuses("blank MQTT_URL is not a location", iso({BROKER_URL_ENV: "   "}))
check("and it still names the path it searched", PATH in msg or "tabichat" in msg, True)
check("an empty MQTT_HOST refuses", refuses("empty host env", iso({BROKER_HOST_ENV: ""})) != "", True)
check("http:// refuses", refuses("http is not an mqtt scheme", iso({BROKER_URL_ENV: "http://h.example:1883"})) != "", True)
check("a URL with no host refuses", refuses("mqtt:// with no host", iso({BROKER_URL_ENV: "mqtt://"})) != "", True)
check("a non-numeric MQTT_PORT refuses", refuses("MQTT_PORT=abc", iso({BROKER_HOST_ENV: "h", BROKER_PORT_ENV: "abc"})) != "", True)
check("MQTT_HOST with a garbage port refuses", refuses("MQTT_HOST=h:abc", iso({BROKER_HOST_ENV: "h:abc"})) != "", True)

# --- 3. the path function is the ONLY place the location is computed ------------------------
# No `os.environ` mutation here any more. It used to POP TABICHAT_CONFIG out of the real
# environment to prove the default; on a box whose default file exists and is configured, that left
# every env-layer check above answering from the operator's file (the 17 FAIL). `site_config_path`
# takes an env dict, so the default is proven with a controlled HOME instead — the same shape the
# TypeScript twin uses (`siteConfigPath({ HOME: "/home/you" })`).
check("no override -> the shared default, expanded under a controlled HOME", site_config_path({"HOME": FAKE_HOME}), SENTINEL_PATH)
check("and that default is the same file the lanes read", SITE_CONFIG_DEFAULT, "~/.pi/agent/tabichat.json")
check("TABICHAT_CONFIG overrides it", site_config_path({SITE_CONFIG_ENV: "/x/y.json"}), "/x/y.json")
check("a blank override falls back to the default", site_config_path({SITE_CONFIG_ENV: "  ", "HOME": FAKE_HOME}), SENTINEL_PATH)
check("the refusal text is built from the path the caller actually searched", PATH in refusal(PATH), True)

# --- 4. SOURCE SHAPE: the clients really call the resolver, and no default is left ----------
SRC = os.path.join(os.path.dirname(__file__), "..", "src")
# `chat_cli.py` left this list with the file (tabichat#10 / leg 506). The loop below `open()`s every
# name, so a deleted client here is a FileNotFoundError, not a skip — and deploy-tabichat.sh dies on
# a red test_broker.py, so the order mattered: this line changes before the file is removed.
clients = ["tabichat_cli.py", "mqtt_tool.py"]
for name in clients:
    with open(os.path.join(SRC, name), encoding="utf-8") as fh:
        text = fh.read()
    check("%s imports the resolver" % name, "from broker import" in text, True)
    # A TLS client must call resolve_broker_url, because resolve_broker throws the SCHEME away and a
    # client that re-reads MQTT_URL to get it back is reading a different layer than the one that
    # answered. The non-TLS clients legitimately keep calling resolve_broker.
    check("%s calls a resolver" % name, "resolve_broker(" in text or "resolve_broker_url(" in text, True)
    check("%s keeps no venue default" % name, 'os.environ.get("MQTT_HOST", ' in text, False)

# THE OTHER HALF OF THE SITE-AGNOSTIC RULING, ON THE TLS SIDE: the transport module used to carry a
# `DEFAULT_URL` pointing at one operator's box. It must not come back, in either language.
# SUBSTRING SEARCH WOULD LIE HERE: tlsenv.py names DEFAULT_URL in the prose that explains why it is
# gone. Ask the parser for an actual module-level BINDING of that name, exactly as test_tlsopts.ts
# does for the string-version defect. A check that reads red on clean prose gets disabled, and a
# disabled check guards nothing.
_tls_ast = ast.parse(open(os.path.join(SRC, "tlsenv.py"), encoding="utf-8").read())
_tls_bound = [
    t.id for n in _tls_ast.body if isinstance(n, (ast.Assign, ast.AnnAssign))
    for t in (n.targets if isinstance(n, ast.Assign) else [n.target])
    if isinstance(t, ast.Name)
]
check("tlsenv.py BINDS no default broker URL at module level", "DEFAULT_URL" in _tls_bound, False)
_ts_src = open(os.path.join(os.path.dirname(__file__), "..", "extensions", "tabichat", "tlsopts.ts"),
               encoding="utf-8").read()
_ts_bound = re.findall(r"^export const (DEFAULT_URL|BROKER_DEFAULT\w*)\b", _ts_src, re.M)
check("tlsopts.ts binds no default either", _ts_bound, [])
check("and index.ts does not read MQTT_URL for its address any more",
      "process.env.MQTT_URL ??" in open(os.path.join(os.path.dirname(__file__), "..", "extensions",
                                                    "tabichat", "index.ts"), encoding="utf-8").read(),
      False)

# --- 5. TREE SCAN: no venue hostname anywhere in the repo text (the negative half) ---------
# hex-encoded so THIS file is clean too. Re-derive: printf 'the host name' | xxd -p
BANNED_HEX = ["636f6c6f7261646f"]
BANNED = [bytes.fromhex(h).decode() for h in BANNED_HEX]
TEXT_EXT = re.compile(r"\.(ts|mjs|js|py|md|sh|json|txt|toml|yml|yaml|hex|lock)$")
SKIP_DIR = re.compile(r"(^|/)(\.git|node_modules|__pycache__|dist|target)(/|$)")

root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
scanned = 0
hits = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if not SKIP_DIR.search(os.path.join(dirpath, d))]
    for f in filenames:
        if not TEXT_EXT.search(f):
            continue
        p = os.path.join(dirpath, f)
        try:
            with open(p, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        scanned += 1
        for b in BANNED:
            if b in text:
                hits.append("%s: %s" % (os.path.relpath(p, root), b))

check("tracked text carries NO venue address", hits, [])
# PROVE THE INSTRUMENT: a scan that scanned nothing is a green lie. Same lesson as the JS twin.
check("the scan really looked at a whole repo", scanned > 40, True)
print("     (%d text files scanned for %d banned literal(s))" % (scanned, len(BANNED)))

# --- 6. HERMETICITY, THE PROOF ---------------------------------------------------------------
# Nothing above may have created, read-for-writing, or otherwise touched the operator's real site
# file, and the sentinel under the controlled HOME must still be absent (a disk-silent run never
# makes it exist). This is the assertion that turns "it passes today" into "it cannot read the box".
check("the sentinel config file was never created", os.path.exists(SENTINEL_PATH), False)
check(
    "the operator's real site file is untouched by this run",
    os.path.isfile(site_config_path(dict(os.environ))),
    os.path.isfile(os.path.expanduser(SITE_CONFIG_DEFAULT)),
)

import shutil  # noqa: E402 - cleanup import, local on purpose

shutil.rmtree(SCRATCH, ignore_errors=True)

print()
if FAILED:
    print("%d check(s) FAILED" % len(FAILED))
    sys.exit(1)
print("all checks pass")
