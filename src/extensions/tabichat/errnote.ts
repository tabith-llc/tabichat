// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Upstream-error notice.
 *
 * The failure this addresses: a provider returns an error mid-turn, pi reports it
 * and ends the turn, that class of error is not auto-retried, and the process
 * stays alive and silent. From the terminal a stalled lane and a stopped lane look
 * identical, so the human has no way to know the machine is simply waiting.
 *
 * This module decides, from the messages an `agent_end` carried, whether the turn
 * finished on an upstream error, and what one short footer line to show. Pure:
 * no pi, no MQTT, no clock, no I/O.
 *
 * Owner ruling 2026-10-25 (release-gating for 0.1.0): pi already prints the provider's own
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
 * Footer text for an upstream-error ending, or null when the turn ended normally.
 *
 * The LAST assistant message is the decision point: whatever came before it
 * succeeded. An `aborted` ending is a human interrupt, not an upstream fault, so it
 * returns null as well.
 *
 * `errorMessage` is scanned for a leading status code and nothing else: the provider's text
 * is pi's to show, not ours to repeat.
 *
 * The tag lives HERE, not at the call site, on purpose: the footer and the toast both read
 * this string, so they cannot drift apart into two different shapes. Owner ruling of
 * 2026-10-25 (Q8): a tabichat-originated system message carries `[tabichat]` AT THE FRONT,
 * names UPSTREAM as the cause, and states the effect on tabichat.
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

/** Status text for the notice. Deliberately one line: the footer is one line. */
export const buildNote = (errorMessage?: string): string => {
  const code = /^\D*(\d{3})\b/.exec(String(errorMessage ?? "").replace(/\s+/g, " ").trim())?.[1];
  const cause = code ? `UPSTREAM ${code} provider error` : "UPSTREAM provider error";
  return `[tabichat] ${cause} \u2014 turn ended, not retried; pi shows the provider's message.`;
};
