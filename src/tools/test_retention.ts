// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * The RETENTION gate — how long a chat record is kept, and who can reach it.
 *   bun src/tools/test_retention.ts        (exit 1 on any failure)
 *
 * TWO HALVES, because the claim has two ends. The pure half decides the numbers: the broker-side
 * expiry seconds derived from the SAME window a seat sweeps on, and the journal's age bound beside
 * its line count. The physical half asks a real broker what it does with them, because "a retained
 * receipt retires" is a statement about the broker's memory and not about our code.
 *
 * WHY THE PHYSICAL HALF IS THE POINT. A seat's own sweep (`index.ts:clearMyReceipts`) can only reach
 * the leaves THAT PROCESS pinned — the per-nick grant is the feature, and the comment beside the
 * sweep says so. So a lane that crashed or was retired left its `_ctl/<nick>/<id>` boards standing
 * with nothing coming back for them, and no knob could shorten what no hand could reach. The v5
 * Message-Expiry-Interval is what lets the broker drop them with nobody online. This file proves the
 * disappearance, and proves the paired negative: a leaf WITHOUT the property survives the same wait.
 *
 * COUNTS ARE BEFORE AND AFTER, never a claim. Every expiry cell reports how many leaves a FRESH
 * subscriber was handed at each moment. A test that asserts a disappearance with no earlier
 * appearance proves only that a socket was quiet.
 *
 * A FIXTURE, NEVER A LIVE BROKER. This file starts and stops its own throwaway mosquitto on
 * 127.0.0.1 on a port it chose, through `src/tools/broker-fixture.sh` with a per-process
 * `TABICHAT_FIXTURE_OWNER` (the shared-state hazard that file's header records), and tears it down on
 * every exit path including a throw. Nothing here contacts, configures, or reloads anyone's broker:
 * broker CONFIG is proposed to the operator in prose, and applying it is not a lane act.
 *
 * NOT COVERED, said so nobody over-reads a green. The fixture runs the image
 * `broker-fixture.sh` defaults to; the fleet's running broker is a different build of the same 2.x
 * line, and `docs/broker/README.md` records that gap for the artifact's own reasons — it is this
 * file's gap too. Re-derive both versions before quoting either. And the 1-second case that
 * `MQTT_ACK_RETAIN_MS=0` maps to is pinned in half 1 as a number, not re-timed here, because a cell
 * that races a one-second expiry is a cell that fails on a slow day and teaches nobody anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import mqtt from "mqtt";
import { ackTopic, clearPayload, expiryIntervalSeconds, receiptClears } from "../extensions/tabichat/roommsg.ts";
import { adminResultTopic } from "../extensions/tabichat/laneadmin.ts";
import {
  ROOMLOG_MAX_AGE_DEFAULT_DAYS,
  ROOMLOG_MAX_AGE_ENV,
  parseRoomLogAgeDays,
  trimRoomLog,
} from "../extensions/tabichat/roomlog.ts";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok    ${name}: ${g}`);
  }
};

const REPO = join(import.meta.dirname, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════════════════════════
// HALF 1 — the numbers, and the wiring that must actually use them. No socket, no real disk.
// ══════════════════════════════════════════════════════════════════════════════════════════════

console.log("== 1a. one knob, two ends: the expiry seconds ==");
// The window is the site's (`MQTT_ACK_RETAIN_MS`); this is the SAME number in the unit MQTT 5.0
// uses, so a seat cannot be configured for ten minutes and leave one-hour boards at the broker.
check("one hour is 3600 seconds", expiryIntervalSeconds(60 * 60_000), 3600);
check("ten minutes is 600 seconds", expiryIntervalSeconds(10 * 60_000), 600);
check("a window that is not a whole second rounds up, never down to zero", expiryIntervalSeconds(1500), 2);
check("and one millisecond still gets a second", expiryIntervalSeconds(1), 1);
// N3, the broker half. `0` is the value that means "no board" at the sweep, and `test_roommsg.ts`
// already pins that the sweep still marks every leaf due at 0. Measured on the loopback fixture: an
// interval of 0 on a RETAINED publish leaves the message STANDING — the value that reads like
// "expire at once" does its opposite — so the zero case must never reach the wire as 0.
check("NEGATIVE N3: the 0 window yields 1 second, not the 0 that measures as 'keep'",
  expiryIntervalSeconds(0), 1);
check("NEGATIVE: a non-finite or negative window yields 1, and never 0",
  [expiryIntervalSeconds(Number.NaN), expiryIntervalSeconds(-5)], [1, 1]);
check("N3 unchanged at the sweep: window 0 still marks every pinned leaf due",
  receiptClears([{ topic: "a", ts: 0 }, { topic: "b", ts: 0 }], Date.now(), 0).clear.length, 2);

console.log("\n== 1c. the journal's age bound, beside the count and not instead of it ==");
const DAY = 86400_000;
// A memory RoomLogIo in the shape `test_roomlog.ts` uses. The boot trim is the ONLY whole-file
// writer there is, so counting writes is how "touched nothing" is proved instead of asserted.
const mem = () => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const appends: string[] = [];
  return {
    files, writes, appends,
    io: {
      read: (p: string) => files.get(p) ?? "",
      append: (p: string, d: string) => { appends.push(d); files.set(p, (files.get(p) ?? "") + d); },
      write: (p: string, d: string) => { writes.push(d); files.set(p, d); },
      ensure: () => {},
    },
  };
};
const line = (id: string, ts: number) =>
  JSON.stringify({ id, nick: "lane1", ts, text: `t-${id}`, dir: "in" }) + "\n";
const idsOf = (s: string) =>
  (s.trim() === "" ? [] : s.trim().split("\n").map((l) => {
    try {
      return JSON.parse(l).id as string;
    } catch {
      return "<unparsed>"; // a line that will not read is SHOWN, not dropped, by this helper
    }
  }));

// The parse shape every knob in this file follows: unset or garbage is the shipped default, `0` is
// the aggressive answer, and nothing means "keep forever" except leaving it alone.
check("unset means no age bound — today's behaviour, byte for byte",
  parseRoomLogAgeDays("", ROOMLOG_MAX_AGE_DEFAULT_DAYS), -1);
check("garbage means no age bound too, and never 'delete the history'",
  [parseRoomLogAgeDays("ten", -1), parseRoomLogAgeDays("-3", -1), parseRoomLogAgeDays(undefined, -1)],
  [-1, -1, -1]);
check("0 is a real answer, and the aggressive one", parseRoomLogAgeDays("0", -1), 0);
check("7 days is 7 days, and 7.9 floors to 7",
  [parseRoomLogAgeDays("7", -1), parseRoomLogAgeDays(" 7.9 ", -1), parseRoomLogAgeDays(3, -1)], [7, 7, 3]);
check("the knob is named once, in the file that reads it", ROOMLOG_MAX_AGE_ENV, "MQTT_ROOMLOG_MAX_AGE_DAYS");

{
  const { io, files, writes } = mem();
  const P = "/j/tabith/lane1.jsonl";
  const now = 1_700_000_000_000;
  files.set(P, [line("d30", now - 30 * DAY), line("d10", now - 10 * DAY), line("d1", now - DAY), line("new", now)].join(""));
  check("an age cut drops what is past it and reports the count the wiring prints",
    trimRoomLog(io, P, 500, 7, now), { ok: true, trimmed: 2 });
  check("and keeps the young records, in the order lived", idsOf(files.get(P)!), ["d1", "new"]);
  check("the age cut ran even though the file sat UNDER its 500-line cap — a count bound alone never touched it",
    writes.length, 1);
}
{
  // Both bounds agreeing, and the ORDER: age first, then the cap, or a short file keeps what a site
  // asked to lose.
  const { io, files } = mem();
  const P = "/j/both.jsonl";
  const now = 1_700_000_000_000;
  files.set(P, [line("old1", now - 40 * DAY), line("y1", now), line("y2", now), line("y3", now)].join(""));
  check("age then count: the old line goes and the cap trims the newest block to two",
    [trimRoomLog(io, P, 2, 7, now), idsOf(files.get(P)!)], [{ ok: true, trimmed: 2 }, ["y2", "y3"]]);
}
{
  // N4 — the one this file exists to pin, in both directions.
  const { io, files, writes, appends } = mem();
  const P = "/j/zero.jsonl";
  const now = 1_700_000_000_000;
  files.set(P, [line("prev-a", now - DAY), line("prev-b", now - 60_000)].join(""));
  check("N4: 0 days drops every record older than this boot — that is what 'no history' means",
    [trimRoomLog(io, P, 500, 0, now), idsOf(files.get(P)!)], [{ ok: true, trimmed: 2 }, []]);
  // ...and it still does not reach into the session that is live. The trim is a BOOT act, before this
  // seat journals a line, and the hot path only appends: so the lines written after it stand.
  const at = Date.now();
  io.append(P, line("live-1", at));
  io.append(P, line("live-2", at + 1));
  check("N4: the current session's own lines land AFTER that trim and are not deleted out from under it",
    [appends.length, writes.length, idsOf(files.get(P)!)], [2, 1, ["live-1", "live-2"]]);
}
{
  const { io, files, writes } = mem();
  const P = "/j/none.jsonl";
  const now = 1_700_000_000_000;
  files.set(P, [line("a", now - DAY), line("b", now)].join(""));
  check("NEGATIVE: no age bound + under the cap touches nothing and writes nothing",
    [trimRoomLog(io, P, 500, ROOMLOG_MAX_AGE_DEFAULT_DAYS, now), writes.length, idsOf(files.get(P)!)],
    [{ ok: true, trimmed: 0 }, 0, ["a", "b"]]);
  const bad = mem();
  const BP = "/j/bad.jsonl";
  const now2 = 1_700_000_000_000;
  bad.files.set(BP, `not json\n${line("keep", now2 - 40 * DAY)}\n`);
  check("an unreadable line is KEPT by an age cut — it is the replay's malformed count to report, not this bound's to destroy",
    [trimRoomLog(bad.io, BP, 500, 7, now2), idsOf(bad.files.get(BP)!)], [{ ok: true, trimmed: 1 }, ["<unparsed>"]]);
}
{
  // The source-shape half: a correct module nobody calls is the failure this repo has booked before.
  const idx = readFileSync(join(REPO, "src", "extensions", "tabichat", "index.ts"), "utf8");
  const at = (s: string) => idx.indexOf(s);
  const connectBlock = idx.slice(at("client = mqtt.connect(brokerUrl"), at("client = mqtt.connect(brokerUrl") + 1200);
  check("the one place a client is built requests v5 — the property means nothing on a v4 packet",
    /protocolVersion:\s*5/.test(connectBlock), true);
  check("NEGATIVE: it is requested at exactly that one site, so no second client was added and missed",
    (idx.match(/protocolVersion:\s*5/g) || []).length, 1);
  const receiptNeedle = "client.publish(t, JSON.stringify(payload), {";
  const receiptSite = idx.slice(at(receiptNeedle), at(receiptNeedle) + 500);
  const adminSite = idx.slice(at("adminResultPayload(rid, nick"), at("adminResultPayload(rid, nick") + 500);
  check("the receipt publish carries the derived expiry",
    receiptSite.includes("properties: { messageExpiryInterval: ACK_EXPIRY_S }"), true);
  check("and so does the admin answer — the other leaf that grows one topic per id under `_ctl`",
    adminSite.includes("properties: { messageExpiryInterval: ACK_EXPIRY_S }"), true);
  check("one number feeds both, derived from the sweep's own window and not a second constant",
    idx.includes("const ACK_EXPIRY_S = expiryIntervalSeconds(ACK_RETAIN_MS);"), true);
  check("NEGATIVE: EXACTLY two publishes get the property — presence and the hist board must not expire a live seat's own record",
    (idx.match(/messageExpiryInterval/g) || []).length, 2);
  check("the CLEAR publish stays a plain empty retained payload — an expiry on a delete is noise",
    idx.includes("client.publish(x.topic, clearPayload(), { retain: true });"), true);
  check("the wiring reads the age knob and passes it into the boot trim",
    idx.includes("roomLogAgeDays = parseRoomLogAgeDays(process.env[ROOMLOG_MAX_AGE_ENV], ROOMLOG_MAX_AGE_DEFAULT_DAYS);")
      && idx.includes("trimRoomLog(ROOMLOG_IO, roomLogTarget.path, roomLogCap, roomLogAgeDays)"), true);
  check("and the boot trim still REPORTS the drop in the words the journal gate pins",
    idx.includes("oldest dropped at boot, newest kept"), true);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// HALF 2 — a real broker on loopback, its own throwaway PKI, torn down on every path.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const OWNER = `retention-${process.pid}`;
const NICKS = "lane11 lane6 lane10";
let fixtureUp = false;
const sh = (args: string[]) => {
  const r = spawnSync("sh", args, {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, TABICHAT_FIXTURE_OWNER: OWNER, TABICHAT_FIXTURE_NICKS: NICKS },
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
};
const down = () => { if (fixtureUp) { fixtureUp = false; sh(["src/tools/broker-fixture.sh", "down"]); } };
process.on("exit", down);

type Env = { DIR: string; PORT: number; ROOM: string };
const parseUp = (out: string): Env | null => {
  const g = (k: string) => out.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();
  const DIR = g("FIXTURE_DIR"), PS = g("FIXTURE_PORT"), ROOM = g("FIXTURE_ROOM");
  if (!DIR || !PS || !ROOM) return null;
  return { DIR, PORT: Number(PS), ROOM };
};

/** N5, the wire half, with no broker in it at all. The shipped broker speaks both levels, so a
 * "3.1.1-only listener" cannot be produced by configuring one — and the claim under test is OUR
 * client's behaviour on a refusal, not a broker's manners. This listener answers a real CONNECT
 * exactly as a 3.1.1-only endpoint would, twice: the 3.1.1 refusal byte and the v5 reason byte. */
const refusalHalf = async () => {
  const forms = [[0x00, 0x01], [0x00, 0x83, 0x00]];
  const seenLevels: (number | null)[] = [];
  for (const connack of forms) {
    const srv = createServer((sock) => {
      sock.once("data", (buf) => {
        const i = buf.indexOf("MQTT");
        seenLevels.push(i >= 0 ? buf[i + 4] : null);
        sock.write(Buffer.from([0x20, connack.length, ...connack]));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    let connected = false;
    let errored = "";
    const cl = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
      protocolVersion: 5, clientId: `n5-${connack[1]}`, reconnectPeriod: 0, connectTimeout: 4000,
    });
    cl.on("connect", () => { connected = true; });
    cl.on("error", (e: Error) => { errored = e.message; });
    await sleep(1500);
    check(`N5: a CONNACK refusal (reason 0x${connack[1].toString(16)}) is LOUD — an error stated and no session`,
      [connected, errored !== ""], [false, true]);
    await new Promise<void>((r) => cl.end(true, r));
    await new Promise<void>((r) => srv.close(() => r()));
  }
  // The control that makes the two refusals mean anything: we really did ask for level 5. A refusal
  // proves nothing if we sent 4 and were correctly told no.
  check("N5 CONTROL: what went on the wire was a protocol-level-5 CONNECT", seenLevels, [5, 5]);
  check("N5: no silent downgrade — nothing reported 'connect' on either refusal shape", 2, seenLevels.length);
};

const physical = async (f: Env) => {
  const ca = readFileSync(join(f.DIR, "pki/ca/ca.crt")).toString();
  const pair = (n: string) => {
    const c = join(f.DIR, `pki/clients/${n}/cert.pem`), k = join(f.DIR, `pki/clients/${n}/key.pem`);
    if (!existsSync(c) || !existsSync(k)) throw new Error(`the fixture minted no pair for "${n}" — declare it in TABICHAT_FIXTURE_NICKS`);
    return { cert: readFileSync(c).toString(), key: readFileSync(k).toString() };
  };
  const conn = (n: string, protocolVersion: 4 | 5) => new Promise<mqtt.MqttClient>((res, rej) => {
    const cl = mqtt.connect(`mqtts://127.0.0.1:${f.PORT}`, {
      protocolVersion,
      clientId: `ret-${n}-v${protocolVersion}-${Math.random().toString(16).slice(2, 6)}`,
      ca: [ca], ...pair(n), rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: 8000,
    });
    cl.on("connect", () => res(cl));
    cl.on("error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 10000);
  });
  const sub = (cl: mqtt.MqttClient, t: string) => new Promise<void>((r) => cl.subscribe(t, { qos: 0 }, () => r()));
  const pub = (cl: mqtt.MqttClient, t: string, p: string, o: unknown) =>
    new Promise<void>((r, j) => cl.publish(t, p, o as any, (e?: Error) => (e ? j(e) : r())));
  /** A FRESH subscriber on the board wildcard — the only view that says what the broker is HOLDING,
   * rather than what one connected lane happens to remember. An empty retained payload is a delete,
   * so a non-empty payload is the whole test. */
  const held = async (topics: string[]) => {
    const o = await conn("lane10", 5);
    const got: string[] = [];
    await sub(o, `chat/${f.ROOM}/_ctl/#`);
    o.on("message", (t, m) => { if (m.length) got.push(t); });
    await sleep(1500);
    o.end(true);
    return topics.filter((t) => got.includes(t)).length;
  };

  await refusalHalf();

  const w = await conn("lane11", 5);
  // N1 and N2 as one broker run, on the product's own topic shapes: three leaves that carry the
  // property (two receipts, one admin answer) against three that carry nothing.
  const EXP = 5;
  const expiring = [ackTopic(f.ROOM, "lane11", "r-1"), ackTopic(f.ROOM, "lane11", "r-2"), adminResultTopic(f.ROOM, "lane11", "a-1")];
  const standing = [ackTopic(f.ROOM, "lane11", "s-1"), ackTopic(f.ROOM, "lane11", "s-2"), ackTopic(f.ROOM, "lane11", "s-3")];
  for (const t of expiring) await pub(w, t, JSON.stringify({ kind: "ack", id: t.split("/").pop(), by: "lane11" }), { retain: true, properties: { messageExpiryInterval: EXP } });
  for (const t of standing) await pub(w, t, JSON.stringify({ kind: "ack", id: t.split("/").pop(), by: "lane11" }), { retain: true });
  await sleep(600);
  const before = [await held(expiring), await held(standing)];
  check("CONTROL, and the instrument can be non-empty: all 3 property-carrying leaves are held at first", before[0], 3);
  check("CONTROL: and all 3 without the property too", before[1], 3);

  // N6 — the grant, physical. A peer's leaf is not ours to clear, and "nobody can" is worth nothing
  // until someone tries it against a real ACL. Under the generated phase-2 grant a foreign write is
  // dropped with NO error to its own publisher (tabichat#10), so the verdict is read at the board.
  const peer = ackTopic(f.ROOM, "lane6", "theirs");
  const p = await conn("lane6", 5);
  await pub(p, peer, JSON.stringify({ kind: "ack", id: "theirs", by: "lane6" }), { retain: true });
  await sleep(400);
  check("N6 CONTROL: the peer's own receipt is on the board before anything touches it", await held([peer]), 1);
  await pub(w, peer, clearPayload(), { retain: true });
  await sleep(700);
  check("N6: lane11's empty retained publish on LANE6's leaf does NOT clear it — option 3 stays refused, by the broker",
    await held([peer]), 1);
  const mine = standing[0];
  await pub(w, mine, clearPayload(), { retain: true });
  await sleep(700);
  check("N6 CONTROL: the identical publish on its OWN leaf DOES clear it — so the refusal above is the grant, not a dead socket",
    await held([mine]), 0);
  p.end(true);

  await sleep(EXP * 1000 + 3000); // past the interval, with room
  const afterExp = await held(expiring);
  const afterStand = await held(standing.filter((t) => t !== mine));
  check("N1: every leaf that carried the property is GONE at the broker, with no seat online to sweep it",
    afterExp, 0);
  check("N2 NEGATIVE: not one leaf that carried NO property went anywhere in the same wait",
    afterStand, 2);
  console.log(`      (before ${before[0]}+${before[1]} held of 6 -> after 0 expired + 2 standing; the third was cleared by its own owner, by hand, in N6)`);
  check("N1/N2: the difference is the property and nothing else — same writer, same topic shape, one flag apart",
    [before[0] - afterExp, before[1] - afterStand], [3, 1]);
  // A 3.1.1 peer alongside, on the same listener: the room's other seats are not asked to change.
  const old = await conn("lane6", 4);
  const hears: string[] = [];
  await sub(old, `chat/${f.ROOM}/_ctl/#`);
  old.on("message", (t, m) => { if (m.length) hears.push(t); });
  const plain = ackTopic(f.ROOM, "lane6", "v311-peer");
  await pub(old, plain, JSON.stringify({ kind: "ack", id: "v311-peer", by: "lane6" }), { retain: true });
  await sleep(800);
  check("a 3.1.1 session still connects and still writes its own leaf while a v5 session is up",
    await held([plain]), 1);
  check("and it hears the retained leaves the v5 half of this file pinned — v5 is per-connection, not per-broker",
    hears.length > 0, true);
  old.end(true); w.end(true);
};

const run = async () => {
  const up = sh(["src/tools/broker-fixture.sh", "up", "phase2"]);
  const f = parseUp(up);
  if (!f) {
    console.log("\nNOT RUN — the fixture did not start, so HALF 2 was NOT EXECUTED. That is a result, not a pass.");
    console.log(up);
    failed++;
    return;
  }
  fixtureUp = true;
  console.log(`\n== half 2: a real broker, 127.0.0.1:${f.PORT}, room "${f.ROOM}", the generated phase-2 grant ==`);
  // The grant is asserted, not assumed: if the generator stopped writing per-nick leaves, the N6
  // cells would pass on a wide grant and lie about the one thing they exist to show.
  const gen = readFileSync(join(f.DIR, "pki/acl-generated.conf"), "utf8");
  check("PRECONDITION: the generated ACL grants lane11 its OWN `_ctl` subtree",
    gen.includes(`topic write chat/${f.ROOM}/_ctl/lane11/#`), true);
  check("PRECONDITION: and no rule writes the whole `_ctl` subtree for anybody",
    /^\s*(topic|pattern)\s+(readwrite|write)\s+chat\/[^/]+\/_ctl\/#\s*$/m.test(gen), false);
  try {
    await physical(f);
  } catch (e) {
    failed++;
    console.log(`HALF 2 raised: ${e instanceof Error ? e.message : String(e)} — cells after the throw did not run.`);
  } finally {
    down();
  }
};

await run();
console.log(failed ? `\ntest_retention: ${failed} FAILURE(S)` : "\ntest_retention: ALL PASS");
// `process.exitCode`, never `process.exit()`: `bun test` runs the given files in ONE process and a
// top-level exit here truncates the suite beside it. `src/tools/test_exit_class.ts` is that rule, and
// it reddened the deploy loop until this line complied.
process.exitCode = failed ? 1 : 0;
