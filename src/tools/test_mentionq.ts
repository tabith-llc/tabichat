// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for mention-queue collapse (option B; gate corrected
// 2026-10-11 — it now reads the lane's RUN STATE, not pi's queue depth).
//   bun tools/test_mentionq.ts      (exit 1 on any failure)
//
// THE RULE UNDER TEST: a mention that lands while the lane is busy does not buy its own visible
// pi queue block — it is HELD in tabichat and drains oldest-first when the run settles. An
// honoured steer is exempt — holding an interrupt would defeat it. And nothing is ever discarded:
// a full hold list hands through to pi rather than dropping an instruction.
//
// THE ARM THAT BROKE IN PRODUCTION, pinned here so it cannot come back: a busy lane has an EMPTY
// pi queue (it is executing, not waiting on input), so a gate reading queue depth answers "queue"
// on every mid-run arrival and the stack never collapses. That is the `busy lane, pi queue empty`
// cell below — see the defect note in the spec dir.
//
// THE COALESCED FLUSH (the ask, verbatim: "i want it fixed. build held-flush"): the
// settle drain delivers ONE message per settle — bounded by 5 lines / 24,000 chars, whichever fills
// first, minimum one line, never truncated — instead of one sendUserMessage per held line. pi 1.1.0
// replays every prompt made while it emits `agent_settled` back-to-back with no delay, so the
// per-line drain was launching N full-context requests at a ~0 s gap: 6 errors / 11 turns (54.5%) at
// >=500k prompt tokens, versus 0/55 at 10-15 s (handoff-400-lane-deaths-20261005.md §2.17). The tail
// that does not fit stays held and drains at the NEXT settle, a whole lane turn later.
//
// THE SECOND RULE, added 2026-10-09 (owner, verbatim: "i want it fixed. build held-flush"): that
// drain delivers ONE coalesced message per settle, not one per held line, bounded by lines and
// characters with the overflow RE-HELD for the next settle. The per-line fan-out was launching N
// full-context requests at a ~0 s gap (pi replays the deferred settled prompts back-to-back), which
// is the measured 54.5% provider-error cell — see mentionq.ts and
// handoff-400-lane-deaths-20261005.md §2.17.
//
// Paired negatives everywhere, per the project's truth-table law: a decision function that always
// answered "hold" (a lane that never sees its mentions) fails here exactly as one that always
// answered "queue" (the disease we are treating) does.
import {
  holdBadge,
  holdsId,
  HELD_FLUSH_MAX_CHARS_DEFAULT,
  HELD_FLUSH_MAX_CHARS_ENV,
  HELD_FLUSH_MAX_LINES,
  heldBatchBody,
  heldBatchChars,
  heldFlushCharBudget,
  HOLD_BADGE_KEY,
  HOLD_MAX,
  holdDecision,
  heldHeader,
  MENTION_MERGE_ENV,
  mergeEnabled,
  noteHeld,
  planHeldFlush,
  takeHeld,
  type HeldMention,
} from "../extensions/tabichat/mentionq.ts";
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
const says = (name: string, hay: string, needle: string) =>
  check(name, hay.includes(needle), true);
const never = (name: string, hay: string, needle: string) =>
  check(name, hay.includes(needle), false);

const line = (id: string, nick = "lead-agent", body = `@worker ${id}`): HeldMention => ({
  id,
  nick,
  ts: 1_700_000_000_000,
  body,
});

/** A held line whose body is exactly `n` characters, for the char-budget cells. */
const fat = (id: string, n: number): HeldMention => {
  const head = `@worker ${id} `;
  return { id, nick: "owner", ts: 1_700_000_000_000, body: head + "x".repeat(Math.max(0, n - head.length)) };
};

/** The exact text the coalesced drain hands pi, so a cell tests what ships. */
const flushText = (send: readonly HeldMention[]): string =>
  `${heldHeader(send.length)}\n\n${heldBatchBody(send)}`;

// --- the switch -------------------------------------------------------------
check("env: unset means ON (the owner wants this behaviour)", mergeEnabled(undefined), true);
check("env: empty means ON", mergeEnabled(""), true);
for (const off of ["0", "false", "off", "no", "OFF", " No "]) {
  check(`env: ${JSON.stringify(off)} means OFF`, mergeEnabled(off), false);
}
for (const on of ["1", "true", "on", "yes", "gibberish"]) {
  check(`env: ${JSON.stringify(on)} keeps it ON`, mergeEnabled(on), true);
}
check("env name is the documented one", MENTION_MERGE_ENV, "MQTT_MENTION_MERGE");

// --- the decision: every arm, positive and negative -------------------------
check(
  "idle lane gets a real turn, never a hold",
  holdDecision({ enabled: true, cls: "turn", alreadyHeld: 3, busy: true }),
  "deliver",
);
check(
  "honoured steer is EXEMPT — it must interrupt, not wait",
  holdDecision({ enabled: true, cls: "steer", alreadyHeld: 5, busy: true }),
  "steer",
);
check(
  "switch OFF: a busy lane queues, exactly like the shipped build (kill switch works)",
  holdDecision({ enabled: false, cls: "followUp", alreadyHeld: 9, busy: true }),
  "queue",
);
// THE REGRESSION CELL (the defect, and the one this file was missing). A lane mid-run has an EMPTY
// pi queue, so this is the ordinary shape of a mid-run arrival: busy + followUp + nothing pending.
// At main `ab50c93` this arm answered `queue` — every mention its own block, 28 of them stacked —
// because the gate read `piHasPending` (pi queue depth) instead of run state.
check(
  "BUSY lane with an EMPTY pi queue holds — this is the arm that was broken",
  holdDecision({ enabled: true, cls: "followUp", alreadyHeld: 0, busy: true }),
  "hold",
);
check(
  "NEGATIVE half: the lane is NOT busy and pi has nothing pending -> queue, no over-holding",
  holdDecision({ enabled: true, cls: "followUp", alreadyHeld: 0, busy: false }),
  "queue",
);
check(
  "NEGATIVE half: not busy, lines already waiting -> still queue, a held backlog is not a reason to stall",
  holdDecision({ enabled: true, cls: "followUp", alreadyHeld: 5, busy: false }),
  "queue",
);
check(
  "a steered mention is never held even when the lane is busy and the list is one below the cap",
  holdDecision({ enabled: true, cls: "steer", alreadyHeld: HOLD_MAX - 1, busy: true }),
  "steer",
);
check(
  "ON, busy, one held already: the later mention is held instead of stacking",
  holdDecision({ enabled: true, cls: "followUp", alreadyHeld: 1, busy: true }),
  "hold",
);
check(
  "a full hold list hands through rather than discarding (no lost instruction, ever)",
  holdDecision({ enabled: true, cls: "followUp", alreadyHeld: HOLD_MAX, busy: true }),
  "queue",
);
// the negative half of that last one, so HOLD_MAX cannot be widened into a silent drop
check(
  "one below the cap still holds",
  holdDecision({ enabled: true, cls: "followUp", alreadyHeld: HOLD_MAX - 1, busy: true }),
  "hold",
);
check(
  "at the cap with the lane idle: queue, same as everything else at the cap",
  holdDecision({ enabled: true, cls: "followUp", alreadyHeld: HOLD_MAX, busy: false }),
  "queue",
);
check("cap is generous but finite", HOLD_MAX, 20);

// --- a full hold sequence: N arrivals on a busy lane, then one settle ----------
// The gate is only half of it; the shape of a real round is what the owner saw. Simulated here
// without pi: 6 mentions arrive while the lane runs, every one must be held (0 pi blocks), then
// the settle drains them oldest-first, one message each, with the count and the badge unwinding.
{
  let seq: HeldMention[] = [];
  let busy = true;
  let piBlocks = 0;
  for (let i = 1; i <= 6; i++) {
    const d = holdDecision({
      enabled: true,
      cls: "followUp",
      alreadyHeld: seq.length,
      busy,
    });
    if (d === "hold") {
      seq = noteHeld(seq, line(`s-${i}`)).held;
    } else {
      piBlocks++; // what would have rendered as its own visible block
    }
  }
  check("six mentions on a busy lane: none of them reached pi as a queue block", piBlocks, 0);
  check("six mentions on a busy lane: all six are held", seq.length, 6);
  check("badge counts the whole held list, not one line each", holdBadge(seq.length), "6 mention(s) held");

  // the run settles
  busy = false;
  const { deliver, held: after } = takeHeld(seq);
  check("drain delivers all six", deliver.length, 6);
  check("drain order is the order the room said them", deliver.map((h) => h.id), [
    "s-1",
    "s-2",
    "s-3",
    "s-4",
    "s-5",
    "s-6",
  ]);
  check("count decrements to zero", after.length, 0);
  check("badge clears at zero", holdBadge(after.length), "");
  check("header names the batch the lane is about to read", heldHeader(deliver.length), "[tabichat][held] 6 mention(s) arrived while this lane was working; they wait here instead of stacking in the queue");

  // and with the lane now idle, the next mention must NOT be held
  check(
    "after the settle the next mention is a turn, not a hold",
    holdDecision({ enabled: true, cls: "turn", alreadyHeld: after.length, busy: false }),
    "deliver",
  );
}

// --- the hold list itself ---------------------------------------------------
{
  const a = noteHeld([], line("m-1"));
  check("first hold is not full", a.full, false);
  check("first hold stored", a.held.map((h) => h.id), ["m-1"]);

  const b = noteHeld(a.held, line("m-2"));
  check("second hold stored in order", b.held.map((h) => h.id), ["m-1", "m-2"]);
  check("second hold not full", b.full, false);

  const original = [...b.held];
  const at = noteHeld(original, line("x"), 2);
  check("at cap: refuses", at.full, true);
  check("at cap: the list is UNTOUCHED (a refusal cannot lose a line)", at.held.map((h) => h.id), original.map((h) => h.id));
  check("at cap: no mutation of the caller's list", at.held === original, false);
  // the refusal is a SECOND lock; the first is `holdDecision` answering `queue` at the cap, so a
  // refused line is on its way to pi rather than dropped. Pin the pairing at the REAL cap: a list
  // of HOLD_MAX lines refuses the store AND the decision hands the next one to pi.
  const full = { held: Array.from({ length: HOLD_MAX }, (_, i) => line(`f-${i}`)) };
  const atCap = noteHeld(full.held, line("overflow"));
  check("at the real cap: refuses", atCap.full, true);
  check("at the real cap: nothing is added", atCap.held.length, HOLD_MAX);
  check(
    "and the cap-reached decision hands the same line to pi (refusal never means discard)",
    holdDecision({ enabled: true, cls: "followUp", alreadyHeld: atCap.held.length, busy: true }),
    "queue",
  );

  const drained = takeHeld(b.held);
  check("drain is oldest first", drained.deliver.map((h) => h.id), ["m-1", "m-2"]);
  check("drain empties", drained.held, []);
  check("drain leaves the source list intact for the caller to clear", b.held.length, 2);
  const empty = takeHeld([]);
  check("draining an empty list delivers nothing", empty.deliver, []);
}

// --- what the lane and the sender are told ----------------------------------
check("badge: zero held clears the footer line", holdBadge(0), "");
says("badge: one held names the count", holdBadge(1), "1 mention(s) held");
says("badge: the footer is the count and nothing else (owner order 2026-10-24)", holdBadge(2), "2 mention(s) held");
check("badge: the pointer text is GONE from the footer", holdBadge(2).includes("chat_read"), false);
check("badge: the subsystem tag is GONE from the footer", holdBadge(2).startsWith("[tabichat]"), false);
check("badge key is the declared slot (renamed to sit behind the mushroom)", HOLD_BADGE_KEY, "queue");
says("held header says why the line is late", heldHeader(3), "arrived while this lane was working");
says("held header says where the rest are", heldHeader(3), "instead of stacking in the queue");
never("held header never claims the lane already saw it", heldHeader(3), "you already read");

// --- THE COALESCED FLUSH ----------------------------------------------------
// The defect this treats: the settle drain used to call pi.sendUserMessage ONCE PER held line, and
// pi 1.1.0 replays every prompt made while it emits `agent_settled` back-to-back with no delay — N
// full-context requests at a ~0 s gap, the measured 6/11 = 54.5% cell at >=500k prompt tokens
// (handoff-400-lane-deaths-20261005.md §2.17). One message per settle deletes N-1 of those launches.
// Budget: HELD_FLUSH_MAX_LINES / HELD_FLUSH_MAX_CHARS_DEFAULT, whichever fills first, minimum one
// line, NEVER truncate; the tail stays held and drains at the NEXT settle (a whole lane turn apart).

// cell 1 — a batch of N>1 renders as ONE message, oldest first, with one header naming N
{
  const all = [line("m-1"), line("m-2"), line("m-3")];
  const { send, rehold } = planHeldFlush(all);
  check("three held lines ship as one batch", send.map((h) => h.id), ["m-1", "m-2", "m-3"]);
  check("nothing is re-held when all three fit", rehold, []);
  const text = flushText(send);
  check(
    "the batch is the header plus every body, oldest first",
    text,
    `${heldHeader(3)}\n\n@worker m-1\n\n@worker m-2\n\n@worker m-3`,
  );
  check("one batch means one header line", text.split("[tabichat][held]").length - 1, 1);
  check("every line keeps its own provenance body", text.split("@worker").length - 1, 3);
}

// cell 7 — the header counts the lines IN THE MESSAGE, not the size of the drained group (negative
// half: the shipped bug stamped the GROUP count on every turn)
{
  const many = Array.from({ length: 7 }, (_, i) => line(`m-${i + 1}`));
  const { send, rehold } = planHeldFlush(many);
  const text = flushText(send);
  says("the header counts what this message carries (5)", text, "5 mention(s) arrived");
  never("the header does not report the drained group (7)", text, "7 mention(s) arrived");
  check("the rest is re-held, not dropped", rehold.map((h) => h.id), ["m-6", "m-7"]);
}

// cell 3 — the LINE budget binds before the char budget (both halves)
check("line budget constant is the ruled 5", HELD_FLUSH_MAX_LINES, 5);
{
  const seven = Array.from({ length: 7 }, (_, i) => line(`m-${i + 1}`));
  const { send, rehold } = planHeldFlush(seven);
  check("7 short lines: 5 ship", send.length, 5);
  check("7 short lines: 2 stay held", rehold.map((h) => h.id), ["m-6", "m-7"]);
  // rejecting half: five lines fit exactly, so a budget that bound at 4 would show up here
  const five = seven.slice(0, 5);
  const exact = planHeldFlush(five);
  check("exactly 5 short lines: all ship, nothing re-held", exact.rehold, []);
  check("exactly 5 short lines: send is 5", exact.send.length, 5);
}

// cell 4 — the CHAR budget binds before the line budget (both halves)
{
  const two = [fat("a", 60), fat("b", 60)];
  check("one of them is under a 100-char budget", heldBatchChars([two[0]]) < 100, true);
  check("both of them are over a 100-char budget", heldBatchChars(two) > 100, true);
  const plan = planHeldFlush(two, HELD_FLUSH_MAX_LINES, 100);
  check("char budget binds first: 1 ships", plan.send.map((h) => h.id), ["a"]);
  check("char budget binds first: 1 is re-held", plan.rehold.map((h) => h.id), ["b"]);
  // rejecting half: two lines that fit under the same budget both ship
  const fits = planHeldFlush(two, HELD_FLUSH_MAX_LINES, 1_000);
  check("under budget: both ship", fits.send.length, 2);
  check("under budget: nothing re-held", fits.rehold, []);
}

// cell 5 — a single over-cap line ships ALONE and WHOLE, never truncated (negative half)
{
  const huge = fat("z", 40_000);
  const plan = planHeldFlush([huge], HELD_FLUSH_MAX_LINES, 24_000);
  check("an over-cap lone line still ships", plan.send.map((h) => h.id), ["z"]);
  check("and nothing is re-held behind it", plan.rehold, []);
  const text = flushText(plan.send);
  check("the body ships whole — no truncation", text.length > 40_000, true);
  check("the body is byte-for-byte the held line", text.endsWith(huge.body), true);
  never("no ellipsis is invented to shorten it", text, "…");
  never("no truncation marker is invented", text.toLowerCase(), "[truncated]");
}

// cell 6 — the re-held tail stays VISIBLE and drains later; it is never lost
{
  const many = Array.from({ length: 12 }, (_, i) => line(`m-${i + 1}`));
  const first = planHeldFlush(many);
  check("first settle ships 5", first.send.length, HELD_FLUSH_MAX_LINES);
  check("first settle re-holds 7", first.rehold.length, 7);
  // the caller writes the tail back into `held`, so badge + holdsId still see it
  const heldAfter = [...first.rehold];
  says("the badge still reports the tail", holdBadge(heldAfter.length), "7 mention(s) held");
  check("holdsId still finds a tail line", holdsId(heldAfter, "m-9"), true);
  check("holdsId no longer finds a shipped line", holdsId(heldAfter, "m-1"), false);
  const second = planHeldFlush(takeHeld(heldAfter).deliver);
  check("next settle ships 5 more", second.send.map((h) => h.id), ["m-6", "m-7", "m-8", "m-9", "m-10"]);
  const third = planHeldFlush(takeHeld(second.rehold).deliver);
  check("the settle after that ships the last 2", third.send.map((h) => h.id), ["m-11", "m-12"]);
  check("and the list is finally empty", third.rehold, []);
  // THE NEVER-SETTLES-AGAIN CASE (ultra left it open): if the lane dies before the next settle, the
  // tail is still in `held` and the session-end valve takes the WHOLE list, so nothing is stranded.
  const rescued = takeHeld(heldAfter);
  check("the shutdown valve would hand over every tail line", rescued.deliver.length, 7);
  check("and it empties the list on the way out", rescued.held, []);
}

// cell 8 — MQTT_HELD_FLUSH_MAX_CHARS: the override works, a malformed value falls back
check("the char budget env name is the documented one", HELD_FLUSH_MAX_CHARS_ENV, "MQTT_HELD_FLUSH_MAX_CHARS");
check("default char budget is the ruled 24,000", HELD_FLUSH_MAX_CHARS_DEFAULT, 24_000);
check("env: unset is the default", heldFlushCharBudget(undefined), HELD_FLUSH_MAX_CHARS_DEFAULT);
check("env: empty is the default", heldFlushCharBudget(""), HELD_FLUSH_MAX_CHARS_DEFAULT);
check("env: a real override is honoured", heldFlushCharBudget(" 8000 "), 8_000);
for (const bad of ["0", "-1", "abc", "12.5x", "1e999", "99999999999999999999999"]) {
  check(`env: ${JSON.stringify(bad)} falls back to the default (no crash, no zero)`, heldFlushCharBudget(bad), HELD_FLUSH_MAX_CHARS_DEFAULT);
}
// the rejecting half: the override actually changes where the chunk boundary lands
{
  const seven = Array.from({ length: 7 }, (_, i) => fat(`m-${i + 1}`, 3_000));
  const budget = heldFlushCharBudget("7000");
  const overridden = planHeldFlush(seven, HELD_FLUSH_MAX_LINES, budget);
  const shipped = planHeldFlush(seven, HELD_FLUSH_MAX_LINES, heldFlushCharBudget(undefined));
  check("with the override, 2 ship", overridden.send.length, 2);
  check("without it, 5 ship (lines bind first)", shipped.send.length, 5);
  check("the override moved the boundary, it did not drop anything", overridden.send.length + overridden.rehold.length, 7);
}

// cell 9 — ordering is preserved and the render is byte-stable for the same input
{
  const many = Array.from({ length: 6 }, (_, i) => line(`m-${i + 1}`));
  const a = flushText(planHeldFlush(many).send);
  const b = flushText(planHeldFlush([...many]).send);
  check("the same input list renders identically", a === b, true);
  const c = flushText(planHeldFlush([...many].reverse()).send);
  check("a reversed input list renders differently (order is not incidental)", a === c, false);
}

// --- holdsId: chat_read's "is this line still waiting?" probe ----------------
{
  const list = [line("m-1"), line("m-2")];
  check("holdsId finds a held line", holdsId(list, "m-1"), true);
  check("holdsId rejects an unread id (negative half)", holdsId(list, "m-9"), false);
  check("holdsId on an empty list says no", holdsId([], "m-1"), false);
  const idless = noteHeld([], { id: "", nick: "old", ts: 0, body: "legacy client" });
  check(
    "an id-less line (older client) is never matched, so nothing is mislabelled as waiting",
    holdsId(idless.held, ""),
    false,
  );
}

// --- the wiring in index.ts (static, greppable facts, same style as test_steer.ts) ---------
// The pure module is only half of it: a held mention that nothing ever drains is a message
// landfill. These checks pin the HAND-OFF, so a later edit cannot quietly break the loop.
{
  const index = readFileSync(join(import.meta.dir, "..", "extensions", "tabichat", "index.ts"), "utf8");
  says("index imports the module", index, 'from "./mentionq.ts"');
  says("the switch is read from the environment", index, "mergeEnabled(process.env[MENTION_MERGE_ENV])");
  says("the decision is asked before anything is handed to pi", index, "holdDecision({");
  // THE GATE, pinned as a wiring fact. The defect was `piHasPending: ctx.hasPendingMessages()` —
  // pi queue depth, which is EMPTY exactly when a lane is busy. The gate is the lane's run state,
  // armed by `agent_start` and discharged by `agent_settled`, cross-checked with the live
  // context's `isIdle()`.
  // RE-PAIRED 2026-10-13 (#585): the socket's callbacks no longer hold a session ctx, so the
  // cross-check reads `liveCtx().isIdle()` through the handle instead of the captured `ctx`.
  // Same gate, same meaning, honest literal. Re-paired, not deleted.
  says("the hold gates on run state, armed and discharged by pi's own events", index, "busy: runActive && !liveCtx().isIdle()");
  says("`agent_start` arms the run state", index, 'pi.on("agent_start"');
  says("`agent_start` sets runActive true", index, "runActive = true;");
  says("`agent_settled` discharges it", index, "runActive = false;");
  says("`session_start` resets it too, so a restart is never mid-run", index, "runActive = false;\n    // flag values are only readable");
  never(
    "the queue-depth gate that caused the 28-line stack is gone",
    index,
    "piHasPending: ctx.hasPendingMessages()",
  );
  // ORDER MATTERS: the inbox push is what makes "held" mean deferred-and-readable. If a future
  // edit moved the hold above it, a held line would NOT be in the inbox and the whole honesty
  // argument would be false.
  const pushAt = index.indexOf("inbox.push(inboundLine)");
  const holdAt = index.indexOf('if (decision === "hold")');
  check("a held line is already in the inbox when it is held (deferred, not lost)", pushAt > -1 && holdAt > pushAt, true);
  says("the drain is wired to the settle event", index, 'pi.on("agent_settled"');
  says("the drain takes from the hold list", index, "takeHeld(held)");
  // RE-PAIRED 2026-10-09 (held-flush coalescing). The old pin read `heldHeader(deliver.length)`,
  // which stamped the size of the DRAINED GROUP on the message; the drain now ships a bounded chunk,
  // so the honest literal is `heldHeader(send.length)`. Re-paired, not deleted.
  says("the drained batch carries the held header, counting what it ships", index, "heldHeader(send.length)");
  never(
    "the header no longer counts the drained group",
    index,
    "heldHeader(deliver.length)",
  );
  says("the drain is COALESCED: one message from the whole send list", index, "heldBatchBody(send)");
  says("the drain asks the budget before it sends", index, "planHeldFlush(deliver");
  says("the char budget is read from the environment", index, "heldFlushCharBudget(process.env[HELD_FLUSH_MAX_CHARS_ENV])");
  says("the tail is re-held, never dropped", index, "held.splice(0, held.length, ...rehold)");
  says("and the badge is restated from what remains", index, "ctx.ui.setStatus(HOLD_BADGE_KEY, holdBadge(held.length))");
  says("the batch is not re-expanded as prompt templates", index, "expandPromptTemplates: false");
  // CELL 2 — the per-line fan-out must not come back. The shipped drain had a `for (const h of
  // deliver)` loop calling pi.sendUserMessage once per line, which is what launched N back-to-back
  // full-context requests at a ~0 s gap. Pinned as a rejection: exactly ONE sendUserMessage in the
  // settle handler, and no loop over the drained list there. (The session-end valve keeps its own
  // loop and is a different handler, hence the slice.)
  const drainStart = index.indexOf('pi.on("agent_settled"');
  const drainSrc = index.slice(drainStart, index.indexOf('pi.on("', drainStart + 10));
  check("the drain handler was found for the fan-out check", drainStart > -1, true);
  check(
    "the settle drain has exactly ONE sendUserMessage call SITE",
    (drainSrc.match(/pi\.sendUserMessage/g) ?? []).length,
    1,
  );
  check(
    "the settle drain has NO iteration at all (nothing per-line to fan out)",
    /\bfor\s*\(|\.forEach\(/.test(drainSrc),
    false,
  );
  check(
    "the settle drain has NO loop over the drained lines",
    /for \(const h of (deliver|send)\)/.test(drainSrc),
    false,
  );
  check(
    "the drain is not a per-line fan-out any more",
    index.includes("for (const h of deliver) {"),
    false,
  );
  // "Set on hold" is the MESSAGE-CALLBACK site (the hold arm inside client.on("message")),
  // not the drain's restatement above. RE-PAIRED 2026-10-13 (#585): that callback now reads the
  // handle, so the honest literal is `liveCtx().ui.setStatus(...)`; the plain-`ctx` form still
  // exists in `agent_settled`, which is a per-event context and stays as it is. Pinning the old
  // literal here would have passed for the wrong reason — the wrong-reason class, not a weakened check.
  says("the footer badge is set on hold", index, "liveCtx().ui.setStatus(HOLD_BADGE_KEY, holdBadge(held.length))");
  says("the badge clears when the list empties", index, 'ctx.ui.setStatus(HOLD_BADGE_KEY, "")');
  says("chat_read inbox can mark a line as held", index, "holdsId(held");
  says(
    "the one-turn-suppression flag exists so a flush is not reported as silence",
    index,
    "if (flushedThisRun)",
  );
  says("the shutdown valve exists", index, "session ending with");
  says("the cap is enforced in the decision, not in a discard branch", index, "alreadyHeld: heldCount()");
  says(
    "the pre-cap arm is still the class-decided path",
    index,
    "pi.sendUserMessage(plan.body, { deliverAs: cls })",
  );
  // SAFETY OF THE SAFETY NET: mentionq.noteHeld also refuses at the cap and reports `full`. The
  // wiring above does NOT consume it (the decision gate is the primary), which is only safe as long
  // as no line is ever dropped on that path. Pinned, so a future edit cannot make the unused field
  // become a silent discard.
  const callLine = index.split("\n").find((l) => l.includes("= noteHeld(held,")) ?? "";
  check(
    "the hold call destructures `held: grown` (never `full`, so nothing can be discarded there)",
    callLine.trim(),
    "const { held: grown } = noteHeld(held, {",
  );
  check(
    "and the grown list is always written back before returning",
    index.includes("held.splice(0, held.length, ...grown);"),
    true,
  );

  // negative half: the drain must not be wired to an event that fires DURING a run, or held lines
  // would re-enter the very queue this replaces
  check("the drain is not wired to turn_end", /pi\.on\("turn_end"[^)]*takeHeld/s.test(index), false);
  // and the safety valve must still be the per-line followUp path it has always been — it is
  // explicitly out of scope for the coalescing change (§3.7), so pin that it did not silently change
  says("the shutdown valve still hands each line back as a followUp", index, 'pi.sendUserMessage(h.body, { deliverAs: "followUp" })');
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nall mention-queue collapse checks green");
}
