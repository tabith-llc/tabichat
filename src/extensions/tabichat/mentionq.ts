// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * MENTION QUEUE COLLAPSE (option B: build it on its own branch,
 * do not merge until the word, then deploy it and use it for a fleet
 * session to see how it goes).
 *
 * THE COMPLAINT, in the owner's own words: "when i send a chat to ultra, i see a comment queue
 * built up over where i type in the harness. more messages, more stacked levels of this visible
 * queue. if one get 200 messages queued, the entire section where the llm prints out their
 * thoughts and speech gets blocked by these stacked messages."
 *
 * WHAT PRODUCES THE STACK, measured at main `9a65226` (index.ts:560-581): a mention that arrives
 * while the lane is mid-run is handed to pi with `deliverAs: "followUp"`, and pi renders every
 * queued follow-up as its own block in the pending-input area above the editor. Nothing in
 * tabichat draws that area — it is pi (`modes/interactive/interactive-mode.d.ts:384-410`,
 * `handleDequeue` / `getAllQueuedMessages` / `clearAllQueues`, ALL PRIVATE). The only queue fact
 * an extension may call is `hasPendingMessages()` (`core/extensions/types.d.ts:243`). So tabichat
 * cannot drain the view; it can only stop OVER-FILLING it, which is exactly what this module does.
 *
 * THE MECHANISM: a busy lane no longer gets one pi turn per mention. Every non-steer mention that
 * arrives while the lane is running is HELD here — it stays in the lane's `inbox`, so `chat_read`
 * scope `inbox` still proves it arrived — and shows as a single footer line. Nothing is handed to
 * pi's queue at all during the run, so the pending-input area stays empty instead of growing one
 * block per mention. When the run fully settles (`agent_settled`, the event whose own doc comment
 * says "no automatic retry, compaction, or queued continuation will run"), the held mentions are
 * delivered in arrival order, oldest first, each with its normal provenance tag plus one line
 * saying it was held.
 *
 * WHAT "BUSY" MEANS HERE (the 2026-10-11 correction, and the reason option B did not hold at
 * first). The gate is the lane's RUN STATE, not pi's queue depth. The shipped gate asked
 * `ctx.hasPendingMessages()` — and a lane that is mid-run has an EMPTY queue, because it is
 * executing rather than waiting on input. So the predicate read false on essentially every
 * mid-run arrival, every mention took the ordinary `queue` arm, and each one rendered as its own
 * visible block: the 28-line stack the owner reported. `busy` is now derived from pi's own run
 * events (`agent_start` → `agent_settled`, paired by construction because the settle call sits in
 * the run's `finally`), cross-checked with `ctx.isIdle()` so the worst a missed event can do is
 * fall back to the pre-option-B behavior rather than stall a line.
 *
 * WHY THIS IS NOT LOSS BY ANOTHER NAME: delivery is DEFERRED, NEVER DROPPED. Three details make
 * that true rather than hopeful — (1) the ack to the sender fires BEFORE the hold decision, so a
 * sender is never told "delivered" about a line this module then loses; (2) a held line is already
 * in `inbox` and `buffer`, so it is readable and citable while it waits; (3) the overflow rule
 * refuses to hold past `HOLD_MAX` and, if that ever happens, delivers through to pi rather than
 * discarding — a deep queue is the disease, a lost instruction is the amputation.
 *
 * STEER IS EXEMPT. A steered mention is an intentional interrupt from the lead or the owner and
 * keeps pi's `deliverAs: "steer"` path untouched; holding one would defeat the whole point of it.
 *
 * THE DRAIN IS COALESCED (the ask, verbatim: "i want it fixed. build held-flush").
 * The settle drain used to call `pi.sendUserMessage` ONCE PER held line. That was worse than it
 * looks: pi 1.1.0 sets `_isEmittingAgentSettled` while it emits the event, and `prompt()` pushes any
 * call made inside that window into `_deferredSettledActions`; when the handlers return it splices
 * that list and `await`s it back-to-back with NO delay. So N held lines became N full-context
 * requests launched at a ~0 s gap — the exact cell measured at 6 errors / 11 turns (54.5%) at >=500k
 * prompt tokens with a gap <=8 s (`handoff-400-lane-deaths-20261005.md` §2.17). One message per
 * settle deletes N-1 launches out of that cell.
 *
 * THE BUDGET. A batch is bounded by LINES AND CHARACTERS, whichever fills first — 5 lines /
 * 24,000 chars, always at least one line, NEVER truncated. Whatever does not fit stays HELD and
 * drains at the NEXT `agent_settled`, which spaces chunk launches by a whole lane turn (the >=15 s
 * cell, 1/63 = 1.6%) instead of the ~0 s one. The character budget covers the joined line bodies
 * plus their separators; the header adds ~120 chars of overhead that is deliberately not counted.
 * `MQTT_HELD_FLUSH_MAX_CHARS` overrides it, in the `MQTT_MENTION_MERGE` posture: unset, empty, or
 * malformed keeps the default, and a value that would zero the budget is refused.
 *
 * THE ACCEPTED WORST CASE IS 2 TURNS, not N+1: the FIRST mid-run mention still goes to pi as a
 * `followUp` (that block is pi-owned and out of scope here), and everything after it arrives as one
 * coalesced batch. Say so before anyone is surprised by a two-block stack.
 *
 * Pure by design, like roommsg.ts: nothing here touches the broker or pi, so every rule is
 * checkable in tools/test_mentionq.ts without a network or a TUI.
 */

/** The kill switch's env name. Set it to 0/false/off/no to restore the shipped per-mention queue. */
export const MENTION_MERGE_ENV = "MQTT_MENTION_MERGE";

/** ON by default (the owner wants this behavior); a non-boolean value keeps the default. */
export const mergeEnabled = (raw: string | undefined | null): boolean => {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return true;
  return !(v === "0" || v === "false" || v === "off" || v === "no");
};

/**
 * Most mentions this module will hold between two settlements. The number is a STALL LIMIT, not a
 * display budget: a held line waits for a settle that may be a long way off, so past this point the
 * overflow goes straight to pi — the per-mention queue that shipped before option B, ugly but never
 * stuck. A deep queue is the disease, a stalled instruction is the amputation, and this cap is the
 * reason a stuck `busy` flag cannot hide more than this many lines. `index.ts` mirrors the number in
 * the footer text it prints.
 */
export const HOLD_MAX = 20;

/**
 * The footer badge key — the same `setStatus` slot semantics as the nick badges.
 *
 * THE KEY NAME IS A LAYOUT DECISION, not a label: status entries are ordered by key, so this string decides
 * where the lane reads the held count. It was `mentions`, which sorts BEFORE `nick`, so the badge led the line
 * ahead of the seat's own name. Owner order 2026-10-24, verbatim: "this section "[tabichat] 1 mention(s) held
 * — the lane is busy; chat_read scope=inbox" need to be shortened to just "1 mention(s) held", and it needs to
 * appear AFTER THE MUSHROOM". `queue` sits after `nick-tabichat` (the mushroom, worker1's O224 position) and after
 * the ponytail extension's key, and before `resume` — the only window that puts the badge behind the mushroom
 * WITHOUT moving the mushroom, which is what `test_laneadmin.ts` O224 guards. Evidence for the ordering model,
 * stated because I could not read pi's renderer itself in the installed dist: the repo comment at
 * `index.ts` "`nick-tabichat` sorts immediately AFTER `nick`", O224's own `localeCompare` sort of the keys read
 * out of source, and the owner's specimen line, whose segments appear in exactly that order.
 */
export const HOLD_BADGE_KEY = "queue";

/** What the lane sees in the footer while lines wait. Empty string means "clear the badge". */
export const holdBadge = (count: number): string => (count <= 0 ? "" : `${count} mention(s) held`);

/**
 * Header line prepended to a delivered mention when it waited here instead of queueing in pi.
 * A lane that sees this knows the line is not stale history: it is the mention, arriving late on
 * purpose, and the provenance tag below it is the id it can cite.
 */
export const heldHeader = (count: number): string =>
  `[tabichat][held] ${count} mention(s) arrived while this lane was working; ` +
  `they wait here instead of stacking in the queue`;

/** How one held mention is remembered. `body` is the exact text pi would have been handed. */
export interface HeldMention {
  id: string;
  nick: string;
  ts: number;
  body: string;
}

/**
 * The one decision this module exists for. `cls` comes from the existing machinery
 * (`ctx.isIdle()` + `steer.ts:deliveryClass`); `busy` is the lane's run state as measured from pi's
 * `agent_start`/`agent_settled` pair, cross-checked against `ctx.isIdle()` — see the header.
 * Neither input is new pi API, and nothing here reaches into pi internals.
 *
 *  - "deliver"  : nothing is running (class "turn") -> normal immediate turn.
 *  - "steer"    : an honoured interrupt -> straight to pi, exempt from holding.
 *  - "queue"    : merge is OFF, the lane is not running, or the hold list is full -> the shipped
 *                 `followUp` behaviour, one pi block per mention.
 *  - "hold"     : merge is ON and the lane is running -> keep it here until the run settles.
 */
export function holdDecision(o: {
  enabled: boolean;
  cls: "turn" | "steer" | "followUp";
  alreadyHeld: number;
  busy: boolean;
}): "deliver" | "steer" | "queue" | "hold" {
  if (o.cls === "turn") return "deliver";
  if (o.cls === "steer") return "steer";
  if (!o.enabled) return "queue";
  if (o.alreadyHeld >= HOLD_MAX) return "queue";
  if (o.busy) return "hold";
  return "queue";
}

/**
 * Add one mention to the hold list. Overflow never discards. The PRIMARY guard is upstream —
 * `holdDecision` answers "queue" (not "hold") once the list reaches `HOLD_MAX`, so an overflowing
 * line goes to pi exactly as it did before option B. This function refuses too, as the second lock
 * on the same door: `{ full: true }` means "I did not store it". The current wiring destructures
 * only `held: grown` and writes the result back unconditionally, so there is no path in which a
 * refusal turns into a drop — and tools/test_mentionq.ts pins that fact as a static check rather
 * than leaving it to a comment.
 */
export function noteHeld(
  held: readonly HeldMention[],
  line: HeldMention,
  cap = HOLD_MAX,
): { held: HeldMention[]; full: boolean } {
  if (held.length >= cap) return { held: [...held], full: true };
  return { held: [...held, line], full: false };
}

/**
 * Drain the hold list for delivery, oldest first, and report the empty list afterwards. The caller
 * owns the clearing so the same call can be re-tried if pi refuses to accept a turn.
 */
export function takeHeld(held: readonly HeldMention[]): {
  deliver: HeldMention[];
  held: HeldMention[];
} {
  return { deliver: [...held], held: [] };
}

// --- the coalesced flush ----------------------------------------------------

/** Most held lines one flush will carry. Beyond it the tail waits for the next settle. */
export const HELD_FLUSH_MAX_LINES = 5;

/** The char budget's env name. */
export const HELD_FLUSH_MAX_CHARS_ENV = "MQTT_HELD_FLUSH_MAX_CHARS";

/**
 * Default character budget for one coalesced flush, over the joined line bodies and their
 * separators. Derived from one round's mean (1,247 chars/line, s83): 5 lines is ~6.2 KB, a full
 * HOLD_MAX batch is ~25 KB. It is a starting budget, not a measurement of the fleet — hence the
 * env override, so tuning it does not cost a redeploy.
 */
export const HELD_FLUSH_MAX_CHARS_DEFAULT = 24_000;

/**
 * Parse the char budget. Same shape and same failure posture as `mergeEnabled`: unset/empty is the
 * default, and anything that is not a plain positive integer is the default too — a typo in the
 * environment must never leave a lane with a zero budget, which would mean "ship nothing".
 */
export const heldFlushCharBudget = (raw: string | undefined | null): number => {
  const v = (raw ?? "").trim();
  if (!/^[0-9]+$/.test(v)) return HELD_FLUSH_MAX_CHARS_DEFAULT;
  const n = Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return HELD_FLUSH_MAX_CHARS_DEFAULT;
  return n;
};

/** Bytes one batch costs on the wire: the line bodies plus the blank line between each pair. */
export const heldBatchChars = (lines: readonly HeldMention[]): number =>
  lines.reduce((n, h) => n + h.body.length, 0) + Math.max(0, lines.length - 1) * 2;

/** The joined bodies of a batch, oldest first, blank line between each. */
export const heldBatchBody = (lines: readonly HeldMention[]): string =>
  lines.map((h) => h.body).join("\n\n");

/** What one settle delivers, and what stays held for the next one. */
export interface HeldFlushPlan {
  send: HeldMention[];
  rehold: HeldMention[];
}

/**
 * Split a drained held list into the chunk that ships now and the tail that stays held. Both
 * budgets bind, whichever fills first; at least one line always ships, and no line is ever cut —
 * a single over-cap line ships alone and whole, which is exactly what the shipped per-line drain
 * did with it.
 */
export function planHeldFlush(
  deliver: readonly HeldMention[],
  maxLines = HELD_FLUSH_MAX_LINES,
  maxChars = HELD_FLUSH_MAX_CHARS_DEFAULT,
): HeldFlushPlan {
  if (deliver.length === 0) return { send: [], rehold: [] };
  const send: HeldMention[] = [];
  for (const h of deliver) {
    const next = [...send, h];
    if (send.length > 0 && (next.length > maxLines || heldBatchChars(next) > maxChars)) break;
    send.push(h);
  }
  return { send, rehold: deliver.slice(send.length) };
}

/** Does any held line carry this message id? `chat_read` uses it to mark held mentions as seen. */
export const holdsId = (held: readonly HeldMention[], id: string): boolean =>
  held.some((h) => h.id !== "" && h.id === id);
