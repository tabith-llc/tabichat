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
 * Advisory threshold, percent of the declared window. **60%** is the shipped default.
 * A higher figure (77) was tried once and it
 * backfired: a lane at 78% kept working and produced the confusion the threshold exists to prevent,
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
 * WHICH handoff counts as THIS seat's.
 *
 * THE FALSE NEGATIVE THIS RULE CLEARS: a well-formed 156-byte handoff sat at
 * `RESUME-<nick>-<OLDTAG>.md` while the bar looked for `RESUME-<nick>-<NEWTAG>.md` and answered
 * `false`. The file was real, fresh and complete; only its BOOT TAG disagreed, and the boot tag
 * CHANGES ACROSS A RENEW — one renew re-mints it. So the rule "the filename must carry my current
 * tag" means a renewed seat's NEXT renew is refused forever: the very seats the force path exists to
 * clear are the ones it strands. That is the second false-negative generator, and it had to be
 * cleared before a force envelope could be trusted.
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
 * THE CONTENT BAR — iid 17, and the payload half of the same problem.
 *
 * `pickResumeHandoff` admits a handoff by nick, freshness and
 * BYTES, so a sheet written early in a boot for an EARLIER task was admitted for the one about to be
 * lost, and a fresh file full of filler cleared the byte floor. Two rules, and neither is a byte count:
 *
 *  - LEG CURRENCY. The sheet names the leg it describes (`leg <n>` on one of its opening lines, or
 *    `-leg<n>` in its filename), and when the seat declares the leg it is running — `MQTT_LEG`, read
 *    by `currentLeg` — the two must agree. A mismatch refuses, and the refusal prints both numbers and
 *    the knob, because a lane cannot fix what it cannot see.
 *  - SECTION PRESENCE, WITH A VALUE. The blocks a handoff must carry are `RESUME_TEMPLATE`'s own lines,
 *    so the list and the check cannot drift apart. A section counts when some line names it AND says
 *    something besides its own name: `next steps:` is not an answer, and a line copied out of the
 *    template verbatim is an unfilled slot, not an answer either. It is n-of-m, not all-or-nothing.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, the trade named rather than discovered later:
 *  - `RESUME_MIN_BYTES` stays **200** and is not raised. A bigger stub is still a stub, and the byte
 *    measure is the check this row says is the wrong check.
 *  - a bar that demands every block would refuse a genuinely good handoff written in prose or in the
 *    lane's own words — the false-negative class the admission rule exists to keep clear — hence `RESUME_MIN_SECTIONS`.
 *  - with no `MQTT_LEG` set the leg is read and printed but NOT compared: it is a launcher value, the
 *    launcher is not this repo's to set, and inventing one here would strand every lane on the box.
 *  - it still cannot tell a lie from a well-formed truth. It checks that the blocks are ANSWERED, not
 *    that the answers are correct; a cold seat reads the file and the wake line tells it which leg the
 *    sheet claims, so a mismatch is visible to the party who can judge it.
 */

/** The env a launcher sets to say which leg THIS seat is running. Unset = the leg is unknown. */
export const LEG_ENV = "MQTT_LEG";

/**
 * The leg the seat declares, digits only, "" when it declares none. Tolerant of `MQTT_LEG=123`,
 * `leg-123` and `Leg: 123` alike because a launcher is hand-written; garbage yields "" (no declared
 * leg) rather than a wrong number, which is the direction that cannot mis-refuse a good sheet.
 */
export const currentLeg = (env: Record<string, string | undefined> = process.env): string => {
  const m = /(\d{1,7})/.exec((env[LEG_ENV] ?? "").trim());
  return m ? m[1] : "";
};

/** How many opening lines of a sheet are searched for its leg line. */
export const RESUME_LEG_SCAN_LINES = 40;

/**
 * A leg named in the FILENAME. `resumePath` mints `RESUME-<nick>-<boot>.md` and a lane names its own
 * sheet too, and both shapes are in use: `RESUME-<nick>-<hextag>-<n>.md` (a trailing
 * all-digit component) and a `-leg<n>` slug. A hex boot tag (`0554ee`) is not a number, so it does not
 * match — which is why the digit rule is anchored to a whole filename component and not a loose search.
 */
export const legInName = (name: string): string | null => {
  const slug = /(?:^|[-_])leg[-_]?(\d{1,7})/i.exec(name ?? "");
  if (slug) return slug[1];
  const tail = /^RESUME-.+-(\d{1,7})\.md$/i.exec(name ?? "");
  return tail ? tail[1] : null;
};

/**
 * A leg named on one LINE, first match wins. The `leg` word must not be preceded by a hyphen, which
 * is what keeps a hyphenated branch slug that ends `-leg-<n>` from answering for the sheet's own
 * `leg <n>` line — measured against real branch names, and pinned by a cell.
 */
export const legInLine = (line: string): string | null =>
  /(?:^|[^-\w])leg[\s:=#]*(\d{1,7})\b/i.exec(line ?? "")?.[1] ?? null;

/** The first leg named anywhere in the head of the sheet, in reading order. */
export const legInHead = (head: string, maxLines = RESUME_LEG_SCAN_LINES): string | null => {
  for (const line of (head ?? "").split("\n").slice(0, maxLines)) {
    const n = legInLine(line);
    if (n !== null) return n;
  }
  return null;
};

/**
 * The blocks, in the voice the refusal prints them in. Each carries the fragment of its OWN
 * `RESUME_TEMPLATE` line that identifies it, so the terms come out of the list a lane is told to fill
 * in and the two cannot drift. `tools/test_ctxwarn.ts` pins that every fragment matches EXACTLY ONE
 * template line: a template edit that renames a block, or that lets one fragment answer for two of
 * them, goes RED at the gate instead of quietly un-checking a block.
 */
export const RESUME_SECTIONS: readonly { label: string; line: string; aliases?: readonly string[] }[] = [
  { label: "venue", line: "venue" },
  { label: "task", line: "task and the spec" },
  { label: "branch", line: "tip commit" },
  { label: "mid-flight", line: "mid-flight", aliases: ["not reached", "nothing in flight", "in flight"] },
  { label: "next steps", line: "next steps", aliases: ["cold seat", "resume"] },
  { label: "report", line: "report path" },
  { label: "HOLD", line: "HOLD flags" },
];

/**
 * How many blocks a handoff must answer. DERIVED, not chosen: 287 real `RESUME-*.md` sheets in the two
 * dirs this box actually uses, counted through the same function over the same head the audit reads —
 *   7 blocks: 122 files · 6: 136 · 5: 22 · 4: 4 · 3: none · 2: 3
 * and those three are stubs written to clear a byte count, and two rig fixtures. So 4 is the HIGHEST
 * floor that refuses every filler sheet found and still
 * admits all 284 real ones. 5 would have refused four genuine handoffs, one of them 18 KB and written
 * in its own vocabulary — and a bar that strands a lane holding a good handoff is the failure class
 * the admission rules exist to prevent. The command and its output are in the leg report.
 */
export const RESUME_MIN_SECTIONS = 4;

/** Words too common to identify a block on their own. */
const RESUME_STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "which", "any", "anything", "it", "is", "in",
  "on", "or", "of", "to", "at", "would", "have", "has", "had", "your", "you", "all", "not", "are",
  "was", "were", "anything", "right", "now", "came", "come", "else", "about", "into", "them", "they",
]);

/** The one template line a block's `line` fragment identifies. First match wins; the gate cell above
 * the use proves the fragment is unique, so a rename or an overlap is RED rather than a silent drop. */
const templateLineFor = (frag: string): string | undefined =>
  RESUME_TEMPLATE.split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().includes(frag.toLowerCase()));

/**
 * The terms that recognise each block: the words of its own template line, its label, and the small
 * alias set for the synonyms this box's real sheets actually use ("NOT REACHED", "what a cold seat does
 * next"). One source for the list and the check, so they cannot drift. Words too common to identify
 * anything are out.
 */
export const resumeSectionTerms = (): { label: string; terms: string[] }[] =>
  RESUME_SECTIONS.map((s) => {
    const line = templateLineFor(s.line) ?? "";
    const words = line
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !RESUME_STOP.has(w));
    const aliases = (s.aliases ?? []).map((a) => a.toLowerCase());
    return { label: s.label, terms: [...new Set([s.label.toLowerCase(), ...words, ...aliases])] };
  });

/**
 * Does this line ANSWER the block, rather than name it? The matched words and the punctuation are
 * stripped and something with real content must remain, so `## next steps` and `next steps:` say
 * nothing and do not count.
 */
const lineAnswers = (line: string, terms: string[]): boolean => {
  const rest = line
    .toLowerCase()
    .replace(new RegExp(`(?:${terms.slice().sort((a, b) => b.length - a.length).join("|")})`, "g"), " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return rest.length >= 2;
};

/**
 * Which blocks this sheet answers. Two rules make this decide the right thing rather than the obvious
 * thing, and both come out of cells on real text:
 *
 *  - **a line counts for at most ONE block, the one it names most specifically** (most distinct terms).
 *    Picking the first match in list order instead credited `next steps:` to the mid-flight block, because
 *    that block's own template line happens to contain the word "next". Cross-talk between neighbouring
 *    blocks is what a keyword list cannot avoid; a specificity ranking is one line and it decides.
 *  - **the line must ANSWER, not name.** The matched terms and the punctuation come out, and something
 *    with real content has to remain — so `## venue` is not an answer, and neither is a line copied out
 *    of `RESUME_TEMPLATE` verbatim, which is an unfilled slot with the placeholder still in it.
 *
 * Only the head is read, because that is where a lane states what it is.
 */
export const resumeSectionsPresent = (head: string): string[] => {
  const defs = resumeSectionTerms();
  const echoes = new Set(RESUME_TEMPLATE.split("\n").map((l) => l.trim()));
  const present = new Set<string>();
  for (const raw of (head ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || echoes.has(line)) continue;
    const words = new Set(line.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const whole = ` ${line.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    let best: { label: string; hits: number; terms: string[] } | null = null;
    for (const d of defs) {
      if (present.has(d.label)) continue;
      let hits = 0;
      for (const t of d.terms) if (t.includes(" ") ? whole.includes(` ${t} `) : words.has(t)) hits++;
      if (hits > 0 && (!best || hits > best.hits)) best = { label: d.label, hits, terms: d.terms };
    }
    if (best && lineAnswers(line, best.terms.filter((t) => !t.includes(" ")))) present.add(best.label);
  }
  return [...present];
};

export interface HandoffContentVerdict {
  ok: boolean;
  /** the leg the sheet names, read from its filename or its head; null when it names none */
  legFile: string | null;
  /** the leg this seat declares (`""` = none declared) */
  legDeclared: string;
  present: string[];
  missing: string[];
  reason: string;
}

/**
 * The payload bar, PURE: it takes the picked sheet's name and its head text, and says whether the
 * sheet is a handoff for the leg about to be lost. It never touches the disk and never throws — the
 * reading is `laneadmin.ts:auditHandoff`, which is where the filesystem half lives.
 */
export const handoffContentVerdict = (
  name: string,
  head: string,
  legDeclared: string = currentLeg(),
): HandoffContentVerdict => {
  const legFile = legInName(name) ?? legInHead(head);
  const present = resumeSectionsPresent(head);
  const missing = RESUME_SECTIONS.map((s) => s.label).filter((l) => !present.includes(l));
  const base = { legFile, legDeclared, present, missing };
  if (legDeclared && legFile === null)
    return {
      ...base,
      ok: false,
      reason:
        `${name} names no leg, and this seat declares ${LEG_ENV}=${legDeclared} — a sheet that does not say ` +
        `which leg it describes cannot be admitted for the one about to be lost. Add one opening line: ` +
        `\`leg ${legDeclared} — <one-line verdict>\`.`,
    };
  if (legDeclared && legFile !== legDeclared)
    return {
      ...base,
      ok: false,
      reason:
        `${name} describes leg ${legFile}, but this seat is running leg ${legDeclared} — that sheet is current ` +
        `by BOOT, which is the wrong key (iid 17): obeying it would hand the next seat instructions for a task ` +
        `that is already finished. Write a handoff for leg ${legDeclared} — same path, first line ` +
        `\`leg ${legDeclared} — <one-line verdict>\`.`,
    };
  if (present.length < RESUME_MIN_SECTIONS)
    return {
      ...base,
      ok: false,
      reason:
        `${name} answers ${present.length} of ${RESUME_SECTIONS.length} blocks a handoff must state — missing: ` +
        `${missing.join(", ") || "none named"}. The floor is not a byte count (${RESUME_MIN_BYTES} is unchanged ` +
        `on purpose): a sheet of headings with nothing under it is the case this bar exists for. Fill the `
        + `blocks the FORCED HANDOFF notice lists, in words of your own — the check wants an answer on the `
        + `line, not the heading alone.`,
    };
  return {
    ...base,
    ok: true,
    reason: legDeclared
      ? `handoff ${name} names leg ${legDeclared} and answers ${present.length}/${RESUME_SECTIONS.length} blocks`
      : `handoff ${name} names leg ${legFile ?? "(none)"} and answers ${present.length}/${RESUME_SECTIONS.length} ` +
        `blocks — ${LEG_ENV} is not set for this seat, so the leg was READ, not COMPARED: set ` +
        `${LEG_ENV}=<n> in the seat's launcher and the bar checks it`,
  };
};

/**
 * WHERE A HANDOFF IS ALLOWED TO LIVE, decided by ONE pure
 * function so no call site can invent a fourth answer.
 *
 * THE DEFECT THIS REMOVES: the shipped default used to be an absolute path on one operator's personal
 * mount (`MQTT_CTX_RESUME_DIR ?? <that path>`). On every machine where that mount is absent the path
 * does not exist, and it is not creatable by the lane user either. So the old code's
 * `mkdir` inside a `try` whose `catch` fell through did not merely fall through — it fell
 * through on EVERY lane, EVERY boot, forever, into `RESUME_FALLBACK = "/tmp/tabichat"`, which is
 * tmpfs. The ordering is deliberate: a durable default whose contents can evaporate on reboot rescues
 * state that no longer exists, which is why the location is settled before the matching rule is.
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
export const RESUME_TEMPLATE = `  leg <n> this handoff describes (the number in your dispatch) — name it on the first line
  venue / working dir (which clone, which work<N>)
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

/**
 * Absolute tripwire from MQTT_CTX_TOKENS; unset, blank, junk or negative all mean off.
 *
 * The number a lane sets is a FLOOR, not the whole rule — see `ctxEffectiveFloor` for what it is
 * compared against.
 */
export const ctxTokenThreshold = (raw: string | undefined): number => {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CTX_TOKENS;
  return n;
};

/**
 * The floor the absolute rule actually compares against: the configured token count, lifted to part
 * of the DECLARED window when the window is big enough to make the configured count premature.
 *
 * Why this exists: an absolute tripwire exported to every seat at a small-window value fires at a
 * quarter of a large declared window, and a seat that is nowhere near full is told to reload. A trip
 * that early is a guess about a lie, not evidence of one.
 *
 * Why `max` and not a skip: skipping silences the guard on the lanes it was written for. An operator
 * who sets 200,000 under a 262,144 declaration is naming a ceiling he believes in, and
 * `max(200000, 144179)` keeps it firing. A lane that declares 1,000,000 and is told 256,000 is being
 * told to reload a quarter full, and `max(256000, 550000)` stops that. A window of 0 or less (no
 * declaration, so the percentage rules are OFF and this is the only guard left) keeps the configured
 * value unchanged.
 *
 * The band: half a re-warn step (`REWARN_STEP_PCT`) ahead of the advisory, so the guard still speaks
 * before the percentage rule does — a seat at 55% of a 1,000,000 window is renewal-due and fires,
 * while 29%, 41% and 51% of that same window are not and do not. If a host really is served short of
 * the window it declares, the repair is that declaration (`contextWindow` in the model config), which
 * is the same number pi's own compaction divides by: fixing it repairs both rules at once, where
 * moving this floor repairs neither.
 */
export const ctxEffectiveFloor = (
  contextWindow: number,
  thresholdTokens: number,
  warnPct: number = DEFAULT_CTX_WARN,
): number => {
  if (thresholdTokens <= 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return thresholdTokens;
  const floorPct = Math.max(0, warnPct - REWARN_STEP_PCT / 2);
  return Math.max(thresholdTokens, Math.round((contextWindow * floorPct) / 100));
};

/**
 * The re-warn cadence for the absolute rule: `REWARN_STEP_TOKENS`, lifted to `REWARN_STEP_PCT` percent
 * of the declared window — the same anti-noise step the percentage rule already uses, in tokens. A
 * fixed 20,000 is 2% of a 1,000,000 window, so a crossed lane re-nags every two points. The cost is
 * honest: a crossed lane can re-nag up to 100,000 tokens later on that window instead of 20,000, and
 * the percentage advisory and the forced handoff behind it are unchanged.
 */
export const ctxRewarnStep = (contextWindow: number): number => {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return REWARN_STEP_TOKENS;
  return Math.max(REWARN_STEP_TOKENS, Math.round((contextWindow * REWARN_STEP_PCT) / 100));
};

/** Which rule raised the advisory — the room line and the notice must not blur them. */
export type CtxTrigger = "percent" | "tokens";

/**
 * Absolute tripwire: fires on tokens, at the floor `ctxEffectiveFloor` derives from the configured
 * count and the declared window.
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
  warnPct: number = DEFAULT_CTX_WARN,
): boolean => {
  const floor = ctxEffectiveFloor(s.contextWindow, thresholdTokens, warnPct);
  if (floor <= 0) return false;
  if (s.tokens === null) return false; // pi has not had a response yet: unknown is not "due"
  if (s.tokens < floor) return false;
  return lastWarnTokens < 0 || s.tokens >= lastWarnTokens + ctxRewarnStep(s.contextWindow);
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
    `advisory at ${thresholdPct}%` +
    (thresholdTokens > 0
      ? ` or ${k(ctxEffectiveFloor(s?.contextWindow ?? 0, thresholdTokens, thresholdPct))} tokens`
      : " (no absolute tripwire)");
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
