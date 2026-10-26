// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// room tap: bun tools/sub.mjs [seconds] — prints chat/<room> messages
//
// The message handler is registered ONCE, at top level. Registering it inside the `connect`
// handler added a fresh handler on every reconnect, so one message printed once per handler —
// same text, same timestamp, N copies. That is the duplicate-room-line defect the owner reported
// on 2026-10-07; the lanes never had it, because the extension registers its handler outside
// `connect`. Payload ids are additionally deduped through the same helper the lanes use, so a
// replayed or retained copy cannot print twice either.
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

let seen = [];
const c = mqtt.connect(broker.url);

c.on("message", (_t, p) => {
  const text = p.toString();
  let id;
  try {
    id = JSON.parse(text).id;
  } catch {}
  const d = noteRoomId(seen, id);
  if (d.dup) return;
  seen = d.seen;
  console.log(text);
});

c.on("connect", () => c.subscribe(`chat/${process.env.MQTT_ROOM ?? "tabith"}`));
setTimeout(() => process.exit(0), (Number(process.argv[2]) || 10) * 1000);
