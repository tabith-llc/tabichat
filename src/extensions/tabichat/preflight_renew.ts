// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * preflight_renew.ts — ask, before you arm a renew, whether the handoff on disk would actually
 * admit it. Read-only, and it holds no rule of its own.
 *
 *   bun preflight_renew.ts                       # the usual run: this seat, its own env
 *   bun preflight_renew.ts --leg 184             # name the leg the sheet must describe
 *   bun preflight_renew.ts --since 1762700000000 # the renewing seat's process start, in ms
 *   bun preflight_renew.ts --nick lane7          # judge another seat's sheets, by nick only
 *
 * Exit: 0 the handoff is admissible · 1 the gate refuses it, with the gate's own reason ·
 * 2 usage, or a knob this tool will not guess.
 *
 * WHY IT EXISTS, and why it is this thin. A standalone checker was written first and measured
 * against the bar it was checking: it read a real handoff as answering nothing where the shipped
 * gate reads it as answering everything, and it read an echo-only skeleton as complete where the
 * same gate refuses it. Both directions, same day. A copy of a bar drifts from the bar, so this
 * file imports the bar: the threshold lives in `ctxwarn.ts` and nowhere else, and this tool's only
 * job is to read the directory, hand the gate what it asks for, and print what came back.
 *
 * WHAT IT NEVER DOES, each one a reason this file is allowed to exist.
 *   - It never writes a sheet, and never fabricates one to turn a refusal into a pass. A preflight
 *     that repairs the thing it is judging is a way to make a decision up.
 *   - It never contacts a broker. There is no network call in this file, and no import that could
 *     make one: the modules it reads (`ctxwarn.ts`, `laneadmin.ts`, `broker.ts`) take the decision
 *     as parameters, which is what makes them loadable on a box that installed only the extension.
 *   - It names no path, no seat and no site. The directory comes from the gate's own resolution
 *     order; the nick comes from the environment; the strings a refusal prints come from the
 *     functions that enforce the refusal.
 *
 * THE PARSE INVARIANT, and it is an invariant because a field test paid for it: **a leg the operator
 * tried to declare must never be silently unread, because unread means no comparison and no comparison
 * prints ADMISSIBLE.** The first version of this parser matched whole tokens only, so `--leg=1184` — the
 * ordinary `--flag=value` form — named no flag, fell through to `legDeclared=""`, and blessed a sheet the
 * gate refuses; a trailing `--leg` with no value did the same. Both now refuse. So: one parse path for
 * both forms, any `--` token that is not one of the three names is refused by the operator's own words,
 * an empty value is refused, a flag in tail position is refused, a flag handed another flag as its value
 * is refused, and a name given twice is refused. Falling through to "nothing was declared" is only ever
 * the truth when nothing was declared.
 *
 * THE UNIT OF `--since`, and it is a bound rather than a hint, because an unbounded clock opens a
 * quiet door: a value is read as epoch MILLISECONDS and nothing else, and a value that cannot be one
 * is refused at the flag. A ten-digit paste is a legal epoch SECONDS reading — `date +%s` prints ten
 * digits — and read as milliseconds it names a "now" in January 1970, which makes every sheet younger
 * than nothing and older than everything, so the age bar ADMITS whatever it finds. The same instant
 * said two ways, one ADMISSIBLE and one refused, is that defect; the tool refuses the first, answers
 * with the second, and prints the date it read in both cases so no reader has to trust a bare number.
 * No silent re-scaling: a tool that guesses whether you meant seconds or milliseconds is the guess
 * that produced the defect. The bounds are exported, and the cells pin each one from just inside and
 * just outside, so widening one is an edit that says so.
 *
 * ON `--since`, said because the difference matters to the person reading a verdict: the gate
 * compares the handoff's mtime against the start of the session that is about to be replaced. Run
 * by a seat about to renew, that is roughly now, and the default — this process's own start — is
 * honest and strict: it admits only a handoff newer than this command, which is what "write your
 * handoff, then ask" means. Run by someone judging a sheet that was written earlier, pass
 * `--since` with that seat's start, and the two answers mean the same thing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  currentLeg,
  handoffContentVerdict,
  LEG_ENV,
  pickResumeHandoff,
  RESUME_DIR_ENV,
  RESUME_LEG_SCAN_LINES,
  RESUME_MIN_BYTES,
  RESUME_MIN_SECTIONS,
  RESUME_TEMPLATE,
  resumeBarRefusal,
  resolveResumeDir,
  resumeFileRe,
  type ResumeFileStat,
} from "./ctxwarn.ts";
import { parseSiteConfig, SITE_CONFIG_ENV } from "./laneadmin.ts";
import { siteConfigPath } from "./broker.ts";

const NICK_ENV = "MQTT_" + "NICK"; // assembled, so this file names no seat and carries no roster nick

const die = (msg: string): never => {
  console.log(`preflight: REFUSE — ${msg}`);
  process.exit(2);
};

// ---- the arguments, and which source won for each of them -----------------------------------------
// ONE path for `--flag value` and `--flag=value`, so the two forms cannot drift apart later, and a
// refusal for everything else. See the PARSE INVARIANT above: the wrong answer here is not an error
// message, it is a bless.
const FLAG_NAMES = ["--leg", "--since", "--nick"] as const;
const parsed: Partial<Record<(typeof FLAG_NAMES)[number], string>> = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--"))
      die(`I do not understand the argument ${JSON.stringify(tok)} — my flags are ${FLAG_NAMES.join(", ")}`);
    const eq = tok.indexOf("=");
    const name = (eq < 0 ? tok : tok.slice(0, eq)) as (typeof FLAG_NAMES)[number];
    if (!FLAG_NAMES.includes(name))
      die(`I do not know the flag ${JSON.stringify(tok)} — my flags are ${FLAG_NAMES.join(", ")}`);
    if (parsed[name] !== undefined)
      die(`${name} was given twice — once as ${JSON.stringify(parsed[name])} and again as ${JSON.stringify(tok)}. I will not pick which one you meant`);
    if (eq >= 0) {
      const v = tok.slice(eq + 1);
      if (v === "")
        die(`${JSON.stringify(tok)} names no value — give it one, drop the "=" and pass the next word, or leave the flag out so I can read the environment`);
      parsed[name] = v;
    } else {
      const next = argv[i + 1];
      if (next === undefined)
        die(`${name} has no value — I will not guess one, because a guessed leg or start changes the answer, not just the wording`);
      if (next.startsWith("--"))
        die(`${name} cannot take ${JSON.stringify(next)} as its value — that is another flag`);
      parsed[name] = next;
      i++;
    }
  }
}

const legFlag = parsed["--leg"] ?? null;
const sinceFlag = parsed["--since"] ?? null;
const nickFlag = parsed["--nick"] ?? null;
if (legFlag !== null && !/^\d{1,7}$/.test(legFlag))
  die(`--leg wants digits: I got ${JSON.stringify(legFlag)}`);
if (sinceFlag !== null && !/^\d{10,}$/.test(sinceFlag))
  die(`--since wants epoch milliseconds (the renewing seat's own start): I got ${JSON.stringify(sinceFlag)}`);
// The two bounds of `--since`, as numbers the cells can pin: neither is a secret, and neither is
// restated in the test file. `as const` narrows them to their literal types, which is what lets the
// ceiling refer to a floor that is declared two lines above it.
export const SINCE_MIN_MS = 1_000_000_000_000 as const; // 2001-09-09T01:46:40Z — below this a value is not ms-scale
export const SINCE_MAX_AHEAD_MS = 86_400_000 as const; // one day: a seat's start is in the PAST, skew is small
const sinceIso = (ms: number): string => new Date(ms).toISOString();
if (sinceFlag !== null) {
  const v = Number(sinceFlag);
  // A digit string long enough to fall between two representable milliseconds is not a measurement, and
  // one long enough to overflow becomes `NaN`, which compares false against BOTH bounds and would sail
  // through a floor-and-ceiling check that assumed the number existed. Refused by name, before either.
  if (!Number.isSafeInteger(v))
    die(
      `--since ${sinceFlag} is not a number this tool can name: read as milliseconds it lands on ${v} or ` +
        `worse, past the largest integer milliseconds can hold (${2 ** 53}). I will not round it, because ` +
        `the rounding is the guess that produced the defect.`,
    );
  if (v < SINCE_MIN_MS)
    die(
      `--since ${sinceFlag} is ${v} ms — that parses as ${sinceIso(v)}, which is not a seat's start. ` +
        `I read ${JSON.stringify(sinceFlag)} as epoch MILLISECONDS and I will not re-scale it: if it is "date +%s", ` +
        `say $(( $(date +%s) * 1000 )).`,
    );
  const ceiling = Date.now() + SINCE_MAX_AHEAD_MS;
  if (v > ceiling)
    die(
      `--since ${sinceFlag} is ${v} ms — that parses as ${sinceIso(v)}, more than ${SINCE_MAX_AHEAD_MS} ms past ` +
        `now (${sinceIso(ceiling)}). A start that far ahead makes every sheet STALE and answers a question ` +
        `nobody asked; pass the renewing seat's own start.`,
    );
}
if (nickFlag !== null && nickFlag.trim() === "")
  die(`--nick names no seat — pass a nick or leave the flag out and I will read ${NICK_ENV}`);

// The seat's start is read once, at launch, and printed: a verdict about age is meaningless without
// saying which clock answered.
const startedAtMs = sinceFlag !== null ? Number(sinceFlag) : Date.now();
const sinceSource = sinceFlag !== null ? "--since" : "this process's own start";

const nick = nickFlag ?? (process.env[NICK_ENV] ?? "").trim();
if (nick === "")
  die(`no nick to judge — pass --nick <n> or export ${NICK_ENV}. A handoff is picked by nick, so a guess here reads another seat's notes as yours`);

// `--leg` beats the launcher's value, and says so: `currentLeg()` may be seeded from a launcher file
// that outlived the leg it was written for, and a reader of this line needs to know which one answered.
const leg = legFlag !== null ? legFlag : currentLeg(process.env as Record<string, string | undefined>);
const legSource = legFlag !== null ? "--leg" : leg === "" ? "none declared" : LEG_ENV;

// ---- the handoff directory, in the gate's own order ----------------------------------------------
const sitePath = siteConfigPath(process.env as Record<string, string | undefined>);
let site: Record<string, unknown> | null = null;
try {
  const parsed = parseSiteConfig(readFileSync(sitePath, "utf8"));
  if (parsed.ok) site = parsed.config;
} catch {
  // no site file is the normal case on a box that never wrote one; the resolution below still refuses
  // rather than guessing, and the env knob still answers on its own.
}
const resolution = resolveResumeDir(
  process.env as Record<string, string | undefined>,
  site,
) as { ok: boolean; dir?: string; source?: string; reason?: string; scratch?: string };
if (!resolution.ok)
  die(
    `${resolution.reason}\n         (the config I read: ${sitePath}, override its location with ${SITE_CONFIG_ENV})`,
  );
const dir = resolution.dir as string;

console.log(`preflight: dir=${dir} source=${resolution.source}`);
console.log(
  `preflight: nick=${nick} source=${nickFlag !== null ? "--nick" : NICK_ENV} · leg=${leg === "" ? "(none)" : leg} source=${legSource} · started=${startedAtMs} (${sinceSource}) parsed=${sinceIso(startedAtMs)}`,
);

// ---- read the directory, hand the gate what it asks for ------------------------------------------
let files: ResumeFileStat[] = [];
try {
  for (const name of readdirSync(dir)) {
    if (!resumeFileRe(nick).test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) files.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // a name that no longer stats is not my problem to invent an answer for; the gate sees the rest
    }
  }
} catch (e) {
  die(`cannot read the RESUME dir ${dir}: ${(e as Error).message}`);
}
files.sort((a, b) => b.mtimeMs - a.mtimeMs);

const pick = pickResumeHandoff(files, nick, startedAtMs);
console.log(
  `preflight: pick=${pick.ok ? "ADMITTED" : "REFUSED"} · scanned=${pick.scanned} · truncated=${pick.truncated} · sheet=${pick.picked ?? "(none)"}`,
);
console.log(`preflight:   ${pick.reason}`);
if (!pick.ok && pick.scanned === 0) console.log(`preflight:   ${resumeBarRefusal([dir])}`);

// ---- the content verdict, on whichever sheet is in hand ------------------------------------------
// Age and content are two gates and the caller needs both answers even when the first one refuses:
// "the file is stale" and "the file also names no leg" are different fixes, and a preflight that
// stops at the first one sends the lane to write a sheet that fails the second.
const sheetName = pick.picked ?? files[0]?.name ?? null;
let contentOk = false;
if (sheetName !== null) {
  const path = join(dir, sheetName);
  const head = readFileSync(path, "utf8").split("\n").slice(0, RESUME_LEG_SCAN_LINES).join("\n");
  const verdict = handoffContentVerdict(sheetName, head, leg);
  contentOk = verdict.ok;
  console.log(
    `preflight: content=${verdict.ok ? "COMPLETE" : "REFUSED"} · sheet=${sheetName} · legInSheet=${verdict.legFile ?? "(none)"} · legDeclared=${verdict.legDeclared === "" ? "(none)" : verdict.legDeclared}`,
  );
  console.log(
    `preflight:   answered ${verdict.present.length} of ${verdict.present.length + verdict.missing.length} blocks (the floor is ${RESUME_MIN_SECTIONS}) · missing: ${verdict.missing.length ? verdict.missing.join(", ") : "(none)"}`,
  );
  console.log(`preflight:   ${verdict.reason}`);
  const wanted = RESUME_TEMPLATE.split("\n")[0];
  console.log(
    `preflight: first line the gate wants: ${wanted} · byte floor ${RESUME_MIN_BYTES} · scanned at most ${RESUME_LEG_SCAN_LINES} opening lines`,
  );
} else {
  console.log(
    `preflight: content=(not judged) — no sheet for ${nick} in ${dir}, so there is nothing to read. Write it, then run me again.`,
  );
}

if (leg === "" && sheetName !== null)
  console.log(
    `preflight: NOTE — no leg was declared, so the gate compared none. Pass --leg <n> or export ${LEG_ENV} to get the answer an arming renew would give; the verdict above is the content half, printed with legDeclared=""`,
  );

const admissible = pick.ok && contentOk;
console.log(`preflight: ${admissible ? "ADMISSIBLE" : "NOT ADMISSIBLE"} — both halves above are the gate's own verdicts, read verbatim`);
process.exit(admissible ? 0 : 1);
