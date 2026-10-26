#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""BROKER LOCATION — tabichat is SITE-AGNOSTIC.

The requirement, in two parts:
    "tabichat repo needs to be made site agnostic. 1. no default, must be set."
and its refinement:
    "the code needs to be updated so the mqtt url can be set in a config, not hardcoded. 1. ok"

THE STEPS, AND NO STEP THAT GUESSES A HOST — the same order the TypeScript side runs
(`src/extensions/tabichat/broker.ts`, and the `preview-ext` twin of it):

    1. a host:port given to THIS process (`--host`/`--port`, or the `/connect <host:port>` command)
       — an address the operator typed for this run is never overridden by a file;
    2. the site config file, key ``mqttUrl`` (the file the site-config layer already put in place for
       site-wide policy; ``TABICHAT_CONFIG`` moves it, and ``site_config_path()`` is the ONLY
       function that knows where it lives, so a change to the location is one edit here);
    3. the environment: ``MQTT_URL`` (a full ``mqtt://host:port`` URL, what the lanes read), or the
       older ``MQTT_HOST`` plus optional ``MQTT_PORT`` (what these clients have always read);
    4. REFUSE — loudly, non-zero for one-shot callers, naming BOTH the config path searched and the
       variables wanted.

Nothing in this repo ships a broker address any more: not as a default, not in prose, not as an
example. 1883 stays as the default PORT because it is the IANA MQTT port, not a venue value.
"""

import json
import os
from urllib.parse import urlparse

BROKER_URL_ENV = "MQTT_URL"
BROKER_HOST_ENV = "MQTT_HOST"
BROKER_PORT_ENV = "MQTT_PORT"
BROKER_URL_KEY = "mqttUrl"
SITE_CONFIG_ENV = "TABICHAT_CONFIG"
SITE_CONFIG_DEFAULT = "~/.pi/agent/tabichat.json"

DEFAULT_PORT = 1883
VALID_SCHEMES = ("mqtt", "mqtts", "ws", "wss")


class BrokerError(Exception):
    """A broker location that is missing or unusable. `str()` is the text to show the operator."""


def site_config_path(env=None):
    """THE ONE FUNCTION THAT KNOWS WHERE THE SITE CONFIG LIVES.

    ``TABICHAT_CONFIG`` overrides; otherwise the shared default. A leading ``~`` expands against
    the ``HOME`` IN THE ENVIRONMENT THE CALLER PASSED IN, the same way ``siteConfigPath`` in
    ``broker.ts`` does it (``env.HOME``), and the same way index.ts resolves the same file for the
    renew policy. ``os.path.expanduser`` is NOT used because it reads the PROCESS environment and
    would silently ignore a caller-supplied dict — which is exactly the hole that made the broker
    test read the operator's real site file. Rename the location once and this
    function plus the docs sentence is the whole change — no client repeats the arithmetic.
    """
    e = os.environ if env is None else env
    raw = (e.get(SITE_CONFIG_ENV) or "").strip() or SITE_CONFIG_DEFAULT
    home = e.get("HOME") or os.path.expanduser("~")
    if raw == "~" or raw.startswith("~/"):
        return os.path.join(home, raw[2:]) if len(raw) > 2 else home
    return os.path.expanduser(raw)


def refusal(config_path):
    """The refusal, naming every door an operator can open. One source, so docs can match it."""
    return (
        "no broker configured — refusing to guess one. Set \"%s\" in the site config I searched at "
        "%s (override its location with %s), or export %s=mqtt://<your-broker-host>:1883 "
        "(%s + %s also work). tabichat ships no broker address: it is a chat client, not an MQTT "
        "service, so the address is yours to configure."
        % (BROKER_URL_KEY, config_path, SITE_CONFIG_ENV, BROKER_URL_ENV, BROKER_HOST_ENV, BROKER_PORT_ENV)
    )


def read_site_config(config_path):
    """Return ``(site_value, note)``.

    No file at all is the normal case on a box that never configured one: silent, ``None``.
    A file that exists and will not parse is a POLICY FAILURE: it is reported in ``note`` and the
    caller says it out loud — a silently ignored config file is how a box stops agreeing with
    itself, which is the same reason index.ts prints its ``siteConfigNote``.
    """
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        return None, ""
    except OSError as exc:
        return None, "site config %s could not be read (%s)" % (config_path, exc)
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        return None, "site config %s was NOT read (not valid JSON: %s)" % (config_path, exc)
    if not isinstance(parsed, dict):
        return None, "site config %s was NOT read (top level is not a JSON object)" % config_path
    return parsed.get(BROKER_URL_KEY), ""


def split_url(url, where):
    """``mqtt://host[:port]`` → ``(host, port)``. Every rejection says WHERE the value came from."""
    text = (url or "").strip()
    if text == "":
        raise BrokerError("%s is set but blank — a blank location is not a location" % where)
    try:
        parts = urlparse(text)
    except ValueError as exc:
        raise BrokerError("%s = \"%s\" is not a URL I can parse (%s)" % (where, text, exc))
    if parts.scheme not in VALID_SCHEMES:
        raise BrokerError(
            "%s = \"%s\" uses scheme \"%s\", which no MQTT client speaks; expected one of %s"
            % (where, text, parts.scheme or "none", ", ".join(VALID_SCHEMES))
        )
    if not parts.hostname:
        raise BrokerError("%s = \"%s\" carries no host name" % (where, text))
    return parts.hostname, parts.port or DEFAULT_PORT


def resolve_broker(env=None, cli_host=None, cli_port=None):
    """Resolve ``(host, port, source)`` in the order documented at the top of this file.

    Raises ``BrokerError`` with the operator-facing text when nothing was configured, and when a
    layer that IS configured holds something unusable — a broken value never falls through quietly.
    """
    host, port, source, _scheme = _resolve_full(env, cli_host)
    # an explicit --port is an operator's word about the PORT, and it wins over whatever the host
    # half came from — otherwise `--port 1884` with a configured host would silently stay 1883.
    if cli_port:
        port = int(cli_port)
        source = f"{source} + command-line port"
    return host, port, source


def resolve_broker_url(env=None, cli_host=None, cli_port=None):
    """Resolve ``(url, source)`` — the SAME resolution as ``resolve_broker``, with the SCHEME kept.

    Why a second entry point exists: the TLS transport (``tlsenv.py``, and ``tlsopts.ts`` on the
    agent side) decides ``mqtts://`` versus ``mqtt://`` FROM THE SCHEME, and ``resolve_broker``
    returns ``(host, port, source)`` with the scheme thrown away. A TLS client that re-reads
    ``MQTT_URL`` itself would be reading a DIFFERENT layer than the one that answered — on a box
    whose site file configures the broker, that is a second, unruled path to a broker address. So
    the scheme is carried here, and every client that needs TLS resolves through this one function.

    A source with no scheme at all (``MQTT_HOST`` / ``MQTT_PORT``, or a ``--host`` typed for this
    run) is plaintext ``mqtt://`` — the scheme is never inferred from a port number, because a
    guess that turns on TLS silently is the silent-downgrade class wearing the other hat.
    """
    host, port, source, scheme = _resolve_full(env, cli_host)
    if cli_port:
        port = int(cli_port)
        source = f"{source} + command-line port"
    return f"{scheme}://{host}:{port}", source


def _scheme_of(raw, default="mqtt"):
    """The scheme half of a configured value, lower-cased, or the default. No validation here —
    ``split_url`` owns rejecting an unusable scheme; this only remembers which one answered."""
    text = (raw or "").strip()
    if "://" in text:
        return text.split("://", 1)[0].lower()
    return default


def _resolve_full(env=None, cli_host=None):
    """``(host, port, source, scheme)``. The single body ``resolve_broker`` and
    ``resolve_broker_url`` share, so the two can never disagree about which layer answered."""
    e = dict(os.environ) if env is None else env
    config_path = site_config_path(e)

    if cli_host:
        return cli_host, DEFAULT_PORT, "command line", "mqtt"

    site, note = read_site_config(config_path)
    if site is not None:
        if not isinstance(site, str):
            raise BrokerError(
                "refusing to connect: \"%s\" in the site config %s is not a URL string. Fix the file "
                "or delete the key; I will not fall through to another layer while my own config is "
                "broken. %s" % (BROKER_URL_KEY, config_path, refusal(config_path))
            )
        host, port = split_url(site, "site config %s -> \"%s\"" % (config_path, BROKER_URL_KEY))
        return host, port, ("site file (%s)%s" % (BROKER_URL_KEY, "; " + note if note else "")), _scheme_of(site)

    url_env = (e.get(BROKER_URL_ENV) or "").strip()
    if url_env:
        host, port = split_url(url_env, "%s env" % BROKER_URL_ENV)
        return host, port, "%s env%s" % (BROKER_URL_ENV, "; " + note if note else ""), _scheme_of(url_env)

    host_env = (e.get(BROKER_HOST_ENV) or "").strip()
    if host_env:
        # a bare host, or the "host:port" form a shell may carry; never a URL here
        if "://" in host_env:
            host, port = split_url(host_env, "%s env" % BROKER_HOST_ENV)
            return host, port, "%s env%s" % (BROKER_HOST_ENV, "; " + note if note else ""), _scheme_of(host_env)
        if ":" in host_env:
            host, _, maybe_port = host_env.partition(":")
            try:
                port = int(maybe_port)
            except ValueError:
                raise BrokerError(
                    "%s = \"%s\" has a port half that is not a number" % (BROKER_HOST_ENV, host_env)
                )
            return host, port, "%s env%s" % (BROKER_HOST_ENV, "; " + note if note else ""), "mqtt"
        raw_port = (e.get(BROKER_PORT_ENV) or "").strip()
        if raw_port == "":
            port = DEFAULT_PORT
        else:
            try:
                port = int(raw_port)
            except ValueError:
                raise BrokerError("%s = \"%s\" is not a port number" % (BROKER_PORT_ENV, raw_port))
        return host_env, port, "%s env%s" % (BROKER_HOST_ENV, "; " + note if note else ""), "mqtt"

    raise BrokerError(refusal(config_path) + (" (%s)" % note if note else ""))
