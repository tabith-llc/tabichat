// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// one-shot chat publisher: bun tools/pub.mjs <nick> <message...>
// run with cwd = a dir whose node_modules has `mqtt` (e.g. ~/.pi/agent/extensions/tabichat)
//
// BROKER LOCATION: site config "mqttUrl" → MQTT_URL → REFUSE (exit 2, message names both doors).
// There is no shipped default (site-agnostic by design: "no default, must be set"), and the
// decision itself lives in ../extensions/tabichat/broker.ts so this tool and the lanes cannot drift.
import mqtt from "mqtt";
import { resolveBrokerFromDisk } from "../extensions/tabichat/broker.ts";

const broker = resolveBrokerFromDisk();
if (!broker.ok) {
  console.error(broker.message);
  process.exit(2);
}
const [nick, ...rest] = process.argv.slice(2);
const c = mqtt.connect(broker.url);
c.on("connect", () => {
  c.publish(
    `chat/${process.env.MQTT_ROOM ?? "tabith"}`,
    JSON.stringify({ nick, message: rest.join(" ") }),
  );
  setTimeout(() => c.end(true), 300);
});
