// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * tabichat iid 29 — the end-of-turn owed-turn notice must measure PUBLICATION.
 *   bun tools/test_owed_notice.ts            (exit 1 on any failure)
 *   bun tools/test_owed_notice.ts --plant    (the negative control: this run is EXPECTED RED, rc 1)
 *
 * THE DEFECT. A seat that published room lines and ended its turn was still told
 * "turn finished — nothing was published: your reply stayed in this terminal", because the counter
 * behind that sentence (`owedTurns`) is written by the INBOUND arm and cleared by the notice, and no
 * publish path ever touched it — five references, none of them a send. The fix measures publication:
 * `publishedThisTurn` is bumped at `publishRoom`'s own tail, reset at `agent_start`, and read by the
 * notice block.
 *
 * WHAT IS REAL HERE. The shipped entry is LOADED, not modelled: one factory pass per cell, the
 * shipped `session_start` handlers run, the shipped socket `message` handler arms the mention, the
 * shipped `/say` command does the publish, and the shipped `agent_end` handlers print the notice.
 * Stubbed: the three package externals (`mqtt`, `@earendil-works/pi-ai`,
 * `@earendil-works/pi-coding-agent`) and the pi API/context objects — the same load-time stubbing
 * `test_renewal_realm.ts` established. `MQTT_DIAG_LOG=off`, `MQTT_ROOMLOG=off`, `MQTT_EXIT_LOG` and
 * `TABICHAT_CONFIG` keep this run out of every shared log and out of the operator's site file.
 *
 * WHY THE NOTICE MUST STAY: it is the fleet's only tell for the "filed by nobody" class — a seat
 * whose reply never left the terminal. So the POSITIVE half is cell 1, asserted as exactly 1, and a
 * fix that silenced the notice by default reddens it. Cell 2 is the plant the spec asked for: a send
 * that bypasses the counter must bring the notice back and turn cell 2 RED. A cell that passes in
 * both shapes measures nothing.
 *
 * (this file's author is the reviewer of a prior leg, writing its two corrections forward).
 *   C-1 — one arm is not both arms. Every cell above ran the FLAT arm, because the env that selects
 *   the per-sender topic is deleted at module scope. A shipped byte that bumped the counter on the flat
 *   arm alone passed all fifteen cells (measured at a prior leg: a reviewer's plant, 15/15 GREEN), so the
 *   gate could not see the difference between "counted on the shared tail" and "counted on one branch".
 *   Cell 6 drives the SAME turn shape with `MQTT_SENDER_TOPIC` set and asserts the topic it actually
 *   landed on, so the two arms are distinguishable and a one-armed bump reddens cell 6.
 *   C-2 — the pre-renew lead hold publishes to `chat/<room>` on its own callback and never passes
 *   `publishRoom`, so a lead whose turn produced only that hold was still told "nothing was published".
 *   The fix counts it; cell 7 drives the shipped `/renew` handler to that publish and asserts no false
 *   notice, then pairs it with the same mount publishing NOTHING at all, which must still print one.
 *
 * (test surface only — no shipped byte moved): cell 8 guards the PLACEMENT cell 7 depends on.
 *   998 counts the hold AFTER the awaited publish resolves, and states in its own comment that a publish
 *   the socket rejected is therefore not counted. That rule had no cell: moving the bump to before the
 *   `await` (PLANT D) passed 25/25 at base `20c21d5d`. Cell 8 makes the stub refuse the write, so the
 *   only way the notice can go quiet is a counter moved by a hand-off that never reached the socket.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";

let failed = 0;
let okCount = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else {
    okCount++;
    console.log(`ok    ${name}: ${g}`);
  }
};
const says = (name: string, hay: string, needle: string) =>
  check(name, hay.includes(needle), true);

/** THE PLANT: with it, cell 2's publish goes straight to the stub socket WITHOUT passing through
 *  `publishRoom`, so the counter never moves and the notice must come back — which is what makes
 *  cell 2's `0` a measurement instead of a default. That run is expected to exit 1. */
const PLANT = process.argv.includes("--plant");

// nick/room/broker are read INSIDE the factory, so env is set before every pass, once here.
const SCRATCH = mkdtempSync(join(tmpdir(), "iid29-owed-"));
mkdirSync(join(SCRATCH, "resume"), { recursive: true });
process.env.MQTT_NICK = "t29seat";
process.env.MQTT_ROOM = "t29room";
process.env.MQTT_URL = "mqtt://127.0.0.1:1883";
process.env.MQTT_OWNER_NICK = "t29owner";
process.env.MQTT_DIAG_LOG = "off";
process.env.MQTT_ROOMLOG = "off";
process.env.MQTT_EXIT_LOG = join(SCRATCH, "exit.log");
process.env.MQTT_CTX_RESUME_DIR = join(SCRATCH, "resume");
process.env.TABICHAT_CONFIG = join(SCRATCH, "no-site-file.json");
delete process.env.MQTT_LEAD_NICK;
delete process.env.MQTT_SENDER_TOPIC;
delete process.env.MQTT_HIST_BOARD;
// An operator's shell on this box exports the TLS pins, and the shipped transport layer REFUSES to put
// a pinned CA beside a plaintext URL (tlsopts.ts, "no silent downgrade"). The names are taken from the
// module that owns them so this list cannot drift: the run is hermetic either way.
const { TLS_ENV } = await import("../extensions/tabichat/tlsopts.ts");
for (const name of Object.values(TLS_ENV)) delete process.env[name as string];

const ROOM_TOPIC = `chat/${process.env.MQTT_ROOM}`;
const NOTICE = "nothing was published";

const stubDir = mkdtempSync(join(tmpdir(), "iid29-stub-"));
const EXT_INDEX = join(import.meta.dirname, "..", "extensions", "tabichat", "index.ts");
const INDEX_SRC = readFileSync(EXT_INDEX, "utf8");
const MQTT_STUB = join(stubDir, "mqtt.ts");
writeFileSync(
  MQTT_STUB,
  [
    "const clients = [];",
    "const factory = {",
    "  connect(url, opts) {",
    "    globalThis.__iid29_connect_calls = (globalThis.__iid29_connect_calls ?? 0) + 1;",
    "    const listeners = {};",
    "    const c = {",
    "      url, opts, connected: true, publishes: [], listeners, ended: false,",
    "      on(ev, fn) { (listeners[String(ev)] ??= []).push(fn); },",
    "      subscribe() {}, unsubscribe() {},",
    "      publish(t, p, o, cb) { this.publishes.push({ topic: String(t), payload: String(p), opts: o }); if (typeof cb === \"function\") cb(globalThis.__iid29_fail_publish ? new Error(\"stub: the socket refused the write\") : null); },",
    "      end(force) { this.ended = force === true; },",
    "      removeAllListeners(ev) { delete listeners[String(ev)]; },",
    "      emit(ev, ...a) { for (const f of listeners[String(ev)] ?? []) f(...a); },",
    "    };",
    "    clients.push(c);",
    "    return c;",
    "  },",
    "};",
    "export default factory;",
    "export const lastClient = () => clients[clients.length - 1];",
    "export const connectCalls = () => globalThis.__iid29_connect_calls;",
  ].join("\n"),
);
writeFileSync(join(stubDir, "pi-ai.ts"), 'const T = new Proxy(function () {}, { get: () => T, apply: () => ({ type: "object" }) });\nexport const Type = T;\n');
writeFileSync(join(stubDir, "pi-ca.ts"), 'export const defineTool = (t) => t;\nexport const isToolCallEventType = () => false;\n');

plugin({
  name: "iid29-owed-externals",
  setup(b) {
    // ONLY the entry module is rewritten, and only its three bare specifiers; every relative import
    // inside it (roommsg.ts, mentionq.ts, …) resolves for real from its own directory.
    b.onLoad({ filter: /[/\\]extensions[/\\]tabichat[/\\]index\.ts$/ }, (a) => ({
      loader: "ts",
      contents: readFileSync(a.path, "utf8")
        .replace(`from "mqtt"`, `from "${join(stubDir, "mqtt.ts")}"`)
        .replace(`from "@earendil-works/pi-ai"`, `from "${join(stubDir, "pi-ai.ts")}"`)
        .replace(`from "@earendil-works/pi-coding-agent"`, `from "${join(stubDir, "pi-ca.ts")}"`),
    }));
  },
});

type StubClient = {
  publishes: { topic: string; payload: string }[];
  listeners: Record<string, ((...a: unknown[]) => void)[]>;
  emit(ev: string, ...a: unknown[]): void;
};
/** A room line on EITHER arm: the flat topic, or the per-sender topic under it. `hist/` is excluded by
 *  shape (MQTT_HIST_BOARD is deleted above, so the tail board never publishes here). */
const isRoomSend = (t: string) => t === ROOM_TOPIC || t.startsWith(`${ROOM_TOPIC}/msg/`);
/** ctxwarn.ts pins the lead's nick to this when MQTT_LEAD_NICK is unset, which this file does on
 *  purpose (the shipped default is what the gates assert). laneadmin.ts:shouldHoldBeforeRenew is
 *  `self === leadNick`, so the ONLY mount that can reach the pre-renew hold is one whose own nick IS
 *  the lead's — that is what cell 7 sets, for its own pass and no other. */
const LEAD_NICK_DEFAULT = "lead-agent";
const factory = ((await import(EXT_INDEX)) as { default: (pi: unknown) => void }).default;
const { lastClient } = (await import(MQTT_STUB)) as {
  lastClient: () => StubClient;
  connectCalls: () => number;
};

/** One factory pass = one seat run with its OWN closure state, so cells never inherit each other. */
const mount = async () => {
  const handlers: { ev: string; fn: (a: unknown, c: unknown) => unknown }[] = [];
  const commands: Record<string, (args: unknown, ctx: unknown) => unknown> = {};
  const sends: string[] = [];
  const notices: string[] = [];
  const base: Record<string, unknown> = {
    on: (ev: string, fn: (a: unknown, c: unknown) => unknown) => void handlers.push({ ev, fn }),
    getFlag: (name: string) => (name === "tabichat" ? true : undefined),
    registerFlag: () => undefined,
    registerCommand: (name: string, def: { handler: (a: unknown, c: unknown) => unknown }) =>
      void (commands[name] = def.handler),
    registerTool: () => undefined,
    sendUserMessage: (content: string) => void sends.push(String(content)),
  };
  const pi = new Proxy(base, {
    get: (t, p: string) => (p in t ? t[p] : () => undefined),
  });
  const ctx = {
    ui: { notify: (t: string) => void notices.push(String(t)), setStatus: () => undefined },
    isIdle: () => true,
    hasPendingMessages: () => false,
    // Driven only as far as the shipped `/renew` handler needs to reach its own hold publish. `cancelled`
    // is pi's "the session change did not happen" face, so `withSession` never runs: no socket is re-armed
    // and no seat is replaced by a test. The hold publish itself happens BEFORE either call.
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: true }),
    getContextUsage: () => null,
    model: { provider: "test", id: "test-model" },
  };
  /** Every handler for the event, in registration order — the order pi itself walks them in. */
  const dispatch = async (ev: string, event: unknown) => {
    for (const h of handlers.filter((x) => x.ev === ev)) await h.fn(event, ctx);
  };
  factory(pi);
  await dispatch("session_start", { reason: "new" });
  const client = lastClient();
  if (!client) {
    console.log("MOUNT FAILED — the shipped session_start never reached mqtt.connect; its own words:");
    for (const t of notices) console.log(`  ${t}`);
    throw new Error("mount: no stub client");
  }
  let n = 0;
  /** The shipped inbound arm: a line addressed to this seat, delivered by the socket callback. */
  const arm = () => {
    n++;
    client.emit("message", ROOM_TOPIC, Buffer.from(
      JSON.stringify({ nick: "peer", message: `@${process.env.MQTT_NICK} say something (c${n})`, id: `iid29-${n}`, ts: Date.now() }),
    ));
  };
  /** The shipped send path, through the shipped /say command. */
  const say = async (text: string) => {
    await commands.say(text, ctx);
  };
  /** The plant shape: bytes to the socket that never pass publishRoom, so the counter stays put. */
  const bypass = (text: string) => {
    client.publish(ROOM_TOPIC, JSON.stringify({ nick: "peer", message: text, ts: Date.now() }));
  };
  /** One turn: begin, publish in the named shape, end, and count the notices the seat was shown. */
  const turn = async (shape: "say" | "none" | "bypass") => {
    const before = client.publishes.length;
    await dispatch("agent_start", {});
    for (let i = 0; i < 3; i++) {
      if (shape === "say") await say(`iid29 published line ${i}`);
      if (shape === "bypass") bypass(`iid29 planted line ${i}`);
    }
    const sent = client.publishes.slice(before).filter((p) => isRoomSend(p.topic));
    notices.length = 0;
    await dispatch("agent_end", { messages: [] });
    return {
      notices: notices.filter((t) => t.includes(NOTICE)).length,
      roomSends: sent.length,
      // which topic the arm ACTUALLY used — the two arms are only distinguishable if this is read
      roomTopics: [...new Set(sent.map((p) => p.topic))],
    };
  };
  /** ONE turn whose only room write is the shipped pre-renew hold, driven through the shipped `/renew`
   *  handler rather than re-implemented here: what the handler does to the socket is the thing asserted.
   *  `mode: "refused"` makes the stub invoke the publish callback with an Error, which is how a real client
   *  reports a write the socket did not take — the handler's `catch` branch then owns the outcome. */
  const holdTurn = async (mode: "ok" | "refused" = "ok") => {
    const before = client.publishes.length;
    await dispatch("agent_start", {});
    (globalThis as Record<string, unknown>).__iid29_fail_publish = mode === "refused";
    await commands.renew("", ctx);
    (globalThis as Record<string, unknown>).__iid29_fail_publish = false;
    const sent = client.publishes.slice(before).filter((p) => isRoomSend(p.topic));
    // the handler's own words, before the buffer is cleared for the notice count
    const renewSaid = notices.filter((t) => t.includes("lead hold published")).length;
    const renewFailed = notices.filter((t) => t.includes("lead hold NOT published")).length;
    notices.length = 0;
    await dispatch("agent_end", { messages: [] });
    return {
      notices: notices.filter((t) => t.includes(NOTICE)).length,
      roomSends: sent.length,
      roomTopics: [...new Set(sent.map((p) => p.topic))],
      renewSaid,
      renewFailed,
      holds: sent.filter((p) => p.payload.includes("hold all comms") && p.payload.includes('"to":"all"') && p.payload.includes('"steer":true')).length,
    };
  };
  return { notices, sends, client, arm, say, turn, holdTurn };
};

// ─── structural — the bump is on the send path and the notice reads it ──────────────────────────
// Pinned by the strings the fix ships: an edit that deletes the bump reddens cell 2's control below,
// and an edit that deletes the read reddens cell 2 itself.
says("S1 publishRoom's own tail bumps the counter", INDEX_SRC, "publishedThisTurn++;");
says("S2 the notice block reads publication before it prints", INDEX_SRC, "if (publishedThisTurn) return;");
says("S3 agent_start opens the turn's budget", INDEX_SRC, "publishedThisTurn = 0;");

// ─── cell 1 — POSITIVE, the half that refuses a lazy fix ────────────────────────────────────────
{
  const cBefore = (globalThis as Record<string, number>).__iid29_connect_calls ?? 0;
  const m = await mount();
  check("C0 CONTROL this mount really reached the stub's own connect()",
    ((globalThis as Record<string, number>).__iid29_connect_calls ?? 0) - cBefore, 1);
  m.arm();
  check("C0b CONTROL the inbound arm reached pi (one hand-off, not a silent drop)", m.sends.length, 1);
  const r = await m.turn("none");
  check(`C1 POSITIVE a turn that published nothing prints the notice exactly once (roomSends ${r.roomSends})`, r.notices, 1);
}

// ─── cell 2 — the paired negative, and the plant that must redden it ────────────────────────────
{
  const m = await mount();
  m.arm();
  const r = await m.turn(PLANT ? "bypass" : "say");
  check(`C2 CONTROL three publishes reached the stub socket (${PLANT ? "planted, bypassing publishRoom" : "the shipped /say"})`, r.roomSends, 3);
  check(
    PLANT
      ? "C2 PLANT a send that bypasses the counter brought the notice back — this cell is EXPECTED RED on this run"
      : "C2 NEGATIVE a turn whose publish reached the socket prints nothing",
    r.notices,
    0,
  );
}

// ─── cell 3 — the bypass shape, asserted as shipped behaviour ───────────────────────────────────
{
  const m = await mount();
  m.arm();
  const r = await m.turn("bypass");
  check("C3 CONTROL the planted send still reached the socket", r.roomSends, 3);
  check("C3 a send that bypasses publishRoom leaves the notice owed (count 1)", r.notices, 1);
}

// ─── cell 4 — the counter is per-TURN, so an earlier turn cannot answer for this one ─────────────
// This is the false-silence class the fix could have introduced, and it would re-open a prior leg's L-1.
{
  const m = await mount();
  m.arm();
  const first = await m.turn("say");
  check("C4a turn 1 published, so nothing is printed", first.notices, 0);
  m.arm();
  const second = await m.turn("none");
  check("C4b turn 2 published nothing after turn 1 spoke — the notice is still owed", second.notices, 1);
}

// ─── cell 5 — an unaddressed line arms nothing ──────────────────────────────────────────────────
{
  const m = await mount();
  const before = m.client.publishes.length;
  m.client.emit("message", ROOM_TOPIC, Buffer.from(
    JSON.stringify({ nick: "peer", message: "a line that names nobody", id: "iid29-quiet", ts: Date.now() }),
  ));
  check("C5a an unaddressed line is buffered, not handed to the lane", m.sends.length, 0);
  const r = await m.turn("none");
  check("C5b and no notice is owed for a turn nobody asked for", r.notices, 0);
  check("C5c CONTROL the mount published nothing on its own", m.client.publishes.length, before);
}

// ─── cell 6 — THE SECOND ARM (C-1): the same shapes with the sender-topic env set ──────
// Measured at a prior leg: a shipped byte that bumped the counter on the FLAT arm alone passed every cell
// above, because the env that selects the per-sender arm is deleted at module scope and no mount ever
// put it back. The env is read INSIDE the factory pass, so it is set for the mount and restored right
// after it — and the arm is then asserted from the topic the publish ACTUALLY landed on, never from a
// guess about the leaf rule. A cell that passes whichever arm ran is not a second arm; it is a duplicate.
{
  process.env.MQTT_SENDER_TOPIC = "1";
  const m = await mount();
  delete process.env.MQTT_SENDER_TOPIC;
  m.arm();
  const r = await m.turn("say");
  const senderTopic = r.roomTopics.join(",");
  check(`C6a CONTROL this mount wrote the PER-SENDER arm — one topic, not the flat one: ${senderTopic}`,
    [r.roomTopics.length, r.roomTopics[0] === ROOM_TOPIC, senderTopic.startsWith(`${ROOM_TOPIC}/msg/`)],
    [1, false, true]);
  check(`C6b CONTROL three room publishes reached the stub socket on that arm (roomSends ${r.roomSends})`, r.roomSends, 3);
  check("C6c NEGATIVE a per-sender-arm turn whose publish reached the socket prints nothing", r.notices, 0);

  // the POSITIVE half on the same arm, so C6c's 0 cannot be earned by a notice that has gone quiet there
  process.env.MQTT_SENDER_TOPIC = "1";
  const m2 = await mount();
  delete process.env.MQTT_SENDER_TOPIC;
  m2.arm();
  const r2 = await m2.turn("none");
  check(`C6d POSITIVE the same arm, a turn that published nothing, still prints (roomSends ${r2.roomSends})`, r2.notices, 1);

  // and the two arms must be OBSERVABLY different, or cell 6 measures nothing new
  const mf = await mount();
  mf.arm();
  const rf = await mf.turn("say");
  const flatTopic = rf.roomTopics.join(",");
  check(`C6e CONTROL the flat arm writes ${flatTopic} and the sender arm writes ${senderTopic} — cell 6 is an arm, not a duplicate`,
    [flatTopic === ROOM_TOPIC, senderTopic !== flatTopic], [true, true]);
}

// ─── cell 7 — THE PRE-RENEW HOLD IS COUNTED (C-2) ───────────────────────────────────────
// The hold is published on its own callback in the `/renew` handler and never passes `publishRoom`, so
// the counter that decides the notice had one KNOWN bypass left at a prior leg: a lead whose turn produced
// only the hold was told "nothing was published" after publishing to every lane. Driven through the
// shipped handler, not re-implemented here. `shouldHoldBeforeRenew` is `self === leadNick`, and this
// file deletes MQTT_LEAD_NICK so the lead is ctxwarn.ts's shipped default — so the mount that can reach
// the hold is one whose own nick is that lead, set for this cell and restored at the end of it.
{
  process.env.MQTT_NICK = LEAD_NICK_DEFAULT;
  const m = await mount();
  m.arm();
  const r = await m.holdTurn();
  check("C7a CONTROL the shipped /renew handler ran to its own success branch (its words: lead hold published)", r.renewSaid, 1);
  check(`C7b CONTROL one room line went out on the hold's own shape (to:"all", steer:true, "hold all comms"), topics: ${r.roomTopics.join(",")}`, r.holds, 1);
  check("C7c CONTROL the hold uses the FLAT topic whatever the seat's env — that is its delivery shape", r.roomTopics.join(","), ROOM_TOPIC);
  check("C7 NEGATIVE a turn whose only room publish was the hold prints no false notice", r.notices, 0);
  // paired on the SAME mount: publishing nothing at all must still print, so C7's 0 is the count speaking,
  // not a notice gone quiet on the lead shape.
  m.arm();
  const q = await m.turn("none");
  check(`C7d POSITIVE the same lead mount, a turn that published nothing, still prints (roomSends ${q.roomSends})`, q.notices, 1);
  process.env.MQTT_NICK = "t29seat";
}

// ─── cell 8 — the hold's PLACEMENT (test surface only, no shipped byte) ───────────────
// 998's own comment states the rule: the bump sits AFTER the await "so a publish the socket rejected is
// NOT counted". Nothing measured that rule — PLANT D, the bump moved to before the `await`, read
// 25/25 GREEN at base 20c21d5d (quoted in the leg's report), so the guard was missing while the byte was
// right. This cell drives the same shipped handler with the stub REFUSING the write, so the only way the
// notice can go quiet is a counter moved by a hand-off that never reached the socket: exactly the false
// silence iid 29 is about, and the weaken-the-check class if it were instead made silent by default.
{
  process.env.MQTT_NICK = LEAD_NICK_DEFAULT;
  const m = await mount();
  m.arm();
  const r = await m.holdTurn("refused");
  check("C8a CONTROL the handler took its own FAILURE branch (its words: lead hold NOT published)", r.renewFailed, 1);
  check("C8b CONTROL the success branch did NOT run (no 'lead hold published' line on a refused write)", r.renewSaid, 0);
  check(`C8c CONTROL the publish call really reached the socket wrapper (roomSends ${r.roomSends}) — this cell is not passing on an empty path`, r.roomSends, 1);
  check("C8 a hold the socket REFUSED buys no silence: the owed notice still prints (count 1)", r.notices, 1);
  // the pair, on the SAME mount: with the write accepted the notice must go quiet again, so C8's 1 is the
  // refusal speaking — not a notice gone mute for every lead turn.
  m.arm();
  const ok = await m.holdTurn("ok");
  check("C8d PAIR the same mount with the write ACCEPTED prints nothing (count 0)", ok.notices, 0);
  process.env.MQTT_NICK = "t29seat";
}

console.log(PLANT ? `plant run: cell 2 drives the BYPASS shape and still asserts silence, so this run is EXPECTED RED` : "default run: cell 2 drives the shipped /say shape");
if (failed) {
  console.log(`${failed} check(s) FAILED of ${failed + okCount} cells`);
  // `process.exitCode`, never `process.exit()`: test_exit_class.ts is the guard, and a top-level exit
  // truncates a combined `bun test` run and under-reports it.
  process.exitCode = 1;
} else {
  console.log(`all checks pass (${okCount} cells)`);
}
