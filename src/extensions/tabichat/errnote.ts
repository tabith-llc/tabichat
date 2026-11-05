// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Upstream-error notice.
 *
 * The failure this addresses: a provider returns an error mid-turn, pi reports it
 * and the process stays alive and quiet. From the terminal a stalled lane and a
 * stopped lane look identical, so the human has no way to know the machine is
 * simply waiting.
 *
 * What this module decides is a PER-RUN fact: from the messages an `agent_end`
 * carried, whether THAT run ended on an upstream error, and what one short footer
 * line describes it. Pure: no pi, no MQTT, no clock, no I/O. It does not decide
 * when the line is shown — that is the caller's job, and the boundary matters.
 * `agent_end` fires when a run ends while pi may still auto-retry, auto-compact and
 * retry, or continue with queued messages (`docs/extensions.md`), and `AgentEndEvent`
 * carries no `willRetry` field: pi annotates only its own session-listener copy. So a
 * retry outcome is not observable at `agent_end` from an extension at all, and
 * `agent_settled` is the boundary that promises no automatic work is left. `index.ts`
 * observes here and reports there.
 *
 * The retired assertion, and why the wording is what it is now: this file used to say "turn ended,
 * not retried". No extension can observe that at any boundary pi hands it — pi-ai retries a
 * transient 429 (`RETRYABLE_PROVIDER_ERROR_PATTERN`) and refuses a quota 429
 * (`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`, checked first), and the old line could not tell the
 * two apart because it never asked. So the notice states only what the settle boundary guarantees.
 *
 * For 0.1.0: pi already prints the provider's own
 * words and ends the turn on them, so repeating them here only makes the product look like
 * the thing that broke. The notice names UPSTREAM as the cause and carries the status code
 * plus what to do; it carries no provider prose.
 */

/** The two fields this decision needs from an assistant message. */
export type EndMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
};

/**
 * Footer text for a run that ended on an upstream error, or null when it did not.
 *
 * The LAST assistant message is the decision point: whatever came before it
 * succeeded. An `aborted` ending is a human interrupt, not an upstream fault, so it
 * returns null as well — and that half has to survive the move to the settle
 * boundary, where `event.aborted` says the same thing from pi's side.
 *
 * `errorMessage` is scanned for a leading status code and nothing else: the provider's text
 * is pi's to show, not ours to repeat.
 *
 * The tag lives HERE, not at the call site, on purpose: the footer and the toast both read
 * this string, so they cannot drift apart into two different shapes. The shape is:
 * a tabichat-originated system message carries `[tabichat]` AT THE FRONT,
 * names UPSTREAM as the cause, and states the effect on tabichat. The effect is now
 * only what a settle is promised: that no automatic retry is coming.
 */
export const upstreamErrorNote = (messages: readonly EndMessage[]): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const reason = String(m.stopReason ?? "").trim().toLowerCase();
    if (reason !== "error") return null;
    return buildNote(m.errorMessage);
  }
  return null;
};

/** Status text for the notice. Deliberately one line: the footer is one line.
 *
 * It claims no retry outcome. Whether pi retried before settling is not handed to an
 * extension, so the line states the one thing the settle boundary guarantees. */
export const buildNote = (errorMessage?: string): string => {
  const code = /^\D*(\d{3})\b/.exec(String(errorMessage ?? "").replace(/\s+/g, " ").trim())?.[1];
  const cause = code ? `UPSTREAM ${code} provider error` : "UPSTREAM provider error";
  return `[tabichat] ${cause} \u2014 no automatic retry is coming; pi shows the provider's message.`;
};
