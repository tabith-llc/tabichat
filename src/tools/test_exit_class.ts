// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the exit-code class (tabichat leg 549).
//   bun src/tools/test_exit_class.ts      (exit 1 on any failure)
//
// WHY THIS FILE EXISTS. `bun test` runs the files it is given in ONE process, and a top-level
// `process.exit()` in the first file kills every later file. Two shapes, both bad:
//   - `process.exit(failed ? 1 : 0)` runs on the GREEN path too, so a green combined run silently
//     executes ONE file and reports it as the suite. Ten sites were like this, and
//     `test_mention.ts:181` was the first file on the README's documented command — fourteen
//     files were never reached, with nothing red anywhere to notice it.
//   - `if (failed) { ...; process.exit(1) }` truncates on RED, so the run under-reports its own
//     failures. Nine sites were like this.
// The fix is `process.exitCode = ...`, which sets the status without ending the process.
// DELETING the exit is NOT a fix and would have shipped a lie: `bun test` on a file of hand-rolled
// checks with no `test()` calls prints `0 pass / 0 fail / Ran 0 tests` and exits rc=0, so a
// deleted exit converts a red gate into a green one.
//
// BOTH HALVES ARE REQUIRED. A scanner that always answers "clean" would keep this gate green, so
// the detector is tested against a real call, a comment, a string literal, a spawned child's own
// script, and `process.exitCode` itself — and the allowlist is pinned to the guard's TEXT, not to
// its line number, so an allowlisted site cannot quietly become something else.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const NEEDLE = "process.exit(";

/** True when `before` ends inside a quote or backtick — i.e. the match is text, not a call. */
const insideString = (before: string): boolean => {
  for (const q of ['"', "'", "`"]) {
    let n = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === "\\") i++;
      else if (before[i] === q) n++;
    }
    if (n % 2 === 1) return true;
  }
  return false;
};

/** Real `process.exit(` CALLS in `src`, each as {file, line, text}. Comments and strings are not calls. */
const exitCalls = (text: string, file: string): { file: string; line: number; text: string }[] => {
  const hits: { file: string; line: number; text: string }[] = [];
  let inBlock = false;
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (inBlock) {
      if (trimmed.endsWith("*/")) inBlock = false;
      return;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.endsWith("*/")) inBlock = true;
      return;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    let at = raw.indexOf(NEEDLE);
    while (at !== -1) {
      if (!insideString(raw.slice(0, at))) hits.push({ file, line, text: trimmed });
      at = raw.indexOf(NEEDLE, at + NEEDLE.length);
    }
  });
  return hits;
};

const DIR = join(import.meta.dir, "..", "tools");

// --- the detector, both halves ---------------------------------------------------------------
// A check on synthetic bytes first, because if the scanner cannot SEE a call, every "clean" result
// below is silence about the class rather than a measurement of it.
const sample = [
  "process.exit(failed ? 1 : 0);", //          real call, top level
  "  process.exit(1);", //                      real call, indented
  "// process.exit(0) here", //                 comment — not a call
  'const s = "process.exit(2)";', //           string literal — not a call
  "process.exitCode = 1;", //                  the FIX — not a call
  'spawnSync("bun", ["-e", "s.close(()=>process.exit(0))"]);', // child script — not OUR call
].join("\n");
check("the detector sees the two real calls and nothing else", exitCalls(sample, "sample").length, 2);
check("and it names them by line, not by count alone", exitCalls(sample, "sample").map((h) => h.line), [1, 2]);
check("it does NOT fire on process.exitCode (the fix is not the defect)",
  exitCalls("process.exitCode = failed ? 1 : 0;\n", "x").length, 0);
check("it does NOT fire on an empty file", exitCalls("", "x").length, 0);

// --- the class is closed across every gate file ------------------------------------------------
const gateFiles = readdirSync(DIR).filter((f) => f.startsWith("test_") && f.endsWith(".ts")).sort();
check("there are gate files to scan", gateFiles.length > 15, true);

// REVIEWED ALLOWLIST — fail-loud guards, NOT summary exits. These files deliberately stop when a
// precondition is unmet, because an unexecuted half is a RESULT, not a pass. Each entry is pinned to
// the sentence that makes it a guard, so if the site is edited into something else the pin fails and
// this file reddens rather than blessing it.
const GUARDS = [
  { file: "test_broker_auth.ts", needle: "That is a result, not a pass." },
  { file: "test_broker_auth.ts", needle: "fixture tree vanished after start" },
];

const violations: string[] = [];
for (const f of gateFiles) {
  const text = readFileSync(join(DIR, f), "utf8");
  for (const h of exitCalls(text, f)) {
    const guarded = GUARDS.some(
      (g) => g.file === f && text.split("\n").slice(0, h.line).join("\n").includes(g.needle),
    );
    if (!guarded) violations.push(`${f}:${h.line}`);
  }
}
check(`no gate file calls process.exit() at top level (violations: ${violations.join(", ") || "none"})`,
  violations, []);
check("every gate file that reports a verdict SETS an exit status",
  gateFiles.filter((f) => {
    const t = readFileSync(join(DIR, f), "utf8");
    return t.includes("all checks pass") && !t.includes("process.exitCode");
  }), []);

// --- the allowlist is real, and this gate can see it break ------------------------------------
for (const g of GUARDS) {
  check(`guard ${g.file} still holds the sentence that justifies its exit`,
    readFileSync(join(DIR, g.file), "utf8").includes(g.needle), true);
}
const guardHits = GUARDS.map((g) =>
  exitCalls(readFileSync(join(DIR, g.file), "utf8"), g.file).some((h) =>
    readFileSync(join(DIR, g.file), "utf8").split("\n").slice(0, h.line).join("\n").includes(g.needle),
  ),
);
check("and each allowlisted guard is an ACTUAL exit call, not a stale allowance",
  guardHits.every(Boolean), true);

console.log();
if (failed) {
  console.log(`${failed} check(s) FAILED — the exit-code class is open again`);
  process.exitCode = 1;
} else {
  console.log(`all checks pass (${gateFiles.length} gate files scanned, ${GUARDS.length} reviewed guards allowed)`);
}
