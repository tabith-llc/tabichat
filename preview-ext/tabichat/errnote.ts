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
 */

/** The two fields this decision needs from an assistant message. */
export type EndMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
};

/** How much of the provider's own words to keep in the notice. */
export const DETAIL_MAX = 60;

/**
 * Footer text for an upstream-error ending, or null when the turn ended normally.
 *
 * The LAST assistant message is the decision point: whatever came before it
 * succeeded. An `aborted` ending is a human interrupt, not an upstream fault, so it
 * returns null as well.
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
  const flat = String(errorMessage ?? "").replace(/\s+/g, " ").trim();
  const code = /^\D*(\d{3})\b/.exec(flat)?.[1];
  const detail =
    flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1).trimEnd()}\u2026` : flat;
  const what = code ? `upstream ${code}` : "upstream error";
  return detail ? `${what} \u2014 retry needed (${detail})` : `${what} \u2014 retry needed`;
};
