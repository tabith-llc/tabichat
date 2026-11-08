// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * leg 1123 — PHYSICAL proof on the throwaway loopback fixture: a line built the way the renew handler
 * builds its lead hold crosses a REAL broker, is heard by a REAL peer, and comes back to its own
 * publisher with the id the ack watch is keyed on — so the watch that leg 1123 arms on the hold is
 * settled by that echo and never ages out as a false alarm about a line every peer read.
 *   bun src/tools/test_hold_journal_broker.ts      (exit 1 on a failure; rc 0 with NOT RUN when the
 *   fixture cannot start — no docker on a host is a host shape, never a product verdict)
 *
 * WHY THIS FILE SITS BESIDE tools/test_hold_journal.ts rather than replacing it. The two measure
 * different halves of one claim, and neither can see the other's:
 *   - `test_hold_journal.ts` mounts the SHIPPED entry and drives the SHIPPED `/renew` handler against
 *     a stub socket and a REAL journal file. That is the only way to prove the handler now writes the
 *     author's own `dir=out` row, and that a refused publish writes nothing.
 *   - a mount cannot do the broker half in the same process: `index.ts` keeps its socket in a
 *     process-wide store (`laneadmin.ts:MQTT_CLIENT_KEY`) and every `session_start` force-closes what
 *     the prior run held, so a second mount would KILL the first seat's connection. Two real lanes are
 *     two processes; this harness is one.
 * So this file asks the broker the questions a stub cannot answer: does the hold's shape ACTUALLY
 * arrive at a peer, and does the publisher's OWN subscription get it back with the payload id intact —
 * the one fact `settleAck` needs and the fact `test_hold_journal.ts` cannot observe because its socket
 * is a stub that echoes nothing.
 *
 * WHAT IS SHIPPED HERE and what is a driver. The bytes on the wire are built by the shipped builders,
 * the same two calls the renew handler makes: `laneadmin.ts:leadHoldLine()` for the text and
 * `roommsg.ts:roomPayload()` for the payload, with an id from the shipped `msgId` shape. The client is
 * a plain authenticated mqtt.js connection standing in for the lane, because the lane's own socket is
 * the thing under test, not its plumbing. `settleAck`/`watchAck` are the shipped deciders. NOT RUN on
 * the peer's journal: writing a row is `index.ts`'s act, measured in the other file.
 *
 * NOTHING HERE PRINTS A CERTIFICATE OR A KEY. Paths are handed to mqtt.js and read into its options,
 * never echoed — key material does not leave the guest and is never pasted into a log.
 *
 * BOUNDED, AND ONLY EVER OURS: `broker-fixture.sh` on 127.0.0.1, a port the fixture chose, a per-owner
 * state record, teardown on every exit path including a throw. No live broker is contacted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mqtt from "mqtt";
import { leadHoldLine } from "../extensions/tabichat/laneadmin.ts";
import { ackWatchKey, bootTag, msgId, msgTopic, roomPayload, settleAck, watchAck } from "../extensions/tabichat/roommsg.ts";

const REPO = join(import.meta.dirname, "..", "..");
const FIXTURE_OWNER = `hold-journal-${process.pid}`;
// The fixture mints a client pair per named nick, and the phase-1 ACL keys its grants on those names,
// so the pair is DECLARED here rather than inherited from a site-neutral default.
const LEAD = "lane11";
const PEER = "lane6";
const sh = (args: string[]) => {
  const r = spawnSync("sh", args, {
    encoding:  "utf8",
    cwd: REPO,
    env: { ...process.env, TABICHAT_FIXTURE_OWNER: FIXTURE_OWNER, TABICHAT_FIXTURE_NICKS: `${LEAD} ${PEER}` },
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
};
const envOf = (h: string, k: string) => new RegExp(`${k}=(.*)`).exec(h)?.[1]?.trim() ?? "";
const teardown = () => sh(["src/tools/broker-fixture.sh", "down"]);
process.on("exit", teardown);

let failed = 0;
let okCount = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { failed++; console.log(`FAIL  ${name}: got ${g}, want ${w}`); }
  else { okCount++; console.log(`ok    ${name}: ${g}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const up = sh(["src/tools/broker-fixture.sh", "up", "phase1"]);
if (!up.includes("FIXTURE_PORT=")) {
  console.log("NOT RUN — the phase-1 fixture did not start, so no broker cell was executed. Its words:");
  console.log(up);
  // NOT RUN is not a pass and not a failure of the product: it says the host has no docker or the
  // image could not be pulled. Exit 0 because `--physical` treats an unavailable host as a skip it has
  // already printed, exactly as the sibling physical gates do.
  process.exitCode = 0;
  throw new Error("STOP-NOT-RUN");
}
const DIR = envOf(up, "FIXTURE_DIR");
const PORT = envOf(up, "FIXTURE_PORT");
const ROOM = envOf(up, "FIXTURE_ROOM");
const ROOM_TOPIC = `chat/${ROOM}`;
const URL = `mqtts://127.0.0.1:${PORT}`;
const CA = join(DIR, "pki/ca/ca.crt");
if (!existsSync(CA)) {
  console.log(`NOT RUN — the fixture tree vanished after start (${DIR})`);
  process.exitCode = 0;
  throw new Error("STOP-NOT-RUN");
}
const pairOf = (n: string) => {
  const c = join(DIR, `pki/clients/${n}/cert.pem`);
  const k = join(DIR, `pki/clients/${n}/key.pem`);
  if (!existsSync(c) || !existsSync(k)) throw new Error(`the fixture minted no client pair for "${n}" — ask for it in TABICHAT_FIXTURE_NICKS, do not debug the broker`);
  return { c, k };
};
const LEAD_PAIR = pairOf(LEAD);
const PEER_PAIR = pairOf(PEER);
const SCRATCH = mkdtempSync(join(tmpdir(), "leg1123-broker-"));

const conn = (n: string, p: { c: string; k: string }) =>
  new Promise<mqtt.MqttClient>((res, rej) => {
    // The options the sibling physical gate uses on this fixture, unchanged: a pinned CA, the named
    // nick's own pair, verification ON (it is never relaxed here or anywhere), and no reconnect, so a
    // refused handshake is this run's fact and not a retry loop. No `servername`: node refuses an IP
    // SNI name outright, and the fixture's CA is what carries the trust.
    const cl = mqtt.connect(URL, {
      clientId: `leg1123-${n}-${process.pid}`,
      ca: [readFileSync(CA, "utf8")],
      cert: readFileSync(p.c, "utf8"),
      key: readFileSync(p.k, "utf8"),
      rejectUnauthorized: true,
      reconnectPeriod: 0,
      connectTimeout: 8000,
    });
    const t = setTimeout(() => rej(new Error(`${n} connect timed out`)), 20_000);
    cl.once("connect", () => { clearTimeout(t); res(cl); });
    cl.once("error", (e) => { clearTimeout(t); rej(e); });
  });

// The peer subscribes FIRST. A delivery observed after the fact is a delivery; one inferred from a
// publish that returned is the claim this repo's iid 10 exists to refuse.
const peer = await conn("peer", PEER_PAIR);
const heard: { topic: string; payload: string }[] = [];
peer.on("message", (topic, payload) => heard.push({ topic: String(topic), payload: payload.toString() }));
peer.subscribe(ROOM_TOPIC);
await sleep(500);

// The publisher's OWN subscription — the echo the ack watchdog is built on, and the only client-side
// signal there is. Leg 1123 armed this watch on the hold; it settles on this frame or it alarms.
const seat = await conn("seat", LEAD_PAIR);
const echoed: { topic: string; payload: string }[] = [];
seat.on("message", (topic, payload) => echoed.push({ topic: String(topic), payload: payload.toString() }));
seat.subscribe(ROOM_TOPIC);
await sleep(500);

// THE LINE, built by the shipped builders the renew handler uses, on the shipped delivery shape:
// `chat/<room>`, `to:"all"`, `steer:true`, an id of the seat's own making.
const holdId = msgId(LEAD, 1, bootTag());
const holdText = leadHoldLine(LEAD);
const holdPayload = roomPayload({ nick: LEAD, message: holdText, id: holdId, ts: Date.now(), to: "all", steer: true });
seat.publish(ROOM_TOPIC, JSON.stringify(holdPayload));
await sleep(1500);

check("the PEER, on a real broker, heard the hold exactly once on the room topic",
  heard.filter((h) => h.topic === ROOM_TOPIC && h.payload.includes("hold all comms")).length, 1);
check("and the PUBLISHER's own subscription echoed it back — the frame the watch is settled by",
  echoed.filter((h) => h.topic === ROOM_TOPIC && h.payload.includes("hold all comms")).length, 1);
check("…with the payload id carried through unharmed, which is the only key the watch can match on",
  echoed.length ? (JSON.parse(echoed[0].payload) as { id?: string }).id : "", holdId);
check("NEGATIVE: the hold text is the shipped lead hold, named by its own author's nick",
  [holdText.includes(`${LEAD} refreshing`), holdText.includes("Work does NOT stop"), (holdPayload.nick as string) === LEAD],
  [true, true, true]);

// The shipped deciders, run over what the broker ACTUALLY handed back — not over a synthesised frame.
const frameId = (p: string): string => {
  try {
    const o = JSON.parse(p) as { id?: unknown };
    return typeof o.id === "string" ? o.id : "";
  } catch { return ""; }
};
const echoId = echoed.length ? frameId(echoed[0].payload) : "";
let pending = watchAck([], ROOM_TOPIC, "room line", Date.now(), holdId).pending;
check("CONTROL the watch holds the entry before the echo (an empty list would make the settle vacuous)", pending.length, 1);
const settled = settleAck(pending, echoId);
check("the hold's own echo CLEARS the watch — so the line leg 1123 armed is settled, never aged out as an alarm",
  [settled.settled, settled.pending.length], [true, 0]);
const wrongId = settleAck(pending, `${echoId}-other`);
check("NEGATIVE a frame carrying a DIFFERENT id does not clear it (iid 21 finding 1 holds on this face too)",
  [wrongId.settled, wrongId.pending.length], [false, 1]);
check("…and the key that makes that possible is the id, not the shared topic: two publishes on one topic are two keys",
  ackWatchKey({ topic: ROOM_TOPIC, id: "a" }) === ackWatchKey({ topic: ROOM_TOPIC, id: "b" }), false);
check("CONTROL the flat room topic this file published on is NOT the per-sender leaf (the hold's delivery shape is flat whatever the env)",
  msgTopic(ROOM, LEAD) !== ROOM_TOPIC, true);

peer.end(true);
seat.end(true);
rmSync(SCRATCH, { recursive: true, force: true });

if (failed) {
  console.log(`${failed} check(s) FAILED of ${failed + okCount}`);
  // process.exitCode, never process.exit(): tools/test_exit_class.ts is the guard on that rule.
  process.exitCode = 1;
} else {
  console.log(`all checks pass (${okCount} cells)`);
}
