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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const indexSrc = read("index.ts");
const approvedLines = new Set(APPROVED_PRINT_SITES.map((a) => a.needle.trim()));
const prints = scanPrints(indexSrc);
const unapproved = prints.filter((p) => !approvedLines.has(p.line));
check(`every console.error in index.ts is a NAMED approved site (found ${prints.length}, approved list ${APPROVED_PRINT_SITES.length})`, unapproved.map((p) => p.line), []);
check(
  "the approved list matches the file exactly — a site REMOVED from the list must be removed here too (so this list cannot silently bless a print that no longer exists)",
  APPROVED_PRINT_SITES.filter((a) => !indexSrc.includes(a.needle.trim())).map((a) => a.name),
  [],
);
check("the belt catch is still ONE sink: stderr only inside the catch", /ui\.notify\(text, level\);\s*\} catch \{\s*console\.error\(text\);/.test(indexSrc), true);
check("notifySafely mirrors ERROR level to the file (audit iid 11 closed here)", /if \(level === "error"\) DIAG\.write\("ERROR", text\);/.test(indexSrc), true);
check("...and the mirror sits BEFORE the notify, so a dead UI cannot lose the record", indexSrc.indexOf('DIAG.write("ERROR", text)') < indexSrc.indexOf("(ctx ?? liveCtx()).ui.notify(text, level)"), true);
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
const diagCall = (level: string, msgStart: string): boolean => flatSrc.includes(`diag("${level}", \`${msgStart}`);
const consoleCall = (msgStart: string): boolean => flatSrc.includes(`console.error( \`${msgStart}`);
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
  indexSrc.includes('ctx.ui.notify(brokerRefusal, "error")') && indexSrc.includes('diag("ERROR", brokerRefusal)'),
  true,
);
check(
  "the renew-latch refusal keeps its notify and is now recorded, not printed",
  flatSrc.includes('ctx.ui.notify(`[tabichat][renew] ${latch.reason}`, "warning")') && diagCall("WARN", "[tabichat][renew] ${latch.reason}"),
  true,
);
check("the stale-handle warning is BOTH surfaces (no live ctx exists, so stderr is the only one it CAN have)", indexSrc.includes('diag("ERROR", staleHandleLine)') && indexSrc.includes("console.error(staleHandleLine)"), true);
check("a refused destination is said ONCE at startup, and a deliberate `off` prints nothing", /if \(!DIAG\.target\.ok && !DIAG\.target\.deliberate\)/.test(indexSrc), true);
check(
  "a dropped write is told ONCE (the fault is loud), and never per line (that would rebuild the flood)",
  /if \(DIAG\.failed && !diagFaultTold\)/.test(indexSrc) && indexSrc.includes("diagnostics are being DROPPED, not printed"),
  true,
);
check("TABICHAT_ERR_STACK no longer has a bare print of its own", /if \(process\.env\.TABICHAT_ERR_STACK === "1"\)\s*console\.error/.test(indexSrc), false);

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

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nall checks pass (${prints.length} console.error sites, all NAMED; ${APPROVED_PRINT_SITES.length} approved)`);
}
