// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// persistent room tap: bun tools/tap.mjs — appends chat/<room> messages to
// /tmp/opencode/lead.tap forever (my lead-agent ears during testing).
// TAB_TAP=<path> redirects the file; /tmp is temporary and /tmp/opencode is abandoned (2026-10-06),
// so point it at the workspace for anything you need to keep.
//
// The message handler is registered ONCE, at top level. Registering it inside the `connect`
// handler added a fresh handler on every reconnect, so every room line was appended once per
// handler — same text, same timestamp, N entries, which is what read as "duplicate lines in the
// room" on 2026-10-07. Ids are deduped through the same helper the lanes use, so a replayed or
// retained copy cannot be appended twice either.
import fs from "fs";
import mqtt from "mqtt";
import { noteRoomId } from "../extensions/tabichat/roommsg.ts";
import { resolveBrokerFromDisk } from "../extensions/tabichat/broker.ts";

// BROKER LOCATION: site config "mqttUrl" → MQTT_URL → REFUSE (exit 2, names both doors). No shipped
// default — site-agnostic by design. The rule lives in ../extensions/tabichat/broker.ts.
const broker = resolveBrokerFromDisk();
if (!broker.ok) {
  console.error(broker.message);
  process.exit(2);
}
if (broker.note) console.error(`[tabichat] ${broker.note} — it may hold the setting you meant.`);

const out = process.env.TAB_TAP ?? "/tmp/opencode/lead.tap";
fs.appendFileSync(out, "--- tap start " + new Date().toISOString() + "\n");
let seen = [];
const c = mqtt.connect(broker.url);

c.on("message", (t, p) => {
  const text = p.toString();
  let id;
  try {
    id = JSON.parse(text).id;
  } catch {}
  const d = noteRoomId(seen, id);
  if (d.dup) return;
  seen = d.seen;
  fs.appendFileSync(out, `${new Date().toISOString().slice(11, 19)} ${text}\n`);
});

c.on("connect", () => c.subscribe(`chat/${process.env.MQTT_ROOM ?? "tabith"}`));
