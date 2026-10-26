// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
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

/**
 * tabichat §5 ITEM 1 / leg 420 ACT B — WHICH handoff counts as THIS seat's.
 *
 * THE MEASURED FALSE NEGATIVE, RED-proofed before I wrote a line (see the report's §ACT B): a
 * well-formed 156-byte handoff sat at `RESUME-flash9-OLDTAG.md`, and the bar looked for
 * `RESUME-flash9-NEWTAG.md` and answered `false`. The file was real, fresh and complete; only its
 * BOOT TAG disagreed, and the boot tag CHANGES ACROSS A RENEW — s136 measured `…-01081a` →
 * `…-059820`. So the rule "the filename must carry my current tag" means a renewed seat's NEXT renew
 * is refused forever: the very seats the force path exists to clear are the ones it strands. That is
 * the second false-negative generator the owner ordered cleared *before* force exists.
 *
 * THE RULE, stated where it is enforced: identity is **nick + freshness**, not nick + tag. A handoff
 * is this seat's when its mtime is newer than this seat's own process start. Why the tag is NOT the
 * key, for the next reader who is tempted to put it back: the tag is per-SESSION and the thing being
 * rescued is a handoff written by an EARLIER session of the same lane, so requiring it to match
 * rejects exactly the case the file exists to serve. The tag still identifies the FILE (two seats
 * never share one, and the newest-writer wins on a tie), it just no longer gates admission.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — the trade, named rather than discovered later: an old-mtime
 * file is refused, so a lane that restarted and left a genuine handoff from BEFORE its own start
 * cannot be rescued by it. That is the intended direction of failure (refusing a stale file is
 * recoverable; obeying one is the false-instruction class the 359-byte-padding precedent names), and
 * it is the paired negative AC: freshness admits, age refuses.
 */
export const RESUME_SCAN_MAX = 200;

/** The regex a handoff filename must satisfy for THIS nick. Anchored, so `flash99` cannot match `flash9`. */
export const resumeFileRe = (nick: string): RegExp =>
  new RegExp(`^RESUME-${(nick ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-.+\\.md$`);

export interface ResumeFileStat {
  name: string;
  bytes: number;
  /** ms since epoch, from the filesystem */
  mtimeMs: number;
}

/**
 * Pick the handoff that counts, from what the caller read off the disk. PURE — no fs, no Date.now —
 * so every corner of the truth table runs headless and no test can reach a real RESUME dir.
 *
 * ORDERING IS A CORRECTNESS PROPERTY, not tidiness: there are 88 `RESUME-*.md` files on this box, a
 * lane may have several from its own earlier sessions, and the tie-break has to be the same one every
 * seat computes. Newest mtime wins; on an equal mtime the lexicographically LARGEST name wins, so two
 * seats writing in the same millisecond still agree on which file answers. Bounded by `RESUME_SCAN_MAX`
 * and the bound is reported, because a truncated search that reads as "no handoff" is a new false
 * negative wearing the old one's costume.
 */
export const pickResumeHandoff = (
  files: readonly ResumeFileStat[],
  nick: string,
  startedAtMs: number,
  minBytes = RESUME_MIN_BYTES,
  max = RESUME_SCAN_MAX,
): {
  ok: boolean;
  picked: string | null;
  reason: string;
  scanned: number;
  truncated: boolean;
} => {
  const re = resumeFileRe(nick);
  const mine = files.filter((f) => re.test(f.name));
  const scanned = mine.length;
  const bounded = mine.slice(0, max);
  const truncated = scanned > bounded.length;
  if (bounded.length === 0)
    return {
      ok: false,
      picked: null,
      reason: `no RESUME-<nick>-*.md file for ${nick || "(no nick)"} in the searched dirs`,
      scanned,
      truncated: false,
    };
  const newest = [...bounded].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))[0];
  if (newest.mtimeMs <= startedAtMs)
    return {
      ok: false,
      picked: newest.name,
      reason:
        `newest handoff ${newest.name} is STALE — mtime ${newest.mtimeMs} is not newer than this seat's start ` +
        `${startedAtMs}. It describes a different task, so obeying it would hand the next seat false instructions.`,
      scanned,
      truncated,
    };
  if (newest.bytes < minBytes)
    return {
      ok: false,
      picked: newest.name,
      reason:
        `newest handoff ${newest.name} is only ${newest.bytes} bytes, under the ${minBytes}-byte floor — ` +
        `a stub cannot tell a cold seat where it was.`,
      scanned,
      truncated,
    };
  return { ok: true, picked: newest.name, reason: `fresh handoff ${newest.name}, ${newest.bytes} bytes`, scanned, truncated };
};

/**
 * THE CONTENT BAR, and the choice the spec asked me to state instead of quietly making. I kept the
 * byte floor AND added the freshness rule; I did NOT check for section headings.
 *
 * Why not headings: a heading check is brittle in the direction that matters. It passes a padded file
 * that repeats `## next steps` three times with nothing under it (exactly the 359-byte-padding case —
 * volume-shaped, useless), and it refuses a genuinely good handoff written in prose or in the lane's
 * own words, which resurrects the false negative this act exists to clear. So the credibility rule is
 * "fresh AND big enough", and the honest limit is stated plainly: **this lets through a fresh file
 * full of filler.** The floor is a volume bar, not a meaning bar, and meaning is what the next seat
 * discovers when it reads the file — which is why `wakeDirective` still points at a PATH and never
 * certifies content. Making it mean something is a separate ruling, not a hunk in this one.
 */

/**
 * tabichat §5 ITEM 1 / leg 420 ACT A — WHERE A HANDOFF IS ALLOWED TO LIVE, decided by ONE pure
 * function so no call site can invent a fourth answer.
 *
 * THE DEFECT THIS REMOVES, measured at `bf6449a` on this box before I typed a line:
 *   `const RESUME_DIR = process.env.MQTT_CTX_RESUME_DIR ?? "/media/dust/dust-ext1/tabith/resume"`
 * is a MONTANA path that does not exist here (`ls -d …` → No such file or directory), and it is not
 * creatable by the lane user either (`mkdir /media/dust` → Permission denied). So the old code's
 * `mkdirSync` inside a `try` whose `catch` fell through did not merely fall through — it fell
 * through on EVERY lane, EVERY boot, forever, into `RESUME_FALLBACK = "/tmp/tabichat"`, which is
 * tmpfs. The owner's own words on why this runs BEFORE the matching work: *"the /media/dust default
 * is the larger false-negative generator, and the tmpfs fallback means a handoff can evaporate on
 * reboot"* and *"A force envelope that can rescue state that no longer exists is theater."*
 *
 * WHAT WAS BUILT, and what deliberately was not: NO new absolute path is hardcoded, because a second
 * fossil is worse than the first — a fresh default that is wrong on a different box just moves the
 * bug and hides it again behind the same silent catch. The order is (1) `MQTT_CTX_RESUME_DIR`, (2) the
 * operator-declared site-config `"resumeDir"`, (3) REFUSE, naming both knobs. `"resume"` is a
 * RELATIVE leaf that may be appended to a root the operator declared; it is never a destination.
 *
 * `scratchDir` is still returned, because a seat at 75 % with no usable durable dir must still be told
 * to write SOMETHING somewhere rather than lose its context to a blocked-tool deadlock. The change is
 * that the fallback is no longer quiet: `fallbackNote()` is what the lane and the operator both read.
 */
export const RESUME_DIR_ENV = "MQTT_CTX_RESUME_DIR";
export const RESUME_DIR_KEY = "resumeDir";
/** The tmpfs sink the lane may still use, and must never use without saying so. */
export const RESUME_SCRATCH = "/tmp/tabichat";

export type ResumeDirResolution =
  | { ok: true; dir: string; source: string }
  | { ok: false; reason: string; scratch: string };

/**
 * The pure decision. `env` is the environment, `site` is the parsed site-config object (or undefined
 * when there is no file / it did not parse — BOTH are passed in by the caller so this function touches
 * no fs and every branch is testable without a home directory).
 */
export const resolveResumeDir = (
  env: Record<string, string | undefined>,
  site?: Record<string, unknown> | null,
): ResumeDirResolution => {
  const fromEnv = (env[RESUME_DIR_ENV] ?? "").trim();
  if (fromEnv)
    return { ok: true, dir: fromEnv, source: `${RESUME_DIR_ENV} env` };
  // A site-config slot is the operator declaring a ROOT once, for the box, which is the shape the
  // ruling asked for. Wrong TYPES refuse rather than fall through: a half-configured file that
  // silently loses to a hardcoded default is the drift `checkBrokerUrl` already refuses for `mqttUrl`.
  const rawSlot = site?.[RESUME_DIR_KEY];
  if (rawSlot !== undefined && rawSlot !== null) {
    if (typeof rawSlot !== "string")
      return {
        ok: false,
        reason:
          `"${RESUME_DIR_KEY}" in the site config is a ${Array.isArray(rawSlot) ? "list" : typeof rawSlot}, not a ` +
          `path string. Fix the key or delete it — I will not fall through to a default while my own config is broken. ` +
          `Set ${RESUME_DIR_ENV} or "${RESUME_DIR_KEY}" to a DURABLE directory that survives a reboot.`,
        scratch: RESUME_SCRATCH,
      };
    const slot = rawSlot.trim();
    if (slot === "")
      return {
        ok: false,
        reason:
          `"${RESUME_DIR_KEY}" in the site config is set but blank — a blank path is not a path. ` +
          `Set ${RESUME_DIR_ENV} or "${RESUME_DIR_KEY}" to a DURABLE directory that survives a reboot.`,
        scratch: RESUME_SCRATCH,
      };
    if (!slot.startsWith("/"))
      return {
        ok: false,
        reason:
          `"${RESUME_DIR_KEY}" = ${JSON.stringify(slot)} is not an absolute path, so I would be guessing which ` +
          `cwd it is relative to and a handoff written under a changing cwd is a handoff nobody can find. ` +
          `Set it to an absolute DURABLE directory, or set ${RESUME_DIR_ENV}.`,
        scratch: RESUME_SCRATCH,
      };
    return { ok: true, dir: slot, source: `site config "${RESUME_DIR_KEY}"` };
  }
  return {
    ok: false,
    reason:
      `no durable RESUME directory configured — refusing to guess one, because every hardcoded default this ` +
      `project has shipped has eventually named a host or a volume that the next box does not have. Set ` +
      `${RESUME_DIR_ENV}=/abs/durable/path (exported in the seat's launcher) or "${RESUME_DIR_KEY}" in the site ` +
      `config. Until then handoffs land in ${RESUME_SCRATCH}, which is tmpfs and WILL NOT survive a reboot.`,
    scratch: RESUME_SCRATCH,
  };
};

/**
 * LOUD HALF (b): the sentence a seat reads the moment its handoff is going to the scratch dir. It is
 * ONE function so the three places that need it (start, forced-handoff, the bar's refusal) cannot drift
 * into three different confessions, and it states the consequence in the operator's terms — tmpfs is
 * not a plumbing detail, it is "your notes die on the next boot".
 */
export const fallbackNote = (dir: string): string =>
  `handoff dir ${dir} is the SCRATCH fallback — it is tmpfs and will NOT survive a reboot. ` +
  `Set ${RESUME_DIR_ENV} or site-config "${RESUME_DIR_KEY}" to a durable directory.`;

/**
 * LOUD HALF (a): why a resolved dir that the operator DID name is still unusable, in the two shapes a
 * lane can actually observe. The path it tried is always in the message; the knob that fixes it is
 * always in the message. Never a bare ENOENT/EACCES code on its own.
 */
export const resumeDirUnusable = (why: "missing" | "unwritable", dir: string): string =>
  `${why === "missing" ? "does not exist" : "is not writable"} — tried RESUME dir ${dir}. ` +
  `Create it, or point ${RESUME_DIR_ENV} (or site-config "${RESUME_DIR_KEY}") at a DURABLE directory you can write.`;

/**
 * LOUD HALF (c), and the one the owner's ruling actually turns on. Today the RESUME bar answers
 * "no RESUME file for this seat yet" for BOTH "nothing was ever written" and "it was written where
 * this seat cannot see it", so a lane refused for the second reason searches for a file it already
 * wrote. The refusal now says WHICH dir it searched and WHY that dir matters.
 */
export const resumeBarRefusal = (searched: string[]): string =>
  `no RESUME file for this seat in ${searched.join(" then ")} — losing this session would leave it with no ` +
  `context. If you already wrote one, it is NOT in a dir this seat looks at: check ${RESUME_DIR_ENV} ` +
  `(scratch fallback is ${RESUME_SCRATCH}, which is tmpfs and does not survive a reboot).`;

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
 * the same idiom as `MQTT_NICK`/`MQTT_URL` above. A venue that renames its lead sets
 * `MQTT_LEAD_NICK` at each lane launch; the shipped
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
