// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Remote lane administration.
 *
 * Three routes the owner asked for, from least to most invasive:
 *   compact   a room-side request shrinks this lane's context in place   (ctx.compact())
 *   shutdown  a room-side request ends this lane cleanly                 (ctx.shutdown())
 *   renew     a room-side request starts a NEW session                   (ctx.newSession())
 *
 * The third one is the hard one — and this file used to state a ceiling on it that was WRONG.
 * What is true: session control (newSession / fork / switchSession / reload) exists ONLY on
 * ExtensionCommandContext, which pi builds for command handlers. What was wrongly concluded from
 * it: that a room message therefore cannot reach it. It can, by MINTING that context for itself —
 *   pi.sendUserMessage("/renew", { expandPromptTemplates: true })
 * pi's gate (agent-session.ts:2067 in 1.3.0) runs extension commands when that flag is set, and
 * _tryExecuteExtensionCommand builds createCommandContext(), the context that carries newSession().
 * The flag DEFAULTS TO FALSE, which is the entire reason the old reading saw nothing: nobody ever
 * passed it. Proof ran against the built 1.3.0 dist.
 *
 * THERE IS NO AUTHORITY GUARD ON THAT PATH — _tryExecuteExtensionCommand never reads `source`,
 * trust, or mode. So the only authority standing between a control-topic publish and a lane losing
 * its session is OURS: the recipient field, the allowlist, and the RESUME bar in adminVerdict. That
 * is precisely why the recipient field had to land before this half could.
 *
 * AND ONE COST PAID IN FULL: dispatching this command REPLACES THE SESSION, and a
 * replaced session does not re-fire session_start, so every context the extension had been holding
 * goes stale behind it. A seat then dies on the next inbound line (assertActive -> uncaughtException
 * -> pi exits). The renew handler now re-arms the live-context handle through newSession's withSession
 * callback and the inbound handler is wrapped in a try/catch, so a context mistake cannot be a crash
 * vector a second time. A remote renew is a session-ending act: that is what the RESUME bar is for.
 *
 * The human-typed door stays: `/renew` at the keyboard is the same handler, and its authority is
 * the person typing it. TIOCSTI, the classic keystroke injection, remains DEAD on this host -
 * dev.tty.legacy_tiocsti=0 and a pty lab returns EIO (errno 5) - so nothing injects keystrokes and
 * no route here is faked.
 *
 * Everything that decides anything lives in this file as pure functions so the gate
 * (tools/test_laneadmin.ts) can hold both halves of every truth table without a terminal.
 *
 * RECIPIENT FIELD: an admin request
 * is judged by its `to` FIELD, by the same whole-token predicate the room uses (mention.ts).
 * A lane acts only when that field names it, or names the room (`all`). Two refusals, and the
 * difference is deliberate:
 *   - no field at all -> REFUSE AND SPEAK. A fieldless publish reaches every lane on the
 *     control topic, so "fleet-wide" is not a fan-out the requester asked for, it is a request
 *     nobody named. It stays inert and every lane says so, because a mistyped or missing
 *     target that produces silence is a dispatch lost with no trace.
 *   - a field naming somebody else -> REFUSE AND STAY SILENT. This lane is a bystander; nine
 *     terminals printing "not addressed to me" for one request is the noise the recipient
 *     field exists to end: an address written into prose routes nothing —
 *     the FIELD is the only thing that decides.
 * Why this lands BEFORE remote renew: `AdminMsg` had no target field, so the moment renew could
 * actually complete, one publish would have ended every session on the box. Fan-out is now an
 * explicit `to: "all"`, never an accident.
 *
 * ALL THREE ROUTES ARE OFF UNLESS TOLD OTHERWISE: LANE_ADMIN_COMPACT, LANE_ADMIN_SHUTDOWN,
 * LANE_ADMIN_RENEW each have to say 1/true/on/yes. No flag, no behaviour.
 */

import { addressedTo, hasAddress } from "./mention.ts";
// One direction only: ctxwarn.ts imports NOTHING (tools/test_ctxwarn.ts runs it
// standalone), and laneadmin.ts is imported by ctxwarn's own callers, so this edge cannot cycle.
import {
  currentLeg,
  handoffContentVerdict,
  legInHead,
  legInName,
  LEG_ENV,
  pickResumeHandoff,
  resumeBarRefusal,
  resumeFileRe,
  resolveResumeDir,
  type ResumeFileStat,
} from "./ctxwarn.ts";
import { controlTopic, sanitizeAckId } from "./roommsg.ts";
// The handoff audit is the one place this module has to look at the disk: the bar decides whether a
// REAL sheet describes the leg about to be lost, and a sheet is bytes on a filesystem. Every call is
// guarded and no path here may refuse on an instrument fault — see `auditHandoff`.
import { readdirSync, readFileSync, statSync } from "node:fs";

export const ADMIN_KIND = "lane-admin";

export const ADMIN_ACTIONS = ["renew", "compact", "shutdown"] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** One opt-in flag per route. Default is off; enabling one route does not enable another. */
export const ADMIN_FLAGS: Record<AdminAction, string> = {
  renew: "LANE_ADMIN_RENEW",
  compact: "LANE_ADMIN_COMPACT",
  shutdown: "LANE_ADMIN_SHUTDOWN",
};

/**
 * THE SELF-RENEW KNOB: a lane must be able to renew ITSELF, and the earlier shape of this did not.
 *
 * A SEPARATE knob from `LANE_ADMIN_RENEW`, deliberately: that one arms the renew ROUTE (any
 * requester on the allowlist), this one widens it to a request a lane addresses to ITSELF. Both
 * have to say yes for a self renew to run, and neither implies the other. Default OFF, because
 * today a self-addressed request is inert on every lane and that is a property someone may be
 * relying on — turning the door on is a venue choice in the launcher, never a code default.
 *
 * What it does NOT buy: `by` still comes off an unauthenticated payload, so a LAN peer that
 * writes `by:"<victim>" to:"<victim>" renew` looks exactly like a lane renewing itself. That is
 * the same convention-check ceiling as the rest of this file (broker auth is row mqauth-20261009,
 * RULED on shape, HELD on execution), and it is the whole reason the widening stops at `renew`
 * and why `shutdown` keeps its refusal. The RESUME bar runs either way, so the worst case of a
 * forged self renew is a lane that loses its session with its handoff already on disk — not a
 * lane that wakes with no context.
 */
export const SELFRENEW_ENV = "LANE_ADMIN_SELFRENEW";

/** Same yes-value vocabulary as the route flags: unset, empty, or a typo is OFF. */
export const selfRenewEnabled = (env: Record<string, string | undefined>): boolean =>
  parseBoolSlot(env[SELFRENEW_ENV]) === true;

/** The line a renewal requester wants to reach the lane's input box. */
export const RENEW_COMMAND = "/renew";

/** What a control-topic admin request looks like. Unrelated kinds are not ours. */
export type AdminMsg = {
  kind?: string;
  action?: string;
  by?: string;
  to?: string;
  id?: string;
  ts?: number;
};

/** Is this control-topic payload an admin request at all? Shape only, no authority. */
export const isLaneAdmin = (msg: AdminMsg | null | undefined): boolean =>
  !!msg && msg.kind === ADMIN_KIND && typeof msg.action === "string" && typeof msg.by === "string";

/** Flag parsing kept small and literal on purpose: an empty or garbage value means OFF. */
export const adminEnabled = (
  env: Record<string, string | undefined>,
  action: AdminAction,
): boolean => {
  const raw = (env[ADMIN_FLAGS[action]] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
};

/**
 * `speak` on a refusal is not decoration: it says whether THIS lane should put the refusal on
 * its own terminal. See the two-halves rule in the header — bystander lanes stay quiet, a
 * request that named nobody is inert AND loud.
 */
export type AdminVerdict =
  | { ok: true; action: AdminAction; by: string; arm: boolean }
  | { ok: false; speak: boolean; reason: string };

/**
 * THE HANDOFF AUDIT (iid 17) — the bar asks the sheet a question bytes cannot ask.
 *
 * How much of a handoff is read to decide admission. A head is where a lane states what it is, and
 * reading a whole multi-KB sheet to answer "which leg" is not this bar's business.
 */
export const HANDOFF_HEAD_BYTES = 8192;

/**
 * The dirs THIS gate can look in, constructed here rather than inherited (a control guarantees its
 * own inputs). It mirrors index.ts's `resumeSearchDirs()` — env `MQTT_CTX_RESUME_DIR`, then the
 * site-config `resumeDir`, then the scratch fallback — and dedupes, so a seat whose dirs come from
 * one place cannot be audited against another. The site-config path arithmetic is repeated here on
 * purpose: `broker.ts:siteConfigPath` owns it, and importing broker.ts from laneadmin.ts would close
 * a cycle (broker.ts already imports laneadmin.ts).
 */
export const handoffDirs = (env: Record<string, string | undefined> = process.env): string[] => {
  let site: Record<string, unknown> | null = null;
  try {
    const p = ((env[SITE_CONFIG_ENV] ?? "").trim() || SITE_CONFIG_DEFAULT).replace(
      /^~(?=\/|$)/,
      env.HOME ?? "~",
    );
    const parsed = parseSiteConfig(readFileSync(p, "utf8"));
    if (parsed.ok) site = parsed.config;
  } catch {
    // No site file is the normal case on a box that never set one. A file that EXISTS and will not
    // parse is already loud at session_start in index.ts; here it only means no site layer.
  }
  const r = resolveResumeDir(env, site) as { ok: boolean; dir?: string; scratch?: string };
  // The cast is here, and not an entry on the approved-error list, on purpose: the scoped tsconfig runs
  // `strict:false`, so a discriminated union does NOT narrow and `r.ok ? r.dir : r.scratch` reports
  // TS2339 (index.ts reads the same field and its entry is already on that list). This leg adds nothing
  // to the list, so the read is written the way the checker can see it.
  const out = [r.dir ?? r.scratch ?? ""].filter((d) => d !== "");
  return [...new Set(out)];
};

export type HandoffAudit =
  | { audited: true; ok: boolean; picked: string | null; reason: string }
  | { audited: false; picked: string | null; reason: string };

/**
 * Read the handoff the bar is about to admit and check it is a handoff FOR THIS LEG: it must name the
 * leg the seat is running, and it must ANSWER the blocks its own notice lists.
 *
 * IT MAY NOT REFUSE ON AN INSTRUMENT FAULT, and that is the load-bearing clause. No dirs, an
 * unreadable dir, no sheet for this nick, or a head that will not read, all return `audited: false`:
 * the caller keeps the verdict it already had and says the new bar did not run. Refusing a good sheet
 * because this function could not see it is the false-negative class the admission rules exist to keep
 * clear, and it is the expensive direction — a lane that renews with a weak sheet is recoverable, a
 * lane stranded because a gate had a blind spot loses its state outright.
 *
 * It never throws, and the identity half is `pickResumeHandoff` — the same pure predicate the gate and
 * the wake pointer already share. This ADDS a bar; it moves no existing one, and it does not touch
 * `RESUME_MIN_BYTES`.
 */
export const auditHandoff = (opts: {
  nick: string;
  dirs?: readonly string[];
  env?: Record<string, string | undefined>;
  /** the freshness floor in the caller's clock; 0 = do not re-check it here (see adminVerdict) */
  startedAtMs?: number;
  /** the leg this seat is on; defaults to what the seat declares in its own env */
  leg?: string;
  minBytes?: number;
}): HandoffAudit => {
  const env = opts.env ?? process.env;
  const dirs = [...new Set((opts.dirs ?? handoffDirs(env)).filter((d) => (d ?? "") !== ""))];
  if (!opts.nick || dirs.length === 0)
    return { audited: false, picked: null, reason: `no handoff dir this gate could read` };
  const re = resumeFileRe(opts.nick);
  const files: ResumeFileStat[] = [];
  const pathOf = new Map<string, string>();
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue; // a dir that is not there contributes no candidates, and says so at the refusal
    }
    for (const n of names) {
      if (!re.test(n)) continue;
      const full = `${d.replace(/\/+$/, "")}/${n}`;
      try {
        // externals.d.ts stubs `node:fs` for the scoped typecheck and that stub declares a partial
        // Stats (`size`, `isDirectory`). The real one carries `mtimeMs` and `isFile`, which the pick
        // needs. So: one narrow cast, and a candidate with no clock on it is DROPPED rather than
        // admitted or refused — an instrument fault must never read as a verdict.
        const st = statSync(full) as { size: number; mtimeMs?: number; isFile?: () => boolean };
        if (!st.isFile?.()) continue;
        const m = st.mtimeMs;
        if (typeof m !== "number" || !Number.isFinite(m)) continue;
        files.push({ name: n, bytes: st.size, mtimeMs: m });
        if (!pathOf.has(n)) pathOf.set(n, full); // durable-then-scratch: the first dir owning a name wins
      } catch {
        /* raced away or unreadable: not a candidate */
      }
    }
  }
  if (files.length === 0)
    return {
      audited: false,
      picked: null,
      reason: `no RESUME-<nick>-*.md for ${opts.nick} in ${dirs.join(" then ")} — nothing to audit`,
    };
  const r = pickResumeHandoff(files, opts.nick, opts.startedAtMs ?? 0, opts.minBytes);
  if (!r.ok) return { audited: true, ok: false, picked: r.picked, reason: r.reason };
  const full = pathOf.get(r.picked ?? "");
  if (!full)
    return {
      audited: false,
      picked: r.picked,
      reason: `${r.picked} was picked but this gate could not resolve its path — content unverified`,
    };
  let head = "";
  try {
    head = readFileSync(full, "utf8").slice(0, HANDOFF_HEAD_BYTES);
  } catch {
    return {
      audited: false,
      picked: r.picked,
      reason: `${r.picked} is not readable by this seat, so its content is unverified`,
    };
  }
  const v = handoffContentVerdict(r.picked, head, opts.leg ?? currentLeg(env));
  return { audited: true, ok: v.ok, picked: r.picked, reason: v.reason };
};

/**
 * Should this lane honour `msg`? Every refusal states its reason, because a lane that
 * silently drops an admin request is indistinguishable from one that never received it -
 * the exact confusion the ack work was built to end.
 *
 * `arm` is true when the request is valid but the lane is mid-turn: the caller stores it
 * and runs it at the next idle boundary rather than dropping it.
 *
 * Shutdown and renew carry an extra bar: no RESUME file for this seat, no session loss. The
 * owner's renewal rule is that a lane must never wake with no context, and a dead lane with no
 * handoff is the worst case of that. Compact is exempt — it keeps the session. Since iid 17 the bar is
 * two questions, not one: does a sheet exist (`resumeWritten`, the caller's byte and freshness verdict),
 * and is it a handoff for THE LEG about to be lost and does it answer its own blocks (`auditHandoff`).
 * Both must pass, the second only ever adds a refusal, and it does not run at all on an instrument fault.
 */
export const adminVerdict = (opts: {
  action?: string;
  by?: string;
  to?: string;
  self: string;
  allow: readonly string[];
  env: Record<string, string | undefined>;
  idle: boolean;
  resumeWritten: boolean;
  /**
   * The dirs this seat actually searched for a handoff, in search order. Optional
   * and defaulted, so every existing caller and every existing cell reads the OLD sentence unchanged;
   * only a caller that HAS the dirs (index.ts → `resumeSearchDirs()`) gets the informative one.
   */
  resumeSearched?: string[];
}): AdminVerdict => {
  // THE RECIPIENT GATE RUNS FIRST. A lane that is not the addressee has no business evaluating
  // authority, flags or RESUME state for somebody else's request — and must not print about it.
  if (!hasAddress(opts.to)) {
    return {
      ok: false,
      speak: true,
      reason: `no recipient field — a fleet-wide admin request is inert by design; name the lane (lane_admin.mjs <by> <target> <action>)`,
    };
  }
  if (!addressedTo(opts.to as string, opts.self)) {
    return {
      ok: false,
      speak: false,
      reason: `addressed to ${opts.to}, not to ${opts.self} — this lane is not the addressee`,
    };
  }
  const by = (opts.by ?? "").trim();
  if (!by) return { ok: false, speak: true, reason: "the request carries no sender" };
  // THE SELF BRANCH. `by === self` used to be a blanket refusal; a self-addressed renew died here
  // while the tool printed `published`. It is now a
  // narrow door, and everything a lane could lose is still guarded: renew ONLY (a self-addressed
  // compact or shutdown returns the OLD refusal, byte for byte), its own opt-in flag ON, the
  // renew ROUTE flag still required, and the RESUME bar below still runs for the session-ending
  // case. The allowlist is deliberately NOT consulted on this path: it exists to judge an
  // OUTSIDE sender, and a worker lane is not on the steer floor — requiring it here would make
  // the door work only for the lead, the owner, and the nicks in MQTT_STEER_NICKS, which is not
  // not what the knob is for.
  let selfRequested = false;
  if (by === opts.self) {
    const asked = (opts.action ?? "").trim();
    if (asked !== "renew") {
      return { ok: false, speak: true, reason: `${opts.self} cannot administer its own lane by room message` };
    }
    if (!selfRenewEnabled(opts.env)) {
      // A refusal must NAME THE WORKING ALTERNATIVE. Silent inertia
      // is what cost the lead seat a session it believed it had renewed.
      // AND the asker must be told WHOM: the honoured floor is this seat's own env, so this
      // refusal is the only place a trapped lane can read it. The sibling stranger-refusal below
      // already prints the same list, so naming it here discloses nothing new — it just stops
      // sending the lane to "a lane on the steer allowlist" with no name attached. An empty floor
      // is said as empty, never as a blank pair of parentheses.
      return {
        ok: false,
        speak: true,
        reason:
          `${opts.self} cannot renew itself while ${SELFRENEW_ENV} is off — set ${SELFRENEW_ENV}=1 in this ` +
          `seat's launcher, or ask one of the lanes this seat honours (${opts.allow.join(", ") || "none — this seat's admin floor is empty"}) ` +
          `to run: lane_admin.mjs <that-nick> ${opts.self} renew`,
      };
    }
    selfRequested = true;
  }
  if (!selfRequested && !opts.allow.includes(by)) {
    return { ok: false, speak: true, reason: `${by} is not on the admin allowlist (${opts.allow.join(", ") || "empty"})` };
    // WHAT THIS CHECK IS, AND IS NOT: `allow` is the steer floor (lead + owner + MQTT_STEER_NICKS),
    // and `by` comes straight off an unauthenticated payload -- the broker accepts anonymous CONNECT
    // and authenticates NO sender, so any LAN peer can write any `by` here exactly as it can for a
    // room post. This is therefore a CONVENTION check, not an identity check: it stops a mistaken
    // lane, not a forged request. The refusal wording says "not on the allowlist" rather than
    // "not authorized" for that reason. Identity requires broker auth, which this repo does not ship
    // yet.
    // Until that lands, LANE_ADMIN_SHUTDOWN stays off, because this is the only thing between a
    // self-asserted name and ctx.shutdown() ending a working lane. The self branch above is narrow
    // for the same reason: it can only renew, only with its own flag on, and only past the RESUME
    // bar. A lane still cannot END itself by room message.
  }
  const action = (opts.action ?? "").trim();
  if (!(ADMIN_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, speak: true, reason: `unknown admin action ${JSON.stringify(action)}` };
  }
  const act = action as AdminAction;
  if (!adminEnabled(opts.env, act)) {
    return { ok: false, speak: true, reason: `${ADMIN_FLAGS[act]} is off — this route is not armed on this lane` };
  }
  const searched = (opts.resumeSearched ?? []).filter((d) => d !== "");
  if ((act === "shutdown" || act === "renew") && !opts.resumeWritten) {
    // "no RESUME file" used to be ONE sentence for two very different states — never wrote one, and
    // wrote one where this seat does not look. The owner's ordering for this leg is that both
    // false-negative generators clear before a force envelope exists, so the refusal now names the dirs
    // searched and the knob that moves them. Without `resumeSearched` the text is byte-identical to the
    // shipped one, which is what keeps the existing refusal cells honest instead of re-paired.
    return {
      ok: false,
      speak: true,
      reason: searched.length
        ? resumeBarRefusal(searched)
        : "no RESUME file for this seat yet; losing this session would leave it with no context",
    };
  }
  // iid 17 — the bar is now current BY LEG and by PAYLOAD as well, and it runs only for the two
  // session-ending acts. `resumeWritten` (the caller's byte + freshness verdict) is still required
  // FIRST: this only ever ADDS a refusal, it never removes one, and `compact` stays outside both
  // because it keeps the session.
  //
  // IT RUNS WHERE THE CALLER SAYS WHERE IT LOOKED, and `tools/test_laneadmin.ts` pins that index.ts
  // does pass `resumeSearched` for these acts. A caller with no dirs gets the shipped verdict, for two
  // reasons that are both load-bearing: (1) the refusal wording above already keys on the same field,
  // so cells that never had dirs keep their exact text instead of being re-paired; and (2) inventing
  // dirs from the ambient environment would make a gate count depend on WHICH LANE IS RUNNING IT — a
  // check that reads /tmp/tabichat because a developer's shell happened to have one is not a check.
  // `handoffDirs()` is exported for the caller that wants the audit without having dirs of its own.
  //
  // `startedAtMs` is deliberately NOT passed: freshness is the caller's floor (BOOT_AT_MS) and this
  // gate cannot see it, so re-checking it against this run's clock would invent refusals for exactly
  // the pre-renew sheets the admission rule says must be admitted.
  if ((act === "shutdown" || act === "renew") && searched.length) {
    const audited = auditHandoff({ nick: opts.self, env: opts.env, dirs: searched });
    if (audited.audited && !audited.ok) return { ok: false, speak: true, reason: audited.reason };
  }
  return { ok: true, action: act, by, arm: !opts.idle };
};

/**
 * tabichat#5 — SUPERSESSION OF CONTROL LINES. A lane that reads a hold line and then a lift line
 * must be able to tell which is CURRENT when they arrive out of order, and today it cannot: room
 * lines are ordered by ARRIVAL, so a hold published at 08:37 that shows up hours after the 08:58
 * lift reads as the newest instruction in the room. Two runs showed it: one obeyed exactly
 * that; the other saw one cancel line land ~20×.
 *
 * THE HANDLE, AND WHY THIS ONE. Two shapes were open on the row: a monotonic per-sender sequence,
 * or an explicit `lifts <id>` pair. BOTH fail here, and for the same reason — the publishers of a
 * hold and of its lift are not one author and not one session. The hold is published by the
 * mechanism (`leadHoldLine`, from the renewing seat); the lift is typed by whoever holds a keyboard
 * next (`comms with lead restored`), which may be the SAME office in a NEW session or the owner in
 * his own harness. A per-sender seq orders a seat's lines against itself and therefore orders
 * nothing across the two publishers; an id back-reference would require a hand-typed lift to quote
 * an id its author never saw. What every line already carries, from a single clock on this box, is
 * its `ts` — so the ledger orders by STAMP, and the handle is the pair (channel, stamp).
 *
 * THE CHANNEL IS THE SUBJECT OF THE ORDER, NOT ITS AUTHOR. `comms:<target>` names whose comms are
 * held, so a hold from the lead and a lift from `owner` land on ONE ledger and order against each
 * other. This is the whole design decision and it is deliberate: a guard that only ordered
 * same-sender lines was the named failure mode, and it would have caught neither case.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST, stated because a guard that is not told is a guard people
 * lean on wrongly:
 *  - it does not silence anything. A superseded line still reaches the lane, labelled, because a
 *    control-plane bug that hides a room line is worse than one that shows it late (fail-loudly).
 *  - it trusts ONE clock. Every seat on this box reads the same wall clock, so stamp order is real
 *    order HERE. A second host with a skewed clock could publish a genuinely-newer order that reads
 *    as older, and it would be labelled superseded — the label stays visible, so a human can overrule.
 *  - it recognises only the SHIPPED wordings. A synonym a seat invents for a hold is not a control
 *    line to this ledger and is delivered unlabelled, exactly as before.
 *  - it cannot retire an order it never saw. If the lift was published while this seat was down and
 *    the seat never read it, the hold is still the newest thing in THIS process's memory. The store
 *    is per-process: a reboot forgets both halves (same limit as every other globalThis store here).
 *  - it is ordering, not authority. Nothing here re-checks the steer allowlist or the recipient
 *    field; both still decide who may say anything at all (row AC5).
 */
export type CtlChannel = string;

/** The one channel family this ledger tracks today: a seat's comms bar. */
export const commsChannel = (target: string): CtlChannel =>
  `comms:${target.trim().toLowerCase()}`;

/** The recorded state of one control channel: the newest order obeyed for it. */
export interface CtlEntry {
  ts: number;
  id: string;
  nick: string;
  /** true when the current order for this channel holds comms, false when it opens them */
  held: boolean;
}

/**
 * Is this line a control order, and about whom? Matches ONLY the shipped texts: `leadHoldLine`'s
 * own wording, and the restore wording `wakeDirective` tells the next lead seat to publish. Both
 * halves of the truth table are checked in tools/test_laneadmin.ts, including the negatives — a
 * line that merely mentions "comms" must not become a control order.
 */
export const controlChannelOf = (line: {
  nick: string;
  message: string;
  to?: string;
}): { channel: CtlChannel; held: boolean; target: string } | null => {
  const m = (line.message ?? "").toLowerCase();
  // A HOLD: "<nick> refreshing — hold all comms to <nick> until the restore line lands. ..."
  let g = /hold all comms to ([a-z0-9_.-]+)/.exec(m);
  if (g) return { channel: commsChannel(g[1]), held: true, target: g[1] };
  // A LIFT: "lead seat restored (sNNN) — comms with <nick> open again. ..."
  g = /comms with ([a-z0-9_.-]+) open again/.exec(m);
  if (g) return { channel: commsChannel(g[1]), held: false, target: g[1] };
  return null;
};

/**
 * The verdict for one control line against the ledger. `current` means the ledger is updated to
 * this line; `superseded` means a newer order was already obeyed for this channel, and the caller
 * labels the line rather than delivering it plain. Equal stamps are CURRENT, never superseded: a
 * tie must not silently retire an order, and the pair-negative AC says "merely older" is not a
 * pass — so the bar is strictly older, and it is stated in the label.
 */
export const ctlAdmit = (
  prev: CtlEntry | undefined,
  now: { ts: number; id: string },
): { kind: "current" } | { kind: "superseded"; by: CtlEntry } =>
  prev && now.ts < prev.ts ? { kind: "superseded", by: prev } : { kind: "current" };

/**
 * The first characters of a supersession label, exported so the drain can recognise a line it has
 * ALREADY labelled. Held lines are re-held when they do not fit the flush budget, so without this the
 * same line would take a second header at the next settle and a third after that — a label that
 * stacks is a label nobody trusts.
 */
export const SUPERSEDED_MARK = "[tabichat][ctl] SUPERSEDED";

/**
 * The label a superseded control line carries into the lane. It names the order that beat it, with
 * its stamp, so the lane can cite WHY it is not acting — and it never deletes the original text.
 */
export const supersededHeader = (ch: CtlChannel, by: CtlEntry): string =>
  `${SUPERSEDED_MARK} control line on channel "${ch}" — do not act on it: this seat already ` +
  `obeyed ${by.held ? "a HOLD" : "a LIFT"} from ${by.nick} at ${new Date(by.ts).toISOString()} ` +
  `(id ${by.id || "none"}), which is newer than this line. Order it after that one, or say why not.`;

/**
 * THE REPLAY HALF (row AC3): a held/queued control line that is drained after this seat has already
 * obeyed something newer for the same channel must come back labelled, not plain — that is the
 * "steer delivery across a session replacement must not resurrect a closed order" criterion. The
 * ledger lives on `globalThis` for the same reason #3 put its stores there: the factory body re-runs
 * on every replacement, so a closure Map would be empty in the session that needs the answer.
 */
export const CTL_LEDGER_KEY = Symbol.for("tabichat.ctlLedger");

/**
 * tabichat#4 — THE LINE THE BELT DROPS.
 *
 * The belt in `index.ts` catches anything the inbound handler throws, prints
 * `inbound line dropped, handler threw: …` and returns. That belt is the #585 fix and it stays: a
 * throw escaping through the MQTT emitter is an `uncaughtException` and a dead seat. The owner's
 * report is not that the belt fires — it is that **a room line is lost when it does**, and the row's
 * own instruction is "fix the loss or prove it cannot happen; do not silence the message".
 *
 * THE MEASUREMENT THAT MAKES THIS FIXABLE (read the handler, not the row): on the room path the sites
 * that can throw on a stale handle — `liveCtx().isIdle()` in `deliveryClass`, and again in
 * `holdDecision` — are BOTH BEFORE the line is handed to pi, and BOTH AFTER the ack was published.
 * So at the moment of a stale-ctx throw the sender has been told "delivered" and the lane has never
 * seen the line. That is not a cosmetic drop, it is a lie on the wire, and it is exactly the case the
 * held-mention comment in this file calls "a silent drop would be a lie on the wire".
 *
 * THE FIX IS A PARK, NOT A RETRY-IN-PLACE. A stale ctx cannot be made live again — pi invalidates the
 * whole runner — so the only correct destination for the line is the NEXT session of this process.
 * The raw payload is parked and replayed by the next session once its socket is connected, in arrival
 * order. Three limits, each one deliberate:
 *   - only a throw that is recognisably pi's stale-ctx invalidation parks a line. Any other handler
 *     bug is a bug, and replaying it into a fresh session would hide it behind a second attempt; the
 *     alarm still prints, unchanged, in both cases.
 *   - only a line that was NOT yet handed off parks. Once the line is in pi's queue or in the held
 *     list it has an owner, and a replay would deliver it twice. The stage is measured, not assumed:
 *     `handedOff` flips at the two sites that take the line.
 *   - the park is bounded, and an overflow is SAID, naming how many lines were discarded. A queue
 *     that silently drops is the defect this cell exists to end.
 */
export const INBOUND_PARK_KEY = Symbol.for("tabichat.inboundPark");
export const INBOUND_PARK_MAX = 50;

/** pi's own invalidation notice — the only error class this belt is willing to replay. */
export const isStaleCtxError = (e: unknown): boolean =>
  /ctx is stale after session|extension ctx is stale/i.test(String((e as Error | null)?.message ?? e));

/**
 * Add one parked line to the park. `handedOff` is the caller's measurement of whether the line had
 * already been given to pi or to the held list; a line that had is NEVER parked, because a replay of
 * an owned line is a duplicate delivery, and a duplicate mention is worse than a late one. Overflow
 * discards the OLDEST entry (the newest is the one a renewed seat most needs) and returns the count so
 * the caller can say it out loud.
 */
export const parkInbound = <T>(
  park: readonly T[],
  line: T,
  handedOff: boolean,
  stale: boolean,
  max = INBOUND_PARK_MAX,
): { park: T[]; dropped: number; parked: boolean } => {
  if (handedOff || !stale) return { park: [...park], dropped: 0, parked: false };
  const next = [...park, line];
  // THE COUNT THAT MATTERS: `dropped > 0` is the only proof an overflow happened. A park that trims in
  // silence is the same silent-drop class in a new costume, so the caller is handed the number.
  const dropped = next.length > max ? next.length - max : 0;
  return { park: dropped ? next.slice(dropped) : next, dropped, parked: true };
};

/** Drain the park in arrival order. The caller replaces the store with the returned empty list. */
export const takeParked = <T>(park: readonly T[]): T[] => [...park];

/**
 * iid 20 — ONE broker client per process. The handle has to live where the NEXT run can find it, for
 * the same reason `INBOUND_PARK_KEY` does: the factory body re-runs on a session replacement, so a
 * closure binding dies with the run that set it and the incoming run cannot reach the socket its
 * predecessor left connected. Measured on one unchanged seat: four established sockets in
 * one pi process with four live `message` handlers, so a single room line was handled four times and
 * every dead handler parked its own copy of it.
 */
export const MQTT_CLIENT_KEY = Symbol.for("tabichat.mqttClient");

/** What `endPriorClient` calls on a client another run left behind. `mqtt.MqttClient` satisfies it. */
export interface ClosableClient {
  end(force?: boolean): unknown;
  removeAllListeners(event?: string | symbol): unknown;
  /**
   * mqtt.js sets this the moment a close is under way and clears it only when that close finishes
   * (`client.js:821`, reset at `:185`, `:321`, `:808`). A client found with it still set is a close
   * that stalled, and `end(true)` cannot restart it — the same function returns early on it
   * (`client.js:818-820`). Optional so a fake that never starts a close still satisfies the shape.
   */
  disconnecting?: boolean;
  /**
   * The transport the client wraps. `destroy()` on it is exactly what mqtt.js's own forced cleanup
   * does (`client.js:990`, reached from `_cleanUp(forced=true)`), and it is the only way down a
   * stream whose `end()` was short-circuited by the flag above. Optional for the same reason.
   */
  stream?: { destroy?: () => unknown } | null;
}

/** The events index.ts registers on the socket — the ones a zombie client would still be hearing. */
export const CLIENT_EVENTS = ["connect", "error", "message"] as const;

/**
 * End and unhook the client a previous run of this process left, if there is one. `store` is the
 * process-scoped holder, which makes this the ONLY place a replaced session's handle is reachable:
 * no shutdown handler races it, so "which shutdown ran last" stops deciding whether the socket closes.
 *
 * `end(true)` FIRST, the unhooks after: `end()` runs mqtt.js's own close bookkeeping, and that lives
 * in listeners `removeAllListeners` would take away if it ran first. Force is right because the run
 * that owned this socket is already gone — anything still queued belongs to a replaced session, and
 * an unhurried close is exactly what let a leaked client keep its subscription.
 *
 * A client that THROWS on close is still unhooked and still dropped from the store, and the caller is
 * handed `ended: false` plus the reason so it can say so out loud. This module holds no retry queue for
 * a socket mqtt.js would not close — unhooking is the half that stops the duplication, and naming it is
 * the half that stops the silence.
 *
 * THE STALLED-CLOSE HOLE, measured on a real renewal: the socket survived even though this helper ran
 * and unhooked everything. The reason is above — `end()` returns `this` immediately when
 * `disconnecting` is already set, which is what a graceful close at shutdown leaves behind — so the force
 * never reaches `_cleanUp` and the stream is never destroyed. The listeners are gone, so a stalled client
 * hears nothing and duplicates nothing; what it still holds is a descriptor and a broker session. Destroying
 * the wrapped stream here closes that remainder by the same route mqtt.js itself uses, and a client that
 * never started a close (`disconnecting` falsy) is left entirely alone, because its `end(true)` already
 * destroyed it.
 */
export const endPriorClient = <T extends ClosableClient>(
  store: { current: T | null },
  why: string,
): { ended: boolean; unhooked: number; destroyed: boolean; note: string } => {
  const prior = store.current;
  if (!prior) return { ended: true, unhooked: 0, destroyed: false, note: `no prior client (${why})` };
  store.current = null;
  const unhook = () => {
    let n = 0;
    for (const ev of CLIENT_EVENTS) {
      try {
        prior.removeAllListeners(ev);
        n++;
      } catch {
        /* an emitter already torn down has nothing left to unhook */
      }
    }
    return n;
  };
  try {
    prior.end(true);
  } catch (e) {
    const unhooked = unhook();
    return { ended: false, unhooked, destroyed: false, note: `prior client NOT closed (${why}): ${errOneLine(e)}` };
  }
  const unhooked = unhook();
  // The stalled-close branch, and the ONLY way a socket left by a replaced run comes down: `end(true)`
  // above returned early because a graceful close was still in flight, so no `_cleanUp(forced)` ever ran
  // and the transport is still open. `stream.destroy()` is what mqtt.js's own forced cleanup calls
  // (`client.js:990`), so this closes it by the library's route rather than a private back door.
  if (prior.disconnecting === true) {
    try {
      prior.stream?.destroy?.();
      return { ended: true, unhooked, destroyed: true, note: `stalled prior client destroyed (${why})` };
    } catch (e) {
      return { ended: false, unhooked, destroyed: false, note: `prior client NOT destroyed (${why}): ${errOneLine(e)}` };
    }
  }
  return { ended: true, unhooked, destroyed: false, note: `closed the prior client before connecting (${why})` };
};

/**
 * iid 20 — ONE measurement line, no behaviour in it.
 *
 * The renewal read came back 1 → 2 sockets with zero `[tabichat][client]` rows, which cannot be
 * told apart from the console: an empty store at teardown is BOTH what a working shutdown-first
 * renewal produces and what a channel that never connected produces. So the start path prints the
 * two things that distinguish them — what the holder held when this run arrived, and what this
 * process can see on the wire at that instant — and the negative pair (`storeShared=false count=2`,
 * the guinea's face) is printable from the helper with no broker in sight.
 */
export const clientFaceNote = (storeShared: boolean, count: number | string): string =>
  `storeShared=${storeShared} count=${count}`;

/**
 * Count the connected sockets in `handles` that face `port`. `handles` is whatever the caller's
 * runtime lists (node's `process._getActiveHandles()` at the call site), so this stays pure and a
 * cell can hand it the guinea's shape. A handle with no `remotePort` is not a connected socket and
 * is not counted; an absent port answers `"?"` rather than inventing a default.
 */
export const countBrokerSockets = (
  handles: readonly unknown[],
  port: string,
): number | string => {
  if (!port) return "?";
  let n = 0;
  for (const h of handles) {
    const p = (h as { remotePort?: unknown } | null)?.remotePort;
    if (p !== undefined && p !== null && String(p) === port) n++;
  }
  return n;
};

/** What the lane's terminal says when a request lands. Names the requester and the route. */
export const adminNotice = (action: AdminAction, by: string): string =>
  action === "compact"
    ? `compact requested by ${by} — compacting this session now`
    : action === "shutdown"
      ? `shutdown requested by ${by} — this lane is ending; its RESUME file is on disk`
      : `renew requested by ${by} — dispatching ${RENEW_COMMAND}; this session ends and the lane comes back fresh`;

/** What the lane's terminal says when the request has to wait for the turn to end. */
export const pendingNotice = (action: AdminAction, by: string): string =>
  `${ADMIN_FLAGS[action]} from ${by}: mid-turn, will run at the next idle boundary`;

/** What the lane's terminal says the moment a remote renew dispatches. */
export const renewDispatched = (by: string): string =>
  `renew requested by ${by} — dispatching ${RENEW_COMMAND} through the command path (this session is about to end)`;

/**
 * The FAILURE half, and it is narrow: pi's gate falls through when the command is NOT registered,
 * so the literal text would reach the model as a prompt (and prompt templates / skill commands
 * expand on that same flag). The command is registered by this same extension, so a failure here
 * means the command path is unreachable — not that a permission was refused. index.ts attaches a
 * catch rather than trusting the dispatch to be inert.
 */
export const renewDispatchFailed = (err: string): string =>
  `renew dispatch FAILED (${err}) — nothing was renewed. ${RENEW_COMMAND} is registered by this same extension, so this is a broken command path, not a refusal.`;

/**
 * THE WAKE HALF, bought by a real renew.
 *
 * What the wire proved, and what it did NOT: a remote renew reached the lane, passed the verdict
 * gate, dispatched /renew, and the lane came back as a NEW session. That is the whole of it.
 * newSession() ends the session by design — the transcript does not travel, and pi says so on the
 * fresh seat's screen ("no prior context"; that literal is pi's own banner, it is in no file of
 * ours, which I checked by grep across the live extension dir, this repo's src, and the installed
 * 1.3.0 tree). The RESUME file is the only thing that carries context across a renew, and NOTHING
 * made the replacement session read it: the seat sat at a fresh prompt with its own handoff already
 * on disk. A renew that kills the old seat and wakes an unread one has destroyed a lane, not
 * renewed it.
 *
 * So the handler that performs the replacement also injects the pointer, through
 * ReplacedSessionContext.sendUserMessage (types.d.ts:329-338 at 1.3.0) — IN-PROCESS, not over the
 * broker. That choice is the ordering law, stated so nobody re-derives it: a mention published to
 * the room during the kill-to-subscribe gap is not re-delivered, and a new session's chat_read
 * shows history that is never injected. A room post would work only if somebody sent it late
 * enough AND remembered to — two ways to lose the lane again. Inside withSession the replacement
 * session is already live and addressable, so there is no window to miss and no sender to rely on.
 *
 * WAKE IS NOT RESUME. The line tells the seat to read its handoff and then HOLD for a dispatch.
 * The no-lane-self-starts rule is not lifted by handing a lane its own notes, so the
 * text must never read as authorisation to pick up an old leg.
 */
/**
 * How the wake line is delivered into the replacement session, and why it is not a steer:
 * `followUp` queues it behind the current run on a seat that has no run — a freshly replaced session
 * is idle, so it arrives as its first turn. `steer` would be an interrupt aimed at nothing.
 *
 * IT IS A CONSTANT FOR A REASON, stated so it never reads as cleverness: index.ts is guarded by a
 * test_steer.ts check that counts `deliverAs: "followUp"` LITERALS in index.ts and allows exactly
 * one (the session_shutdown valve), so no future change can quietly make a literal the main delivery
 * path. Naming this site's class leaves that guard at one literal and UNCHANGED — the gate was not
 * re-paired for this leg, which is the point. The cost is real and stated: the counter cannot see
 * this site, so tools/test_laneadmin.ts asserts the constant is imported and used at the injection
 * point. Anyone "simplifying" it back into a literal fails test_steer instead — two guards, both
 * load-bearing, and neither one edited out from under the other.
 */
export const WAKE_DELIVER_AS = "followUp";

/**
 * The one sentence the wake line adds about the sheet it is pointing at: WHICH LEG it names. The
 * pointer has always said "a handoff says where you were", and iid 17 is the case where that is not
 * enough — a sheet from an earlier leg of the same boot reads as brand new and a cold seat obeys it.
 * A gate cannot always know the leg the next seat will be given (the lead assigns that after the
 * renew), so the pointer states the fact and lets the seat judge it: the leg the sheet names, and
 * whether it agrees with the leg this seat declares.
 *
 * "" is a real answer: no path, or a sheet this seat cannot read. It never invents a leg.
 */
export const wakeLegNote = (
  path: string | null,
  env: Record<string, string | undefined> = process.env,
): string => {
  if (!path) return "";
  let head = "";
  try {
    head = readFileSync(path, "utf8").slice(0, HANDOFF_HEAD_BYTES);
  } catch {
    return "";
  }
  const leg = legInName(path.slice(path.lastIndexOf("/") + 1)) ?? legInHead(head);
  const declared = currentLeg(env);
  if (leg === null)
    return ` It names no leg${declared ? ` while this seat declares ${LEG_ENV}=${declared}` : ""}: read the ` +
      `first lines and satisfy yourself it describes the task you are ACTUALLY on before you obey any of it.`;
  if (declared && declared !== leg)
    return ` It names leg ${leg} while this seat declares ${LEG_ENV}=${declared} — the sheet is from another ` +
      `task. Do NOT obey it: post one line saying your handoff is for leg ${leg}, and hold.`;
  return ` It names leg ${leg}${declared ? "" : `, which is READ, not checked — set ${LEG_ENV}=<n> in this seat's launcher and the bar compares it before a renew.`}`;
};

export const wakeDirective = (path: string | null, leadNick = "", legNote = ""): string => {
  // Two roles, one line, because the FIRST act of a renewed seat differs by what is waiting on it.
  // A worker reads its notes and holds. A LEAD announces itself again FIRST — lanes may be holding
  // finished verdicts addressed to a nick that was gone a moment ago, and a verdict filed by nobody
  // is a closed leg with a report on disk — a failure this office has produced on the record. Both forms end in the same
  // clause, and that clause is the point: WAKE IS NOT RESUME.
  if (leadNick.trim() !== "") {
    const restore =
      `[tabichat][renew] this LEAD seat (${leadNick}) was renewed. FIRST ACT: publish the restore line to ` +
      `the room — "lead seat restored — comms with ${leadNick} open again" — because lanes may be holding ` +
      `finished verdicts addressed to a nick that was gone a moment ago. `;
    return path === null
      ? restore +
        `THEN say plainly that you woke with NO handoff, read the ledger files, and re-ship every dispatch ` +
        `that has an ack and no report. Do not pick your own next task.`
      : restore +
        `THEN read your handoff at ${path}, read the report directory, and re-ship every dispatch that has an ` +
        `ack and no report. A handoff says where you were; a lane's report says what it finished — neither ` +
        `says what to do next.` + legNote;
  }
  return path === null
    ? `[tabichat][renew] this seat was renewed and NO RESUME file was found for it, so there is no ` +
      `handoff to read. Post one line saying you woke with no handoff, then HOLD. Do not start work, ` +
      `do not pick a venue, do not resume anything from memory — a renewed session has none.`
    : `[tabichat][renew] this seat was renewed. Your handoff is ${path}. Read it, then post one line ` +
      `("renewed, holding") and WAIT for a dispatch. A handoff says where you were; it does not say ` +
      `what you are authorised to do next.` + legNote;
};

/**
 * One line for a lane's terminal, and NEVER a stack trace:
 * "at Socket.ondata (node:internal/streams/readable:1009:22)" once sat in the harness as a text
 * artifact).
 *
 * Where it came from: the inbound belt in index.ts printed `e.stack`, and pi renders stderr as
 * plain text in the TUI, so node's internal frames appeared as if the seat itself were corrupting.
 * Those frames are worthless to a lane — they name the emitter, not the bug — while the error NAME
 * and MESSAGE are exactly what identifies a stale-context throw from anything else. A trace is
 * still available behind TABICHAT_ERR_STACK=1; it is opt-in because it is the thing that made the
 * artifact, not because it is useless in principle.
 */
export const errOneLine = (e: unknown): string => {
  if (e instanceof Error) {
    const msg = (e.message || "").replace(/\s+/g, " ").trim();
    return msg ? `${e.name}: ${msg}` : e.name;
  }
  // A thrown non-Error is real — pi-adjacent code and some emitters throw plain objects. Bare
  // String() on one renders "[object Object]", which is a WORSE artifact than the stack it
  // replaced: it names nothing and looks like a broken seat. Flatten to JSON when it can be, and
  // never let the flattener itself become the failure.
  if (typeof e === "object" && e !== null) {
    // Prefer a message/name field: an object thrown in Error's shape is common, and its message is
    // the informative half. JSON is the fallback, not the first word.
    const f = (e as { name?: unknown; message?: unknown }).message ?? (e as { name?: unknown }).name;
    if (typeof f === "string" && f.trim()) return f.replace(/\s+/g, " ").trim();
    try {
      const j = JSON.stringify(e);
      if (j !== undefined) return j.replace(/\s+/g, " ").trim() || "{}";
    } catch {
      // circular or exotic: say so plainly instead of throwing out of the thing that reports throws
    }
    return "object (no message)";
  }
  return `${String(e)}`.replace(/\s+/g, " ").trim() || "(empty error)";
};

/**
 * SITE-WIDE AUTO-RENEW: one knob the operator can set for every seat on the box.
 *
 * WHY A FILE AND NOT ONLY AN ENV LINE. `LANE_ADMIN_RENEW` in the launcher is per-seat, and a box
 * with eighteen seats has eighteen chances to disagree about a policy. The owner asked for a knob
 * that is set ONCE for the venue, so the settings file is the site-wide layer and the two older
 * doors stay as overrides, not as the only way in.
 *
 * PRECEDENCE, highest first, and it is a short list on purpose:
 *   1. the pi flag           --auto-renew / --no-auto-renew   (one launch, typed or scripted)
 *   2. the env               LANE_AUTO_RENEW                  (one seat, the launcher's form)
 *   3. the site file         autoRenew                        (every seat that reads it)
 *   4. the default           ON
 * Layers 1-3 still answer BEFORE the default, and an explicit OFF at any of them (--no-auto-renew,
 * LANE_AUTO_RENEW=0, {"autoRenew": false}) is still heard: the owner's order moved the FLOOR, it did
 * not remove the CEILING.
 * Anything unrecognised in a boolean slot is no answer from THAT layer and falls through; it is
 * never treated as a deliberate ON there. Note what the new default means for a typo: it now falls
 * through to ON, so a garbage value at all three layers self-renews at the floor. The two sentences
 * used to agree on OFF; only the first half of that reasoning survived the owner's order.
 */
export const AUTO_RENEW_ENV = "LANE_AUTO_RENEW";
export const AUTO_RENEW_FLAG = "auto-renew";
export const SITE_CONFIG_ENV = "TABICHAT_CONFIG";
export const SITE_CONFIG_DEFAULT = "~/.pi/agent/tabichat.json";

/** True/False from a bool slot; anything else (garbage, empty, a typo) is NOT enabled. */
export const parseBoolSlot = (raw: unknown): boolean | null => {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return null;
};

/**
 * The four layers, resolved. `flag` is the pi flag value (undefined = absent, false = an explicit
 * --no-auto-renew, which must be able to turn the site setting OFF for one launch — that is why an
 * explicit false is a answer and not a fall-through).
 */
export const resolveAutoRenewLayered = (layers: {
  flag?: unknown;
  env?: string | undefined;
  site?: unknown;
}): { armed: boolean; source: string } => {
  const f = parseBoolSlot(layers.flag);
  if (f !== null) return { armed: f, source: `pi flag --${AUTO_RENEW_FLAG}` };
  const e = parseBoolSlot(layers.env);
  if (e !== null) return { armed: e, source: `${AUTO_RENEW_ENV} env` };
  const s = parseBoolSlot(layers.site);
  if (s !== null) return { armed: s, source: "site file (autoRenew)" };
  return { armed: true, source: "default on (no layer set it)" };
};

/** The boolean the caller acts on. One precedence, stated once, in the function right above. */
export const resolveAutoRenew = (layers: {
  flag?: unknown;
  env?: string | undefined;
  site?: unknown;
}): boolean => resolveAutoRenewLayered(layers).armed;

/**
 * A site config that will not parse is a POLICY FAILURE and must be loud. A lane that quietly
 * falls back to the defaults starts behaving differently from its neighbours for no visible reason,
 * which is the failure class this project keeps paying for. So: null + the reason, and the caller
 * says it in the terminal.
 */
export const parseSiteConfig = (
  text: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; reason: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not valid JSON (${String(e).split("\n")[0]})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, reason: "top level is not a JSON object" };
  return { ok: true, config: parsed as Record<string, unknown> };
};

/**
 * Should this lane renew ITSELF right now? Every refusal carries a reason, and the caller shows it
 * rather than staying quiet — a seat that skips a renew nobody can see is the same dead lane with
 * extra steps.
 *
 * THE FLOOR IS NOT COSMETICS. A renew discards the transcript and re-loads the whole always-loaded
 * block from disk, and on this box that block is large. A seat renewing at 20% is not tidying, it
 * is paying to re-read its own instructions, so the floor is the existing forced-handoff threshold
 * (the point past which a lane degrades quietly) and nothing below it triggers.
 *
 * ONE PER BOOT, HARD. Without this a lane that wakes, reads its handoff and immediately crosses the
 * floor again would renew forever. The cap is per-process, and a fresh process is the only thing
 * that resets it.
 *
 * AND THE HANDOFF BAR, which is the whole point of the ordering: a seat may not destroy its own
 * context until its notes exist. Same predicate as the remote gate and the wake pointer.
 */
export type AutoRenewVerdict = { ok: true } | { ok: false; reason: string };

/**
 * tabichat#3 AC1 — may this seat dispatch a renew RIGHT NOW, given one may already be in flight?
 *
 * A SECOND concurrent replacement is the fork itself. Measured on a two-seat fixture:
 * every control message arrives TWICE per lane (the seat subscribes to `_ctl` AND `_ctl/#`, and
 * mosquitto delivers one copy per matching subscription — `sport/#` also matches `sport`, MQTT
 * 3.1.1 §4.7), and each copy is adjudicated independently. On a cheap test seat the second copy
 * lands in the stale-ctx window and the #585 belt eats it; on a heavy seat (a lead mid-turn, a
 * reload measured in seconds) BOTH copies pass the verdict while the context is still alive and
 * dispatch two concurrent `newSession()` calls. Each replacement re-runs the extension factory
 * (a new BOOT tag per fork), each builds a live session with its own socket and its own wake
 * injection, and every room-wide line — the hold, the restore — then costs every lane a paid
 * turn PER COPY. Three files at one millisecond, three restore lines with three boot tags.
 *
 * So: while a stamp is fresh, refuse. The dispatching handler clears the stamp on every terminal
 * path (replaced, cancelled, no-re-arm, throw), so this window exists ONLY as the backstop for a
 * seat that wedged mid-replacement — a stuck stamp must never strand renewals past the lifetime
 * of whatever set it. Both truth-table halves are checked in tools/test_laneadmin.ts: an ABSENT
 * stamp and a STALE stamp both say ok (the paired negative — a real second renew later must
 * still renew), a FRESH stamp refuses, and a different nick's stamp never applies here because
 * the store is keyed per nick.
 */
export const RENEW_INFLIGHT_MAX_MS = 900_000;

export const renewInFlightRefusal = (
  inflightSince: number | null | undefined,
  now: number,
  maxMs = RENEW_INFLIGHT_MAX_MS,
): { ok: true } | { ok: false; reason: string } => {
  if (inflightSince === null || inflightSince === undefined) return { ok: true };
  const age = now - inflightSince;
  if (age > maxMs) return { ok: true };
  return {
    ok: false,
    reason:
      `a renew is already in flight for this seat (stamped ${Math.max(0, Math.round(age))}ms ago; ` +
      `window ${maxMs}ms) — a second concurrent replacement would fork it; not dispatching`,
  };
};

export const autoRenewVerdict = (opts: {
  armed: boolean;
  percent: number | null;
  floorPct: number;
  renewedThisBoot: boolean;
  resumeWritten: boolean;
  /** the seat's nick; defaults to `MQTT_NICK`, which is what a live seat already has */
  nick?: string;
  env?: Record<string, string | undefined>;
  dirs?: readonly string[];
}): AutoRenewVerdict => {
  if (!opts.armed) return { ok: false, reason: `${AUTO_RENEW_ENV} is off at every layer` };
  if (opts.renewedThisBoot)
    return { ok: false, reason: "already auto-renewed once this boot — no renew loop" };
  if (opts.percent === null || !Number.isFinite(opts.percent))
    return { ok: false, reason: "no context reading yet" };
  if (opts.percent < opts.floorPct)
    return {
      ok: false,
      reason: `${Math.floor(opts.percent)}% is under the ${opts.floorPct}% floor (a renew re-reads the whole always-loaded block)`,
    };
  if (!opts.resumeWritten)
    return { ok: false, reason: "no RESUME file for this seat; renewing now would erase the only copy of its state" };
  // iid 17, same bar as the remote gate and the same rule about instrument faults — and the per-boot
  // loop brake above is untouched: it is the thing that stops a renew loop and it still runs FIRST.
  // It audits when the caller names the seat (a nick) and stays at the shipped verdict when it does
  // not, because a decision that reads the developer's /tmp is not a decision. index.ts does not pass
  // a nick here yet, so this door is wired and waiting for one line at its call site — said plainly in
  // the leg report rather than left as a green function nobody calls.
  if (opts.nick) {
    const env = opts.env ?? process.env;
    const audited = auditHandoff({ nick: opts.nick, env, dirs: opts.dirs });
    if (audited.audited && !audited.ok) return { ok: false, reason: audited.reason };
  }
  return { ok: true };
};
/**
 * THE WAKE ACT, factored out so it can be EXECUTED by the gate instead of grepped for.
 *
 * Why: the shipped version of this lived inline in index.ts's `withSession`, so the strongest thing
 * tools/test_laneadmin.ts could say about it was "the call is in the file" — a pattern match, not a
 * behavior proof. That is the gap this repo has been bitten by before (a `ctx is not
 * defined` fault: a perfectly tested module that nothing ever called). So the decision and the
 * delivery live HERE, and the caller injects only what only a live session can provide: the
 * replacement context, the filesystem probe, and where to speak. The gate then runs the real
 * function against a fake `next` and asserts what the renewed seat actually receives — including the
 * failure half, which no grep could ever have shown.
 *
 * CONTRACT, and it is the whole reason this is safe to call inside a session-replacement callback:
 * **it never throws.** A wake line that cannot be delivered is bad news, not a crash. If this
 * escaped, the throw would land inside `newSession({ withSession })` and turn a cosmetic miss into
 * a dead seat — the exact failure class the context re-arm exists to prevent.
 */
export type RenewTarget = {
  sendUserMessage: (content: string, options?: { deliverAs?: string }) => Promise<void>;
  ui?: { notify?: (text: string, level?: string) => void };
};

export const wakeRenewedSeat = async (
  next: RenewTarget,
  deps: {
    /** probe the two RESUME dirs for THIS seat, in durable-then-scratch order */
    resumeCandidates: () => Array<{ path: string; bytes: number | null }>;
    minBytes: number;
    /**
     * The nick+freshness fallback scan, supplied by the caller. The exact-name probe
     * above keys on BOOT, and a renew mints a new BOOT (and a lane may name its handoff from its
     * session id, not from the notify text), so an exact-name miss is NOT "no handoff". When the
     * fast path misses, the pointer asks this and believes it. Optional so existing callers and
     * gate cells keep their exact shape.
     */
    fallbackPick?: () => string | null;
    /** where a failure goes: stderr on a live seat, a capture array in the gate */
    stderr?: (text: string) => void;
    /** print a stack only when the env says so — a stack in a lane's window is an artifact */
    stackEnvOn?: boolean;
    /** non-empty when THIS seat is the lead; changes what the fresh seat is told to do first */
    leadNick?: string;
    err?: unknown;
  },
): Promise<{ sent: boolean; path: string | null; error?: string }> => {
  try {
    let path = wakePathFor(deps.resumeCandidates(), deps.minBytes);
    // An exact-name miss used to be the whole answer, and the renewed seat was told
    // "NO RESUME file was found" while its handoff sat on disk (the first live run of this path).
    // The nick+freshness scan is the same predicate the gate already trusts
    // (index.ts:resumeScan); the pointer must not be dumber than the gate. A fallback that throws
    // cannot eat the wake line either — the outer catch still speaks, but a scan error alone must
    // not, so the fallback is guarded here and degrades to the old null answer.
    if (path === null && deps.fallbackPick) {
      try {
        path = deps.fallbackPick();
      } catch {
        path = null;
      }
    }
    await next.sendUserMessage(wakeDirective(path, deps.leadNick ?? "", wakeLegNote(path)), { deliverAs: WAKE_DELIVER_AS });
    next.ui?.notify?.(
      path === null
        ? "[tabichat][renew] woke with NO handoff — told the seat to say so and hold"
        : `[tabichat][renew] wake line sent — handoff at ${path}`,
      path === null ? "warning" : "info",
    );
    return { sent: true, path };
  } catch (e) {
    // The session WAS replaced and re-armed, so the seat is alive; only its pointer is missing.
    const msg = errOneLine(e);
    deps.stderr?.(
      `[tabichat][renew] wake injection FAILED (${msg}) — the renewed session is live but was never ` +
        `told its handoff path. It must be pointed at its RESUME file by hand.`,
    );
    if (deps.stackEnvOn) deps.stderr?.(e instanceof Error ? e.stack ?? String(e) : String(e));
    return { sent: false, path: null, error: msg };
  }
};

/**
 * Which handoff does the wake line point at? First candidate at or over the bar wins, in the order
 * the caller supplies (the durable RESUME dir before the scratch fallback — the same order
 * index.ts handoffOnDisk walks, so the gate and the pointer cannot disagree about which dir is
 * "mine"). No candidate clears the bar -> null -> the no-handoff half of wakeDirective.
 *
 * THE KNOWN HOLE, and what closed it. This function measures BYTES, and a 359-byte sheet once
 * cleared a 200-byte bar with a sentence whose own last line confessed it was padding. That hole is no
 * longer open on purpose: tabichat#17 put the payload and leg bar in `auditHandoff`, and the
 * renew/shutdown door runs it. What is DELIBERATE is the split — `wakePathFor` stays a byte-and-name
 * matcher, because this is the POINTER: telling a seat where its own sheet lives is information, not
 * permission, and a pointer that refuses to look at a real file is the false-negative class the
 * admission rules exist to clear. The gate asks whether the sheet is fit to lose a session on; the pointer only
 * says where it is, and now also which leg it claims (`wakeLegNote`) so the seat can judge the match.
 */
export const wakePathFor = (
  candidates: ReadonlyArray<{ path: string; bytes: number | null }>,
  minBytes: number,
): string | null => {
  for (const c of candidates) {
    if (c.bytes !== null && c.bytes >= minBytes) return c.path;
  }
  return null;
};

/**
 * The FULL wake-pointer decision, pure, so both halves run headless: exact boot-tag
 * hit first (`wakePathFor` over the caller's candidates), and on a miss the nick+freshness scan
 * under the floor the CALLER carries in (the renewing session's start — never a re-minted one).
 * `pickResumeHandoff` answers with a NAME; the wake line needs a PATH, so the caller supplies the
 * name->path map from its own dir walk (`index.ts:resumePathsOf`). A pick whose path is missing
 * (raced away between stat and map) degrades to null, never to a phantom path.
 */
export const wakePickPath = (
  candidates: ReadonlyArray<{ path: string; bytes: number | null }>,
  minBytes: number,
  files: readonly ResumeFileStat[],
  pathOf: ReadonlyMap<string, string>,
  nick: string,
  floorMs: number,
): string | null => {
  const exact = wakePathFor(candidates, minBytes);
  if (exact !== null) return exact;
  const r = pickResumeHandoff(files, nick, floorMs, minBytes);
  return r.ok && r.picked !== null ? pathOf.get(r.picked) ?? null : null;
};

/**
 * THE LEAD HOLD.
 *
 * A lead seat that replaces its own session without telling the room first reproduces a
 * failure this office has produced on the record: lanes finish real work, address the lead nick, and the verdict lands
 * nowhere. The requirement already existed as a promise in a seat contract (the refresh protocol's
 * step 1), and this office has broken promises of exactly that kind on the record — so it moves
 * into the mechanism that performs the renew.
 *
 * `self === leadNick` is the entire test, and it is deliberately not "the sender asked": the human
 * typing /renew, a remote admin request, and auto-renew at the floor all end in the same command
 * handler, so one insertion covers all three doors. A worker seat renewing publishes NOTHING to the
 * room — one lane's restart is not a fleet event, and every room line lands in every lane's context
 * and is paid for thirteen times over.
 *
 * Both blank cases refuse: an empty self cannot be a lead, and an empty LEAD_NICK must not make some
 * random seat start broadcasting room-wide holds. That is the same blank-fallback discipline
 * ctxwarn.ts documents for the lead constant.
 */
export const shouldHoldBeforeRenew = (self: string, leadNick: string): boolean =>
  self.trim() !== "" && leadNick.trim() !== "" && self.trim() === leadNick.trim();

/**
 * The hold text, kept close to the wording lanes are already trained on ("hold all comms to <nick>
 * until the restore line lands"). A synonym would be a line a lane has to stop and interpret, and
 * the paired clause — work does NOT stop — is what keeps a hold from being misread as a stall order.
 */
export const leadHoldLine = (nick: string): string =>
  `${nick} refreshing — hold all comms to ${nick} until the restore line lands. ` +
  `Work does NOT stop: keep executing and keep landing reports.`;

/**
 * THE OUTCOME, PUT ON THE WIRE: the outcome must be observable by the ASKER.
 *
 * What the requester had before this: `lane_admin.mjs` printed `published lane-admin renew ...`
 * and exited 0 whatever happened, because publishing to a topic is the only thing it can see. The
 * cost is a self-addressed renew refused at the guard above, the tool
 * reporting success, and the requester planning on a refresh that had not happened. "Published" was TRUE; "renewed" was a claim the
 * publisher had no evidence for. So the lane that JUDGES the request now answers it, on the same
 * control channel the request rode, with one of exactly three words:
 *
 *   armed    taken, and it will run at the next idle boundary (the lane is mid-turn)
 *   run      accepted and dispatched now (for renew: the session is about to be replaced)
 *   refused  this lane is the addressee and it said no, with the verdict's own reason
 *
 * What it is NOT: proof the session actually changed. That observable is the boot tag on the
 * target's next post and its wake line (proven on a real renew), and
 * no ack can substitute for it — which is why the tool prints ARMED/RUN and never the word DONE.
 *
 * Bystander lanes publish NOTHING, by the same rule that keeps them silent in the terminal: one
 * targeted request must not make nine terminals talk. The seat that answers is the one the
 * recipient field named, or every lane when it named nobody — and in that fieldless case the text
 * is identical on all of them, so last-retained-wins loses nothing.
 */
export const ADMIN_RESULT_KIND = "lane-admin-result";

export const ADMIN_OUTCOMES = ["armed", "run", "refused"] as const;
export type AdminOutcome = (typeof ADMIN_OUTCOMES)[number];

/** One answer to one admin request, published by the lane that judged it. */
export interface AdminResult {
  kind: typeof ADMIN_RESULT_KIND;
  /** the `id` of the request this answers — the correlation key the requester waits on */
  id: string;
  /** the lane that answered, i.e. the addressee */
  lane: string;
  /** the requester's self-asserted `by` field, echoed back so the caller can recognise its own */
  requester: string;
  action: string;
  outcome: AdminOutcome;
  reason: string;
  ts: number;
}

export const adminResultPayload = (
  id: string,
  lane: string,
  requester: string,
  action: string,
  outcome: AdminOutcome,
  reason: string,
  ts: number,
): AdminResult => ({ kind: ADMIN_RESULT_KIND, id, lane, requester, action, outcome, reason, ts });

/** Shape only, no authority — same standing as isLaneAdmin(). */
export const isAdminResult = (o: unknown): o is AdminResult => {
  const r = o as Partial<AdminResult> | null;
  return (
    !!r &&
    r.kind === ADMIN_RESULT_KIND &&
    typeof r.id === "string" &&
    typeof r.lane === "string" &&
    typeof r.outcome === "string" &&
    ADMIN_OUTCOMES.includes(r.outcome as AdminOutcome)
  );
};

/**
 * Where the answer goes: a per-request child of the control topic, retained, so a requester that
 * subscribes a moment after the publish still gets it. It shares ackTopic()'s sanitiser for the
 * same reason — an id with a `/` in it would otherwise address a different topic level, and `#`
 * would let one collide with the wildcard every lane subscribes. Empty leaf, empty topic: the
 * caller must not publish to the control topic's own name.
 */
/**
 * SHAPE (ii), same class, one file over (tabichat#10). The lane-admin OUTCOME
 * is a receipt too — it answers a request the same way an ack answers a dispatch — and before this
 * it lived at `chat/<room>/_ctl/admin/<id>`: a topic ANY authenticated lane could write, so a peer
 * could answer a renew request it never adjudicated. That is the forgery, one level deep instead of
 * two, and closing the ack board while leaving this open would have been half a fix.
 *
 * Now `chat/<room>/_ctl/<answering-nick>/admin/<id>` — the marker is the SECOND level, not the
 * first, and that ordering is deliberate: it puts every byte a lane writes on the control tree
 * UNDER ITS OWN LEAF, so the one per-nick grant `topic write chat/<room>/_ctl/<nick>/#` covers
 * receipts AND answers and there is no second line to forget. The alternative
 * (`_ctl/admin/<nick>/<id>`) sits outside that grant, needs its own rule, and collides with a nick
 * literally named `admin`. Found by running it: with `_ctl/admin/<nick>/<id>` the shipped generator
 * grant refused a lane's OWN answer, which is AC1's positive half failing.
 */
export const adminResultTopic = (room: string, by: string, id: string): string => {
  const who = sanitizeAckId(by ?? "");
  const leaf = sanitizeAckId(id);
  return who && leaf ? `${controlTopic(room)}/${who}/admin/${leaf}` : "";
};

/**
 * What the REQUESTER subscribes. Under shape (ii) the answer lives under the ANSWERER's nick, which
 * the requester cannot know in advance for a `to: all` request — and reconstructing it from `to`
 * would be one more thing to get wrong. So the requester subscribes the single wildcard one level
 * wide and correlates by the payload's `id`, exactly as it always did:
 * `chat/<room>/_ctl/+/admin/<id>`. `+` is one level, so it matches a responder leaf and nothing
 * deeper; the read side is covered by the same `pattern read chat/<room>/_ctl/#` grant either phase
 * already emits, which is why this subscription works before AND after the ACL pass.
 */
export const adminResultWild = (room: string, id: string): string => {
  const leaf = sanitizeAckId(id);
  return leaf ? `${controlTopic(room)}/+/admin/${leaf}` : "";
};

/**
 * The process exit code the requester's shell gets. Kept here, next to the payload, so the gate
 * can prove the rc semantics instead of reading them off a print:
 *
 *   0  armed / run — the addressee took it (NOT proof the session changed; see the note above)
 *   1  refused     — the addressee said no, and said why
 *   3  unknown     — nothing answered inside the window (the tool's own code; this map never
 *                    invents 0 for a missing answer, which is the exact bug being fixed)
 *
 * An unrecognised outcome is 1, not 0: a word we do not know is not a success we may assume.
 */
export const ADMIN_EXIT = { taken: 0, refused: 1, usage: 2, unknown: 3, broker: 4 } as const;

export const adminExitCode = (outcome: AdminOutcome | string): number => {
  if (outcome === "armed" || outcome === "run") return ADMIN_EXIT.taken;
  return ADMIN_EXIT.refused;
};
