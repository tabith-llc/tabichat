// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * leg 1123 — a room publish must journal itself, on every path that writes the room.
 *   bun tools/test_hold_journal.ts      (exit 1 on any failure)
 *
 * THE DEFECT THIS MEASURES. The pre-renew lead hold reaches the socket on its own callback rather
 * than through `publishRoom`, so it consumed a counter number and reached every peer while the
 * SENDING seat's own journal held nothing. The author then could not answer "did I send that?" about
 * a line it had in fact sent — and a check that reads journal absence as evidence says the wrong
 * thing about a real line. The fix shares one tail (`roomSendTail`) between the fire-and-forget arms
 * and the awaited hold, and keeps the await: `session_shutdown` closes the socket about a second per
 * publish, so an unawaited hold races the session change it exists to announce.
 *
 * WHAT IS REAL HERE. The shipped entry is LOADED and its shipped handlers run: the `/renew` command
 * does the hold publish, the socket `message` callback does the inbound journaling, `/say` does an
 * ordinary room send, and `session_shutdown` does the presence write. The journal is a REAL file
 * under a scratch dir (`MQTT_ROOMLOG` names it; `roomlog.ts` refuses tmpfs only for the DEFAULT
 * path, so a scratch dir is a normal target), read back row by row. Stubbed: the three package
 * externals, and the pi API/context — the same load-time shape `test_owed_notice.ts` established.
 *
 * WHY EACH CELL IS PAIRED. A journal row that appears is easy to fake by journalling everything;
 * rows that must NOT appear are the other half. So every positive here has a partner: the hold is in
 * the author's journal (N1) while receipts, the heartbeat and the offline record are not (N5); the
 * hold is counted once (N3) and not counted at all when the socket refused it (N2).
 *
 * WHAT THIS FILE CANNOT SEE, said plainly: the peer's `dir=in` row is produced by feeding the AUTHOR'S
 * OWN PUBLISHED BYTES into the shipped inbound arm of a second mount. That is the shipped reader and
 * the shipped bytes, but it is not a broker round trip — the delivery question (does the write come
 * back on the publisher's own subscription) belongs to `test_ack_watch_broker.ts`, which runs the
 * loopback fixture. This file measures journalling, not the wire.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const SCRATCH = mkdtempSync(join(tmpdir(), "leg1123-"));
mkdirSync(join(SCRATCH, "resume"), { recursive: true });
const EXT_INDEX = join(import.meta.dirname, "..", "extensions", "tabichat", "index.ts");
const ROOM = "t1123room";
const ROOM_TOPIC = `chat/${ROOM}`;
// `ctxwarn.ts` pins the lead's nick to this when MQTT_LEAD_NICK is unset, and
// `laneadmin.ts:shouldHoldBeforeRenew` is `self === leadNick` — so the only mount that can reach the
// pre-renew hold is one whose own nick IS the lead's. That is what `LEAD` is; `PEER` is N4's mount.
const LEAD = "lead-agent";
const PEER = "t1123peer";
const NOTICE = "nothing was published";

// One scratch journal PER MOUNT. The shipped default keys one file per seat per room; a mount that
// reused a neighbour's file would read rows a previous cell wrote, which is the false-pass shape.
let mountN = 0;
const journalOf = (who: string) => join(SCRATCH, `journal-${who}-${(mountN += 1)}.jsonl`);

process.env.MQTT_ROOM = ROOM;
process.env.MQTT_URL = "mqtt://127.0.0.1:1883";
process.env.MQTT_OWNER_NICK = "t1123owner";
process.env.MQTT_DIAG_LOG = "off";
process.env.MQTT_EXIT_LOG = join(SCRATCH, "exit.log");
process.env.MQTT_CTX_RESUME_DIR = join(SCRATCH, "resume");
process.env.TABICHAT_CONFIG = join(SCRATCH, "no-site-file.json");
delete process.env.MQTT_LEAD_NICK;
delete process.env.MQTT_SENDER_TOPIC;
delete process.env.MQTT_HIST_BOARD;
const { TLS_ENV } = await import("../extensions/tabichat/tlsopts.ts");
for (const name of Object.values(TLS_ENV)) delete process.env[name as string];

const stubDir = mkdtempSync(join(tmpdir(), "leg1123-stub-"));
const MQTT_STUB = join(stubDir, "mqtt.ts");
writeFileSync(
  MQTT_STUB,
  [
    "const clients = [];",
    "const factory = {",
    "  connect(url, opts) {",
    "    const listeners = {};",
    "    const c = {",
    "      url, opts, connected: true, publishes: [], listeners, ended: false,",
    "      on(ev, fn) { (listeners[String(ev)] ??= []).push(fn); },",
    "      subscribe() {}, unsubscribe() {},",
    "      publish(t, p, o, cb) { this.publishes.push({ topic: String(t), payload: String(p), opts: o }); if (typeof cb === \"function\") cb(globalThis.__fail_publish ? new Error(\"stub: the socket refused the write\") : null); },",
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
  ].join("\n"),
);
writeFileSync(join(stubDir, "pi-ai.ts"), 'const T = new Proxy(function () {}, { get: () => T, apply: () => ({ type: "object" }) });\nexport const Type = T;\n');
writeFileSync(join(stubDir, "pi-ca.ts"), 'export const defineTool = (t) => t;\nexport const isToolCallEventType = () => false;\n');
plugin({
  name: "leg1123-externals",
  setup(b) {
    b.onLoad({ filter: /[/\\]extensions[/\\]tabichat[/\\]index\.ts$/ }, (a) => ({
      loader: "ts",
      contents: readFileSync(a.path, "utf8")
        .replace(`from "mqtt"`, `from "${join(stubDir, "mqtt.ts")}"`)
        .replace(`from "@earendil-works/pi-ai"`, `from "${join(stubDir, "pi-ai.ts")}"`)
        .replace(`from "@earendil-works/pi-coding-agent"`, `from "${join(stubDir, "pi-ca.ts")}"`),
    }));
  },
});

type Stub = {
  publishes: { topic: string; payload: string }[];
  listeners: Record<string, ((...a: unknown[]) => void)[]>;
  emit(ev: string, ...a: unknown[]): void;
};
const factory = ((await import(EXT_INDEX)) as { default: (pi: unknown) => void }).default;
const { lastClient } = (await import(MQTT_STUB)) as { lastClient: () => Stub };

/** One factory pass = one seat with its own closure state and its own journal file. */
const mount = async (who: string) => {
  const jPath = journalOf(who);
  process.env.MQTT_NICK = who;
  process.env.MQTT_ROOMLOG = jPath;
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
  const pi = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
  const ctx = {
    ui: { notify: (t: string) => void notices.push(String(t)), setStatus: () => undefined },
    isIdle: () => true,
    hasPendingMessages: () => false,
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: true }),
    getContextUsage: () => null,
    model: { provider: "test", id: "test-model" },
  };
  const dispatch = async (ev: string, event: unknown) => {
    for (const h of handlers.filter((x) => x.ev === ev)) await h.fn(event, ctx);
  };
  factory(pi);
  await dispatch("session_start", { reason: "new" });
  const client = lastClient();
  if (!client) throw new Error("mount: the shipped session_start never reached mqtt.connect");
  return {
    client,
    notices,
    dispatch,
    say: async (t: string) => void (await commands.say(t, ctx)),
    renew: async () => void (await commands.renew("", ctx)),
    /** The shipped inbound arm: a line addressed to THIS seat. This is what owes the turn its notice
     *  (`owedTurns` is written by the inbound arm and cleared by the notice), so a cell that counts
     *  the notice must arm first — test_owed_notice.ts C0b is the witness for that. */
    arm: () =>
      client.emit("message", ROOM_TOPIC, Buffer.from(JSON.stringify({
        nick: "someoneelse", message: `@${who} answer this`, id: `leg1123-arm-${mountN}`, ts: Date.now(),
      }))),
    rows: () => {
      let raw = "";
      try {
        raw = readFileSync(jPath, "utf8");
      } catch {
        return [];
      }
      return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
};

/** The hold's own published bytes: the room write whose payload carries the hold text and to=all. */
const holdSend = (c: Stub) =>
  c.publishes.find((p) => {
    if (p.topic !== ROOM_TOPIC) return false;
    const o = JSON.parse(p.payload) as Record<string, unknown>;
    return typeof o.message === "string" && o.message.includes("hold all comms");
  });

// ─── N1 — the hold is in the author's journal, and a peer's `dir=in` row matches it ────────────
const lead = await mount(LEAD);
await lead.dispatch("agent_start", {});
await lead.renew();
const held = holdSend(lead.client);
const leadRows = lead.rows();
check("N1 CONTROL the shipped /renew put exactly one hold on the room topic", held !== undefined, true);
check("N1 the author's OWN journal carries the hold it published (dir=out, one row)",
  leadRows.filter((r) => r.dir === "out").length, 1);
const outRow = leadRows.find((r) => r.dir === "out") ?? {};
const heldObj = JSON.parse(held?.payload ?? "{}") as Record<string, unknown>;
check("N1 and the row is the SAME LINE: id, nick, text and `to` all equal the bytes on the wire",
  [outRow.id, outRow.nick, outRow.text, outRow.to],
  [heldObj.id, heldObj.nick, heldObj.message, heldObj.to]);
check("N1 NEGATIVE CONTROL: the row is not a duplicate of the send (one out row, not two)",
  [leadRows.length, leadRows.filter((r) => r.dir === "in").length], [1, 0]);

// the peer half: the AUTHOR'S OWN BYTES, handed to the shipped inbound arm of a second seat.
const peer = await mount(PEER);
peer.client.emit("message", ROOM_TOPIC, Buffer.from(held!.payload));
const peerRows = peer.rows();
check("N1 a peer hearing those bytes journals dir=in with the SAME id and the SAME text",
  peerRows.map((r) => [r.dir, r.id, r.text, r.nick]),
  [["in", heldObj.id as string, heldObj.message as string, LEAD]]);
check("N1 and the two rows agree byte-for-byte on the only fields the attribution read uses",
  [outRow.id === peerRows[0].id, outRow.text === peerRows[0].text, outRow.nick === peerRows[0].nick],
  [true, true, true]);

// ─── N2 — a publish the socket refused is NOT counted, NOT journalled, and says so ─────────────
{
  const m = await mount(LEAD);
  m.arm();
  await m.dispatch("agent_start", {});
  globalThis.__fail_publish = true;
  await m.renew();
  globalThis.__fail_publish = false;
  const rows = m.rows();
  check("N2 CONTROL the write really reached the socket wrapper and was REFUSED there (one room write, the refusal branch taken)",
    [m.client.publishes.filter((p) => p.topic === ROOM_TOPIC).length, m.notices.filter((t) => t.includes("lead hold NOT published")).length], [1, 1]);
  check("N2 NEGATIVE a refused hold buys no journal row (the tail runs only after the callback)",
    rows.filter((r) => r.dir === "out").length, 0);
  check("N2 and it buys no silence either: the owed-turn notice still prints",
    await (async () => {
      m.notices.length = 0;
      await m.dispatch("agent_end", { messages: [] });
      return m.notices.filter((t) => t.includes(NOTICE)).length;
    })(),
    1);
  // the pair on a FRESH mount: same handler, write accepted, notice goes quiet — so N2's 1 is the
  // refusal speaking, not a notice that has gone mute for every lead turn.
  const ok = await mount(LEAD);
  ok.arm();
  await ok.dispatch("agent_start", {});
  await ok.renew();
  ok.notices.length = 0;
  await ok.dispatch("agent_end", { messages: [] });
  check("N2 PAIR the same handler with the write ACCEPTED prints nothing and journals one row",
    [ok.notices.filter((t) => t.includes(NOTICE)).length, ok.rows().filter((r) => r.dir === "out").length],
    [0, 1]);
}

// ─── N3 — one room publish, ONE counter step (the double-count trap) ───────────────────────────
{
  const m = await mount(PEER);
  m.arm();
  await m.dispatch("agent_start", {});
  await m.say("leg1123 one ordinary line");
  const rows = m.rows();
  check("N3 one /say publish -> exactly one out row (the tail runs once per publish, not twice)",
    [m.client.publishes.filter((p) => p.topic === ROOM_TOPIC).length, rows.filter((r) => r.dir === "out").length], [1, 1]);
  check("N3 and the turn that published it owes no notice", await (async () => {
    m.notices.length = 0;
    await m.dispatch("agent_end", { messages: [] });
    return m.notices.filter((t) => t.includes(NOTICE)).length;
  })(), 0);
  // A hold AND an ordinary line in one turn is two publishes, so two rows — the count tracks the
  // writes, and a tail called twice for one write would show up here as rows > sends.
  const both = await mount(LEAD);
  both.arm();
  await both.dispatch("agent_start", {});
  await both.say("leg1123 line beside a hold");
  await both.renew();
  check("N3 a turn with two room writes has TWO out rows and no more (rows == sends)",
    [both.client.publishes.filter((p) => p.topic === ROOM_TOPIC).length, both.rows().filter((r) => r.dir === "out").length], [2, 2]);
}

// ─── N4 — a non-lead seat renewing publishes NOTHING to the room (unchanged behaviour) ─────────
{
  const m = await mount(PEER);
  m.arm();
  await m.dispatch("agent_start", {});
  await m.renew();
  check("N4 a worker seat's renew sends no room line at all", m.client.publishes.filter((p) => p.topic === ROOM_TOPIC).length, 0);
  check("N4 and it therefore writes no out row", m.rows().filter((r) => r.dir === "out").length, 0);
  check("N4 CONTROL the handler still ran to its own end (the session change is what it is)", await (async () => {
    m.notices.length = 0;
    await m.dispatch("agent_end", { messages: [] });
    return m.notices.filter((t) => t.includes(NOTICE)).length;
  })(), 1);
}

// ─── N5 — transport noise is not room text: receipts, beats and the offline record stay out ────
{
  const m = await mount(PEER);
  // inbound line addressed to THIS seat: the shipped arm journals dir=in and answers with a receipt
  // (publishCtl + publishCtlRetained). The connect heartbeat beat already fired once at connect.
  m.arm();
  const ctlPublishes = m.client.publishes.filter((p) => p.topic !== ROOM_TOPIC);
  check("N5 CONTROL receipts really went out on the control topic (this is not an empty path)",
    ctlPublishes.length > 0, true);
  check("N5 and NONE of the control writes entered the journal — room lines only",
    m.rows().filter((r) => r.dir === "out").length, 0);
  check("N5 …while the room line it heard IS journaled, once, as dir=in",
    m.rows().map((r) => [r.dir, r.id]), [["in", `leg1123-arm-${mountN}`]]);
  // session_shutdown: the retained offline presence record, then the socket close.
  const before = m.rows().length;
  await m.dispatch("session_shutdown", { reason: "renew" });
  const offline = m.client.publishes.filter((p) => p.topic.startsWith(`${ROOM_TOPIC}/presence/`));
  check("N5 CONTROL the offline presence record was published (a retained write, not chat)", offline.length, 1);
  check("N5 and the presence record added no journal row", m.rows().length, before);
  // clearMyReceipts and publishCtlRetained are control-child writes; neither is a room line, and the
  // journal holds no row for either — asserted above by "room lines only" plus the counts here.
}

// ─── structural — one tail, one counter bump, the await kept ───────────────────────────────────
{
  const src = readFileSync(EXT_INDEX, "utf8");
  check("the journal write lives in ONE shared tail (journalAppend(\"out\") has one site)",
    (src.match(/journalAppend\("out"/g) || []).length, 1);
  check("and the counter has ONE bump site — the hand-moved bump beside the tail is gone",
    (src.match(/publishedThisTurn\+\+/g) || []).length, 1);
  check("the hold is still AWAITED (iid 29's race is not re-opened by sharing the tail)",
    /await new Promise<void>\(\(resolve, reject\) => \{[\s\S]{0,400}?client\.publish\(\s*`chat\/\$\{room\}`,[\s\S]{0,300}?\(err\) => \(err \? reject\(err\) : resolve\(\)\),/.test(src),
    true);
  check("NEGATIVE: the hold path does not call publishRoom (that would drop the await back in)",
    /holdPayload[\s\S]{0,200}?publishRoom\(/.test(src), false);
  check("the hold arms its own ack watch on the topic it actually used, under its own id",
    /watchSend\(`chat\/\$\{room\}`, ROOM_SEND_KIND, typeof holdPayload\.id === "string" \? holdPayload\.id : ""\);/.test(src),
    true);
}

rmSync(SCRATCH, { recursive: true, force: true });
rmSync(stubDir, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} check(s) FAILED of ${failed + okCount}`);
  // process.exitCode, never process.exit(): test_exit_class.ts is the guard.
  process.exitCode = 1;
} else {
  console.log(`all checks pass (${okCount} cells)`);
}
