// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the fresh-session advisory.
//   bun tools/test_ctxwarn.ts      (exit 1 on any failure)
// Positive and negative halves both required.
// TEST-ENV SENTRY — same reason and same form as tools/test_steer.ts: `LEAD_NICK` is
// frozen at module load, a lead seat's shell exports MQTT_LEAD_NICK, and 4 honest checks read RED.
// Scrub first, then import the module-under-test dynamically (a static import hoists above the scrub).
// `import type` below is erased at compile time, so it pulls in the type without evaluating the module.
delete process.env.MQTT_LEAD_NICK;
delete process.env.MQTT_OWNER_NICK;
import type { CtxSample } from "../extensions/tabichat/ctxwarn.ts";
const {
  absoluteSessionDue,
  ctxDeclarationLine,
  ctxEffectiveFloor,
  ctxModelLabel,
  ctxRewarnStep,
  ctxStatusText,
  ctxTokenThreshold,
  ctxWarnLine,
  ctxWarnTargets,
  ctxWarnThreshold,
  ctxForceThreshold,
  bashAllowedWhileForced,
  forceBlockNote,
  forceDue,
  forceRoomLine,
  giveUpLine,
  giveUpNow,
  rearmForce,
  RESUME_TEMPLATE,
  resumePath,
  resumeWritten,
  freshSessionDue,
  // iid 17 — the payload and leg bar
  currentLeg,
  LEG_ENV,
  RESUME_MIN_BYTES,
  legInName,
  legInLine,
  legInHead,
  RESUME_MIN_SECTIONS,
  RESUME_SECTIONS,
  resumeSectionTerms,
  resumeSectionsPresent,
  handoffContentVerdict,
} = await import("../extensions/tabichat/ctxwarn.ts");
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

/** Assert a substring is present (wording checks). */
const says = (name: string, hay: string, needle: string) => check(name, hay.includes(needle), true);

const sample = (percent: number | null, tokens: number | null = 186_000, contextWindow = 262_144): CtxSample => ({
  tokens,
  contextWindow,
  percent,
});

// The incident this file's absolute rule was written for: a 262,144-token model whose serving
// host stops far short of that. pi divides by the DECLARED window, so 58k tokens reads as 22% and
// nothing ever fires — not the advisory, and not pi's own compaction.
const lying = (tokens: number, declared = 262_144): CtxSample => ({
  tokens,
  contextWindow: declared,
  percent: (tokens / declared) * 100,
});

// threshold parsing (MQTT_CTX_WARN)
check("threshold default is the shipped number", ctxWarnThreshold(undefined), 60);
check("threshold override", ctxWarnThreshold("80"), 80);
check("threshold zero allowed", ctxWarnThreshold("0"), 0);
check("threshold clamped high", ctxWarnThreshold("150"), 99);
check("threshold garbage falls back to 60", ctxWarnThreshold("banana"), 60);

// due / not due, threshold 65, never warned
check("64.9% not due (negative half)", freshSessionDue(sample(64.9), 65, -1), false);
check("65% due (positive half)", freshSessionDue(sample(65), 65, -1), true);
check("92% due", freshSessionDue(sample(92), 65, -1), true);
check("null percent not due", freshSessionDue(sample(null), 65, -1), false);
check("null tokens not due", freshSessionDue(sample(70, null), 65, -1), false);
check("undeclared window not due", freshSessionDue(sample(70, 100, 0), 65, -1), false);
check("68% after a 65% advisory not due (anti-noise)", freshSessionDue(sample(68), 65, 65), false);
check("75% after a 65% advisory due", freshSessionDue(sample(75), 65, 65), true);
check("68% after a 90% advisory not due", freshSessionDue(sample(68), 65, 90), false);
check("60% below an 80% threshold not due", freshSessionDue(sample(60), 80, -1), false);

// who gets told
check("worker tells lead + owner", ctxWarnTargets("lane1", "owner"), ["lead-agent", "owner"]);
check("lead tells owner only", ctxWarnTargets("lead-agent", "owner"), ["owner"]);

// the room line
const worker = ctxWarnLine(sample(68), ctxWarnTargets("lane1", "owner"));
const lead = ctxWarnLine(sample(68), ctxWarnTargets("lead-agent", "owner"));
check("worker line addresses lead and owner", worker.startsWith("@lead-agent @owner "), true);
check("lead line addresses owner only", lead.startsWith("@owner "), true);
check("worker line carries the percent", worker.includes("CONTEXT 68%"), true);
check("worker line carries tokens/window", worker.includes("(182k/256k, 68% of the window)"), true);
check("worker line states the ask", worker.includes("fresh session needed"), true);
check("room line has no newline", worker.includes("\n"), false);

// footer status text
check("status unknown when no sample", ctxStatusText(null), "ctx: unknown");
check("status unknown when percent null", ctxStatusText(sample(null)), "ctx: unknown");
check("status floors the percent and shows the fraction", ctxStatusText(sample(68.7)), "ctx 68% (182k/256k)");
check("status omits nothing when tokens are unknown", ctxStatusText({ tokens: null, contextWindow: 262_144, percent: 12 }), "ctx 12% (0k/256k)");

// --- absolute token tripwire (MQTT_CTX_TOKENS): fires on tokens, at a floor the declaration can
// still be trusted to leave room beneath ------------------------------------------------------
check("token threshold off by default", ctxTokenThreshold(undefined), 0);
check("token threshold parsed", ctxTokenThreshold("200000"), 200000);
check("token threshold blank is off", ctxTokenThreshold(""), 0);
check("token threshold junk is off", ctxTokenThreshold("banana"), 0);
check("token threshold negative is off", ctxTokenThreshold("-5"), 0);
check("absolute OFF means never due (negative half)", absoluteSessionDue(lying(500_000), 0, -1), false);
check("absolute below the floor not due (negative half)", absoluteSessionDue(lying(199_999), 200_000, -1), false);
check("absolute at the floor due (positive half)", absoluteSessionDue(lying(200_000), 200_000, -1), true);
// THIS CELL WAS REVERSED, not deleted, at a prior leg, and the reason is the defect it addressed: the same
// reading (a floor crossed at a fifth of the declared window) is the false alarm that was halting
// staffed lanes, and the guard it was meant to provide is kept by the two cells under it — the lie
// that is caught is one whose declaration puts it in the band, not one read at 20%.
check(
  "THE LIE, 20% of a 1M declaration: no longer due — this was the false-alarm class",
  absoluteSessionDue(lying(200_000, 1_000_000), 200_000, -1),
  false,
);
check(
  "and the percent rule agrees nothing was due there (why the floor moved, not vanished)",
  freshSessionDue(lying(200_000, 1_000_000), 65, -1),
  false,
);
check("absolute unknown tokens not due", absoluteSessionDue({ tokens: null, contextWindow: 262_144, percent: null }, 200_000, -1), false);
check("absolute anti-noise: same count twice not due", absoluteSessionDue(lying(201_000), 200_000, 201_000), false);
check(
  "absolute anti-noise: under one tenth of the window, not due again",
  absoluteSessionDue(lying(221_000), 200_000, 201_000),
  false,
);
check(
  "absolute anti-noise: one scaled step on (26,214 = 10% of a 262,144 declaration) is due again",
  absoluteSessionDue(lying(227_214), 200_000, 201_000),
  true,
);

// --- the tripwire respects a window it cannot possibly be guarding ------------------------------
// The field faces are the acceptance instrument (lane11-652-note-false-positive-face-20261028.md):
// three published lines between 29% and 51% of a 1,000,000-token declaration that commanded a
// restart which was NOT due, and two true faces — a seat renewal-due at 55% of that same window,
// and a seat at 76% of a 262,144 declaration. Silencing all five would be a weakened check, so the
// cells below take each observed line by its own number.
const big = (tokens: number, declared = 1_000_000): CtxSample => ({
  tokens,
  contextWindow: declared,
  percent: (tokens / declared) * 100,
});
// the configured floor of the box is MQTT_CTX_TOKENS=256000; every row below uses it
const FLOOR_SET = 256_000;
check("652 FALSE face: 29% (288k/977k) is silent", absoluteSessionDue(big(288_000), FLOOR_SET, -1), false);
check("652 FALSE face: 41% (410k/977k) is silent", absoluteSessionDue(big(410_000), FLOOR_SET, -1), false);
check("652 FALSE face: 51% (510k/977k) is silent", absoluteSessionDue(big(510_000), FLOOR_SET, -1), false);
check("652 FALSE face: the measured 25.6% (256k/977k) is silent", absoluteSessionDue(big(256_000), FLOOR_SET, -1), false);
check("652 ...and the percent rule agrees none of those were due", [410_000, 510_000].map((t) => freshSessionDue(big(t), 60, -1)), [false, false]);
check("652 TRUE face: 55% (554k/977k) still trips", absoluteSessionDue(big(554_000), FLOOR_SET, -1), true);
check("652 ...and the percent rule alone would NOT have caught it there", freshSessionDue(big(554_000), 60, -1), false);
check("652 TRUE face: 76% of a real 262,144 declaration still trips", absoluteSessionDue(lying(199_000), FLOOR_SET, -1) || freshSessionDue(lying(199_000), 60, -1), true);
check("652 ...that face is carried by the percentage rule, not the tripwire", freshSessionDue(lying(199_000), 60, -1), true);
check("652 THE LIE, small window: a 200k floor under a 262,144 declaration still trips at 200k", absoluteSessionDue(lying(200_000), 200_000, -1), true);
check("652 THE LIE, 3x over: a seat declaring 786k that dies at 500k still trips at its floor", absoluteSessionDue(big(500_000, 786_432), FLOOR_SET, -1), true);
check("652: a floor that already sits over the band is left alone, so it never trips early", absoluteSessionDue(big(500_000), 900_000, -1), false);
check("652: =0 keeps the off-switch, near the ceiling and everywhere else", absoluteSessionDue(big(900_000), 0, -1), false);
check("652: junk and negative thresholds are off on a big window too", absoluteSessionDue(big(900_000), ctxTokenThreshold("banana"), -1), false);
check("652: unknown tokens stay silent on a big window", absoluteSessionDue({ tokens: null, contextWindow: 1_000_000, percent: null }, FLOOR_SET, -1), false);
check("652: no declaration at all keeps the configured floor exactly", ctxEffectiveFloor(0, FLOOR_SET), 256_000);
// the re-warn step is the other half of the noise: a fixed 20,000 is 2% of a 1,000,000 window, so a
// crossed lane re-nagged every two points. It now scales with the declaration; 20,000 is its floor.
check("652: re-warn step is 10% of a 262,144 declaration", ctxRewarnStep(262_144), 26_214);
check("652: re-warn step is 10% of a 1,000,000 declaration", ctxRewarnStep(1_000_000), 100_000);
check("652: the 20,000 floor still applies where the window is tiny", ctxRewarnStep(100_000), 20_000);
check("652: an honest 1M seat does not re-nag inside one tenth of its window", absoluteSessionDue(big(600_000), FLOOR_SET, 554_000), false);
check("652: ...and it does re-nag a tenth of the window later", absoluteSessionDue(big(654_000), FLOOR_SET, 554_000), true);
// the line must name the number that actually fired, not the raw config value
check("652: the room line names the EFFECTIVE floor, in the same k() form as every other number here", ctxWarnLine(big(554_000), ["lead", "owner"], "tokens", ctxEffectiveFloor(1_000_000, FLOOR_SET)).includes("over the 537k absolute limit"), true);
check("652: ...and it is NOT the raw configured number the false alarm used to print", ctxWarnLine(big(554_000), ["lead", "owner"], "tokens", ctxEffectiveFloor(1_000_000, FLOOR_SET)).includes("over the 250k absolute limit"), false);
check("652: ...and the effective floor is 550k on a 1M window, 256k on a 262k one", [ctxEffectiveFloor(1_000_000, FLOOR_SET), ctxEffectiveFloor(262_144, FLOOR_SET)], [550_000, 256_000]);

// the room line names which rule fired, so a lead never has to guess
const absLine = ctxWarnLine(lying(200_000, 1_000_000), ["lead-agent", "owner"], "tokens", 200_000);
says("absolute line names the tripwire", absLine, "over the 195k absolute limit");
says("percent line names the window", worker, "68% of the window");
check("absolute line has no newline", absLine.includes("\n"), false);

// --- naming the denominator -------------------------------------------------------------------
check("model label is provider/id", ctxModelLabel({ provider: "opencode", id: "qwen3.8-flash" }), "opencode/qwen3.8-flash");
check("model label without a provider", ctxModelLabel({ id: "x" }), "?/x");
check("model label when there is no model", ctxModelLabel(undefined), "unknown model");
check("model label for a null model", ctxModelLabel(null), "unknown model");
const decl = ctxDeclarationLine(lying(58_000), "opencode/qwen3.8-flash", 65, 200_000);
says("declaration line gives the fraction", decl, "22% = 58000/262144");
says("declaration line names the model", decl, "opencode/qwen3.8-flash");
says("declaration line says it is not measured", decl, "DECLARED");
const declUnknown = ctxDeclarationLine({ tokens: null, contextWindow: 262_144, percent: null }, "tabith/lead-agent", 65, 0);
says("unknown-usage declaration still names the window", declUnknown, "window 262144 declared");
says("unknown-usage declaration says so", declUnknown, "unknown until the first response");
check(
  "no-window declaration turns the percent advisory off in words",
  ctxDeclarationLine(null, "tabith/lead-agent", 65, 0).includes("advisory OFF"),
  true,
);

// --- the wiring in index.ts -------------------------------------------------------------------
const index = readFileSync(join(import.meta.dir, "..", "extensions", "tabichat", "index.ts"), "utf8");
says("index reads MQTT_CTX_TOKENS", index, "process.env.MQTT_CTX_TOKENS");
says("index asks the absolute rule", index, "absoluteSessionDue(");
says("index names the model in the report", index, "ctxModelLabel(ctx.model)");
says("index states the declaration at session start", index, "ctxDeclarationLine(");
// OWNER ORDER ("GET RID OF THE CTX REPORT!"): the cell that used to sit here asserted the footer DID
// carry the fraction. It is DELETED, not left to fail and not softened into a pass — an assertion that
// contradicts an owner-ordered behaviour change is a false check, and the honest act is to remove it and say
// so. BOTH halves of the new rule are stated so this file still bites: the widget must be ABSENT from
// index.ts, and the advisory that replaced it must still be there.
check("the footer NO LONGER sets a ctx status entry", index.includes('setStatus("ctx"'), false);
check("the ctx advisory still addresses lead + owner", index.includes("ctxWarnTargets("), true);
check("ctxStatusText itself survives as an exported, tested helper", ctxStatusText(sample(68.7)), "ctx 68% (182k/256k)");
says("both counters advance together", index, "lastCtxWarnTokens = s.tokens");
says("compaction resets the absolute counter", index, "lastCtxWarnTokens = -1");

// --- FORCED handoff at 75 percent (raised from the 70 first discussed). At the threshold the
// lane must write a RESUME file; reads, writes to that file, and read-only git stay available; the block
// lifts on its own once the file exists; and after three unanswered refusals the gate gives up loudly.
const at = (pct: number) => ({ tokens: Math.round((pct / 100) * 262144), contextWindow: 262144, percent: pct });
check("force default is the shipped 75", ctxForceThreshold(undefined, 60), 75);
check("force override parses", ctxForceThreshold("80", 60), 80);
check("force never sits BELOW the warn threshold", ctxForceThreshold("50", 60), 60);
check("force clamped high", ctxForceThreshold("150", 60), 99);
check("force junk falls back to 75", ctxForceThreshold("banana", 60), 75);
check("one point under the force threshold is not due", forceDue(at(74), 75, false), false);
check("at the threshold it is due", forceDue(at(75), 75, false), true);
check("...and a second firing in the same crossing does not re-arm", forceDue(at(80), 75, true), false);
check("no reading means not due", forceDue({ tokens: null, contextWindow: 262144, percent: null }, 75, false), false);
check("pi compacting (percent well back) re-arms the force", rearmForce(true, 62, 75), false);
check("a small drop does NOT re-arm (no second blocking in one decline)", rearmForce(true, 70, 75), true);
check("an unarmed force stays unarmed", rearmForce(false, 10, 75), false);
check("resume path is named by nick and boot tag", resumePath("/home/u/resume/", "lane1", "abc123"), "/home/u/resume/RESUME-lane1-abc123.md");
check("a missing file is not written", resumeWritten(false, 0), false);
check("a stub file is not written (too small to help the next seat)", resumeWritten(true, 199), false);
check("a real file counts", resumeWritten(true, 200), true);
check("two refusals is not yet giving up", giveUpNow(2, false), false);
check("three refusals with no file gives up", giveUpNow(3, false), true);
check("once the file exists the gate never gives up", giveUpNow(9, true), false);
check("read-only git stays available while blocked", bashAllowedWhileForced("git status --short"), true);
check("...and so does a read-only chain", bashAllowedWhileForced("git status && git diff --stat"), true);
check("git commit is NOT read-only", bashAllowedWhileForced("git commit -m x"), false);
check("git push is NOT read-only", bashAllowedWhileForced("git status && git push"), false);
check("a redirect out of git is not read-only", bashAllowedWhileForced("git status > /tmp/x"), false);
check("an unrelated command is blocked", bashAllowedWhileForced("rm -rf build"), false);
check("an empty command is blocked", bashAllowedWhileForced("   "), false);
check("the block reason names the exact file to write", forceBlockNote("/home/u/resume/RESUME-lane10-0000aa.md").includes("RESUME-lane10-0000aa.md"), true);
check("...and carries the template's HOLD-flag line", forceBlockNote("/x").includes("HOLD flags"), true);
check("...and says nothing was killed", forceBlockNote("/x").includes("Nothing is lost and nothing was killed"), true);
check("the template asks for uncommitted/unpushed state", RESUME_TEMPLATE.includes("uncommitted or unpushed"), true);
check("the trigger line addresses the lead", forceRoomLine("lane1", at(76), 75, "/r/RESUME-lane1-000001.md", ["lead-agent", "lane16"]).includes("@lead-agent"), true);
check("...and carries the path", forceRoomLine("lane1", at(76), 75, "/r/RESUME-lane1-000001.md", ["lane16"]).includes("/r/RESUME-lane1-000001.md"), true);
check("the give-up line names the lane and the file", giveUpLine("lane1", 75, "/r/RESUME-lane1-000001.md").includes("did not write its RESUME file"), true);


// ─── iid 17 — the payload bar and leg currency ──────────────────────────────────────
// The row: the renew bar admitted a handoff by BOOT, so a sheet written early in a boot for an
// earlier leg passed for the leg about to be lost, and a fresh file of headings with nothing under it
// cleared the byte floor. Both halves get their refusal case AND their acceptance case here, and every
// fixture is a string — this gate never reads the disk, so no cell can pass on one lane's /tmp.
console.log("\n== iid 17: leg currency, read from the name and the head ==");
check("a plain `leg 954` in a sentence answers", legInLine("lane3 resume: leg 954 — CLOSED, nothing in flight"), "954");
check("the block form answers too", legInLine("leg 959"), "959");
check("...and so does `Leg: 959 — verdict`", legInLine("Leg: 959 — verdict"), "959");
check("NEGATIVE: a branch slug `by-leg-17` is NOT a leg — it would answer for the wrong number", legInLine("Branch `feature/handoff-bar-by-leg-17`"), null);
check("NEGATIVE: a bare number with no leg word before it is not a leg either", legInLine("959-leg handoff"), null);
check("a `-leg959` filename slug answers", legInName("RESUME-lane3-0554ee-leg959.md"), "959");
check("a trailing all-digit component answers — this box has sheets named that way", legInName("RESUME-lane14-01a1a325-940.md"), "940");
check("NEGATIVE: a hex BOOT tag is not a leg. That is the key this row says is the wrong key", legInName("RESUME-lane3-0554ee.md"), null);
check("NEGATIVE: and digits nowhere in the name means no leg in the name", legInName("RESUME-lane3-next-s141.md"), null);
check("legInHead reads in order and takes the first", legInHead("title line\nleg 959\nleg 12\n"), "959");
check("currentLeg pulls the digits out of a hand-written launcher value", currentLeg({ MQTT_LEG: "leg-959" }), "959");
check("...and the plain form", currentLeg({ MQTT_LEG: "959" }), "959");
check("NEGATIVE: unset is empty, not zero", currentLeg({}), "");
check("NEGATIVE: garbage declares NO leg rather than a wrong one", currentLeg({ MQTT_LEG: "soon" }), "");
check("the knob the refusal names is the knob this reads", LEG_ENV, "MQTT_LEG");

console.log("\n== iid 17: the blocks, and what counts as answering one ==");
check("every block resolves to a real line of the template (a rename goes RED, not unchecked)",
  resumeSectionTerms().every((d) => d.terms.length > 2), true);
check("and each block's fragment identifies EXACTLY ONE template line (no overlap, no orphan)",
  RESUME_SECTIONS.map((s) => [s.label, RESUME_TEMPLATE.split("\n").filter((l) => l.toLowerCase().includes(s.line.toLowerCase())).length]),
  [
    ["venue", 1],
    ["task", 1],
    ["branch", 1],
    ["mid-flight", 1],
    ["next steps", 1],
    ["report", 1],
    ["HOLD", 1],
  ]);
check("the template now asks the lane for its leg, in the same notice the bar reads",
  RESUME_TEMPLATE.includes("leg <n> this handoff describes"), true);
check("a sheet of headings with nothing under it answers NOTHING",
  resumeSectionsPresent(Array.from({ length: 40 }, (_, i) => `## block ${i}`).join("\n")), []);
check("an empty string answers nothing", resumeSectionsPresent(""), []);
check("NEGATIVE: the template copied out VERBATIM is unfilled slots, not answers",
  resumeSectionsPresent("# handoff\n" + RESUME_TEMPLATE + "\n"), []);
check("a heading is not a value", resumeSectionsPresent("next steps:\nvenue:\nreport:\nHOLD:\nbranch:\n"), []);

const GOOD = `lane3 report: the renew bar is current by leg, not by boot
leg 954 — payload floor and leg currency are in
  venue: work5/tabichat-959 (my tabichat clone, branch feature/handoff-bar-by-leg-17)
  task and the spec path it came from: specs/handoff-bar-by-leg-959.md
  branch tip 580572c, nothing uncommitted or unpushed
  mid-flight right now: writing the cells, next command is the stage run
  next steps: faces 2 to 8, then the report, then push both faces
  report path: specs/handoff-bar-by-leg-959-report.md
  HOLD flags — no merge, no tag, no deploy verb at the live destination
`;
const NOLEG = GOOD.replace("leg 954 — payload floor and leg currency are in\n", "");
check("a genuine sheet answers all seven blocks", resumeSectionsPresent(GOOD).length, 7);
check("NEGATIVE for the n-of-m choice: one block missing still PASSES, because four-block real handoffs are on this box",
  resumeSectionsPresent(GOOD.replace(/  HOLD flags[^\n]*\n/, "")).length >= RESUME_MIN_SECTIONS, true);
check("RESUME_MIN_SECTIONS is the derived 4, not a picked number", RESUME_MIN_SECTIONS, 4);
check("and seven blocks are enumerated", RESUME_SECTIONS.length, 7);

console.log("\n== iid 17: handoffContentVerdict — both doors, both ways ==");
const stale = handoffContentVerdict("RESUME-lane3-0554ee.md", GOOD, "961");
check("RENEW REFUSED: a sheet for leg 954 cannot stand for leg 961, same boot and all", stale.ok, false);
says("...and the refusal prints the leg the sheet describes", stale.reason, "leg 954");
says("...and the leg the seat is actually on", stale.reason, "leg 961");
says("...and how to fix it", stale.reason, "Write a handoff for leg 961");
const match = handoffContentVerdict("RESUME-lane3-0554ee.md", GOOD, "954");
check("PASSES: the same sheet, for the leg the seat is running", match.ok, true);
says("...and the accepted reason says what it checked", match.reason, "names leg 954");
check("a sheet that names NO leg is refused when the seat declares one",
  handoffContentVerdict("RESUME-lane3-0554ee.md", NOLEG, "954").ok, false);
const nolane = handoffContentVerdict("RESUME-lane3-0554ee.md", NOLEG, "");
check("NEGATIVE: with no leg declared it is NOT refused — that would strand every lane on a box that never set MQTT_LEG",
  nolane.ok, true);
says("...and the accept line says the leg was read, not compared", nolane.reason, "READ, not COMPARED");
says("...and names the knob that would make it bite", nolane.reason, "MQTT_LEG=<n>");
const padded = handoffContentVerdict("RESUME-lane3-0000aa.md", "x".repeat(400), "");
check("RENEW REFUSED: a 400-byte sheet that answers nothing — over the byte floor, under the payload one", padded.ok, false);
says("...and the refusal lists what is missing", padded.reason, "venue");
says("...and states that the byte floor was NOT the fix", padded.reason, "200 is unchanged on purpose");
check("THE FLOOR THIS ROW FORBADE: RESUME_MIN_BYTES is still 200 — the byte measure was not raised to reach green",
  RESUME_MIN_BYTES, 200);
check("and the payload bar is a SEPARATE bar, so the byte floor still bites on its own", resumeWritten(true, 199), false);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks pass");
process.exitCode = failed ? 1 : 0;
