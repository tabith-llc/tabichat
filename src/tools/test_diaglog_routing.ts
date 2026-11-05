// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Truth table for the diagnostic sink and its routing (leg 517).
 *   bun tools/test_diaglog_routing.ts      (exit 1 on any failure)
 *
 * WHY THIS FILE EXISTS. The owner's order, verbatim 2026-10-24: "can we not figure out how to keep
 * errors out of the place the owner types?" Two fixes had already landed and NEITHER was about the
 * destination — #585 made the throw survivable, `07b2bbd` made ONE emitter stop double-publishing —
 * and the class survived both because `index.ts` had nineteen other print sites. A gate that checks
 * the DECISION but not the DESTINATION would have kept this green forever.
 *
 * Four halves, and the fourth is the one that makes the rest durable:
 *   1. the path resolver's truth table, both directions (precedence, and every rejection);
 *   2. the writer's bounds (rotation, and the rule that a failed write never falls back to stderr);
 *   3. the routing, as a DENYLIST OF NAMED SITES — not a count, because a count goes stale the first
 *      time someone legitimately adds a print, and a check nobody updates is a check that is off;
 *   4. a NEGATIVE CONTROL: the same scanner run over a synthetic source with a rogue print MUST
 *      report it. A structural gate that cannot fail is decoration (audit `iid 13`, and the
 *      silent-filter law this box already pays for).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";
import {
  DIAG_DEFAULT_MAX_BYTES,
  DIAG_DEFAULT_SUBPATH,
  DIAG_ENV,
  DIAG_MAX_ENV,
  DIAG_ROTATE_SUFFIX,
  DIAG_SITE_KEY,
  formatDiagLine,
  makeDiagIo,
  makeDiagSink,
  resolveDiagTarget,
  resolveDiagMaxBytes,
  rotateNeeded,
  writeDiagLine,
  type DiagIo,
} from "../extensions/tabichat/diaglog.ts";

let failed = 0;
const printf_ = (t: string): void => { process.stdout.write(t); };
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

const DIR = join(import.meta.dir, "..", "extensions", "tabichat");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

// --- 1. THE PATH RESOLVER, both halves ----------------------------------------------------
// The precedence is env -> site -> default, and every rejection is an ANSWER, never a guess.
check("env beats site and the default", resolveDiagTarget({ env: "/srv/a.log", site: "/srv/b.log", home: "/h" }), {
  ok: true,
  path: "/srv/a.log",
  source: `pi env ${DIAG_ENV}`,
});
check("site answers when the env layer is absent", resolveDiagTarget({ site: "/srv/c.log", home: "/h" }), {
  ok: true,
  path: "/srv/c.log",
  source: `site file (${DIAG_SITE_KEY})`,
});
check(
  "with nothing set the default is the durable per-user file, derived from the HOME it was given",
  resolveDiagTarget({ home: "/h" }),
  { ok: true, path: `/h/${DIAG_DEFAULT_SUBPATH}`, source: `default (${DIAG_DEFAULT_SUBPATH} under the resolved home)` },
);
check(
  "and the default is NOT a literal venue home — the caller's home is what appears",
  resolveDiagTarget({ home: "/srv/tenant" }).ok && resolveDiagTarget({ home: "/srv/tenant" }).path === "/srv/tenant/.pi/agent/tabichat-diag.log",
  true,
);
check("a trailing slash on HOME does not double it", resolveDiagTarget({ home: "/h/" }).path, "/h/.pi/agent/tabichat-diag.log");
check("~-prefixed env expands through the resolved home", resolveDiagTarget({ env: "~/d.log", home: "/h" }).path, "/h/d.log");
check("~ alone expands to the home", resolveDiagTarget({ env: "~", home: "/h" }).path, "/h");

// the rejection halves, each naming the layer that answered
const offR = resolveDiagTarget({ env: "off", home: "/h" });
check("an explicit OFF is honored, not treated as absence", [offR.ok, offR.path, offR.deliberate], [false, "", true]);
check("...and it says which layer answered", offR.ok === false && /pi env/.test(offR.source), true);
const emptyR = resolveDiagTarget({ env: "", home: "/h" });
check("an empty env slot is an ABSENCE (next layer answers), not OFF", emptyR.ok && emptyR.source.startsWith("default"), true);
const garbageR = resolveDiagTarget({ env: "   x   ", home: "/h" });
check("a garbage value is REFUSED, not quietly pointed at a home dir", [garbageR.ok, garbageR.path, garbageR.deliberate], [false, "", false]);
check("...and the refusal says why", garbageR.ok === false && /not an absolute path/.test(garbageR.reason), true);
check(
  "a boolean true at the site layer names no path and is REFUSED (not deliberate)",
  (() => { const r = resolveDiagTarget({ site: true, home: "/h" }); return [r.ok, r.deliberate]; })(),
  [false, false],
);
check(
  "a boolean false at the site layer is a deliberate opt-out",
  (() => { const r = resolveDiagTarget({ site: false, home: "/h" }); return [r.ok, r.deliberate]; })(),
  [false, true],
);
check(
  "no home and nothing set is a REFUSAL, never a guess at `/`",
  (() => { const r = resolveDiagTarget({}); return [r.ok, r.path]; })(),
  [false, ""],
);
check(
  "NEGATIVE: a resolved-but-tmpfs home does NOT become a scratch default",
  (() => { const r = resolveDiagTarget({ home: "/tmp/fakehome" }); return [r.ok, r.deliberate]; })(),
  [false, false],
);

// --- 1b. the cap ---------------------------------------------------------------------------
check("cap: unset is the 1 MiB default", resolveDiagMaxBytes(undefined), DIAG_DEFAULT_MAX_BYTES);
check("cap: a real number in a string is honored", resolveDiagMaxBytes("2048"), 2048);
check("cap: ZERO is not 'unlimited' — it falls back to the default", resolveDiagMaxBytes("0"), DIAG_DEFAULT_MAX_BYTES);
check("cap: garbage is the default, never NaN and never unbounded", resolveDiagMaxBytes("lots"), DIAG_DEFAULT_MAX_BYTES);
check("cap: a negative is the default", resolveDiagMaxBytes(-5), DIAG_DEFAULT_MAX_BYTES);

// --- 2. THE WRITER: rotation bounds and the no-terminal-fallback rule ----------------------
const fakeIo = (): DiagIo & { files: Record<string, string>; renamed: string[] } => {
  const files: Record<string, string> = {};
  const renamed: string[] = [];
  return {
    files,
    renamed,
    size: (p) => (files[p] ? files[p].length : 0),
    append: (p, d) => {
      files[p] = (files[p] ?? "") + d;
    },
    rename: (from, to) => {
      files[to] = files[from] ?? "";
      delete files[from];
      renamed.push(`${from}->${to}`);
    },
    ensureDir: () => {},
  };
};
const okTarget = resolveDiagTarget({ home: "/h" });
check("rotate decision: a line that fits does NOT rotate", rotateNeeded(10, 5, 100), false);
check("rotate decision: the first line into an empty file never rotates", rotateNeeded(0, 500, 100), false);
check("rotate decision: crossing the cap rotates", rotateNeeded(90, 20, 100), true);
{
  const io = fakeIo();
  const big = "x".repeat(60);
  writeDiagLine(okTarget, io, big, 100);
  writeDiagLine(okTarget, io, big, 100);
  writeDiagLine(okTarget, io, big, 100);
  check("bounded: THREE over-cap writes leave at most two files, not three growing ones", Object.keys(io.files).sort(), [`${okTarget.ok ? okTarget.path : ""}${DIAG_ROTATE_SUFFIX}`].concat([okTarget.ok ? okTarget.path : ""]).sort());
  check("bounded: exactly ONE rename happened per overflow, and never more than one generation", io.renamed.length, 2);
}
{
  const io = fakeIo();
  for (let i = 0; i < 40; i++) writeDiagLine(okTarget, io, "y".repeat(30), 100);
  check(
    "the file cannot grow without bound under a steady belt: it stays at ~cap plus the rotated copy",
    Object.values(io.files).reduce((n, s) => n + s.length, 0) <= 100 + 30 + 100,
    true,
  );
}
{
  const boom: DiagIo = { ...fakeIo(), append: () => { throw new Error("EROFS: read-only"); } };
  const r = writeDiagLine(okTarget, boom, "hello\n", 1000);
  check("a failed write is RETURNED, and the record says which path", r.ok === false && /EROFS/.test(r.reason), true);
  const sink = makeDiagSink({ home: "/h" }, { nick: "flash1", now: () => "2026-10-24T20:00:00Z", io: boom });
  sink.write("ERROR", "first dropped line");
  check("...and through the sink it sets the one-time fault flag rather than printing", [sink.failed, /EROFS/.test(sink.reason)], [true, true]);
}
{
  const r = writeDiagLine(resolveDiagTarget({ env: "off" }), fakeIo(), "x\n", 1000);
  check("writing to an OFF target is a no-op with the reason, not an exception", [r.ok, r.ok === false && /not written/.test(r.reason)], [false, true]);
}

// --- 2b. the record itself -----------------------------------------------------------------
// LEG 522 RE-PAIR. The cell below used to build its message as
//   `dropped at ${redactUrl("mqtts://user:hunter2@...")}`
// — the fixture applied the function under test BEFORE handing the string over, so the formatter
// only ever saw a clean input and "the credential is redacted at the file boundary" asserted that a
// clean string stays clean. It could not go red for the reason it claimed to guard (peer 520 finding
// F, confirmed at two pens). The dirty string is now fed straight in, at BOTH positions, and the
// pre-fix run of this file is the proof the cell can bite.
const DIRTY_MID = "dropped at connect threw url=mqtts://user:hunter2@broker.example:1883 handshake";
const DIRTY_LEAD = "mqtts://user:hunter2@broker.example:1883";
const line = formatDiagLine({ ts: "2026-10-24T20:00:00Z", nick: "flash1", level: "ERROR", message: DIRTY_MID });
check("one record is ONE line (a newline in a message would forge a second record)", (line.match(/\n/g) ?? []).length, 1);
check("the credential in a MID-STRING url is redacted at the file boundary", /hunter2/.test(line), false);
check("...and the SAME secret is redacted when the url starts the message", /hunter2/.test(formatDiagLine({ ts: "T", nick: "n", level: "ERROR", message: DIRTY_LEAD })), false);
check("...and when TWO credential urls ride in one message", /hunter2/.test(formatDiagLine({ ts: "T", nick: "n", level: "ERROR", message: `a=mqtt://u1:hunter2@h1:1883 b=mqtts://u2:hunter2@h2:8883` })), false);
check("...and the stack field is under the same rule", /hunter2/.test(formatDiagLine({ ts: "T", nick: "n", level: "ERROR", message: "m", stack: `at connect (url mqtts://x:hunter2@h:8883)` })), false);
check("the non-secret part of the URL survives to be useful", /broker\.example:1883/.test(line), true);
check("the text BEFORE the url survives (a fix that blanks the message is a worse bug)", line.includes("dropped at connect threw url="), true);
check("the text AFTER the url survives", line.includes("handshake"), true);
check("the user name survives, only the secret is replaced", line.includes("user:***@broker.example:1883"), true);
check("the record names time, lane and level", line.startsWith("2026-10-24T20:00:00Z flash1 ERROR "), true);
check("NEGATIVE: a message with no url is returned untouched (no false rewriting)", formatDiagLine({ ts: "T", nick: "n", level: "INFO", message: "nothing credential-shaped here" }).endsWith(" nothing credential-shaped here\n"), true);
check(
  "a stack reaches the record only when the caller passes one (the sink gates it on TABICHAT_ERR_STACK)",
  formatDiagLine({ ts: "T", nick: "n", level: "ERROR", message: "m", stack: "at Socket.ondata (node:internal)" }).includes("stack="),
  true,
);
check(
  "NEGATIVE: no stack field when the caller passed none",
  formatDiagLine({ ts: "T", nick: "n", level: "ERROR", message: "m" }).includes("stack="),
  false,
);

// --- 3. THE ROUTING: a named-site DENYLIST, not a count -----------------------------------
/**
 * Every `console.error(` that may remain in index.ts, NAMED. Add a print at a new site and this
 * fails, which is the point: the approved list is a claim about specific places, so it is reviewable,
 * and a count would silently bless whatever was there the day it was written.
 */
const APPROVED_PRINT_SITES: { name: string; needle: string }[] = [
  { name: "notifySafely's catch — the ONE sink fallback when the UI is unreachable", needle: "      console.error(text);" },
  { name: "wake-line stderr sink handed to newSession (not an emitter call site)", needle: "stderr: (t) => console.error(t)," },
  { name: "stale-handle warning — no live ctx exists to notify through, so stderr is the only surface", needle: "console.error(staleHandleLine);" },
];
/** Every approved site, named, and every print that is NOT one of them. */
const scanPrints = (src: string) => {
  const hits: { at: number; line: string }[] = [];
  let at = src.indexOf("console.error(");
  while (at >= 0) {
    const lineStart = src.lastIndexOf("\n", at) + 1;
    const lineEnd = src.indexOf("\n", at);
    hits.push({ at, line: src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd).trim() });
    at = src.indexOf("console.error(", at + 1);
  }
  return hits;
};
// --- 3. THE ENTRY, EXECUTED (iid 11 AC4: "a test that only checks 'the line appears somewhere' would
//        have passed on the broken face"). Leg 954 found the three cells below this one — the mirror
//        regex, the sink regex, the `indexOf` ordering comparison — reading `index.ts` as TEXT, and
//        text is exactly what a broken face can still contain. So the claim moved here: the shipped
//        entry is IMPORTED and RUN, with the two surfaces recorded, with the presenter throwing, and
//        with a real diagnostic sink (an injected one, no disk) as the durable half. The text cells
//        stay underneath as a cheap belt — they are cheap, they catch a careless edit, and they are no
//        longer the thing this file claims.
//
// The three package externals are supplied the way `test_errnote.ts` and `test_renewal_realm.ts`
// already supply them: copy the ENTRY's three bare specifiers onto local stub modules and leave every
// relative import resolving for real. `index.ts` is the only file in the shipped set that names them
// (each token counted once across the 13 names), so one rewrite covers the graph.
const stubDir = mkdtempSync(join(tmpdir(), "iid11-entry-"));
// THE LISTENER IS KEPT, NOT DROPPED (leg 983, iid 11 finding L-2: "two text assertions, zero
// observations"). The stub records every `on(ev, fn)` the entry registers, so a cell can CALL the
// shipped `message` handler and raise `owedTurns` through the real inbound path instead of assuming
// it. The previous stub answered `on() {}` and dropped the listener, which is why no cell in this
// file could observe a owed-turn notice at all. Rebuilds the instrument the 978 reviewer built and
// left in tmpfs.
writeFileSync(join(stubDir, "mqtt.ts"), `export default { connect() {\n  const kept = (globalThis.__tabichatStubListeners ??= []);\n  const c = { on(ev, fn) { kept.push({ ev, fn }); return c; }, publish() {}, subscribe() {}, end() {}, removeAllListeners() {}, connected: false };\n  return c;\n} };\n`);
writeFileSync(join(stubDir, "pi-ai.ts"), `const T = new Proxy(function () {}, { get: () => T, apply: () => ({ type: "object" }) });\nexport const Type = T;\n`);
writeFileSync(join(stubDir, "pi-ca.ts"), `export const defineTool = (t) => t;\nexport const isToolCallEventType = () => false;\n`);

// EVERY SINK THE SHIPPED ENTRY CAN APPEND TO IS POINTED AT SCRATCH BEFORE THE ENTRY IS MOUNTED
// (iid 11 finding F-2). Measured on the face this leg started from:
// one run of this file grew `~/.pi/agent/tabichat-diag.log` by 4 `guarantee-973` lines and
// `/tmp/tabichat/lane-exits.log` by 2, because the fault this file provokes is recorded by the
// shipped gate into whatever sink the process has. Both sinks are resolved inside the factory, so
// setting them here — before any mount — is what makes the gate a reader of scratch, not a writer
// of the shared file a later lane greps.
const sinkDir = mkdtempSync(join(tmpdir(), "iid11-sinks-"));
process.env.MQTT_DIAG_LOG = join(sinkDir, "diag.log");
process.env.MQTT_EXIT_LOG = join(sinkDir, "lane-exits.log");
plugin({
  name: "iid11-entry-externals",
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
const ENTRY = await import("../extensions/tabichat/index.ts");
const { NOTICE_ARMS, noticeSurfaces, emitNotice, LOSS_KINDS, lossTellHeader, makeLossTeller } = ENTRY;

// (1) the arm set, read out of the shipped module rather than restated here — three arms, and the
// middle column is what `iid 11` never had written down.
check(`the entry exports its arms, and the set is the three shapes the row describes (${NOTICE_ARMS.length})`,
  NOTICE_ARMS.join(" "), "record-and-present present-only record-only");
check("record-and-present keeps AND shows", noticeSurfaces("record-and-present"), { record: true, present: true });
check("present-only shows and keeps NOTHING (the owner's input area is the point)", noticeSurfaces("present-only"), { record: false, present: true });
check("record-only keeps and shows NOTHING — kept quiet is a decision, not an oversight", noticeSurfaces("record-only"), { record: true, present: false });
check("NEGATIVE CONTROL: an arm nobody recognises still KEEPS the line rather than dropping it",
  noticeSurfaces("typo-arm" as never), { record: true, present: true });

// (2) the run. Every surface call is logged in order, so "the record happens first" is a measured
// sequence and not a comparison of two positions in a text file.
type Call = string;
const surfaceLog = (name: string, bag: { calls: Call[] }) => ({
  record: (t: string, stack?: string) => void bag.calls.push(`record:${t}${stack ? `|stack=${stack.slice(0, 12)}` : ""}`),
  present: (t: string, level: string) => void bag.calls.push(`present:${level}:${t}`),
});
const runArm = (arm: string, o: { level?: string; stack?: string; throws?: boolean } = {}) => {
  const bag = { calls: [] as Call[] };
  const surface = surfaceLog(arm, bag);
  const wrapped = {
    record: surface.record,
    present: (t: string, level: string) => {
      surface.present(t, level);
      if (o.throws) throw new Error("assertActive: this context is no longer active");
    },
  };
  let escaped = "";
  try {
    emitNotice(arm as never, "the line", wrapped, o.level ?? "warning", o.stack);
  } catch (e) {
    escaped = e instanceof Error ? e.message : String(e);
  }
  return { calls: bag.calls, escaped };
};

{
  const r = runArm("record-and-present");
  check("RECORDED THEN SHOWN: an error arm with a working UI, in that order", r.calls, ["record:the line", "present:error:the line"]);
  check("...and the level shown at the UI is the arm's error, whatever the caller passed", r.calls[1], "present:error:the line");
}
{
  // the face the row was filed for: the UI is DEAD (a disposed context throws `assertActive`), and
  // the record still exists. This is the ordering claim made in behaviour, not in text.
  const r = runArm("record-and-present", { throws: true });
  check("A DEAD UI CANNOT LOSE THE RECORD: the write happened first even though the presenter threw",
    r.calls, ["record:the line", "present:error:the line"]);
  check("...and the throw does not escape into the socket callback that made the call (the #585 family)",
    r.escaped, "");
}
{
  const r = runArm("present-only", { level: "warning" });
  check("a warning shows one line and keeps NOTHING — the quiet half of the one-sink rule", r.calls, ["present:warning:the line"]);
  const i = runArm("present-only", { level: "info" });
  check("...and the same is true of an informative line", i.calls, ["present:info:the line"]);
}
{
  const r = runArm("record-only", { stack: "at handleInbound (index.ts)" });
  check("an internal fault is kept, with its stack, and NOTHING is presented", r.calls, ["record:the line|stack=at handleInb"]);
}

// (3) redaction through the entry, on the real sink. The durable half is not a fake here: it is the
// shipped `makeDiagSink` over an injected io, so a credential that reaches the entry by any arm has
// to come out of the file redacted.
{
  const io = fakeIo();
  const sink = makeDiagSink({ home: "/h" }, { nick: "flash3", now: () => "2026-11-04T12:00:00Z", io });
  const dirty = "transport refused url=mqtts://user:hunter2@broker.example:1883";
  for (const arm of NOTICE_ARMS.filter((a: string) => a !== "present-only")) {
    emitNotice(arm as never, dirty, { record: (t, st) => sink.write("ERROR", t, st), present: () => {} }, "error");
  }
  const written = Object.values(io.files).join("");
  check("the credential is gone from the file on BOTH recording arms", /hunter2/.test(written), false);
  check("...and the useful half of it survives to be grepped", /broker\.example:1883/.test(written) || written.includes("broker.example:1883"), true);
  check("...and one record per arm, so the entry is not double-writing", (written.match(/\n/g) ?? []).length, 2);
  check("NEGATIVE: the sink was not asked to write for the showing-only arm", emitNotice("present-only" as never, dirty, { record: () => { io.renamed.push("FORBIDDEN"); }, present: () => {} }, "warning"), undefined);
  check("...confirmed: no extra record line appeared", Object.values(io.files).join("").match(/\n/g)!.length, 2);
}

const indexSrc = read("index.ts");

// --- 3a. THE LOSS TELLS (iid 11 piece 5): six kinds, executed, not read off a call site ----------
// The ruling promoted six of the fourteen record-only faults to the CHANNEL THE SEAT READS — never the
// operator's input area — and at most once per kind per session. `makeLossTeller` is exported and
// injected (redactor, budget) for exactly the reason `emitNotice` was: a claim that only exists as
// prose at one call site cannot be re-run by anyone.
{
  check("the promoted kinds are the six the ruling names, enumerated from the entry",
    (LOSS_KINDS as readonly string[]).join(" "),
    "journal-write-failed journal-not-prepared inbound-handler-threw park-overflowed inbound-not-parked sender-acl-inert");
  const told: string[] = [];
  const t = makeLossTeller(24_000, (x: string) => { told.push(x); return `R(${x})`; });
  check("a first fault queues a tell", t.tell("park-overflowed", "the line"), true);
  check("...and the SAME kind a second time does not — once per session per kind", t.tell("park-overflowed", "the line"), false);
  check("a DIFFERENT kind does queue", t.tell("inbound-not-parked", "other line"), true);
  check("nothing reached the redactor yet (telling is not delivering)", told.length, 0);
  const blk = t.peek();
  check("peek builds one batched block, header first", blk.startsWith(lossTellHeader(2)), true);
  check("...and it carries BOTH kinds", [blk.includes("park-overflowed"), blk.includes("inbound-not-parked")], [true, true]);
  check("...and every text goes THROUGH the redactor before the seat sees it", told.length, 2);
  check("peek does not commit: a second peek is the same block", t.peek(), blk);
  check("commit reports the two kinds it shipped", t.commit(), 2);
  check("...and the queue is empty after it", [t.pending(), t.peek()], [0, ""]);
  check("...and the kind is spent for the session: re-telling is refused", t.tell("park-overflowed", "again"), false);
  check("an empty teller ships nothing (never an empty turn of prose)", makeLossTeller(24_000, (x: string) => x).peek(), "");
  {
    // face 8 — the model channel carries fault text too, so the SHIPPED redactor runs through the
    // teller, not a stand-in: a credential URL in a fault message must not reach the seat.
    const { redactUrl } = await import("../extensions/tabichat/tlsopts.ts");
    const t = makeLossTeller(24_000, redactUrl);
    t.tell("park-overflowed", "dropped at connect url=mqtts://user:hunter2@broker.example:1883 handshake");
    const blk = t.peek();
    check("the credential never reaches the model channel", blk.includes("hunter2"), false);
    check("...and the useful half survives to be grepped", blk.includes("broker.example:1883"), true);
    check("...and the shipped flush injects that same redactor, not a test double",
      indexSrc.includes("makeLossTeller(HELD_FLUSH_MAX_CHARS, redactUrl)"), true);
  }
  // face 2 of the leg, executed per kind rather than asserted once: each of the six reaches the seat
  // channel on its own teller, and the second occurrence of the SAME kind ships nothing (face 4).
  for (const k of LOSS_KINDS as readonly string[]) {
    const one = makeLossTeller(24_000, (x: string) => x);
    const first = one.tell(k, `the ${k} fault text`);
    const shipped = one.peek();
    const n = one.commit();
    const second = one.tell(k, `the ${k} fault text again`);
    check(`  ${k}: one tell ships to the model channel, and a repeat ships nothing`,
      [first, shipped.includes(`- ${k}: the ${k} fault text`), n, second, one.peek()], [true, true, 1, false, ""]);
  }
}
{
  // face 3 — THE OVERSHOOT GUARD, written as numbers. All six faults fire in one session: the operator's
  // input area must receive NOTHING new (the record arm never presents), and the seat's own channel must
  // receive all six in ONE batched block, not six turns.
  const seenByUi: string[] = [];
  const one = makeLossTeller(24_000, (x: string) => x);
  for (const k of LOSS_KINDS as readonly string[]) {
    one.tell(k, `${k} text`);
    emitNotice("record-only" as never, `[tabichat] ${k}`, {
      record: () => {},
      present: (t: string) => { seenByUi.push(t); },
    }, "warning", "stack");
  }
  const block = one.peek();
  check("all six fired: the operator area received 0 lines (not 'a few', not 'mostly')", seenByUi.length, 0);
  check("...and the seat channel has ONE batched block carrying all six kinds",
    [1, (LOSS_KINDS as readonly string[]).filter((k) => block.includes(`- ${k}:`)).length], [1, 6]);
  check("...and it is one message, so six faults are not six interruptions", (block.match(/\n- /g) ?? []).length, 6);
}
{
  // face 6 — the budget survives the collision. The flush reserves room for the tell BEFORE planning,
  // so mentions that no longer fit are RE-HELD whole: cut by nothing, dropped by nothing.
  const MQ = await import("../extensions/tabichat/mentionq.ts");
  const mk = (id: string, n: number) => ({ id, nick: "x", ts: 1_700_000_000_000, body: "@" + "z".repeat(n) });
  const two = [mk("m1", 60), mk("m2", 60)];
  const loss = "x".repeat(80); // what the teller reserved
  const fit = MQ.planHeldFlush(two, MQ.HELD_FLUSH_MAX_LINES, 1_000 - loss.length);
  const tight = MQ.planHeldFlush(two, MQ.HELD_FLUSH_MAX_LINES, 100 - 0);
  check("two mentions and a pending tell: both mentions ship whole inside the reserved budget",
    [fit.send.length, fit.rehold.length, MQ.heldBatchChars(fit.send) + loss.length <= 1_000], [2, 0, true]);
  check("...and when the budget really bites, the tail stays HELD — it is never cut or dropped",
    [tight.send.length >= 1, tight.send.length + tight.rehold.length, tight.rehold.length > 0], [true, 2, true]);
  check("...and the reservation is arithmetic, not hope: the shipped flush subtracts the block it measured",
    indexSrc.includes("HELD_FLUSH_MAX_CHARS - (lossBlock ? lossBlock.length + 2 : 0)"), true);
}
{
  // The budget half: a block that does not fit says what stayed in the file, and never drops silently.
  const t = makeLossTeller(160, (x: string) => x);
  for (const k of ["journal-write-failed", "journal-not-prepared", "inbound-handler-threw", "park-overflowed"]) t.tell(k, "x".repeat(80));
  const wide = makeLossTeller(24_000, (x: string) => x);
  for (const k of ["journal-write-failed", "journal-not-prepared", "inbound-handler-threw", "park-overflowed"]) wide.tell(k, "y".repeat(20));
  check("with room to spare all four ship, and no leftovers are named", [4, /more kind\(s\)/.test(wide.peek())], [4, false]);
  const blk = t.peek();
  check("over budget: the block ships FEWER kinds than are queued (the budget bit, derived)", blk.includes("more kind(s) stayed"), true);
  check("...the first kind always ships whole (the planHeldFlush posture, not a cut line)", blk.includes("journal-write-failed"), true);
  check("...and what did not fit is NAMED, not silently lost", /stayed in the durable file, not dropped\./.test(blk), true);
  const left = Number((blk.match(/(\d+) more kind\(s\)/) ?? ["0", "0"])[1]);
  const shipped = (blk.match(/\n- [a-z-]+:/g) ?? []).length;
  check("...and the count of what stayed is the arithmetic of what is missing (nothing invented, nothing dropped)",
    [shipped + left, shipped >= 1], [4, true]);
}
{
  // The WIRING half: the six sites must actually call the helper, and the eight must not.
  const promoted = (indexSrc.match(/noticeLost\("/g) ?? []).length;
  const quiet = (indexSrc.match(/notice\("record-only"/g) ?? []).length;
  check(`the six promoted sites are wired (derived from the shipped file: ${promoted})`, promoted, 6);
  check(`the eight that stay quiet are still quiet, plus the helper's own record call (derived: ${quiet})`, quiet, 9);
  for (const k of LOSS_KINDS as readonly string[])
    check(`...and the kind ${k} is named at a call site`, indexSrc.includes(`noticeLost("${k}"`), true);
  const stripped = indexSrc.replace(/noticeLost\("/g, 'noticeRecordOnly("');
  check("NEGATIVE CONTROL: a file that promotes nothing is REPORTED by the same count (so the census can fail)",
    (stripped.match(/noticeLost\("/g) ?? []).length, 0);
  check("...and the rewrite did not just delete them: the six calls are still there under another name",
    (stripped.match(/noticeRecordOnly\("/g) ?? []).length, 6);
  const extra = indexSrc + '\n      noticeLost("made-up-kind", "x");';
  check("...and a seventh kind is REPORTED too (it counts, it does not match a list)",
    (extra.match(/noticeLost\("/g) ?? []).length, 7);
}
{
  // The channel half of the ruling: this leg adds NO print to the operator's area. Counted on the
  // shipped bytes, and the count is printed in the cell name so a future drift is visible as a number.
  const ui = (indexSrc.match(/\.ui\.notify\(/g) ?? []).length;
  check(`no new ui.notify site: the shipped file still holds ${ui} of them`, ui, 44);
  const errUi = (indexSrc.match(/\.ui\.notify\([^)\n]*"error"/g) ?? []).length;
  check(`...and none of them is an error-level print outside the entry (derived: ${errUi})`, errUi, 0);
}
const approvedLines = new Set(APPROVED_PRINT_SITES.map((a) => a.needle.trim()));
const prints = scanPrints(indexSrc);
const unapproved = prints.filter((p) => !approvedLines.has(p.line));
check(`every console.error in index.ts is a NAMED approved site (found ${prints.length}, approved list ${APPROVED_PRINT_SITES.length})`, unapproved.map((p) => p.line), []);
check(
  "the approved list matches the file exactly — a site REMOVED from the list must be removed here too (so this list cannot silently bless a print that no longer exists)",
  APPROVED_PRINT_SITES.filter((a) => !indexSrc.includes(a.needle.trim())).map((a) => a.name),
  [],
);
/** The entry's one ordering claim, as a predicate so the negative control can run it too. */
const recordsBeforeShowing = (src: string) =>
  src.indexOf("if (half.record) surface.record(text, stack);") < src.indexOf("surface.present(text, arm ===");
// BELTS, and only belts. Each one is cheap and each one can go red on a careless edit; none of them
// is the claim any more, because all three were reading a source line that `iid 11`'s own AC4 says a
// broken face could still contain. The claims are the executed cells above.
check("the belt is still ONE sink: stderr only inside the catch", /surface\.present\(text, arm === "record-and-present"[^)]*\);\s*\} catch \{\s*console\.error\(text\);/.test(indexSrc), true);
check("the entry still asks the table, never a level test, whether to keep the line", /if \(half\.record\) surface\.record\(text, stack\);/.test(indexSrc), true);
check("...and the record call still sits BEFORE the presentation call inside the entry", recordsBeforeShowing(indexSrc), true);
// the same predicate over a source whose two calls are the other way round: if this ever prints
// `false` for the shipped file and `true` here, the ordering cell is measuring something.
check("NEGATIVE CONTROL: the ordering predicate says NO to a source that presents first",
  recordsBeforeShowing('surface.present(text, arm === "x"); if (half.record) surface.record(text, stack);'),
  false,
);

check("the sink is installed once, from the env/site/home layers", /makeDiagSink\(\s*\{ env: process\.env\[DIAG_ENV\], site: siteConfig\[DIAG_SITE_KEY\], home: process\.env\.HOME \}/.test(indexSrc), true);
check("the real-fs IO is the only place append/rename/stat are reached for diagnostics", /makeDiagIo\(\{ appendFileSync, renameSync, statSync, mkdirSync \}\)/.test(indexSrc), true);
/**
 * Does a message reach the file through a `diag(` call? Whitespace is flattened FIRST and the test is
 * a substring of the flat source, not a hand-escaped regex: these calls wrap across lines, and the
 * first version of the four cells below wrote the pattern with the template literal's backtick on the
 * wrong side of the `\[`, so it read a ROUTED line as an unrouted one — an empty result from a pattern
 * that could never have hit, which is this box's oldest instrument fault. Printing the failure is what
 * caught it: a check that cannot fail tells you nothing about the world.
 */
const flatSrc = indexSrc.replace(/\s+/g, " ");
/**
 * Is this message routed to the durable file? Both spellings count, because leg 954 moved the record
 * decision into the entry: `notice("record-only", …)` is the arm, and `diag("ERROR", …)` remains
 * legitimate ONLY as the entry's own surface binding — the census below is what keeps it there.
 */
const diagCall = (level: string, msgStart: string): boolean =>
  flatSrc.includes(`diag("${level}", \`${msgStart}`) ||
  flatSrc.includes(`notice("record-only", \`${msgStart}`) ||
  // leg 962 (iid 11 piece 5): a PROMOTED fault still records through the entry — `noticeLost`'s own body
  // is `notice("record-only", text, o)` — and additionally queues a tell for the seat. The routing claim
  // is unchanged, so the spelling is accepted; it is not a licence, because the kind has to be one of the
  // six the entry enumerates, and the negative control below proves a bare terminal print is still NO.
  (LOSS_KINDS as readonly string[]).some((k) => flatSrc.includes(`noticeLost("${k}", \`${msgStart}`));
check("NEGATIVE CONTROL: the routing predicate still says NO to a line that is only printed",
  (() => {
    const f = "console.error(`[tabichat] inbound line dropped, handler threw: x`);".replace(/\s+/g, " ");
    return (
      (LOSS_KINDS as readonly string[]).some((k) => f.includes(`noticeLost("${k}", \`[tabichat] inbound line dropped`)) ||
      f.includes('diag("ERROR", `[tabichat] inbound line dropped') ||
      f.includes('notice("record-only", `[tabichat] inbound line dropped')
    );
  })(),
  false);
/**
 * Is this message printed to the terminal — i.e. is there a `console.error(` whose first argument begins
 * with this text? FOUND BY THIS LEG to have been an inert predicate (iid 13 follow-on, leg 969): the shipped
 * needle was `flatSrc.includes(`console.error( \`${msgStart}`)` — a SPACE between the paren and the backtick —
 * while `flatSrc` is `indexSrc.replace(/\s+/g, " ")`, which turns every whitespace run into exactly one space.
 * A source written with no space flattens to no space, so the spaced needle could never match the shape the
 * real file uses; `!consoleCall(…)` below was true because the predicate could not fire, not because the
 * routing is clean.
 *
 * Removing that one space fixes the case the file actually contains, and ONLY that case: a print written as
 * `console.error( \`x\` )`, or with the template literal on the next line, flattens to a single space and
 * would still read clean. So the needle here is whitespace-tolerant between the paren and the opening
 * quote/backtick, and runs on the RAW source rather than the flattened one — `\s*` spans newlines too. It
 * accepts a quote or a backtick, because the approved shapes in this file are `console.error(text)`,
 * `console.error(t)` and `console.error(staleHandleLine)` and a future `console.error("[tabichat] …")` is
 * the same defect in a different quote.
 */
const consoleCallIn = (src: string, msgStart: string): boolean => {
  const needle = msgStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`console\\.error\\(\\s*[\`\'\"]\\s*${needle}`).test(src);
};
const consoleCall = (msgStart: string): boolean => consoleCallIn(indexSrc, msgStart);
{
  const noSpace = consoleCallIn("  const a = 1;\n  console.error(`[tabichat] inbound line dropped, handler threw: x`);\n", "[tabichat] inbound line dropped");
  check("CONTROL: the needle CAN fire — a template-literal print is reported (a predicate never shown nonzero has never measured a zero)", noSpace, true);
  check("...and it fires on the same print written with a space and a newline after the paren, which the old needle could not see",
    consoleCallIn("console.error(\n  `[tabichat] inbound line dropped, handler threw: x`,\n)", "[tabichat] inbound line dropped"), true);
  check("...and it fires on a double-quoted print, so the defect does not return in another quote",
    consoleCallIn('console.error("[tabichat] inbound line dropped, handler threw")', "[tabichat] inbound line dropped"), true);
  check("...and it says NO to a source that only records the line (the shape the routing rule wants)",
    consoleCallIn('notice("record-only", `[tabichat] inbound line dropped, handler threw`)', "[tabichat] inbound line dropped"), false);
  check("NEGATIVE CONTROL ON THE OLD NEEDLE ITSELF: the shipped spaced form reads a real print as clean, which is the defect being closed",
    "console.error(`[tabichat] inbound line dropped".includes("console.error( `[tabichat] inbound line dropped"), false);
  const realSites = (indexSrc.match(/console\.error\(/g) ?? []).length;
  const realTemplate = (indexSrc.match(/console\.error\(\s*[`'"]/g) ?? []).length;
  printf_(`note  the real index.ts at this face: ${realSites} console.error( call sites, ${realTemplate} of them begin their argument with a quote or backtick — so the routing cell's zero is now a measurement, not an absent instrument.\n`);
}

check(
  "the owner's reported line is routed: `[tabichat] inbound line dropped, handler threw` reaches the FILE, not the terminal",
  diagCall("ERROR", "[tabichat] inbound line dropped, handler threw") && !consoleCall("[tabichat] inbound line dropped"),
  true,
);
check("the parked-replay family is file-only too", diagCall("ERROR", "[tabichat] parked line replay threw"), true);
check("the authorship-conflict drop is file-only", diagCall("ERROR", "[tabichat] line dropped, authorship conflict"), true);
check(
  "the ctl admission notes are file-only (all three, named)",
  ["[tabichat][ctl] replaying", "[tabichat][ctl] superseded control line", "[tabichat][ctl] held control line"].every((m) => diagCall("INFO", m)),
  true,
);
check(
  "STARTUP faults keep an operator surface: the broker refusal still notifies AND is recorded",
  indexSrc.includes('notifySafely(ctx, brokerRefusal, "error")') && !/ctx\.ui\.notify\(brokerRefusal/.test(indexSrc),
  true,
);
check(
  "the renew-latch refusal keeps its notify and is now recorded, not printed",
  flatSrc.includes('ctx.ui.notify(`[tabichat][renew] ${latch.reason}`, "warning")') && diagCall("WARN", "[tabichat][renew] ${latch.reason}"),
  true,
);
check("the stale-handle warning is BOTH surfaces (no live ctx exists, so stderr is the only one it CAN have)", indexSrc.includes('notice("record-only", staleHandleLine)') && indexSrc.includes("console.error(staleHandleLine)"), true);
check("a refused destination is said ONCE at startup, and a deliberate `off` prints nothing", /if \(!DIAG\.target\.ok && !DIAG\.target\.deliberate\)/.test(indexSrc), true);
check(
  "a dropped write is told ONCE (the fault is loud), and never per line (that would rebuild the flood)",
  /if \(DIAG\.failed && !diagFaultTold\)/.test(indexSrc) && indexSrc.includes("diagnostics are being DROPPED, not printed"),
  true,
);
check("TABICHAT_ERR_STACK no longer has a bare print of its own", /if \(process\.env\.TABICHAT_ERR_STACK === "1"\)\s*console\.error/.test(indexSrc), false);

// --- 3d. A BYPASS CANNOT SURVIVE (piece 3). Derived every run, printed every run, asserted as a
// PAIRING property rather than a number: the count of error-level `ui.notify` calls outside the entry
// today is 2, tomorrow it is whatever somebody makes it, and `iid 11`'s own body is the proof that a
// hand-carried site count rots (it shipped "8 sites / 3-4-1" for a file that now holds 9).
/**
 * Every raw `.ui.notify(…, "error")` in a source, each judged by the same question a reviewer would
 * ask: is the record for THIS text present in the same statement? String containment, not a regex built
 * out of the subject — the first draft of this function assembled a RegExp from source text and threw
 * on a newline inside the character class, which is the oldest way to turn a gate into a crash.
 */
/** The three spellings a record for THIS subject can take, one of which is the entry itself. */
const RECORD_CALLS = (subject: string) => [
  `diag("ERROR", ${subject}`,
  `DIAG.write("ERROR", ${subject}`,
  `notice("record-only", ${subject})`,
  `notice("record-and-present", ${subject})`,
];
const errorNotifies = (src: string) => {
  const lines = src.split("\n");
  const found: { line: number; text: string; subject: string; paired: boolean }[] = [];
  lines.forEach((l, i) => {
    if (!/\.ui\.notify\([^)]*"error"/.test(l)) return;
    const subject = (l.match(/\.ui\.notify\(\s*([^,)]+)/)?.[1] ?? "").trim();
    const window = lines.slice(Math.max(0, i - 2), i + 6).join("\n");
    found.push({
      line: i + 1,
      text: l.trim(),
      subject,
      paired: subject !== "" && RECORD_CALLS(subject).some((call) => window.includes(call)),
    });
  });
  return found;
};
{
  const found = errorNotifies(indexSrc);
  const unpaired = found.filter((f) => !f.paired).map((f) => `:${f.line} ${f.text}`);
  check(
    `every raw error-level notify in the shipped file already sits beside its record (derived: ${found.length} site(s), ${found.length - unpaired.length} paired)`,
    unpaired,
    [],
  );
  const plant = ['      ctx.ui.notify(theLoneRefusal, "error");', "      return;"].join("\n");
  const p = errorNotifies(plant);
  check("NEGATIVE CONTROL: a raw error notify with no record beside it is REPORTED, by line",
    p.length === 1 && p[0].paired === false, true);
  const pairedPlant = ['      ctx.ui.notify(theLoneRefusal, "error");', '      diag("ERROR", theLoneRefusal);'].join("\n");
  const q = errorNotifies(pairedPlant);
  check("...and the SAME instrument stays quiet when the record is there (so it is not 'everything fails')",
    q.length === 1 && q[0].paired === true, true);
  const armPlant = ['      ctx.ui.notify(theLoneRefusal, "error");', '      notice("record-only", theLoneRefusal);'].join("\n");
  check("...and it accepts the entry's own record arm as the pairing, not only a hand-written call",
    errorNotifies(armPlant)[0].paired, true);
  check("CONTROL: the census is reading a non-empty list somewhere (an empty instrument is the old sin)",
    p.length + q.length, 2);
}

// --- 3b. it must be WIRED, or it is decoration (audit iid 13) ------------------------------
const deploy = readFileSync(join(import.meta.dir, "deploy-tabichat.sh"), "utf8");
const gatesLine = (deploy.match(/^\s*GATES=\((.*)\)$/m) ?? ["", ""])[1];
check("this gate is IN the deploy GATES array (a gate nobody runs is not a gate)", gatesLine.includes("test_diaglog_routing.ts"), true);
check("and the new module is in the deploy FILES array, dependencies before index.ts", (() => { const filesLine = (deploy.match(/^\s*FILES=\((.*)\)$/m) ?? ["", ""])[1]; const parts = filesLine.split(/\s+/); return parts.indexOf("diaglog.ts") >= 0 && parts.indexOf("diaglog.ts") < parts.indexOf("index.ts"); })(), true);
check("NEGATIVE CONTROL: a new module added to the extension but not to FILES is refused by the same instrument", (() => { const parts = ((deploy.match(/^\s*FILES=\((.*)\)$/m) ?? ["", ""])[1]).split(/\s+/); return !parts.includes("nonexistent_module.ts"); })(), true);

// --- 4. THE NEGATIVE CONTROL: prove the scanner can bite -----------------------------------
const rogueName = "synthetic rogue print is REPORTED";
{
  const synth = [
    "const ok = 1;",
    "      console.error(text);", // looks like the approved catch fallback
    "        console.error(`[tabichat] brand new rogue print nobody approved`);",
  ].join("\n");
  const p = scanPrints(synth);
  const bad = p.filter((h) => !approvedLines.has(h.line));
  check(rogueName, bad.length >= 1 && bad.some((b) => /rogue print nobody approved/.test(b.line)), true);
  check("...and the approved-looking line in the SAME sample is NOT reported (so the control is not just 'everything fails')", bad.filter((b) => b.line === "console.error(text);").length, 0);
}
{
  // The denylist half: an approved needle that is no longer in the source must be named.
  const shrunk = indexSrc.replace("console.error(staleHandleLine);", "console.error(someOtherThing);");
  check("NEGATIVE CONTROL: deleting an approved print without deleting its entry is REPORTED", APPROVED_PRINT_SITES.filter((a) => !shrunk.includes(a.needle.trim())).map((a) => a.name).length, 1);
}


// ─── 7. THE GUARANTEE (iid 11 piece 5 follow-on, leg 973) ──────────────────────────────────────
// What is claimed: a seat is told it lost work even when nobody talked to it. The tell used to ride
// the held flush, so on a quiet room the tell stayed queued and unspent — not muted by design, just
// never reached. These cells run the shipped settle handler itself against a recording ExtensionAPI:
// the fault is produced by the shipped producer, the block is built by the shipped teller, and the
// send is the shipped `sendUser` binding. Nothing here is a re-implementation of that path.
// WHAT IS STUBBED: the three package externals (as above) and `mqtt.connect`, which returns an
// in-memory client so no socket exists in this run. No broker, no network, no seat restart.
{
  console.log("\n== THE GUARANTEE — the settle handler, executed ==");
  const blockedRoot = mkdtempSync(join(tmpdir(), "iid11-guarantee-"));
  const asFile = join(blockedRoot, "is-a-file");           // a parent that cannot hold a directory
  writeFileSync(asFile, "x");
  const goodRoot = join(blockedRoot, "writable");
  mkdirSync(goodRoot);

  type Rec = { ev: string; fn: (...a: never[]) => unknown };
  const makePi = (who = "guarantee-973") => {
    const handlers: Rec[] = [];
    const sends: string[] = [];
    const notifies: string[] = [];
    const flags: Record<string, unknown> = { tabichat: true, room: who };
    const base: Record<string, unknown> = {
      on: (ev: string, fn: (...a: never[]) => unknown) => void handlers.push({ ev, fn }),
      getFlag: (name: string) => flags[name],
      registerFlag: () => undefined,
      registerCommand: () => undefined,
      registerTool: () => undefined,
      sendUserMessage: (text: string) => void sends.push(String(text)),
    };
    const pi = new Proxy(base, {
      get(t, p: string) {
        if (p in t) return t[p];
        return () => undefined;
      },
    });
    return { pi, handlers, sends, notifies };
  };
  // `idle` is the option-B gate input: the shipped decision reads `runActive && !liveCtx().isIdle()`,
  // so a cell that wants a mention HELD has to answer isIdle() false. It defaulted to the old truthy
  // object, which is what every pre-983 call in this file saw.
  // `idle` may be a GETTER: the option-B gate calls `liveCtx().isIdle()`, and the live handle is the
  // one this lane registered at `session_start` — not the fresh ctx each event is fired with. A cell
  // that wants a mention HELD has to move the handle the gate actually reads.
  const mkCtx = (notifies: string[], who = "guarantee-973", idle: boolean | (() => boolean) = true) =>
    new Proxy({ ui: { setStatus: () => undefined, notify: (t: string) => void notifies.push(String(t)), setWidget: () => undefined },
      cwd: blockedRoot, messages: [], sessionId: who,
      isIdle: () => (typeof idle === "function" ? idle() : idle),
      getContextUsage: () => ({ percent: 1, tokens: 1, contextWindow: 1_000_000 }) } as Record<string, unknown>, {
      get(t, p: string) { if (p in t) return t[p]; return () => ({ percent: 1, tokens: 1, window: 1 }); },
    });
  const fire = async (handlers: Rec[], ev: string, notifies: string[], o: { who?: string; idle?: boolean | (() => boolean) } = {}) => {
    for (const h of handlers.filter((x) => x.ev === ev)) {
      try { await (h.fn as (e: unknown, c: unknown) => Promise<unknown>)({ type: ev }, mkCtx(notifies, o.who, o.idle)); } catch { /* handler belts are its own cells' business */ }
    }
  };

  // G1 — the shipped shape: the tell is measured BEFORE the quiet-room branch, and that branch sends
  // it alone. Pinned by stable fragments, so a rewrap of the prose cannot redden this.
  const guarSrc = indexSrc;
  check("G1 the quiet-room branch ships the tell alone", guarSrc.includes('sendUser(lossBlock, { expandPromptTemplates: false });'), true);
  check("G1 and the tell is measured above that branch, not below it",
    guarSrc.indexOf("const lossBlock = lossTeller.peek();") < guarSrc.indexOf("if (!held.length) {"), true);
  check("G1 the held path still welds the tell to the batch it already made",
    guarSrc.includes("sendUser(`${lossBlock}${lossBlock ? \"\\n\\n\" : \"\"}${heldHeader(send.length)}"), true);
  check("G1 the retired comment is gone: the tell no longer claims to ship only on a send that was happening anyway",
    /ONLY place it ships/.test(guarSrc), false);
  check("G1 and the replacement sentence states the price it bought",
    guarSrc.includes("The price is the extra turn this send starts"), true);

  // G2 — THE POSITIVE, EXECUTED: a quiet room, one real fault, exactly one send carrying it.
  process.env.MQTT_ROOMLOG = join(asFile, "sub", "journal.jsonl");
  process.env.MQTT_NICK = "guarantee-973";
  const g2 = makePi();
  ENTRY.default(g2.pi as never);
  const g2events = g2.handlers.map((h) => h.ev);
  await fire(g2.handlers, "session_start", g2.notifies);      // the shipped producer runs here
  await fire(g2.handlers, "agent_settled", g2.notifies);      // nothing is held on this lane
  const g2loss = g2.sends.filter((t) => t.startsWith(lossTellHeader(1)));
  check("G2 a quiet lane with a pending tell gets exactly one send (sends=" + g2.sends.length + ")", g2.sends.length, 1);
  check("G2 that send IS the tell, header and kind named", g2loss.length, 1);
  check("G2 and it carries the kind the shipped producer queued",
    g2loss[0]?.includes("- journal-not-prepared:") ?? "", true as unknown as string);
  check("G2 nothing reached the operator's typing area from the fault tell (ui.notify lines naming it: 0)",
    g2.notifies.filter((n) => n.includes("[tabichat][loss]")).length, 0);
  check("G2 the tell was spent, so the next settle cannot repeat it", await (async () => {
    const before = g2.sends.length;
    await fire(g2.handlers, "agent_settled", g2.notifies);
    return g2.sends.length === before;
  })(), true);
  check("G2 the handler set this lane registered (session_start + agent_settled both present)",
    [g2events.includes("session_start"), g2events.includes("agent_settled")], [true, true]);

  // G3 — THE CONTROL: same handler, no fault, quiet room → no invented turn.
  process.env.MQTT_ROOMLOG = join(goodRoot, "journal.jsonl");
  const g3 = makePi();
  ENTRY.default(g3.pi as never);
  await fire(g3.handlers, "session_start", g3.notifies);
  await fire(g3.handlers, "agent_settled", g3.notifies);
  check("G3 a quiet lane with NOTHING pending sends nothing (=0)", g3.sends.filter((t) => t.includes("[tabichat][loss]")).length, 0);

  // G4 — flushedThisRun: the tell-only send is OUR send, so the owed-turn notice is suppressed for
  // that turn; the control lane, which was never interrupted, still hears it. Both outcomes executed.
  const owedNotice = (list: string[]) => list.filter((n) => n.includes("nothing was published")).length;
  check("G4 the tell-only branch sets the flag before it commits (source)",
    indexSrc.indexOf("flushedThisRun = true;\n      // committed only once the text was handed over") > 0, true);
  check("G4 and the tell-only path is the only new setter of it (one added line, not a move)",
    (indexSrc.match(/flushedThisRun = true;/g) ?? []).length, 2);

  // G5 — the ceiling, executed on the shipped teller: six kinds, ONE block, and once per kind.
  const six = makeLossTeller(24_000, (x) => x);
  const sixAccepted = (LOSS_KINDS as readonly string[]).map((k) => six.tell(k, `probe ${k}`));
  const sixBlock = six.peek();
  check("G5 all six kinds were accepted on a fresh teller", sixAccepted.filter(Boolean).length, 6);
  check("G5 and they batch into ONE block naming all six",
    [sixBlock.split("\n").length - 1, (LOSS_KINDS as readonly string[]).filter((k) => sixBlock.includes(`- ${k}:`)).length], [6, 6]);
  check("G5 a repeated kind is refused before it can queue", six.tell("journal-not-prepared", "again"), false);
  check("G5 commit spends exactly what the block carried (=6)", six.commit(), 6);
  check("G5 and after the commit nothing is pending, so the next settle sends nothing", [six.pending(), six.peek()], [0, ""]);

  // G6 — F3, made honest: a budget-truncated tail is NOT marked told. Paired negative for G5's `6`.
  const tight = makeLossTeller(160, (x) => x);
  (LOSS_KINDS as readonly string[]).forEach((k) => tight.tell(k, `text for ${k} that is long enough to matter`));
  const tightBlock = tight.peek();
  const shownKinds = (LOSS_KINDS as readonly string[]).filter((k) => tightBlock.includes(`- ${k}:`)).length;
  check("G6 a small budget truncates the block (kinds shown < 6)", shownKinds < 6, true);
  check("G6 and it says so on the face of the block", tightBlock.includes("more kind(s) stayed in the durable file"), true);
  check("G6 commit spends ONLY the kinds that were carried", tight.commit(), shownKinds);
  check("G6 the unshipped tail is still pending, not silently told", tight.pending(), 6 - shownKinds);
  const secondBlock = tight.peek();
  check("G6 and the next settle offers the tail again rather than losing it",
    (LOSS_KINDS as readonly string[]).filter((k) => !tightBlock.includes(`- ${k}:`) && secondBlock.includes(`- ${k}:`)).length >= 1, true);
  // The property that matters across settles: every kind ships exactly once, in as many settles as the
  // budget needs. A kind is never counted told by a block that did not carry it, and never told twice.
  const drained: string[] = [...(LOSS_KINDS as readonly string[]).filter((k) => tightBlock.includes(`- ${k}:`))];
  let rounds = 1;
  while (tight.pending() > 0 && rounds <= 6) {
    const b2 = tight.peek();
    const n2 = tight.commit();
    for (const k of LOSS_KINDS as readonly string[]) if (b2.includes(`- ${k}:`) && !drained.includes(k)) drained.push(k);
    if (n2 === 0) break;
    rounds++;
  }
  check("G6 every kind is eventually carried, once each (6 kinds, " + rounds + " settles)", drained.length, 6);
  check("G6 and nothing is left pending when the drain finishes", tight.pending(), 0);
  check("G6 the drain never exceeded the number of kinds (no spinning)", rounds <= 6, true);
  check("G6 NEGATIVE CONTROL: marking every queued kind told is no longer what commit() does",
    (makeLossTeller(160, (x) => x), (() => {
      const t = makeLossTeller(160, (x) => x);
      LOSS_KINDS.forEach((k) => t.tell(k, `text for ${k} that is long enough to matter`));
      t.peek();
      return t.commit() === 6;
    })()), false);


  // ==========================================================================
  // L-1 (iid 11, raised by the 978 review): THE OWED-TURN SUPPRESSION MUST EXPIRE
  // IN THE RUN THAT CAUSED IT. Every number below is an OBSERVATION taken by
  // calling the shipped handlers: the shipped `message` listener raises `owedTurns`,
  // the shipped `agent_settled` does the flush, the shipped `agent_end` decides the
  // notice. This is the cell class finding L-2 said did not exist — it goes red if
  // the suppression stops working, and it goes red for the reason, in words.
  // ==========================================================================
  const keptListeners = (): { ev: string; fn: (...a: never[]) => unknown }[] =>
    ((globalThis as Record<string, unknown>).__tabichatStubListeners ?? []) as { ev: string; fn: (...a: never[]) => unknown }[];
  let injectSeq = 0;
  // One room line, driven through the inbound path the seat actually uses. The RECIPIENT FIELD
  // decides everything (mention.ts:receives), so an addressed line raises `owedTurns` and an
  // unaddressed one is buffer-only and owes nothing.
  const injectLine = (who: string, from: string, to: string) => {
    const l = keptListeners().filter((x) => x.ev === "message").pop();
    if (!l) throw new Error("no shipped `message` listener is captured: this instrument cannot reach the inbound path");
    (l.fn as (t: string, p: Buffer) => void)(`chat/${who}`, Buffer.from(JSON.stringify({
      nick: from, message: `@${to} the floor moved`, to, id: `l1-${who}-${++injectSeq}`, ts: Date.now(),
    })));
  };
  // `busy` is the knob the option-B gate reads: `liveCtx().isIdle()` answers from this box, so a cell
  // sets it false to be mid-run (mention held) and true to be idle (mention delivered).
  type Lane = { handlers: Rec[]; sends: string[]; notifies: string[]; busy: { idle: boolean } };
  const mountQuiet = async (who: string, roomlog: string): Promise<Lane> => {
    process.env.MQTT_NICK = who;
    process.env.MQTT_ROOM = who;
    // A URL the STUBBED client never dials. broker.ok has to be true or the entry never registers a
    // `message` listener at all; an in-memory client means no socket, no broker, no network here.
    process.env.MQTT_URL = "mqtt://127.0.0.1:18830";
    process.env.MQTT_ROOMLOG = roomlog;
    const lane = makePi(who);
    ENTRY.default(lane.pi as never);
    keptListeners().length = 0;              // only THIS mount's listeners, whatever an earlier cell left
    const busy = { idle: true };
    for (const h of lane.handlers.filter((x) => x.ev === "session_start")) {
      await (h.fn as (e: unknown, c: unknown) => Promise<unknown>)({ type: "session_start" },
        mkCtx(lane.notifies, who, () => busy.idle));
    }
    return { ...lane, busy };
  };
  // One run, in the order pi emits it: the turn ends, then it settles.
  const oneTurn = async (lane: Lane, who: string, idle = true) => {
    await fire(lane.handlers, "agent_start", lane.notifies, { who, idle });
    await fire(lane.handlers, "agent_end", lane.notifies, { who, idle });
    await fire(lane.handlers, "agent_settled", lane.notifies, { who, idle });
  };

  // THE INSTRUMENT'S OWN POSITIVE CONTROL, before any zero below means anything: prove this harness
  // can reach the inbound path and can produce a notice at all (root AGENTS.md §1).
  {
    const who = "expiry-983ctl";
    const lane = await mountQuiet(who, join(goodRoot, "ctl.jsonl"));
    check("E0 the mount registered the shipped inbound listener (captured: 1)",
      keptListeners().filter((x) => x.ev === "message").length, 1);
    await oneTurn(lane, who);
    const owedBefore = owedNotice(lane.notifies);
    injectLine(who, "peer", who);
    await oneTurn(lane, who);
    check("E0 CONTROL: a mention driven through it raises one owed-turn notice (+1)",
      owedNotice(lane.notifies) - owedBefore, 1);
  }

  // (a) THE L-1 FACE: a tell-only send lands in a turn that owes no notice. The flag must die there,
  // so the NEXT owed turn still hears it. Pre-fix this lane lost that notice — the reviewer's
  // `[0,1,2,3]` versus `[1,2,3,4]`, reproduced here as one number.
  {
    const who = "expiry-983a";
    const lane = await mountQuiet(who, join(asFile, "sub", "journal.jsonl"));   // unwritable: a real fault, a real tell
    await oneTurn(lane, who);
    check("E1(a) a quiet lane with a pending tell shipped it as its own single send (=1)",
      lane.sends.filter((t) => t.startsWith(lossTellHeader(1))).length, 1);
    await oneTurn(lane, who);                                                   // the tell's OWN turn: nothing owed it
    check("E1(a) that notice-free turn printed no notice (=0), and spent the flag",
      owedNotice(lane.notifies), 0);
    injectLine(who, "peer", who);
    await oneTurn(lane, who);
    check("E1(a) THE EXPIRY: the following owed turn's notice FIRES (=1; it was 0 with the flag left armed)",
      owedNotice(lane.notifies), 1);
  }
  // The reviewer's own measurement, executed here rather than quoted: four genuinely owed turns AFTER a
  // tell, and the running notice count. Armed-and-carried reads [0,1,2,3] — one turn's notice is lost.
  // Expired-in-its-own-run reads [1,2,3,4]: every owed turn still hears it.
  {
    const who = "expiry-983vec";
    const lane = await mountQuiet(who, join(asFile, "sub", "journal.jsonl"));
    // kind 1 (`journal-not-prepared`) is already queued by the mount. Queue kind 2 with a line that
    // addresses nobody — it journals, and an unjournalable journal is the shipped producer's fault —
    // then spend BOTH tells before the measured turns. What follows then contains no fault at all,
    // so the only variable left is whether the flag expired in the run that armed it.
    injectLine(who, "peer", "someone-else");
    await oneTurn(lane, who);                                   // this settle ships the tell and arms the flag
    await oneTurn(lane, who);                                   // its own turn owes nothing: the flag expires here
    check("E1(a) both kinds went out in one tell before the count starts (loss sends=1)",
      lane.sends.filter((t) => t.includes("[tabichat][loss]")).length, 1);
    const vec: number[] = [];
    for (let i = 0; i < 4; i++) {
      injectLine(who, "peer", who);
      await oneTurn(lane, who);
      vec.push(owedNotice(lane.notifies));
    }
    check("E1(a) four genuinely owed turns after a tell, counted: the vector is [1,2,3,4], not [0,1,2,3]",
      vec.join(","), "1,2,3,4");
    // `4 - the last count` is the lost-notice figure the review quoted (lost 1 of 4 before, 0 of 4
    // after). A vector that merely SHIFTED would not be caught by comparing positions, and a count
    // that stopped rising is the harm: one turn, once, silently.
    check("E1(a) ...so notices lost across those four turns (4 - last count)", 4 - vec[3], 0);
  }

  // (b) THE CASE THAT ALREADY WORKS, held as a non-regression: a held-batch flush is a send the lane
  // did not choose, so its own owed turn is silenced exactly ONCE — and the debt still stands.
  {
    const who = "expiry-983b";
    const lane = await mountQuiet(who, join(goodRoot, "held.jsonl"));
    await fire(lane.handlers, "agent_start", lane.notifies, { who });
    lane.busy.idle = false;                             // mid-run: the next mention is held, not injected
    injectLine(who, "peer", who);                       // lands while the run is in flight -> held
    await fire(lane.handlers, "agent_end", lane.notifies, { who });
    const before = lane.sends.length;
    await fire(lane.handlers, "agent_settled", lane.notifies, { who });
    lane.busy.idle = true;                              // the flush's own turn is running, and idle
    check("E2(b) the held batch shipped as exactly one send (+1)", lane.sends.length - before, 1);
    await fire(lane.handlers, "agent_start", lane.notifies, { who, idle: true });
    injectLine(who, "peer", who);                       // the flush's own turn IS owed
    const atFlush = owedNotice(lane.notifies);
    await fire(lane.handlers, "agent_end", lane.notifies, { who, idle: true });
    check("E2(b) suppression still fires there, exactly once (+0 notices)", owedNotice(lane.notifies) - atFlush, 0);
    await fire(lane.handlers, "agent_settled", lane.notifies, { who, idle: true });
    const afterFlush = owedNotice(lane.notifies);
    await fire(lane.handlers, "agent_start", lane.notifies, { who, idle: true });
    await fire(lane.handlers, "agent_end", lane.notifies, { who, idle: true });
    check("E2(b) ...and the next owed turn still prints (+1, the debt was not forgiven)",
      owedNotice(lane.notifies) - afterFlush, 1);
  }

  // (c) NEGATIVE AGAINST AN INVENTED SUPPRESSION: a lane with nothing pending must set nothing, so no
  // later notice can be silently eaten by a flag nobody armed.
  {
    const who = "expiry-983c";
    const lane = await mountQuiet(who, join(goodRoot, "quiet.jsonl"));   // writable journal: no fault, no tell
    for (let i = 0; i < 3; i++) await oneTurn(lane, who);
    check("E3(c) a quiet lane with no fault invented no loss tell (loss sends=0)",
      lane.sends.filter((t) => t.includes("[tabichat][loss]")).length, 0);
    check("E3(c) ...and no notice either (=0), so nothing was spent in advance", owedNotice(lane.notifies), 0);
    injectLine(who, "peer", who);
    await oneTurn(lane, who);
    check("E3(c) and the first real owed turn still prints (=1): zero invented suppressions",
      owedNotice(lane.notifies), 1);
  }

  // (d) THE FLAG IS BOOLEAN, SO THE COST IS ONE: two kinds queue, one tell-only send carries both, and
  // two kinds must not buy two silenced turns.
  {
    const who = "expiry-983d";
    const lane = await mountQuiet(who, join(asFile, "sub", "journal.jsonl"));  // kind 1: journal-not-prepared
    injectLine(who, "peer", "someone-else");            // unaddressed: journals (kind 2), owes no turn
    const before = lane.sends.length;
    await oneTurn(lane, who);
    const shipped = lane.sends.slice(before);
    const two = shipped.filter((t) => t.startsWith(lossTellHeader(2)));
    check("E4(d) two kinds shipped in exactly one send (=1)", shipped.length, 1);
    check("E4(d) and that one block names both kinds",
      [(two[0] ?? "").includes("- journal-not-prepared:"), (two[0] ?? "").includes("- journal-write-failed:")],
      [true, true]);
    await oneTurn(lane, who);                            // the tell's own turn, zero owed
    injectLine(who, "peer", who);
    await oneTurn(lane, who);
    check("E4(d) two kinds cost ONE silenced turn, not two: the owed notice still fires (=1)",
      owedNotice(lane.notifies), 1);
  }

  // THE COMMENT IS PART OF THE DEFECT (L-1, second half): it claimed the next `agent_end` is OUR
  // flush landing, and a zero-owed turn falsifies that. Corrected, and pinned so a later edit cannot
  // re-loosen the sentence without a cell going red.
  check("E5 the declaration comment now states the expiry the code enforces",
    indexSrc.includes("it expires in the run that set it"), true);
  check("E5 ...and the unenforced claim is gone from the source",
    /the next `agent_end` is our own flush landing/.test(indexSrc), false);
  check("E5 and the zero-owed guard spends the flag BEFORE it returns",
    /if \(!owedTurns\) \{[\s\S]{0,300}?flushedThisRun = false;[\s\S]{0,80}?return;/.test(indexSrc), true);

  // AC4, MEASURED WITH A PAREN-BALANCED WALK (root of the 973 disclosure: the claim was made with
  // substring counts). The shipped `errorNotifies` above reads `\.ui\.notify\([^)]*"error"` — newline-
  // blind, so a call whose arguments wrap is invisible to it. This walk takes WHOLE CALLS by matching
  // parentheses, so the number is a count of calls, not of lines that happen to keep their close paren
  // on the same row. shortcut: does not step over string literals, so an argument containing a literal
  // "(" would mis-walk; upgrade the day a notify argument carries one.
  const notifyCalls = (src: string): string[] => {
    const out: string[] = [];
    const re = /\.ui\.notify\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let depth = 0, end = src.length;
      for (let i = m.index + m[0].length - 1; i < src.length; i++) {
        const c = src[i];
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      out.push(src.slice(m.index, end));
    }
    return out;
  };
  const tellSites = (src: string) =>
    notifyCalls(src).filter((c) => /\[tabichat\]\[loss\]|lossTellHeader|lossBlock/.test(c));
  {
    const calls = notifyCalls(indexSrc);
    const blind = (indexSrc.match(/\.ui\.notify\(/g) ?? []).length;
    console.log(`   walk: ${calls.length} notify call(s) taken whole; the newline-blind count sees ${blind}`);
    check("E6 AC4: not one notify call in the shipped file presents a loss tell (0 tell sites)",
      tellSites(indexSrc).length, 0);
    check("E6 CONTROL: the same filter DOES fire on a planted tell-to-notify site (=1), so the 0 above is a measurement",
      tellSites('ctx.ui.notify(lossTellHeader(1), "warning");').length, 1);
    check("E6 and the walk is not returning an empty list for the whole file", calls.length > 0, true);
  }
  rmSync(blockedRoot, { recursive: true, force: true });
}

rmSync(stubDir, { recursive: true, force: true });
rmSync(sinkDir, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nall checks pass (${prints.length} console.error sites, all NAMED; ${APPROVED_PRINT_SITES.length} approved)`);
}
