// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the notice tags (the two rules below).
//   bun tools/test_notice_prefix.ts      (exit 1 on any failure)
//
// Ruling 1: the room notices must say "[tabichat]", never "[mqtt]" — the tag names the product
//           the lane is talking to, not the transport underneath it.
// Ruling 2: a subsystem notice carries the product tag FIRST: "[tabichat][ctx]",
//           "[tabichat][exitlog]", "[tabichat][steer]". One bracket
//           of provenance on every line this extension prints.
//           ("ask_owner" left this list with the tool itself, owner order 2026-10-08; the four
//           subsystems that still print a notice are all still checked.)
//           UPSTREAM is the one subsystem that carries the tag as "[tabichat] " plus a prose cause
//           instead of a second bracket: owner ruling of 2026-10-25 (Q8) requires the product tag
//           AT THE FRONT AND ONLY THERE, with UPSTREAM named as the cause and the provider payload
//           left out. LEG 537 shipped the tag trailing; that form is reversed and the emit-site
//           cells below lock the front position. Rule 2's own requirement — tag first — is what
//           that ruling agrees with, so no cell here was loosened.
//
// Both halves are required: every rule gets the case that must pass AND the case that must be
// rejected, otherwise a scanner that always answers "clean" would keep this gate green.
import { readFileSync } from "node:fs";
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

const PRODUCT = "[tabichat]";
const RETIRED = "[mqtt]";
const SUBSYSTEMS = ["ctx", "exitlog", "upstream", "steer"];
// index.ts carried 15 room notices at the sweep. A floor, not an exact count: adding a notice is
// legitimate, deleting them quietly is not.
const ROOM_FLOOR = 15;
const DIR = join(import.meta.dir, "..", "extensions", "tabichat");
const FILES = ["index.ts", "roommsg.ts", "mention.ts", "ctxwarn.ts", "errnote.ts", "exitlog.ts", "steer.ts"];

/** How many times `needle` occurs in `hay`. */
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** Rule 2 as a predicate: every subsystem tag in `text` already carries the product tag. */
const bareSubsystemTags = (text: string): string[] =>
  SUBSYSTEMS.filter((s) => count(text, `[${s}]`) !== count(text, `${PRODUCT}[${s}]`));

// --- the scanner and the predicate, positive and negative halves ---------------------------
check("scanner counts a repeated tag", count("a [tabichat] b [tabichat] c", PRODUCT), 2);
check("scanner finds the retired tag in a sample", count(`x ${RETIRED} y`, RETIRED), 1);
check("scanner answers zero on clean text", count("x [tabichat][ctx] y", RETIRED), 0);
check("scanner counts an empty string as none", count("", PRODUCT), 0);
check("compound tag passes the rule", bareSubsystemTags("a [tabichat][ctx] b"), []);
check("bare subsystem tag is caught", bareSubsystemTags("a [ctx] b"), ["ctx"]);
check("mixed file reports the bare one only", bareSubsystemTags("[tabichat][ctx] then [exitlog]"), ["exitlog"]);
check("absent subsystem is not a finding", bareSubsystemTags("nothing tagged here"), []);

// --- rule 1: the retired transport tag is gone from the whole extension --------------------
let retiredTotal = 0;
for (const f of FILES) {
  let text = "";
  try {
    text = readFileSync(join(DIR, f), "utf8");
  } catch {
    check(`${f} is readable`, "missing", "present");
    continue;
  }
  const hits = count(text, RETIRED);
  retiredTotal += hits;
  check(`${f} carries no retired tag`, hits, 0);
}
check("no file in the extension reintroduces [mqtt]", retiredTotal, 0);

// --- rule 1 + rule 2 on the file that prints the notices -----------------------------------
const index = readFileSync(join(DIR, "index.ts"), "utf8");
const roomCount = count(index, `${PRODUCT} `);
check(`room notices still carry [tabichat] (>= ${ROOM_FLOOR})`, roomCount >= ROOM_FLOOR, true);
check("no bare subsystem tag survives in index.ts", bareSubsystemTags(index), []);
// LEG 542 (owner ruling of 2026-10-25, Q8): the product tag must be AT THE FRONT and the notice
// must carry no provider payload. The tag now lives in buildNote, so BOTH surfaces (the footer
// status and this toast) read one string and cannot drift — which is the failure this pair locks:
// a call site that re-adds or moves a tag would produce two different shapes from one event.
// Both halves were negative-controlled against the bytes at `c84b15f` (the leg 537 face, tag
// TRAILING): re-apply `notify(`${note} [tabichat]`, "warning")` and cell 1 goes got:true/want:false
// while cell 2 goes got:false/want:true; revert buildNote to the leading-tag form and cell 3 reddens.
check(
  "the upstream call site carries no trailing tag (the leg 537 shape is reversed)",
  /notify\(`\$\{note\}[^`]*\[tabichat\]/.test(index),
  false,
);
check(
  "the upstream toast notifies from the note verbatim, on both surfaces",
  /setStatus\("upstream", note\)/.test(index) && /notify\(note, "warning"\)/.test(index),
  true,
);
const errleaf = readFileSync(join(DIR, "errnote.ts"), "utf8");
check(
  "the notice text opens with the product tag",
  /return `\[tabichat\] \$\{cause\}/.test(errleaf),
  true,
);
// steer.ts prints the one line a steered mention carries, so it is under the same tag law
const steerLeaf = readFileSync(join(DIR, "steer.ts"), "utf8");
check("no bare subsystem tag survives in steer.ts", bareSubsystemTags(steerLeaf), []);
check("the steer header compounds the product tag", count(steerLeaf, `${PRODUCT}[steer]`) >= 1, true);
check(
  "the retired tag is not hiding inside a notify argument",
  /notify\([^)]*\[mqtt/i.test(index),
  false,
);

// OWNER BUG REPORT 2026-10-24 — "this is written in your harness where normally the user would type!
// UNACCEPTABLE!" The line was `[tabichat][ack-board] cleared 1 of my own retained receipt older than
// 3600000ms`: an hourly timer cleaning THIS seat's own expired retained receipts, announced as an operator
// notice. Two rules come out of it, and BOTH cells were negative-controlled against the shipped bytes at
// `main` (`1b69e32`) before they were written — predicate | on my branch | on `main`: fallback-inside-catch
// | 1 | 0 ; housekeeping notify | 0 | 1. A check that cannot fail is not a check.
check(
  "no operator line for the retained-receipt sweep (owner: noise in the input area is a release blocker)",
  index.includes("ack-board] cleared"),
  false,
);
check(
  "notifySafely has ONE sink: stderr is the fallback INSIDE the catch, never a second publish",
  (() => {
    const at = index.indexOf("console.error(text)");
    if (at < 0) return false;
    const before = index.slice(Math.max(0, at - 60), at).replace(/\s+/g, " ");
    return before.includes("} catch {");
  })(),
  true,
);

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  const compound = SUBSYSTEMS.reduce((n, s) => n + count(index, `${PRODUCT}[${s}]`), 0);
  console.log(`\nall checks pass (${roomCount} room notices, ${compound} subsystem notices tagged)`);
}
