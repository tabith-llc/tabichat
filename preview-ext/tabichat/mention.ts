// Whole-token @mention matcher for the tabichat room extension.
//
// Why this file exists: the first implementation tested mentions with a plain
// substring check (text.includes("@all")), so "@allen" and "@allow" woke every
// session in the room, and "@flash10" woke "@worker1". A mention must be a
// whole token to count.
//
// Rule: a mention is "@<name>" where neither neighbour character is a NAME
// character. NAME characters are the ones a room nick can hold — letters,
// digits, "_" and "-" — so "@lead-agent" is one token and "@lead" does not
// match inside it. "." is deliberately NOT a name character: src/tabichat_cli.py
// strips "." from nicks, and leaving it out keeps a sentence-final "@all." a
// valid mention.

const NAME_CHARS = "a-z0-9_-";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex that matches "@<name>" as a whole token in lower-case text. */
export const mentionMatcher = (name: string): RegExp =>
  new RegExp(`(?<![${NAME_CHARS}])@${escapeRe(name.toLowerCase())}(?![${NAME_CHARS}])`);

/** True when `text` addresses this `nick` directly, or the room via "@all". */
export const mentions = (text: string, nick: string): boolean => {
  const lower = text.toLowerCase();
  return mentionMatcher(nick).test(lower) || mentionMatcher("all").test(lower);
};
