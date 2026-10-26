/**
 * Steered delivery of an @-mention.
 *
 * The problem this solves: a lead realizes something that changes what a running worker is
 * doing and posts an addendum. A mention that lands while the lane is mid-run is queued as a
 * FOLLOW-UP, and pi's own words say what that means — "A steering message enters after the
 * current assistant turn and its tool calls. A follow-up enters after the current run finishes
 * its pending work" (`docs/sdk.md:68`). Both queues are drained before `agent_end`, so the line
 * is never LOST; it simply arrives after the worker has done everything it planned, verdict post
 * included, and reads as news about finished work. That is the missed-addendum the owner
 * reported.
 *
 * The fix is a per-message choice pi already exposes: `sendUserMessage(content, { deliverAs })`
 * (`dist/core/extensions/types.d.ts:1233`). Regular delivery stays the DEFAULT; a sender who
 * needs to reach a lane that is already working sets `steer` on the post, and only a sender on
 * the allowlist is honoured (lead + owner, per the ruling).
 *
 * Kept out of index.ts so the class decision and the wording are testable without a broker
 * (tools/test_steer.ts).
 */

import { LEAD_NICK } from "./ctxwarn.ts";

/** The tag on the header line the receiving lane sees. Product tag first, per the notice law. */
export const STEER_TAG = "[tabichat][steer]";

/** Extra nicks to honour, on top of the floor. Additive — it can widen, never drop the floor. */
export const STEER_NICKS_ENV = "MQTT_STEER_NICKS";

/**
 * Which senders may interrupt. The floor is the lead and the owner (the pair named in
 * the rule: `lead-agent` + owner); `MQTT_STEER_NICKS` (comma or space separated) adds to it and never
 * subtracts, so a mis-set variable cannot silently disarm the lead's own ability to steer.
 * De-duplicated, blanks dropped, order stable.
 */
export function parseSteerNicks(raw: string | undefined | null, ownerNick: string): string[] {
  const out: string[] = [];
  for (const nick of [LEAD_NICK, ownerNick, ...(raw ?? "").split(/[,\s]+/)]) {
    const n = (nick ?? "").trim();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Does this payload ask to interrupt? Strictly `=== true`: a sender that sent `"true"`, `1` or
 * any other truthy junk did not set the flag, and a malformed field must never buy an interrupt.
 */
export function wantsSteer(msg: unknown): boolean {
  return (msg as { steer?: unknown } | null)?.steer === true;
}

/** How the receiving lane hands the line to pi. "turn" = nothing is running, so nothing to queue. */
export type DeliveryClass = "turn" | "steer" | "followUp";

/**
 * The one decision this module exists for. A busy lane gets a steer ONLY when the sender asked
 * and is on the allowlist; everything else keeps the behaviour that shipped before this file.
 */
export function deliveryClass(o: {
  idle: boolean;
  sender: string;
  flag: boolean;
  allow: readonly string[];
}): DeliveryClass {
  if (o.idle) return "turn";
  if (o.flag && o.allow.includes(o.sender)) return "steer";
  return "followUp";
}

/**
 * The header line a steered mention carries, so the lane is told what just landed between its
 * tool results instead of finding an unexplained user message there. Only ever added when the
 * class really is "steer" — a lane that was idle is not being interrupted.
 */
export function steerHeader(sender: string): string {
  return `${STEER_TAG} addendum from ${sender} — this arrived while you were working; re-plan before you finish`;
}

/**
 * What the SENDER is told about the steer it asked for. The receiving lane decides the final
 * class and the sender cannot see that far, so this states the request and whether THIS nick
 * could ever be honoured — it never claims the interrupt happened.
 */
export function steerNote(o: {
  requested: boolean;
  honoured: boolean;
  allow: readonly string[];
}): string {
  if (!o.requested) return "";
  if (o.honoured) {
    return "; steer requested — if the addressee is still working it enters at its next tool-result "
      + "boundary, otherwise it lands as a normal turn";
  }
  return `; steer NOT honoured from this nick (only ${o.allow.join(", ")}) — it queues behind `
    + "whatever the addressee is running";
}
