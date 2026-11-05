// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Truth table for the room journal and the tail board (legs 800 + 804).
 *   bun tools/test_roomlog.ts      (exit 1 on any failure)
 *
 * WHY. Room lines publish UNRETAINED while receipts and presence are retained, so a restarted seat
 * got the paperwork of a conversation and never the conversation. The fix is an on-disk journal
 * replayed at session start as HISTORY, plus a retained per-lane board that ships dark. The
 * load-bearing rules: history/not-news (replayed lines never double, never surface as unseen, never
 * inject), per-SEAT files (D2: one shared file under one uid lost 93 lines while every
 * writer returned ok), an append-only hot path (read/rewrite cycles lose writers; only the boot
 * trim writes whole), and both rejection halves copied from diaglog exactly: an explicit `off` is
 * an answer, a garbage value is a refusal, never a quiet default.
 *
 * The decision lives in roomlog.ts and is driven here with injected I/O (no real disk, no broker).
 * The WIRING in index.ts is checked structurally, denylist-style — named sites, not counts — and
 * the scanner carries a negative control over a stripped source that CANNOT come out green, so
 * this file cannot become decoration the next time a block moves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOMLOG_DEFAULT_DIR_SUBPATH,
  ROOMLOG_ENV,
  ROOMLOG_MAX_DEFAULT,
  ROOMLOG_MAX_ENV,
  ROOMLOG_REPLAY_DEFAULT,
  ROOMLOG_REPLAY_ENV,
  appendRoomLogRecord,
  formatRoomLogRecord,
  histBoardPayload,
  loadRoomLogTail,
  makeRoomLogIo,
  parseRoomLogCap,
  parseRoomLogRecord,
  resolveRoomLogTarget,
  roomLogFileLeaf,
  trimRoomLog,
  type RoomLogIo,
  type RoomLogRecord,
} from "../extensions/tabichat/roomlog.ts";
import { histTopic, histWild, lastSeq, msgTopic, nickFromHistTopic, noteRoomId, planInbound, pushRoomLine, renderLine, takeUnseen, topicLeaf, type RoomLine } from "../extensions/tabichat/roommsg.ts";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  } else console.log(`ok   ${name}`);
};

// --- injected in-memory disk: append and write are TRACKED SEPARATELY (D2 needs that) --------
const mem = () => {
  const files = new Map<string, string>();
  const writes: string[] = []; // whole-file rewrites — legal ONLY in the boot trim
  const appends: string[] = []; // O_APPEND records — the whole hot path
  const ensured: string[] = [];
  const io: RoomLogIo = {
    read: (p) => files.get(p) ?? "",
    append: (p, d) => {
      files.set(p, (files.get(p) ?? "") + d);
      appends.push(p);
    },
    write: (p, d) => {
      files.set(p, d);
      writes.push(p);
    },
    ensure: (p) => {
      if (!files.has(p)) files.set(p, "");
      ensured.push(p);
    },
  };
  return { io, files, writes, appends, ensured };
};
const rec = (i: number, over: Partial<RoomLogRecord> = {}): RoomLogRecord => ({
  id: `n-1-${i}`,
  nick: "worker1",
  ts: 1000 + i,
  text: `line ${i}`,
  dir: "in",
  ...over,
});

// --- 1. precedence, both rejection halves (copies diaglog's discipline) ---------------------
const HOME = "/home/agent";
const L = (over: Record<string, unknown> = {}) => ({ home: HOME, room: "tabith", nick: "lane1", ...over });
check("env layer beats site and default",
  resolveRoomLogTarget(L({ env: "/srv/roomlog.jsonl", site: "/etc/other.jsonl" })).path,
  "/srv/roomlog.jsonl");
check("site layer answers when env is absent",
  resolveRoomLogTarget(L({ site: "~/venue-log.jsonl" })).path,
  `${HOME}/venue-log.jsonl`);
check("empty env slot is an ABSENCE, next layer answers",
  resolveRoomLogTarget(L({ env: "  ", site: "/etc/venue.jsonl" })).path,
  "/etc/venue.jsonl");
check("default is per SEAT per ROOM under the resolved home",
  resolveRoomLogTarget(L()).path,
  `${HOME}/${ROOMLOG_DEFAULT_DIR_SUBPATH}/tabith/lane1.jsonl`);
check("the nick leaf uses the ONE topic sanitiser, never a second filter",
  roomLogFileLeaf("my room/x!"),
  topicLeaf("my room/x!"));

// explicit `off` is an ANSWER; garbage is a REFUSAL — never a quiet default
{
  const off = resolveRoomLogTarget(L({ env: "off" }));
  check("off token refuses DELIBERATELY", [off.ok, off.deliberate, off.path], [false, true, ""]);
  const boolFalse = resolveRoomLogTarget(L({ site: false }));
  check("site false is deliberate too", [boolFalse.ok, boolFalse.deliberate], [false, true]);
  const boolTrue = resolveRoomLogTarget(L({ env: true }));
  check("bare true names no path and is NOT deliberate", [boolTrue.ok, boolTrue.deliberate], [false, false]);
  const junk = resolveRoomLogTarget(L({ env: "relative/path" }));
  check("a non-absolute value is REFUSED, not defaulted", [junk.ok, junk.path.includes(`${HOME}/`)], [false, false]);
  const noHome = resolveRoomLogTarget({ home: "", room: "tabith", nick: "lane1" });
  check("no home means no default and a refusal that names the knobs", [noHome.ok, noHome.reason.includes(ROOMLOG_ENV)], [false, true]);
  const tmpHome = resolveRoomLogTarget({ home: "/tmp/agent", room: "tabith", nick: "lane1" });
  check("a tmpfs resolved home REFUSES the default (a reboot would eat it)", tmpHome.ok, false);
  const tmpExplicit = resolveRoomLogTarget(L({ env: "/tmp/x.jsonl" }));
  check("an explicit tmpfs path is used VERBATIM (diaglog precedence copied exactly, operator aimed it)",
    [tmpExplicit.ok, tmpExplicit.path], [true, "/tmp/x.jsonl"]);
}

// --- 1b. D2: the key carries the seat (acceptance 1 + the paired negatives) -------------------
{
  const nicks = Array.from({ length: 8 }, (_, i) => `seat${i}`);
  const paths = nicks.map((n) => resolveRoomLogTarget(L({ nick: n })).path);
  check("distinct default paths across 8 seat nicks is 8 (was 1 at a0471508)", new Set(paths).size, 8);
  check("NEGATIVE-SHAPED ASSERT: two named seats never resolve to the same file",
    resolveRoomLogTarget(L({ nick: "lane1" })).path === resolveRoomLogTarget(L({ nick: "lane2" })).path,
    false);
  check("the SAME nick in a different room is a different file too",
    [resolveRoomLogTarget(L({ nick: "lane1", room: "tabith" })).path, resolveRoomLogTarget(L({ nick: "lane1", room: "demo" })).path][0] ===
      [resolveRoomLogTarget(L({ nick: "lane1", room: "tabith" })).path, resolveRoomLogTarget(L({ nick: "lane1", room: "demo" })).path][1],
    false);
  const noNick = resolveRoomLogTarget({ home: HOME, room: "tabith", nick: "" });
  check("an empty nick REFUSES the default rather than sharing one file between seats",
    [noNick.ok, noNick.reason.includes("per seat")], [false, true]);
  const weirdNick = resolveRoomLogTarget({ home: HOME, room: "tabith", nick: "///" });
  check("a nick with nothing leaf-safe in it is refused by the SAME rule", weirdNick.ok, false);
}

// --- 2. the git-working-tree bar (A1.3, now walking the nick component too) -------------------
{
  const inTree = (d: string) => d === "/srv/repo" || d.startsWith("/srv/repo/");
  const hit = resolveRoomLogTarget(L({ env: "/srv/repo/journal.jsonl" }), inTree);
  check("a resolved path inside a git tree is REFUSED and nothing is defaulted",
    [hit.ok, hit.deliberate, hit.reason.includes("git working tree")], [false, false, true]);
  const miss = resolveRoomLogTarget(L({ env: "/srv/outside/journal.jsonl" }), inTree);
  check("NEGATIVE: a path outside any tree is accepted verbatim", [miss.ok, miss.path], [true, "/srv/outside/journal.jsonl"]);
  const def = resolveRoomLogTarget(L(), inTree);
  check("NEGATIVE: the harness-dir default is accepted", def.ok, true);
  const treeHome = resolveRoomLogTarget({ home: "/srv/repo", room: "tabith", nick: "lane1" }, inTree);
  check("the default too: a home inside a tree is refused through the nick-keyed path", treeHome.ok, false);
}

// --- 3. the APPEND-ONLY hot path and the BOOT TRIM (D2 acceptance 3) ---------------------------
{
  const { io, files, writes, appends } = mem();
  const P = "/j/tabith/lane1.jsonl";
  check("append lands one parseable record", appendRoomLogRecord(io, P, rec(1)), { ok: true });
  check("the record round-trips", parseRoomLogRecord(files.get(P)!.trim()), rec(1));
  appendRoomLogRecord(io, P, rec(2));
  appendRoomLogRecord(io, P, rec(3));
  appendRoomLogRecord(io, P, rec(4));
  check("D2 NEGATIVE: the hot path performed ZERO whole-file writes (4 appends, 0 rewrites)",
    [appends.length, writes.length], [4, 0]);
  check("nothing was lost between appends", files.get(P)!.trim().split("\n").length, 4);
  const tr = trimRoomLog(io, P, 3);
  check("the boot trim keeps the newest and RETURNS the drop count the wiring prints", tr, { ok: true, trimmed: 1 });
  check("the kept block is the newest three, in order",
    files.get(P)!.trim().split("\n").map((l) => JSON.parse(l).id),
    ["n-1-2", "n-1-3", "n-1-4"]);
  const under = trimRoomLog(io, P, 500);
  check("NEGATIVE: under the cap the trim touches nothing and reports zero",
    [under, writes.length], [{ ok: true, trimmed: 0 }, 1]);
  check("a newline inside text never writes a second record", (() => {
    appendRoomLogRecord(io, "/j/nl.jsonl", rec(9, { text: "two\nlines" }));
    return files.get("/j/nl.jsonl")!.split("\n").length;
  })(), 2); // record line + trailing newline: still ONE record
}

// --- 4. replay: tail, order, malformed counts, and NO write amplification (A1.5, AC1) --------
{
  const { io, writes, appends } = mem();
  const P = "/j/r.jsonl";
  for (let i = 1; i <= 7; i++) appendRoomLogRecord(io, P, rec(i));
  const t = loadRoomLogTail(io, P, ROOMLOG_REPLAY_DEFAULT);
  check("tail returns everything, oldest first (the order lived)", t.records.map((r) => r.id), ["n-1-1", "n-1-2", "n-1-3", "n-1-4", "n-1-5", "n-1-6", "n-1-7"]);
  check("limit takes the NEWEST n", loadRoomLogTail(io, P, 3).records.map((r) => r.id), ["n-1-5", "n-1-6", "n-1-7"]);
  const w0 = writes.length;
  const a0 = appends.length;
  loadRoomLogTail(io, P, 50);
  check("AC1: reading the journal for replay performs ZERO writes and ZERO appends", [writes.length - w0, appends.length - a0], [0, 0]);
  io.write(P, "not json\n" + formatRoomLogRecord(rec(1)) + "{broken\n");
  const bad = loadRoomLogTail(io, P, 50);
  check("malformed lines are COUNTED and skipped, the good one stands", [bad.malformed, bad.records.length], [2, 1]);
  check("no file yet is an absence, not an error", loadRoomLogTail(io, "/j/none.jsonl", 50), { records: [], malformed: 0 });
  // a seat restarts and replays ITS OWN history: the file it reads is the one its nick names
  const own = resolveRoomLogTarget(L({ nick: "lane1" }));
  const other = resolveRoomLogTarget(L({ nick: "lane2" }));
  check("D2 acceptance 4: replay reads this seat's file, never a neighbour's", [own.ok, other.ok, own.path !== other.path], [true, true, true]);
}

// --- 5. caps parse to defaults, never to unlimited --------------------------------------------
check("cap default", parseRoomLogCap(undefined, ROOMLOG_MAX_DEFAULT), ROOMLOG_MAX_DEFAULT);
check("replay default", parseRoomLogCap("", ROOMLOG_REPLAY_DEFAULT), ROOMLOG_REPLAY_DEFAULT);
check("explicit cap", parseRoomLogCap("120", ROOMLOG_MAX_DEFAULT), 120);
check("garbage cap is the DEFAULT, never unlimited", parseRoomLogCap("all of them", ROOMLOG_MAX_DEFAULT), ROOMLOG_MAX_DEFAULT);
check("zero is not 'unlimited', it falls back", parseRoomLogCap("0", ROOMLOG_MAX_DEFAULT), ROOMLOG_MAX_DEFAULT);

// --- 6. the tail board: leaf, payload, and the shared sanitiser (A2, AC8) --------------------
check("hist topic reuses the msgTopic leaf filter", histTopic("tabith", "seat-a"), "chat/tabith/hist/seat-a");
check("an empty leaf after sanitising REFUSES the topic", histTopic("tabith", "///  "), "");
check("NEGATIVE: a real leaf survives unchanged", topicLeaf("lane1"), "lane1");
check("the board read filter is one level", histWild("tabith"), "chat/tabith/hist/+");
check("the board author comes from the topic", nickFromHistTopic("chat/tabith/hist/seat-a", "tabith"), "seat-a");
check("a wild or nested topic is nobody's board", [nickFromHistTopic("chat/tabith/hist/+ ", "tabith"), nickFromHistTopic("chat/tabith/hist/a/b", "tabith")], ["", ""]);
{
  const out: RoomLogRecord[] = [];
  for (let i = 1; i <= 12; i++) out.push(rec(i, { dir: "out", nick: "me" }));
  const p = histBoardPayload({ nick: "me", leaf: "me", journalPath: "/j/mine.jsonl", outLines: out });
  check("the payload holds at most the last 10 by this lane", [p.lines.length, p.lines[0].id, p.lines[9].id], [10, "n-1-3", "n-1-12"]);
  check("lastId/lastTs name the newest line", [p.lastId, p.lastTs], ["n-1-12", 1012]);
  check("the payload carries the version and the journal path", [p.v, p.journalPath], [1, "/j/mine.jsonl"]);
}

// --- 7. the history marker renders, and only for history lines --------------------------------
{
  const live: RoomLine = { nick: "lead", message: "hello", ts: 5 };
  const hist: RoomLine = { ...live, hist: true };
  check("a replayed line carries a visible marker", renderLine(hist).includes("chat:lead hist]"), true);
  check("NEGATIVE: a live line carries none", renderLine(live).includes("hist"), false);
}

// --- 8. the WIRING in index.ts, named sites (denylist style, not counts) ----------------------
const idx = readFileSync(join(import.meta.dir, "..", "extensions", "tabichat", "index.ts"), "utf8");
check("journal written for EVERY room send inside publishRoom", (() => {
  const def = idx.indexOf("const publishRoom = (payload");
  const out = idx.indexOf('journalAppend("out"');
  return def >= 0 && out > def && out - def < 2500;
})(), true);
check("journal written when a line is TAKEN INTO the buffer (in)", idx.includes('journalAppend("in"'), true);
check("replay happens inside session_start after the room is set", idx.lastIndexOf("loadRoomLogTail(") > idx.indexOf("room = String(pi.getFlag"), true);
check("replayed lines are pushed marked hist", /for \(const rec of t\.records\)[\s\S]{0,900}hist: true,/.test(idx), true);
check("the cursor moves past the replayed block only when the block added lines",
  idx.includes("if (added > 0) readCursor = lastSeq(buffer);"), true);
check("every room-window push goes through the stamping pushRoomLine, none hand-rolls push+shift",
  (idx.match(/pushRoomLine\(buffer,/g) || []).length, 3);
check("NEGATIVE: no shipped site re-introduces the index-cursor line", idx.includes("readCursor = buffer.length"), false);
check("the journal default is resolved WITH the seat's nick in the layers", /resolveRoomLogTarget\(\{[^}]*nick[^}]*room[^}]*\}|resolveRoomLogTarget\(\s*\{[\s\S]{0,240}?nick[\s\S]{0,240}?\}/.test(idx), true);
check("boot order is ensure -> trim -> replay, in that order", (() => {
  const e = idx.indexOf("ROOMLOG_IO.ensure(roomLogTarget.path)");
  const t = idx.indexOf("trimRoomLog(ROOMLOG_IO");
  const l = idx.indexOf("loadRoomLogTail(ROOMLOG_IO");
  return e > 0 && t > e && l > t;
})(), true);
check("the boot trim's drop count is REPORTED, never silent", idx.includes("oldest dropped at boot, newest kept"), true);
check("seen ids from replay land in the id ledger (live redelivery cannot double)",
  /for \(const rec of t\.records\)[\s\S]{0,200}noteRoomId\(seenRoomIds, rec\.id\)/.test(idx), true);
check("unseen reads filter hist lines out — history is never news", idx.includes('got.lines.filter((l) => !l.hist)'), true);
check("the board is on EXACTLY \"1\", not mere presence of the variable", idx.includes('process.env.MQTT_HIST_BOARD === "1"'), true);
check("board publishes are gated by the flag", idx.includes("if (HIST_BOARD)"), true);
// this refusal is a RECORD-ONLY notice (kept, never shown), so the cell follows the arm
// rather than the old hand-written call — same claim, one less thing a future edit can decouple.
check("an empty board leaf refuses and says so instead of misrouting",
  /if \(!ht\) \{\s*\n\s*notice\("record-only",\s*\n?\s*`\[tabichat\]\[hist\] MQTT_HIST_BOARD=1/.test(idx), true);
const histBranch = idx.indexOf('if (topic.startsWith(`chat/${room}/hist/`))');
const avSite = idx.indexOf("const av = authorVerdict(topic, room");
check("the board branch is handled BEFORE the room-line path and RETURNS", histBranch > 0 && histBranch < avSite, true);
check("NEGATIVE CONTROL: the board branch injects nothing and journals nothing",
  /if \(topic\.startsWith\(`chat\/\$\{room\}\/hist\/`\)\) \{[\s\S]{0,1800}?\n      \}\n/.test(idx) &&
    !/if \(topic\.startsWith\(`chat\/\$\{room\}\/hist\/`\)\) \{[\s\S]{0,1800}?(sendUserMessage|journalAppend|planInbound)/.test(idx),
  true);

// the scanner itself must be able to fail: same checks over a source with the wiring stripped
{
  const stripped = idx
    .replace('journalAppend("out"', 'void("out"')
    .replace('journalAppend("in"', 'void("in"')
    .replace("if (added > 0) readCursor = lastSeq(buffer);", ";")
    .replace("ROOMLOG_IO.ensure(roomLogTarget.path)", ";");
  const wired = (s: string) =>
    s.includes('journalAppend("out"') && s.includes('journalAppend("in"') &&
    s.includes("if (added > 0) readCursor = lastSeq(buffer);") &&
    s.includes("ROOMLOG_IO.ensure(roomLogTarget.path)");
  check("NEGATIVE CONTROL: the scanner goes RED when the wiring is removed", wired(stripped), false);
  check("and reads the shipped file as wired", wired(idx), true);
}

// --- 8c. the WIRING SHAPE cell — the keys production passes vs the keys the factory
// declares. The 803/805 lesson in one predicate: a cell that builds its OWN fs object cannot catch
// a wiring mistake, so this reads the object literally AT THE CALL SITE in index.ts and compares it
// with the declared parameter of makeRoomLogIo in roomlog.ts. RED at b6deb39e (missing
// `appendFileSync`), green at the fix.
{
  const roomlogSrc = readFileSync(join(import.meta.dir, "..", "extensions", "tabichat", "roomlog.ts"), "utf8");
  const declaredBlock = roomlogSrc.match(/makeRoomLogIo = \(fs: \{([\s\S]*?)\}\):/);
  if (!declaredBlock) throw new Error("roomlog.ts: no `makeRoomLogIo = (fs: {` shape found — the instrument is pointed at the wrong code");
  const DECLARED = [...declaredBlock[1].matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  const site = idx.match(/const ROOMLOG_IO = makeRoomLogIo\(\{([^}]*)\}\)/);
  if (!site) throw new Error("index.ts: no `const ROOMLOG_IO = makeRoomLogIo({...})` call site found");
  const PASSED = site[1].split(",").map((s) => s.trim()).filter((s) => s !== "");
  const missing = DECLARED.filter((k) => !PASSED.includes(k));
  check(`the object actually passed at the wiring site covers every key makeRoomLogIo declares (declared ${DECLARED.length}, passed ${PASSED.length})`, missing, []);
  check("NEGATIVE CONTROL: the same predicate reports the exact omission production made", (() => {
    const broken = PASSED.filter((k) => k !== "appendFileSync");
    return DECLARED.filter((k) => !broken.includes(k));
  })(), ["appendFileSync"]);

  // --- 8d. REAL-fs append cell at the SAME shape: no mock supplies a key production forgot, because
  // the fs object is built at runtime from exactly the identifiers the shipped call site names.
  // This is the field failure reproduced verbatim ("fs.appendFileSync is not a function") against
  // a temp dir, and it is the cell the whole 45+236+421+10 suite missed.
  const realFs = await import("node:fs");
  const fsObj: Record<string, unknown> = {};
  for (const k of PASSED) fsObj[k] = (realFs as Record<string, unknown>)[k];
  const IO_REAL = makeRoomLogIo(fsObj as never);
  const osMod = await import("node:os");
  const tmp = realFs.mkdtempSync(join(osMod.tmpdir(), "tabichat-roomlog-"));
  const P = `${tmp}/tabith/lane1.jsonl`;
  try {
    IO_REAL.ensure(P);
    const r1 = appendRoomLogRecord(IO_REAL, P, rec(1, { nick: "lane1" }));
    const r2 = appendRoomLogRecord(IO_REAL, P, rec(2, { nick: "lane1" }));
    check("real-fs append at the shipped wiring shape SUCCEEDS (field failure reproduced at unit level if this is red)", [r1.ok, r2.ok], [true, true]);
    if (!r1.ok || !r2.ok) console.log(`  reason: ${!r1.ok ? r1.reason : r2.reason}`);
    const back = loadRoomLogTail(IO_REAL, P, 10);
    check("two records written, two records read back", back.records.map((x) => x.id), ["n-1-1", "n-1-2"]);
    const mode = realFs.statSync(P).mode & 0o777;
    check("the file on disk is 0600", mode.toString(8), "600");
    check("the directory on disk is 0700", (realFs.statSync(`${tmp}/tabith`).mode & 0o777).toString(8), "700");
  } finally {
    realFs.rmSync(tmp, { recursive: true, force: true });
    check("the temp tree is cleaned up", realFs.existsSync(tmp), false);
  }
}

// real-fs block: the mode promise is enforced at boot, and the hot path is a bare append
{
  const made: Array<[string, string]> = [];
  const fsMock = {
    readFileSync: () => "",
    appendFileSync: (p: string, d: string) => made.push([`append:${p}`, d]),
    writeFileSync: (p: string, _d: string, o?: { mode?: number }) => made.push([`write:${p}`, `mode=${(o?.mode ?? 0).toString(8)}`]),
    mkdirSync: (p: string) => made.push(["mkdir", p]),
    chmodSync: (p: string, m: number) => made.push([`chmod:${p}`, m.toString(8)]),
    existsSync: (p: string) => p !== "/brand/new/dir",
    statSync: () => ({ isDirectory: () => true }),
  };
  const io = makeRoomLogIo(fsMock as never);
  io.append("/d/f.jsonl", "one\n");
  check("the hot append is one O_APPEND call, no chmod churn", made.filter(([k]) => k.startsWith("append")).length, 1);
  io.ensure("/d/f.jsonl");
  check("ensure dirs 0700 and files 0600 by name, at boot",
    made.some(([k, v]) => (k === "chmod:/d" || k === "chmod:/d/") && v === "700") && made.some(([k, v]) => k === "chmod:/d/f.jsonl" && v === "600"),
    true);
}

// --- 9. PART 3: a LIVE mention crossing the replay block injects EXACTLY ONCE --------
// The same function sequence the shipped wiring runs — replay through noteRoomId+pushRoomLine into
// the buffer with no injector touched, then the live path. A redelivery of a REPLAYED id dies at
// the id ledger; a genuinely new mention gets one inject plan and one unseen entry. Negative half:
// the replay region of index.ts contains no call to planInbound or sendUserMessage at all.
{
  const buffer: RoomLine[] = [];
  let seen: string[] = [];
  const replayed = rec(7, { id: "lead-9-zz", nick: "lead", text: "@lane1 wake", dir: "out" });
  const s0 = noteRoomId(seen, replayed.id);
  seen = s0.seen;
  pushRoomLine(buffer, { nick: replayed.nick, message: replayed.text, ts: replayed.ts, id: replayed.id, hist: true }, 50);
  const cursorAfterReplay = lastSeq(buffer);
  const s1 = noteRoomId(seen, "lead-9-zz");
  check("a live redelivery of a replayed id is refused by the id ledger — no second line, no second turn", s1.dup, true);
  const live: RoomLine = { nick: "lead", message: "@lane1 new", ts: 2000, id: "lead-10-aa" };
  const s2 = noteRoomId(seen, live.id ?? "");
  seen = s2.seen;
  const plan = planInbound({ mentioned: true, head: "", line: live });
  pushRoomLine(buffer, live, 50);
  check("a new live mention after the block plans exactly one injection", [s2.dup, plan.kind], [false, "inject"]);
  const unseen = takeUnseen(buffer, cursorAfterReplay).lines.filter((l) => !l.hist);
  check("the unseen window after the crossing holds the live line, not the replayed mention", unseen.map((l) => l.message), ["@lane1 new"]);
  const from = idx.indexOf("const t = loadRoomLogTail(");
  const to = idx.indexOf("(marked hist; not injected", from);
  check("NEGATIVE CONTROL: the shipped replay region calls no injector", from > 0 && to > from && !/sendUserMessage|planInbound/.test(idx.slice(from, to)), true);
}

// --- 10. iid 18 at the FULL window: the read the row says nobody has run -------------
// The row's own words: "A field read that exercises the full window (a seat booting with >= 50 journal
// records, then one inbound line, then unseen_only as its first read) has not been run yet — the
// seat-level test at 9 records could not distinguish the two cursors." Below 50 lines the array-index
// answer and the stamp answer are the same number, so every earlier cell was green in BOTH worlds. This
// section runs the shape at the size where the two cursors disagree, through the shipped functions in
// the order the shipped wiring uses them: journal -> loadRoomLogTail -> pushRoomLine -> lastSeq -> one
// inbound -> takeUnseen as the FIRST read.
//
// The relation between the two constants is pinned here too, and it is the reason the defect became a
// boot state instead of an event: ROOMLOG_REPLAY_DEFAULT (roomlog.ts) EQUALS the window cap (index.ts),
// so a default boot fills the window to capacity before the seat has read anything. Nothing related the
// two numbers before this cell — `BUFFER_MAX` is factory-local and `test_roomlog.ts` referenced it zero
// times, which is exactly the hole 803 reported.
{
  const capMatch = idx.match(/const BUFFER_MAX = (\d+);/);
  const CAP = capMatch ? Number(capMatch[1]) : -1;
  check("the window cap is readable from the shipped source (the instrument can fire)", CAP > 0, true);
  check("a DEFAULT boot fills the window to capacity — the two constants are equal, and that is the trap",
    [ROOMLOG_REPLAY_DEFAULT, CAP], [CAP, CAP]);

  // the seat's own post is not in the window it reads (by separate design), so the inbound line here
  // is named as another nick. A cell that posted as SELF would report a false failure.
  const { io } = mem();
  const P = "/j/full.jsonl";
  for (let i = 1; i <= CAP + 10; i++) appendRoomLogRecord(io, P, rec(i));
  const tail = loadRoomLogTail(io, P, ROOMLOG_REPLAY_DEFAULT);
  check("the journal holds more than the cap, and the replay takes the NEWEST cap records",
    [CAP + 10, tail.records.length], [CAP + 10, CAP]);

  const buf: RoomLine[] = [];
  for (const r of tail.records)
    pushRoomLine(buf, { nick: r.nick, message: r.text, ts: r.ts, id: r.id, hist: true }, CAP);
  check("the boot replay fills the window to exactly the cap", buf.length, CAP);
  const cursor = lastSeq(buf); // what index.ts does at the replay site
  check("the replay cursor lands EXACTLY on the cap — where an index cursor goes blind and a stamp does not",
    [cursor === CAP, cursor === buf.length], [true, true]);

  const inbound: RoomLine = { nick: "lead", message: "a line after the saturated boot", ts: 9_000_000, id: "in-1" };
  pushRoomLine(buf, inbound, CAP);
  const got = takeUnseen(buf, cursor);
  check("IID 18 ACCEPTANCE: unseen_only as the FIRST read after a saturated boot surfaces the one line",
    got.lines.map((l) => l.message), ["a line after the saturated boot"]);
  check("and no replayed history EVER reads as news at full window",
    got.lines.filter((l) => l.hist).length, 0);
  check("the window stays capped after the shift", buf.length, CAP);
  check("a second read of the same state is empty, which is the ANSWER and not the silence",
    takeUnseen(buf, got.cursor).lines.length, 0);

  // NEGATIVE CONTROL — the 0.1.0 wiring, same data, same order: cursor = buffer.length and a raw
  // push/shift. If this ever stops reproducing 0/N, the instrument has stopped distinguishing the two
  // cursors and the acceptance cells above are green for the wrong reason.
  const legacy: RoomLine[] = [];
  for (const r of tail.records)
    legacy.push({ nick: r.nick, message: r.text, ts: r.ts, id: r.id, hist: true } as RoomLine);
  if (legacy.length > CAP) legacy.splice(0, legacy.length - CAP);
  let lc = legacy.length; // the shipped 0.1.0 statement, verbatim in shape
  legacy.push(inbound);
  if (legacy.length > CAP) legacy.shift();
  const lgot = takeUnseen(legacy, lc);
  check("NEGATIVE CONTROL: the index-cursor shape is blind at the full window (0 surfaced, was 1)",
    [lgot.lines.length, lgot.cursor], [0, CAP]);
  lc = lgot.cursor;
  for (let j = 1; j <= 5; j++) {
    legacy.push({ nick: "lead", message: `later ${j}`, ts: 9_100_000 + j, id: `later-${j}` } as RoomLine);
    if (legacy.length > CAP) legacy.shift();
    const g2 = takeUnseen(legacy, lc);
    lc = g2.cursor;
    check(`NEGATIVE CONTROL: and it stays blind for every later line (later ${j})`, g2.lines.length, 0);
  }

  // and the shipped replay site really is the one that was reproduced above: no direct push anywhere.
  const bypass = (idx.match(/\bbuffer\.(push|shift|splice|unshift)\(/g) ?? []);
  check("PUSHROOMLINE IS THE ONLY WAY IN: zero direct window mutations in the shipped wiring", bypass.length, 0);
  const stamped = (idx.match(/pushRoomLine\(/g) ?? []).length;
  check("and the shipped file does call the stamper (so the zero above is not an unread file)", stamped >= 3, true);
}

console.log(failed === 0 ? `test_roomlog: ALL PASS (${ROOMLOG_ENV}, ${ROOMLOG_MAX_ENV}, ${ROOMLOG_REPLAY_ENV})` : `test_roomlog: ${failed} FAILURE(S)`);
process.exitCode = failed ? 1 : 0;
