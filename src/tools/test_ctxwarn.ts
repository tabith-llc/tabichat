// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the fresh-session advisory.
//   bun tools/test_ctxwarn.ts      (exit 1 on any failure)
// Positive and negative halves both required.
// TEST-ENV SENTRY (leg 540) — same reason and same form as tools/test_steer.ts: `LEAD_NICK` is
// frozen at module load, a lead seat's shell exports MQTT_LEAD_NICK, and 4 honest checks read RED.
// Scrub first, then import the module-under-test dynamically (a static import hoists above the scrub).
// `import type` below is erased at compile time, so it pulls in the type without evaluating the module.
delete process.env.MQTT_LEAD_NICK;
delete process.env.MQTT_OWNER_NICK;
import type { CtxSample } from "../extensions/tabichat/ctxwarn.ts";
const {
  absoluteSessionDue,
  ctxDeclarationLine,
  ctxModelLabel,
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
check("threshold default is the 2026-10-07 owner number", ctxWarnThreshold(undefined), 60);
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
check("worker tells lead + owner", ctxWarnTargets("flash1", "owner"), ["lead-agent", "owner"]);
check("lead tells owner only", ctxWarnTargets("lead-agent", "owner"), ["owner"]);

// the room line
const worker = ctxWarnLine(sample(68), ctxWarnTargets("flash1", "owner"));
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

// --- absolute token tripwire (MQTT_CTX_TOKENS): fires on tokens, declaration ignored -----------
check("token threshold off by default", ctxTokenThreshold(undefined), 0);
check("token threshold parsed", ctxTokenThreshold("200000"), 200000);
check("token threshold blank is off", ctxTokenThreshold(""), 0);
check("token threshold junk is off", ctxTokenThreshold("banana"), 0);
check("token threshold negative is off", ctxTokenThreshold("-5"), 0);
check("absolute OFF means never due (negative half)", absoluteSessionDue(lying(500_000), 0, -1), false);
check("absolute below the floor not due (negative half)", absoluteSessionDue(lying(199_999), 200_000, -1), false);
check("absolute at the floor due (positive half)", absoluteSessionDue(lying(200_000), 200_000, -1), true);
check(
  "THE LIE: 22% of a wrong window still trips the absolute rule",
  absoluteSessionDue(lying(200_000, 1_000_000), 200_000, -1),
  true,
);
check(
  "and the percent rule alone would NOT have fired there (why the second rule exists)",
  freshSessionDue(lying(200_000, 1_000_000), 65, -1),
  false,
);
check("absolute unknown tokens not due", absoluteSessionDue({ tokens: null, contextWindow: 262_144, percent: null }, 200_000, -1), false);
check("absolute anti-noise: same count twice not due", absoluteSessionDue(lying(201_000), 200_000, 201_000), false);
check("absolute anti-noise: +20k due again", absoluteSessionDue(lying(221_000), 200_000, 201_000), true);

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
// OWNER ORDER 2026-10-24 ("GET RID OF THE CTX REPORT!"): the cell that used to sit here asserted the footer DID
// carry the fraction. It is DELETED, not left to fail and not softened into a pass — an assertion that
// contradicts an owner-ordered behaviour change is a false check, and the honest act is to remove it and say
// so. BOTH halves of the new rule are stated so this file still bites: the widget must be ABSENT from
// index.ts, and the advisory that replaced it must still be there.
check("the footer NO LONGER sets a ctx status entry (owner order 2026-10-24)", index.includes('setStatus("ctx"'), false);
check("the ctx advisory still addresses lead + owner", index.includes("ctxWarnTargets("), true);
check("ctxStatusText itself survives as an exported, tested helper", ctxStatusText(sample(68.7)), "ctx 68% (182k/256k)");
says("both counters advance together", index, "lastCtxWarnTokens = s.tokens");
says("compaction resets the absolute counter", index, "lastCtxWarnTokens = -1");

// --- FORCED handoff at 75 percent (raised from the 70 first discussed). At the threshold the
// lane must write a RESUME file; reads, writes to that file, and read-only git stay available; the block
// lifts on its own once the file exists; and after three unanswered refusals the gate gives up loudly.
const at = (pct: number) => ({ tokens: Math.round((pct / 100) * 262144), contextWindow: 262144, percent: pct });
check("force default is the owner's 75", ctxForceThreshold(undefined, 60), 75);
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
check("resume path is named by nick and boot tag", resumePath("/media/u/tabith/resume/", "flash1", "abc123"), "/media/u/tabith/resume/RESUME-flash1-abc123.md");
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
check("the block reason names the exact file to write", forceBlockNote("/media/u/tabith/resume/RESUME-ultra-0000aa.md").includes("RESUME-ultra-0000aa.md"), true);
check("...and carries the template's HOLD-flag line", forceBlockNote("/x").includes("HOLD flags"), true);
check("...and says nothing was killed", forceBlockNote("/x").includes("Nothing is lost and nothing was killed"), true);
check("the template asks for uncommitted/unpushed state", RESUME_TEMPLATE.includes("uncommitted or unpushed"), true);
check("the trigger line addresses the lead", forceRoomLine("flash1", at(76), 75, "/r/RESUME-flash1-000001.md", ["lead-agent", "dust"]).includes("@lead-agent"), true);
check("...and carries the path", forceRoomLine("flash1", at(76), 75, "/r/RESUME-flash1-000001.md", ["dust"]).includes("/r/RESUME-flash1-000001.md"), true);
check("the give-up line names the lane and the file", giveUpLine("flash1", 75, "/r/RESUME-flash1-000001.md").includes("did not write its RESUME file"), true);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks pass");
process.exitCode = failed ? 1 : 0;
