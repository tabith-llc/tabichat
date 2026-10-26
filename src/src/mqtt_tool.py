#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Manual send to the chat topic — a mosquitto_pub-equivalent. One-shot, no daemon.

Usage:
    mqtt_tool.py --nick=owner <message...>     # explicit nick (recommended)
    mqtt_tool.py <message...>                 # nick from env chat_nick/irc_nick, else "owner"
Env: MQTT_URL (or MQTT_HOST + MQTT_PORT) — REQUIRED, there is no shipped broker address; the
     site config key "mqttUrl" answers first. See broker.py beside this file for the order and the
     refusal. MQTT_TOPIC (default chat/tabith).
"""

import json
import os
import re
import sys

import paho.mqtt.client as mqtt

from broker import BrokerError, resolve_broker_url
from tlsenv import TransportBlocked, TransportRefusal, apply_to_client, transport_kwargs

# Transport comes from the RESOLVED broker location (site file `mqttUrl` → MQTT_URL →
# MQTT_HOST/MQTT_PORT → REFUSE) — never from a second read of MQTT_URL and never from a shipped
# default. A refusal is fatal at start: this tool publishes into
# the room, so a plaintext fall back would be a secret leak that reports success (the print below
# says "Sent as"), and a default would be a guess about a venue this repo does not know.
PLAN = None
try:
    BROKER_URL, BROKER_SOURCE = resolve_broker_url()
    PLAN = transport_kwargs(BROKER_URL)
except (BrokerError, TransportRefusal, TransportBlocked) as e:
    print(f"mqtt_tool: refusing to send — {e}", file=sys.stderr)
    raise SystemExit(1)

for _w in PLAN["warnings"]:
    print(f"mqtt_tool: {_w}", file=sys.stderr)
TOPIC = os.environ.get("MQTT_TOPIC", "chat/tabith")


def clean(nick):
    return re.sub(r"[^a-zA-Z0-9_\-]", "", nick)[:20] or "owner"


def main():
    nick = None
    msg = []
    a = sys.argv[1:]
    while a:
        x = a.pop(0)
        if x.startswith("--nick="):
            nick = x.split("=", 1)[1]
        elif x == "send":
            continue
        elif x in ("-h", "--help"):
            print(__doc__.strip())
            return 0
        else:
            msg.append(x)

    if nick is None:
        nick = os.environ.get("chat_nick") or os.environ.get("irc_nick") or os.environ.get("USER") or "owner"
    nick = clean(nick)
    message = " ".join(msg).strip()
    if not message:
        print("Usage: mqtt_tool.py [--nick=<nick>] <message...>", file=sys.stderr)
        return 1

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{nick}-tool")
    try:
        # ONE-SHOT PUBLISHER, so "must be set" is a hard stop: no address configured -> the reason
        # goes to stderr and the exit code is 1. It never guesses a host and never says "Sent".
        # The TLS plan is applied BEFORE connect, and a plan that cannot be applied raises rather
        # than connecting bare — the socket is never given a chance to downgrade.
        apply_to_client(client, PLAN)
        client.connect(PLAN["host"], PLAN["port"], keepalive=15)
        client.loop_start()
        info = client.publish(TOPIC, json.dumps({"nick": nick, "message": message}))
        info.wait_for_publish(timeout=5)
        client.loop_stop()
        print(f"Sent as {nick} to {TOPIC} (broker {PLAN['host']}:{PLAN['port']}, from {BROKER_SOURCE}, transport={'TLS' if PLAN['tls'] else 'plaintext'}).")
        return 0
    except BrokerError as e:
        print(f"{e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Send failed: {e}", file=sys.stderr)
        return 1
    finally:
        try:
            client.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
