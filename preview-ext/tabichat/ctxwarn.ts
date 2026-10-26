// Fresh-session advisory for the tabichat room extension.
//
// Why: a lane that runs out of context does not fail loudly — it answers badly
// or the endpoint refuses the request. The lane is also the only thing that can
// see its own context usage, so the extension reads pi's own estimate after each
// turn and says so, once, in the room (lead + owner) and in the lane's own
// footer.
//
// Nothing here computes tokens: the numbers come from pi's
// ctx.getContextUsage(), which is the same estimate the footer and compaction
// use. If the active model declares no contextWindow (see
// ~/.pi/agent/models.json), that call returns undefined and this module reports
// "unknown" — it never guesses.

/**
 * Advisory threshold, percent of the declared window. **60%** is the shipped default,
 * replacing the 77 of 2026-10-06. The higher number was chosen to stop early interruptions and it
 * backfired the next day: a lane at 78% kept working and produced the confusion the owner was chasing,
 * which is what an alarm at 77% looks like from the outside — it goes off when there is nothing left
 * to do about it. On a 262,144-token window, 60% is ~157,300 tokens, which leaves roughly 88,000
 * tokens of runway: enough to finish the item in hand AND write the handoff. The paired hard action
 * sits at 75% (~196,600 tokens, see MQTT_CTX_FORCE), and pi's own compaction remains the last-resort
 * net at roughly 245,700. `MQTT_CTX_WARN` overrides per lane.
 */
export const DEFAULT_CTX_WARN = 60;
/**
 * The HARD action, percent of the declared window. **75** is the shipped default (raised from the
 * 70 first discussed). At this point the advisory stops being advice:
 * the lane is required to write a RESUME file describing exactly what a fresh seat needs, and its tools
 * are blocked until that file exists on disk. Nothing is killed, no session is ended, no running command
 * is aborted, and nothing decides anything about the task — it makes the lane write its state down, then
 * it lets the lane carry on. `MQTT_CTX_FORCE` overrides per lane, and it is always at least as high as
 * the warn threshold (forcing before warning would block a lane with no prior notice).
 */
export const DEFAULT_CTX_FORCE = 75;

/** A RESUME file below this size has not told the next seat anything useful. */
export const RESUME_MIN_BYTES = 200;

/** Refusals tolerated before the gate gives up and says so, rather than hanging a lane forever. */
export const GIVE_UP_AFTER = 3;

/** Force threshold from MQTT_CTX_FORCE: default 75, clamped 0..99, and never BELOW the warn threshold. */
export const ctxForceThreshold = (raw: string | undefined, warnPct: number): number => {
  const n = Number.parseInt(raw ?? "", 10);
  const want = Number.isFinite(n) ? Math.min(Math.max(n, 0), 99) : DEFAULT_CTX_FORCE;
  return Math.max(want, warnPct);
};

/**
 * True when the lane should be forced: at or over the threshold, and not already in the forced state.
 * One firing per crossing — the anti-noise discipline from the advisory applies here too.
 */
export const forceDue = (s: CtxSample, forcePct: number, alreadyForced: boolean): boolean => {
  if (alreadyForced) return false;
  if (s.percent === null || s.tokens === null || s.contextWindow <= 0) return false;
  return s.percent >= forcePct;
};

/** Re-arm after pi compacts: the percent dropped well back under the threshold. */
export const rearmForce = (forced: boolean, percent: number | null, forcePct: number): boolean =>
  forced && percent !== null && percent < forcePct - REWARN_STEP_PCT ? false : forced;

/** The RESUME path for this lane: named by nick and boot tag, so two seats never share a file. */
export const resumePath = (dir: string, nick: string, boot: string): string =>
  `${dir.replace(/\/+$/, "")}/RESUME-${nick}-${boot}.md`;

/** The file counts as written when it exists and carries real content. */
export const resumeWritten = (exists: boolean, bytes: number): boolean => exists && bytes >= RESUME_MIN_BYTES;

/** Give up rather than hang a lane: N refusals and still no file. */
export const giveUpNow = (refusals: number, written: boolean): boolean =>
  !written && refusals >= GIVE_UP_AFTER;

/** The line the room gets at the trigger moment — the only one the force posts on its own. */
export const forceRoomLine = (
  nick: string,
  s: CtxSample,
  forcePct: number,
  path: string,
  targets: string[],
): string =>
  `@${targets.join(" @")} FORCED HANDOFF ${nick}: ${Math.floor(s.percent ?? 0)}% = ${k(s.tokens ?? 0)}/${k(
    s.contextWindow,
  )} (at or over ${forcePct}%) — tools stay blocked until it writes ${path}, then the lane carries on`;

/** The line the room gets when a lane will not cooperate. Loud, because a stalled lane is worse. */
export const giveUpLine = (nick: string, pct: number, path: string): string =>
  `@${LEAD_NICK} ${nick} hit ${pct}% context and did not write its RESUME file (${path}) — blocking dropped, this lane needs the owner`;

/** What the lane reads on every blocked call: the path, the shape, and how to get unblocked. */
export const forceBlockNote = (path: string): string =>
  `tabichat context force: this lane is over its handoff threshold, so this call is blocked. ` +
  `Nothing is lost and nothing was killed — finish writing the handoff and the block lifts by itself.\n` +
  `Write this file (reads, and writes to THIS path only, are allowed; read-only git is allowed):\n${path}\n` +
  `Fill in, briefly:\n${RESUME_TEMPLATE}`;

/** What a lane that did not cooperate leaves the room saying. */
export const RESUME_TEMPLATE = `  venue / working dir (which clone, which work<N>)
  task and the spec file path it came from
  branch, tip commit, and ANYTHING uncommitted or unpushed
  what is mid-flight right now (the exact next command you would have run)
  next steps, in order
  report path (where your output lives)
  HOLD flags — any "do not do X / do not tell Y" instruction still in force`;

/**
 * Read-only git stays available while a lane is blocked, so the handoff records the TRUE git
 * state instead of a guess. Anything that changes the repository, or writes a file, is not this.
 */
// A read-only git call: the verb is on the list, and the line carries no pipe, no redirect, and no
// second command hiding behind it — otherwise "git status && git push" would read as safe
const GIT_READONLY =
  /^(?:cd\s+\S+\s*&&\s*)?git (?:status|diff|log|rev-parse|show|ls-files|ls-remote|remote\s+-v|remote\s+show|branch\s+(?:-v|-a|--show-current))(?:\s+[^\s|>&;`]*)*$/;
/** A bare directory change carries no repository risk and shows up in front of most git calls. */
const CD_ONLY = /^cd\s+\S+$/;

export const bashAllowedWhileForced = (command: string): boolean => {
  const c = command.trim();
  if (!c) return false;
  if (GIT_READONLY.test(c)) return true;
  // chains are allowed only when EVERY segment is read-only in its own right
  return c.split(/&&|;/).every((seg) => {
    const t = seg.trim();
    return GIT_READONLY.test(t) || CD_ONLY.test(t);
  });
};

/** The two write tools whose target may be the RESUME path itself. */
export const WRITE_TOOLS_SELF = ["write", "edit", "Write", "Edit"];
/** Read-ish tools that stay available: the lane must be able to look around to describe its state. */
export const READ_TOOLS_SELF = ["read", "Read", "grep", "Grep", "glob", "Glob", "ls", "Ls", "view", "chat_read"];

/** Absolute token tripwire. 0 (the default) = off, so it can never nag a genuinely large window. */
export const DEFAULT_CTX_TOKENS = 0;
/** Re-warn only after this many further percentage points (anti-noise). */
export const REWARN_STEP_PCT = 10;
/** Re-warn the absolute rule only after this many further tokens (same anti-noise discipline). */
export const REWARN_STEP_TOKENS = 20_000;
/**
 * The lead lane's room nick. This constant decides TWO things at once: who receives a lane's context
 * alarm (`ctxWarnTargets`) and who is allowed to interrupt a busy lane (`steer.ts` builds the honoured
 * floor from it), so it must never be set to a name that no seat in the venue publishes. Read from the
 * environment with the documented default, so an operator can retarget it without editing this file —
 * the same idiom as `MQTT_NICK`/`MQTT_URL` above. A venue that renames its lead (this one renamed the
 * seat to `lead-agent`) sets `MQTT_LEAD_NICK` at each lane launch; the shipped
 * default stays `lead-agent` so no single venue's name becomes the released value, and the steer/ctx
 * suites that assert that default keep their meaning.
 *
 * A BLANK or whitespace-only value falls back to the default ON PURPOSE. `MQTT_LEAD_NICK=` inside a
 * launch line is a typo an operator can actually make, and measured against the raw `??` form it set
 * `LEAD_NICK` to the empty string, which `parseSteerNicks` then DROPPED — leaving the honoured floor as
 * `[owner]` alone: no lead, no alarm target, no steering, and no error printed anywhere. Falling back is
 * the fail-safe direction, and the empty case is pinned in `tools/test_steer.ts`.
 */
const leadNickRaw = process.env.MQTT_LEAD_NICK?.trim();
export const LEAD_NICK = leadNickRaw === "" || leadNickRaw === undefined ? "lead-agent" : leadNickRaw;
export const DEFAULT_OWNER_NICK = "owner";

export interface CtxSample {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Compact token/window label used in the footer, the room line and the notices. */
const k = (n: number): string => `${Math.round(n / 1024)}k`;

/** Warning threshold from MQTT_CTX_WARN, default 60, clamped to 0..99. */
export const ctxWarnThreshold = (raw: string | undefined): number => {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_CTX_WARN;
  return Math.min(Math.max(n, 0), 99);
};

/** Absolute tripwire from MQTT_CTX_TOKENS; unset, blank, junk or negative all mean off. */
export const ctxTokenThreshold = (raw: string | undefined): number => {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CTX_TOKENS;
  return n;
};

/** Which rule raised the advisory — the room line and the notice must not blur them. */
export type CtxTrigger = "percent" | "tokens";

/**
 * Absolute tripwire: fires on tokens alone, whatever the declared window says.
 *
 * Why this exists next to the percent rule: the percentage divides by a number somebody wrote
 * in a config file (`model.contextWindow`), and that same number is what pi's own compaction and
 * overflow recognition use. An over-declared window therefore silences the percentage AND pi's
 * self-heal at once — the incident this was built for was a 262,144-token model reading 22% until
 * a human did the arithmetic. Tokens come from the provider's own usage, so they cannot be lied
 * to about. Off unless MQTT_CTX_TOKENS is set.
 */
export const absoluteSessionDue = (
  s: CtxSample,
  thresholdTokens: number,
  lastWarnTokens: number,
): boolean => {
  if (thresholdTokens <= 0) return false;
  if (s.tokens === null) return false; // pi has not had a response yet: unknown is not "due"
  if (s.tokens < thresholdTokens) return false;
  return lastWarnTokens < 0 || s.tokens >= lastWarnTokens + REWARN_STEP_TOKENS;
};

/** `provider/id` for the model pi handed us, or an honest placeholder. */
export const ctxModelLabel = (m?: { provider?: string; id?: string } | null): string =>
  m?.id ? `${m.provider ?? "?"}/${m.id}` : "unknown model";

/**
 * The session-start line. It names the denominator BEFORE anyone needs it, and says plainly that
 * the window is a declaration pi was handed rather than something measured off the serving host.
 */
export const ctxDeclarationLine = (
  s: CtxSample | null,
  modelLabel: string,
  thresholdPct: number,
  thresholdTokens: number,
): string => {
  const rules =
    `advisory at ${thresholdPct}%` + (thresholdTokens > 0 ? ` or ${k(thresholdTokens)} tokens` : " (no absolute tripwire)");
  if (!s || s.contextWindow <= 0)
    return `context: no declared window for ${modelLabel} — percent-based advisory OFF; ${rules}`;
  if (s.percent === null || s.tokens === null)
    return `context: window ${s.contextWindow} declared for ${modelLabel} (a declaration, not a measurement — check \`pi --list-models\`); usage unknown until the first response; ${rules}`;
  return (
    `context: ${Math.floor(s.percent)}% = ${s.tokens}/${s.contextWindow} against ${modelLabel} — `
    + `that window is DECLARED in pi's model config, not measured off the server; ${rules}`
  );
};

/**
 * True when the lane should raise the advisory: at or over the threshold, and
 * either never warned or at least REWARN_STEP_PCT above the last warning.
 * A null percent (right after compaction) is never due.
 */
export const freshSessionDue = (
  s: CtxSample,
  thresholdPct: number,
  lastWarnPct: number,
): boolean => {
  if (s.percent === null || s.tokens === null || s.contextWindow <= 0) return false;
  if (s.percent < thresholdPct) return false;
  return lastWarnPct < 0 || s.percent >= lastWarnPct + REWARN_STEP_PCT;
};

/** Footer text: always honest, including when the number is unavailable. */
export const ctxStatusText = (s: CtxSample | null): string =>
  s === null || s.percent === null
    ? "ctx: unknown"
    : `ctx ${Math.floor(s.percent)}% (${k(s.tokens ?? 0)}/${k(s.contextWindow)})`;

/** Who to address: every lane tells the lead and the owner; the lead has no lead. */
export const ctxWarnTargets = (nick: string, ownerNick: string): string[] =>
  nick === LEAD_NICK ? [ownerNick] : [LEAD_NICK, ownerNick];

/**
 * One consolidated room line, no newlines. `trigger` says WHICH rule fired: a percentage of a
 * declared window, or the absolute token tripwire that ignores the declaration entirely.
 */
export const ctxWarnLine = (
  s: CtxSample,
  targets: string[],
  trigger: CtxTrigger = "percent",
  thresholdTokens = 0,
): string => {
  const pct = Math.floor(s.percent ?? 0);
  const tok = k(s.tokens ?? 0);
  const win = k(s.contextWindow);
  const heads = targets.map((t) => `@${t}`).join(" ");
  const why =
    trigger === "tokens" ? `${tok} over the ${k(thresholdTokens)} absolute limit` : `${pct}% of the window`;
  return (
    `${heads} CONTEXT ${pct}% (${tok}/${win}, ${why}) — fresh session needed here; ` +
    `owner restart, no other reply required`
  );
};
