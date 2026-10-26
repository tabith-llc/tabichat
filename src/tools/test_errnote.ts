// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the upstream-error notice.
//   bun tools/test_errnote.ts      (exit 1 on any failure)
// Positive and negative halves both required: a notice that also fires on a clean
// or interrupted turn is worse than no notice.
import { buildNote, upstreamErrorNote, type EndMessage } from "../extensions/tabichat/errnote.ts";

// The contract, from the owner's ruling of 2026-10-25 (Q8, resolving the earlier no-echo ruling):
// a tabichat-originated system message carries the product tag AT THE FRONT, names UPSTREAM as
// the cause, states the EFFECT on tabichat (the turn ended; this class is not retried), and does
// NOT restate the provider's payload — pi already prints that. TAG_LEAD / CAUSE_TOKEN / EFFECT are
// the three load-bearing halves, stated here as values so a regression is caught by a check and
// not by a reviewer's memory.
const TAG_LEAD = "[tabichat] ";
const CAUSE_TOKEN = "UPSTREAM";
const EFFECT = "turn ended, not retried";

/** The whole notice, for the exact-equality cells: tag first, then cause, then effect. */
const noticeFor = (code: string | null) =>
  `${TAG_LEAD}${code ? `UPSTREAM ${code} provider error` : "UPSTREAM provider error"} \u2014 ${EFFECT}; pi shows the provider's message.`;

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

const asst = (stopReason: string, errorMessage?: string): EndMessage => ({
  role: "assistant",
  stopReason,
  errorMessage,
});

// --- negative half: nothing may be shown when nothing is wrong ---
check("no messages at all", upstreamErrorNote([]), null);
check("clean stop", upstreamErrorNote([asst("stop")]), null);
check("tool use still working", upstreamErrorNote([asst("toolUse")]), null);
check("human interrupt is not an upstream fault", upstreamErrorNote([asst("aborted", "Operation aborted")]), null);
check("no assistant message", upstreamErrorNote([{ role: "user" }]), null);
check("missing stopReason", upstreamErrorNote([{ role: "assistant" }]), null);
check("clean turn after an earlier error", upstreamErrorNote([asst("error", "400 boom"), asst("stop")]), null);

// --- positive half: the shape this lane saw physically on 2026-10-05 ---
const sse = "400 event: error\ndata: {}\n\n";
const hit = upstreamErrorNote([{ role: "user" }, asst("toolUse"), asst("error", sse)]);
check("detects the provider 400", typeof hit, "string");
check("names the status code", (hit ?? "").includes("UPSTREAM 400 "), true);
check("states the effect on tabichat", (hit ?? "").includes(EFFECT), true);
// Q8 REVERSES two cells that leg 537 wrote to the earlier reading, and both reversals are
// required by the ruling rather than chosen to go green:
//   "says what to do" ("retry needed") is gone, because the notice now states what HAPPENED;
//   "opens by naming upstream" and "does not open with the product name" both flip, because the
//   product tag must now come FIRST. The no-echo ruling is unchanged and stays locked below.
check("carries NO provider prose (the old echo is gone)", (hit ?? "").includes("event: error"), false);
check("opens with the product tag", (hit ?? "").startsWith(TAG_LEAD), true);
check("does NOT open with the cause (tag is first now)", (hit ?? "").startsWith(CAUSE_TOKEN), false);
check("names upstream as the cause, after the tag", (hit ?? "").includes(CAUSE_TOKEN), true);
check("the notice is the ruled string exactly", hit, noticeFor("400"));
check("notice is one line", (hit ?? "").includes("\n"), false);
check("collapsed the blank line from the SSE frame", (hit ?? "").includes("  "), false);
check("still detected when a tool result follows", upstreamErrorNote([asst("error", sse), { role: "toolResult" }]) !== null, true);

// --- the text builder, both halves ---
check("no code in the text", buildNote("Connection reset"), noticeFor(null));
check("empty error text", buildNote(""), noticeFor(null));
check("missing error text", buildNote(undefined), noticeFor(null));
check("401 is named", buildNote('401 {"type":"error"}').includes("UPSTREAM 401 "), true);
check("429 is named", buildNote("429: provider returned error").includes("UPSTREAM 429 "), true);
const long = buildNote("400 " + "x".repeat(300));
// Replaces "detail is capped" / "capped detail is marked": there is no provider detail to cap
// any more, so the bound is total — the same input that used to be truncated to 60 chars of
// prose now contributes nothing but its status code. Stronger half, same intent (one short line).
check("a 300-char provider text contributes no prose", long.includes("xxx"), false);
check("the line is the ruled string, whatever the provider said", long, noticeFor("400"));
check("a number late in the text is not read as a code", buildNote("no code here 2026"), noticeFor(null));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks pass");
process.exitCode = failed ? 1 : 0;
