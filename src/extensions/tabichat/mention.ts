// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Addressing rules for the tabichat room: what makes a line land in a lane's context.
//
// TWO RULES, ONE PREDICATE (broadcasting is a
// property of the RECIPIENT FIELD, and body text is inert):
//
//   1. FIELD-FIRST. A room payload that carries a `to` field is delivered by that field alone.
//      A token in the prose — even the all-lanes token — decides NOTHING while a field is set.
//      This is the fix for the reported defect: a lane's verdict that QUOTED an address used to
//      re-broadcast to every seat in the room, because the only addressing signal was the text.
//   2. TEXT-FALLBACK. A payload with no field (a human `tabichat_cli.py` line, `/say`, the ctx
//      advisories, anything published before this change) is still decided by scanning the whole
//      body. That is the documented residue, not an oversight: the fieldless sender has no way to
//      say who it meant, and suppressing the scan would silently stop delivery to the human path.
//
// Why the body scan is whole-token and not a substring: the first implementation tested
// `text.includes("@all")`, so "@allen" and "@allow" woke every session in the room, and
// "@worker10" woke "@worker1". NAME characters are the ones a room nick can hold — letters,
// digits, "_" and "-" — so "@lead-agent" is one token and "@lead" does not match inside it.
// "." is deliberately NOT a name character: src/tabichat_cli.py strips "." from nicks, and leaving it
// out keeps a sentence-final "@all." a valid mention. The FIELD carries the same discipline: it
// is read as whole tokens, so a field of "allen" never matches the all-lanes value.

const NAME_CHARS = "a-z0-9_-";

/** The recipient-field value that means "every lane in the room". */
export const ALL_LANES = "all";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex that matches "@<name>" as a whole token in lower-case text. */
export const mentionMatcher = (name: string): RegExp =>
  new RegExp(`(?<![${NAME_CHARS}])@${escapeRe(name.toLowerCase())}(?![${NAME_CHARS}])`);

/**
 * A recipient field split into whole name tokens, lower-cased.
 *
 * A field is a short list of nicks, not prose, so splitting on anything that is not a NAME
 * character is the whole-token rule: "lead-agent" -> ["lead-agent"], "@all" -> ["all"],
 * "worker1, worker2" -> ["worker1", "worker2"], and "worker10" is ONE token that is not "worker1".
 * A field of "  " or "!!!" yields no tokens, i.e. it names nobody (see `hasAddress`).
 */
export const addressTokens = (to: string): string[] =>
  to
    .toLowerCase()
    .split(new RegExp(`[^${NAME_CHARS}]+`))
    .filter((t) => t !== "");

/** Does this recipient field name anyone at all? An empty or punctuation-only field names nobody. */
export const hasAddress = (to: string | undefined): boolean =>
  typeof to === "string" && addressTokens(to).length > 0;

/**
 * Normalize what the caller passed as `to:` into the value that goes on the wire as the recipient
 * FIELD, or "" when nobody was named (so the publisher omits the field and the legacy scan runs).
 *
 * A leading "@" is dropped — `to: "@all"` and `to: "all"` are the same address — and the result is
 * trimmed. A field that holds no name token at all ("", "  ", "@", "!!!") is treated as NO field:
 * an address that names nobody must not silence the line by deciding alone, because that is how a
 * dispatch is lost with no trace. It falls back to the body scan instead.
 */
export const recipientField = (to: string | undefined): string => {
  if (typeof to !== "string") return "";
  const cleaned = to.trim().replace(/^@+/, "").trim();
  return addressTokens(cleaned).length ? cleaned : "";
};

/**
 * True when the recipient FIELD addresses this `nick` — or names the whole room.
 * Case-folded, whole-token. The body text is never consulted here, and that is the point.
 */
export const addressedTo = (to: string, nick: string): boolean => {
  const tokens = addressTokens(to);
  const want = nick.toLowerCase();
  return tokens.includes(want) || tokens.includes(ALL_LANES);
};

/**
 * LEGACY PATH — the whole-body scan. Kept for fieldless senders only (see rule 2 above);
 * `receives()` falls back here when the payload carries no recipient field. Prefer `addressedTo`.
 */
export const mentions = (text: string, nick: string): boolean => {
  const lower = text.toLowerCase();
  return (
    mentionMatcher(nick).test(lower) || mentionMatcher(ALL_LANES).test(lower)
  );
};

/**
 * THE ONE DELIVERY DECISION. A lane receives a room line when the recipient field names it (or
 * names the room), or — only when there is no field to read — when the body text mentions it.
 *
 * Both the inject gate and the receipt gate in index.ts call THIS function, so a dispatch
 * produces receipts from its true addressee(s) and nothing else: today a token quoted in prose
 * makes every seat publish a receipt for one send, and that is the fan-out this replaces.
 */
export const receives = (
  to: string | undefined,
  text: string,
  nick: string,
): boolean => (hasAddress(to) ? addressedTo(to as string, nick) : mentions(text, nick));
