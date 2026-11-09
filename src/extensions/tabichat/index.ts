// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, } from "@earendil-works/pi-coding-agent";
import mqtt from "mqtt";
import { recipientField, receives } from "./mention.ts";
// transport security: the TLS/plaintext decision, the URL redaction, and the shape-(B) write gate.
// Pure module (tlsopts.ts), no broker and no fs inside it, so both truth-table halves are checkable
// in tools/test_tlsopts.ts. The design row is features/tabichat-mqtt-broker-auth.md, shape (B).
import {
  makePemReader,
  redactUrl,
  SENDER_TOPIC_ENV,
  senderTopicEnabled,
  transportDecision,
  TLS_ENV,
  type TransportDecision,
} from "./tlsopts.ts";
import {
  BROKER_URL_ENV,
  BROKER_URL_KEY,
  resolveBrokerUrl,
  siteConfigPath,
} from "./broker.ts";
import {
  DIAG_ENV,
  DIAG_MAX_ENV,
  DIAG_SITE_KEY,
  makeDiagIo,
  makeDiagSink,
} from "./diaglog.ts";
import {
  ROOMLOG_ENV,
  ROOMLOG_MAX_AGE_DEFAULT_DAYS,
  ROOMLOG_MAX_AGE_ENV,
  ROOMLOG_MAX_DEFAULT,
  ROOMLOG_MAX_ENV,
  ROOMLOG_REPLAY_DEFAULT,
  ROOMLOG_REPLAY_ENV,
  ROOMLOG_SITE_KEY,
  appendRoomLogRecord,
  histBoardPayload,
  loadRoomLogTail,
  makeRoomLogIo,
  parseRoomLogAgeDays,
  parseRoomLogCap,
  resolveRoomLogTarget,
  trimRoomLog,
  type RoomLogRecord,
  type RoomLogTarget,
} from "./roomlog.ts";
import {
  absoluteSessionDue,
  ctxDeclarationLine,
  ctxEffectiveFloor,
  ctxModelLabel,
  ctxWarnLine,
  ctxWarnTargets,
  ctxWarnThreshold,
  ctxForceThreshold,
  ctxTokenThreshold,
  bashAllowedWhileForced,
  forceBlockNote,
  forceDue,
  forceRoomLine,
  giveUpLine,
  giveUpNow,
  rearmForce,
  RESUME_TEMPLATE,
  RESUME_MIN_BYTES,
  resolveResumeDir,
  fallbackNote,
  resumeDirUnusable,
  RESUME_DIR_ENV,
  RESUME_DIR_KEY,
  pickResumeHandoff,
  RESUME_SCAN_MAX,
  type ResumeFileStat,
  resumePath,
  resumeWritten,
  READ_TOOLS_SELF,
  WRITE_TOOLS_SELF,
  DEFAULT_OWNER_NICK,
  LEAD_NICK,
  freshSessionDue,
  type CtxSample,
  type CtxTrigger,
  RESUME_SCRATCH,
} from "./ctxwarn.ts";
import { upstreamErrorNote, type EndMessage } from "./errnote.ts";
import {
  adminNotice,
  adminResultPayload,
  adminResultTopic,
  adminVerdict,
  type AdminOutcome,
  RENEW_COMMAND,
  isLaneAdmin,
  pendingNotice,
  renewDispatchFailed,
  errOneLine,
  leadHoldLine,
  shouldHoldBeforeRenew,
  wakePathFor,
  wakePickPath,
  wakeRenewedSeat,
  AUTO_RENEW_ENV,
  AUTO_RENEW_FLAG,
  parseSiteConfig,
  resolveAutoRenewLayered,
  autoRenewVerdict,
  renewInFlightRefusal,
  controlChannelOf,
  isStaleCtxError,
  parkInbound,
  takeParked,
  INBOUND_PARK_KEY,
  INBOUND_PARK_MAX,
  MQTT_CLIENT_KEY,
  clientFaceNote,
  countBrokerSockets,
  endPriorClient,
  ctlAdmit,
  supersededHeader,
  CTL_LEDGER_KEY,
  type CtlEntry,
  type AdminAction,
  type AdminMsg,
  SUPERSEDED_MARK,
} from "./laneadmin.ts";
import { appendExitLine, endStateOf, exitLine, EXIT_LOG_DEFAULT, type EndState } from "./exitlog.ts";
import {
  deliveryClass,
  parseSteerNicks,
  steerHeader,
  steerNote,
  STEER_NICKS_ENV,
  wantsSteer,
} from "./steer.ts";
// Mid-run mentions are held and the visible pending-mention stack is collapsed to a badge. Pure
// module; tests in tools/test_mentionq.ts, whose header states the mechanism.
import {
  holdBadge,
  holdsId,
  HOLD_BADGE_KEY,
  holdDecision,
  heldBatchBody,
  heldFlushCharBudget,
  HELD_FLUSH_MAX_CHARS_ENV,
  HELD_FLUSH_MAX_LINES,
  heldHeader,
  MENTION_MERGE_ENV,
  mergeEnabled,
  noteHeld,
  planHeldFlush,
  takeHeld,
  type HeldMention,
} from "./mentionq.ts";
import {
  ackLostLine,
  ACK_WATCH_DEFAULT_MS,
  ACK_WATCH_ENV,
  ackPayload,
  ackTopic,
  ackWatchKey,
  ACK_RETAIN_DEFAULT_MS,
  ACK_RETAIN_ENV,
  clearPayload,
  deliveryClause,
  deliveryVerdict,
  expiryIntervalSeconds,
  outboxView,
  type Delivery,
  pinAck,
  receiptClears,
  type AckWatch,
  type PinnedAck,
  expireAcks,
  bootTag,
  controlTopic,
  expandMe,
  foldToOneLine,
  HEARTBEAT_MS_DEFAULT,
  isAck,
  inboxTally,
  legacyPresenceTopic,
  msgId,
  msgTopic,
  msgWild,
  histTopic,
  histWild,
  nickFromHistTopic,
  topicLeaf,
  authorVerdict,
  planInbound,
  postLengthVerdict,
  postMax,
  POST_MAX_DEFAULT,
  postTooLongNote,
  presenceTopic,
  presenceWild,
  peerRecordWins,
  queryAcks,
  recordAck,
  renderAck,
  idNamespaceNote,
  renderInbound,
  renderLine,
  renderPeersBoard,
  roomPayload,
  noteRoomId,
  takeUnseen,
  pushRoomLine,
  lastSeq,
  type Ack,
  type PeerSeen,
  type RoomLine,
  settleAck,
  watchAck,
  ACK_WATCH_MAX,
  ACK_RETAIN_MAX,
} from "./roommsg.ts";

// v3 (PLAN steps 3-5): connect to the chat broker, expose /mqtt-status, /say
// and /room, clean shutdown. @-mentions inject a live turn via
// pi.sendUserMessage(). A line that does not address this lane is kept in the buffer for
// chat_read only — it is NEVER injected (the rule lives in roommsg.ts:planInbound), so
// a mention arrives alone, with its own provenance tag.
// A mention that arrives while the lane is mid-run is HELD by tabichat (mentionq.ts)
// and drained when the run settles, so it does not stack in the visible queue; the optional
// `steer` flag (steer.ts, lead + owner only) delivers it as an interrupt instead.
//
// The hold gates on the lane's RUN STATE, never on pi's queue depth: that queue is empty exactly
// when a lane is busy, so a depth-based gate cannot fire and every mid-run mention renders as its
// own block.
//
// PUBLISHING IS EXPLICIT: nothing the lane
// prints to its own terminal ever enters the room. Room text leaves this
// extension only through chat_post (or a human's /say). The former agent_end
// auto-publish is removed: it put terminal prose in front of the room against
// the lane's stated intent, and a lane that believes it is silent must be silent.
// Opt-in: the whole extension is inert unless pi runs with --tabichat.
// PROCESS-SCOPED STORE KEYS (tabichat#3). The factory body RE-RUNS on every session replacement —
// that re-run is what mints a new BOOT tag (one renew can produce three boots in one process).
// So a closure `let` is per-SESSION, whatever its comment claims, and two decisions must survive a
// replacement and be visible to EVERY instance in this process: the auto-renew once-per-boot cap
// (AC3 — a fork must not get a fresh cap per fork) and the renew in-flight latch (AC1 — one
// replacement in flight per seat per process). They live on globalThis under named symbols,
// initialised with `??=` so each factory re-run picks up the SAME store.
const RENEW_INFLIGHT_KEY = Symbol.for("tabichat.renewInflight");
const AUTO_RENEWED_KEY = Symbol.for("tabichat.autoRenewed");

/**
 * THE THREE SHAPES A LINE CAN TAKE, named (audit `iid 11`). The row was filed against an emitter that
 * recorded `error` lines and quieted everything else; enumerating the call sites turned up a third
 * shape — a failure that is real, consequence-bearing, kept in the durable
 * file, and deliberately NOT printed where a human types. So the decision is stated once, as data:
 *
 *   record-and-present  an error the operator must see AND a post-mortem must be able to grep;
 *   present-only        a warning or an informative line — the UI, and nothing else (the rule from
 *                       the rule about the place a human types);
 *   record-only         an internal fault: kept, never shown. Whether a given one SHOULD be shown is
 *                       a decision of its own, so nothing is promoted here.
 *
 * Exported, so a gate can enumerate the arms and what each one touches instead of trusting one call
 * site's wording — the table is the claim, and `tools/test_diaglog_routing.ts` runs it.
 */
export const NOTICE_ARMS = ["record-and-present", "present-only", "record-only"] as const;
export type NoticeArm = (typeof NOTICE_ARMS)[number];

/** Which half of the surface an arm touches. The ONE place that answers; never re-derived per site. */
export const noticeSurfaces = (arm: NoticeArm): { record: boolean; present: boolean } =>
  arm === "record-and-present"
    ? { record: true, present: true }
    : arm === "record-only"
      ? { record: true, present: false }
      : arm === "present-only"
        ? { record: false, present: true }
        // Unreachable through the type, and kept total on purpose: it fails toward KEEPING the line,
        // so an arm nobody recognised can never drop a record silently.
        : { record: true, present: true };

/** The two halves a caller supplies; the entry decides which ones run. */
export type NoticeSurface = {
  /** the durable half — called with the text, and with a stack where the site has one */
  record: (text: string, stack?: string) => void;
  /** the operator half. It is ALLOWED TO THROW (a disposed context does), and the entry catches. */
  present: (text: string, level: string) => void;
};

/**
 * THE ENTRY. `noticeSurfaces` says what an arm is for; this says what happens, in the order that
 * makes the ordering a property of the code and not a habit of the call site:
 *
 *   1. the durable record, if the arm keeps one — ALWAYS FIRST, because the belt below is the reason
 *      `iid 11` exists: a line that dies with a dead UI leaves nothing to grep afterwards;
 *   2. the operator's line, if the arm shows one — inside a `try`, and the `catch` writes it to
 *      stderr. One publish, never a second: the catch is the fallback, not an extra channel.
 *
 * Exported, and deliberately injected, so `tools/test_diaglog_routing.ts` can EXECUTE all three arms
 * against a presenter that works and a presenter that throws. The shipped call sites reach this through
 * the session-bound `notice` / `notifySafely` inside the factory, so the tested path and the published
 * path are the same function — which is the half the old text-regex gate could not say.
 */
export const emitNotice = (
  arm: NoticeArm,
  text: string,
  surface: NoticeSurface,
  level = "warning",
  stack?: string,
): void => {
  const half = noticeSurfaces(arm);
  if (half.record) surface.record(text, stack);
  if (!half.present) return;
  try {
    surface.present(text, arm === "record-and-present" ? "error" : level);
  } catch {
    console.error(text);
  }
};

/**
 * THE SIX FAULTS THAT LOSE WORK OR A PROMISE, named (audit `iid 11`, piece 5).
 *
 * The ruling on option 3 ("promote six of the fourteen record-only sites, at most once per session per
 * kind") changed the CHANNEL: not `ui.notify` — that is the place a human types — but the door the seat
 * itself reads. So a tell here is QUEUED and rides the model-facing send that was already going to
 * happen, the `agent_settled` held flush, and nothing in this block ever creates a turn of its own.
 * A lane that never holds a mention is never interrupted by it, and its tells stay in the durable file,
 * which is where they were always kept.
 *
 * Exported at module scope so a gate can ENUMERATE the kinds and EXECUTE the teller with an injected
 * redactor and budget — `emitNotice` takes the same posture, for the same reason: a claim
 * that is only readable as prose at one call site is a belief, not a control.
 */
export const LOSS_KINDS = [
  "journal-write-failed",
  "journal-not-prepared",
  "inbound-handler-threw",
  "park-overflowed",
  "inbound-not-parked",
  "sender-acl-inert",
] as const;
export type LossKind = (typeof LOSS_KINDS)[number];

/** Header of the batched tell: what it is, and why it says each kind once. */
export const lossTellHeader = (count: number): string =>
  `[tabichat][loss] ${count} fault(s) this session lost work or a promise — one tell per kind, ` +
  `full text in the durable file`;

export type LossTeller = {
  /** queue a tell; false when this kind was already told or is already queued (once per session) */
  tell: (kind: string, text: string) => boolean;
  /** the batched block, bounded by the budget, WITHOUT committing it — "" when nothing is pending */
  peek: () => string;
  /** mark the kinds the last block actually carried as told; a kind a budget cut left out stays
   * queued and is told by a later settle. Returns how many kinds this call spent. */
  commit: () => number;
  pending: () => number;
};

/**
 * The teller: a per-session queue, the once-per-kind rule, and the held-flush budget applied to it.
 * `redact` is injected (the shipped `redactUrl`) because the model channel carries fault text too: the
 * durable half is redacted inside the sink by `formatDiagLine`, and this half is redacted HERE, so a
 * future call site cannot forget it either. A block that does not fit says how many kinds stayed in
 * the file — a tell that cannot ship is never dropped in silence, and the first line always ships,
 * the same posture `planHeldFlush` takes for one over-cap mention.
 */
export const makeLossTeller = (budget: number, redact: (s: string) => string): LossTeller => {
  const told = new Set<string>();
  const queue: { kind: string; text: string }[] = [];
  // Which kinds the last built block actually put on the wire. A block that does not fit says how many
  // kinds stayed in the file, and those kinds are NOT told — so the count here is what commit() spends,
  // and an unshipped tail stays queued for the next settle instead of being marked told by a block that
  // never carried it.
  let shipped: string[] = [];
  const block = (items: { kind: string; text: string }[]): string => {
    if (!items.length) return "";
    let body = lossTellHeader(items.length);
    let shown = 0;
    for (const q of items) {
      const line = `\n- ${q.kind}: ${redact(q.text)}`;
      if (shown > 0 && body.length + line.length > budget) break;
      body += line;
      shown++;
    }
    shipped = items.slice(0, shown).map((q) => q.kind);
    return shown < items.length
      ? `${body}\n- ${items.length - shown} more kind(s) stayed in the durable file, not dropped.`
      : body;
  };
  return {
    tell: (kind, text) => {
      if (told.has(kind) || queue.some((q) => q.kind === kind)) return false;
      queue.push({ kind, text });
      return true;
    },
    peek: () => block(queue),
    commit: () => {
      for (const k of shipped) told.add(k);
      const unshipped = queue.filter((q) => !shipped.includes(q.kind));
      const n = queue.length - unshipped.length;
      queue.length = 0;
      queue.push(...unshipped);
      return n;
    },
    pending: () => queue.length,
  };
};

export default function (pi: ExtensionAPI) {
  // declared first: the tool descriptions below are built at setup time
  const BUFFER_MAX = 50;
  const nick = process.env.MQTT_NICK ?? "bot";
  let room = ""; // set at session_start from --room / MQTT_ROOM
  // THE BROKER LOCATION is resolved below, AFTER the site config is read — never guessed here.
  // Site-agnostic by design: this repo must not know any venue's address. 1. no default, must be
  // set; and the mqtt url is set in a config, not hardcoded.
  // The three steps (site file → MQTT_URL → loud refusal naming both) live in broker.ts, and the
  // transport decision that reads the RESOLVED url lives beside it below.
  // fresh-session advisory: warn at this percent of the context window
  const CTX_WARN = ctxWarnThreshold(process.env.MQTT_CTX_WARN);
  // absolute token tripwire (0 = off): fires on tokens once the declared window leaves room for the
  // floor to mean something — see ctxEffectiveFloor in ctxwarn.ts
  const CTX_TOKENS = ctxTokenThreshold(process.env.MQTT_CTX_TOKENS);
  const OWNER_NICK = process.env.MQTT_OWNER_NICK ?? DEFAULT_OWNER_NICK;
  // forced handoff threshold — 75 percent of the declared window (raised from the 70 first
  // discussed). At this percent the
  // lane must write a RESUME file before it may keep using its tools; MQTT_CTX_FORCE overrides, and it
  // is never below the warn threshold
  const CTX_FORCE = ctxForceThreshold(process.env.MQTT_CTX_FORCE, CTX_WARN);
  // --- auto-renew, site-wide layer ---------------------------------------------------------------
  // Read ONCE at setup. A policy file that changes mid-session is not a thing a seat should chase.
  const sitePath = siteConfigPath(process.env);
  let siteConfig: Record<string, unknown> = {};
  let siteConfigNote = "";
  try {
    const parsed = parseSiteConfig(readFileSync(sitePath, "utf8"));
    if (parsed.ok) siteConfig = parsed.config;
    else siteConfigNote = parsed.reason;
  } catch {
    // no file at all is the normal case on a box that never set one: silent, and the layers below it
    // still answer. A file that EXISTS and does not parse is the loud case, handled at session_start.
  }

  // --- DIAGNOSTIC SINK: errors stay out of the place a human types ------------------------------
  // Read ONCE at setup beside the site config, because the destination is a policy, not a per-line
  // choice. The precedence and the refusal text live in diaglog.ts; this is only the wiring.
  const DIAG = makeDiagSink(
    { env: process.env[DIAG_ENV], site: siteConfig[DIAG_SITE_KEY], home: process.env.HOME },
    {
      nick,
      maxRaw: process.env[DIAG_MAX_ENV],
      stackOn: process.env.TABICHAT_ERR_STACK === "1",
      now: () => new Date().toISOString(),
      io: makeDiagIo({ appendFileSync, renameSync, statSync, mkdirSync }),
    },
  );
  /**
   * One machine-readable diagnostic to the durable file, NEVER to the terminal. A failed write is
   * NOT retried onto stderr — that fallback is the flood this sink exists to stop — but it is said ONCE,
   * because "your diagnostics are being dropped" is consequence-bearing while "a line was parked" is
   * not, and saying it per line would rebuild the flood we just removed.
   */
  let diagFaultTold = false;
  const diag = (level: string, message: string, stack?: string): void => {
    DIAG.write(level, message, stack);
    if (DIAG.failed && !diagFaultTold) {
      diagFaultTold = true;
      notifySafely(null, `[tabichat][diag] diagnostics are being DROPPED, not printed: ${DIAG.reason}`, "warning");
    }
  };

  // --- ROOM JOURNAL -------------------------------------------------------------------------------
  // The journal's destination is resolved at session_start, once the ROOM is known (the default
  // file name carries the room leaf); everything else — precedence, refusals, caps, trim — lives
  // in roomlog.ts and is unit-gated there. This is only the wiring, same split as DIAG above.
  const ROOMLOG_IO = makeRoomLogIo({ readFileSync, appendFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync });
  const HIST_BOARD = process.env.MQTT_HIST_BOARD === "1"; // default OFF; the ACL is phase 2 (docs/broker)
  let roomLogTarget: RoomLogTarget | null = null;
  let roomLogCap = ROOMLOG_MAX_DEFAULT;
  /** The age bound beside it. -1 (unset/garbage) = no age bound, exactly the behaviour before it. */
  let roomLogAgeDays = ROOMLOG_MAX_AGE_DEFAULT_DAYS;
  // the last ten lines THIS lane sent — the tail board's whole payload, kept in memory so the
  // board never has to re-read the journal to answer "what did I just say"
  const outTail: RoomLogRecord[] = [];
  /** How many publishes the tail — and so one outbox read — can hold. Named so the read can say it. */
  const OUT_TAIL_MAX = 10;
  const journalAppend = (
    dir: "in" | "out",
    l: { id?: string; nick: string; to?: string; ts: number; message: string },
  ): void => {
    if (!roomLogTarget || !roomLogTarget.ok) return;
    const rec: RoomLogRecord = {
      id: l.id ?? "",
      nick: l.nick,
      ...(l.to ? { to: l.to } : {}),
      ts: l.ts,
      text: l.message,
      dir,
    };
    // APPEND-ONLY hot path: one O_APPEND record, never a read/rewrite cycle, so no
    // writer can land on another's bytes. The cap is enforced at boot, in this seat's own file.
    const r = appendRoomLogRecord(ROOMLOG_IO, roomLogTarget.path, rec);
    if (!r.ok) {
      noticeLost("journal-write-failed", `[tabichat][roomlog] journal write failed: ${r.reason} — room lines are NOT being kept for the next seat`);
      return;
    }
    if (dir === "out") {
      outTail.push(rec);
      if (outTail.length > OUT_TAIL_MAX) outTail.shift();
    }
  };

  // durable RESUME location (/tmp is temporary, so it is never the answer). The old shape was an
  // environment default pointing at one machine's private mount, with a `/tmp/tabichat` scratch on the
  // next line: wherever that mount was absent — which is every box that is not that one — EVERY lane
  // fell through to tmpfs in SILENCE on EVERY boot. There is no new hardcoded default here,
  // deliberately: a second fossil just moves the same bug somewhere quieter.
  // The order is env → site-config "resumeDir" → REFUSE naming both knobs (ctxwarn.ts:resolveResumeDir).
  const RESUME_RES = resolveResumeDir(
    process.env as Record<string, string | undefined>,
    siteConfig,
  );
  // A refusal is not a dead seat: the lane keeps working and writes to the scratch dir, but it is told
  // in the same breath that its handoff will not survive a reboot. Silent-into-tmpfs was the defect.
  const RESUME_DIR = RESUME_RES.ok ? RESUME_RES.dir : RESUME_RES.scratch;
  const RESUME_FALLBACK = RESUME_RES.ok ? "" : RESUME_RES.scratch;
  // room-post length cap — the owner's own posts are exempt; agents are
  // capped at 2500 (raised from 1500 after three posts bounced in one round and a long merge order
  // died inside a refused draft; refusal behavior unchanged) — MQTT_POST_MAX overrides per lane, 0 or less turns it off
  const POST_MAX = postMax(process.env.MQTT_POST_MAX);
  // who may interrupt a running lane with a steered mention (steer.ts): the lead and the owner,
  // plus anything the operator adds via MQTT_STEER_NICKS — additive, never subtractive
  const STEER_NICKS = parseSteerNicks(process.env[STEER_NICKS_ENV], OWNER_NICK);
  // mention-queue collapse (option B). ON by default; MQTT_MENTION_MERGE=0 restores the shipped
  // behaviour of one pi queue block per mention, per lane, with no redeploy.
  const MERGE_MENTIONS = mergeEnabled(process.env[MENTION_MERGE_ENV]);
  // the coalesced held-flush char budget (mentionq.ts). A malformed or zero value keeps the
  // default: a typo in the environment must never leave a lane shipping nothing.
  const HELD_FLUSH_MAX_CHARS = heldFlushCharBudget(process.env[HELD_FLUSH_MAX_CHARS_ENV]);
  // One teller per session (iid 11 piece 5). Its budget IS the held-flush budget, so a loss tell can
  // never make a turn larger than the batch the lane already agreed to receive.
  const lossTeller = makeLossTeller(HELD_FLUSH_MAX_CHARS, redactUrl);

  // --- remote lane administration. Three routes — compact, shutdown,
  //     renew — each OFF unless its own LANE_ADMIN_* flag says otherwise in THIS lane. Authority is the
  //     steer allowlist (lead + owner + MQTT_STEER_NICKS), and every decision is a pure function in
  //     laneadmin.ts so the gate can hold both truth-table halves without a terminal.
  //     HAZARD, stated because it is not this seat's to forget: the broker authenticates NOTHING, so the
  //     sender nick on a request is self-asserted (features/tabichat-mqtt-broker-auth.md, row
  //     mqauth-20261009, HELD). That makes `shutdown` a forged-nick path to ENDING a lane, which is why
  //     the trial runs `compact` only and LANE_ADMIN_SHUTDOWN stays unset until authentication lands.
  // tabichat#4 — written by `handleInbound` at the two sites that take the line, read by the belt in
  // the sibling socket callback. It must be factory-scoped for that read to see anything at all.
  let handedOff = false;
  let pendingAdmin: AdminAction | null = null;
  let pendingBy = "";
  /**
   * tabichat#10 — retained control-child publishes this lane handed the broker and has not seen
   * come back. Factory-scoped like `handedOff` above: the publisher writes it, the inbound callback
   * clears it, and the sweep timer reads it — three siblings, one owner. The decision itself is a
   * pure module (`roommsg.ts:watchAck/settleAck/expireAcks/ackLostLine`) so the gate can drive every
   * corner without a broker; what lives here is only plumbing and the two channels the alarm uses.
   */
  let ackWatch: AckWatch[] = [];
  /** My own pinned board entries, cleared on the same sweep (shape ii, AC3). */
  let pinnedAcks: PinnedAck[] = [];
  const ACK_RETAIN_MS = (() => {
    const n = Number.parseInt(process.env[ACK_RETAIN_ENV] ?? "", 10);
    // unset or garbage = the shipped hour. 0 is not "never clear" — it means the board is emptied at
    // the next sweep, which is what a venue that wants no retained board asks for. There is no value
    // that means "keep receipts forever": that is the leak AC3 closes, so it is not offered as a knob.
    return Number.isFinite(n) && n >= 0 ? n : ACK_RETAIN_DEFAULT_MS;
  })();
  /**
   * ONE knob, two ends. The window above bounds what THIS seat sweeps; this bounds what the broker
   * holds on the same leaves, derived from the same value and never a second constant. A lane
   * configured for ten minutes must not leave one-hour retained boards standing once it is gone.
   */
  const ACK_EXPIRY_S = expiryIntervalSeconds(ACK_RETAIN_MS);
  const ACK_WATCH_MS = (() => {
    const n = Number.parseInt(process.env[ACK_WATCH_ENV] ?? "", 10);
    // unset/garbage/negative all mean the shipped default, and 0 means OFF: the same
    // "an empty or junk value is never a guess" rule every other knob in this file follows.
    return Number.isFinite(n) && n >= 0 ? n : ACK_WATCH_DEFAULT_MS;
  })();

  /**
   * iid 21 — what the sweep has already called a miss, keyed by `ackWatchKey` (the publish's own id,
   * or its topic when the write has no id and its topic is already unique to it).
   *
   * The delivery answer must not live in the inbound hot path: `test_laneadmin.ts` pins the settle
   * block at four lines and at six lines total, precisely so nobody grows a check onto every line
   * the room sends, and widening that pin to make room for this fix is the move §2 forbids. So the
   * echo is left alone — it keeps clearing `ackWatch` exactly as it did — and this records only what
   * the SWEEP and the cap decided, which is the one moment the system knows "this publish aged out"
   * and "this publish was dropped unanswered". Without it, an absent publish would be
   * indistinguishable from a delivered one, because settling and ageing both remove the entry from
   * the same list.
   *
   * Bounded by the same cap the watch list uses: an unbounded set of past misses is a leak dressed as
   * a memory, and a lane that re-posts clears its own stale verdict at `watchSend`.
   */
  const lostKeys = new Set<string>();
  const noteLost = (key: string): void => {
    if (!key) return;
    lostKeys.add(key);
    while (lostKeys.size > ACK_WATCH_MAX) {
      const oldest = lostKeys.values().next().value;
      if (oldest === undefined) break;
      lostKeys.delete(oldest);
    }
  };

  /** How often a waiting publish re-reads the watch list. A read of an in-memory array, not a poll of the wire. */
  const DELIVERY_POLL_MS = 40;

  /**
   * iid 21 AC1 — the bounded wait for the answer the watchdog is already going to get.
   *
   * Three states are kept apart on purpose, because collapsing any two of them is the bug this row
   * filed: a publish still watched at the deadline was never confirmed; a publish no longer watched
   * was confirmed ONLY if the frame that took it off the list was its OWN echo, which after
   * `settleAck` matches on `ackWatchKey` is the only way its key can leave the list; and a publish
   * that was never watched at all — watch off, no client, or a socket that is not connected, where
   * mqtt.js QUEUES the write and that is not a refusal — can be answered nothing, and must not be
   * reported as either verdict. `off` names WHICH of the three this seat is in, because the sentence
   * a lane reads must not blame `MQTT_ACK_WATCH_MS=0` on a host whose knob is 3000 (finding 3).
   */
  const awaitDelivery = async (topic: string, id = ""): Promise<Delivery> => {
    const t0 = Date.now();
    if (!topic) return { state: "not-sent", waitedMs: 0 };
    if (!ACK_WATCH_MS) return { state: "watch-off", waitedMs: 0, off: "knob" };
    if (!client) return { state: "watch-off", waitedMs: 0, off: "no-client" };
    if (!client.connected) return { state: "watch-off", waitedMs: 0, off: "reconnecting" };
    const key = ackWatchKey({ topic, id });
    for (;;) {
      const v = deliveryVerdict(key, ackWatch, lostKeys);
      if (v !== "watching") return { state: v, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 >= ACK_WATCH_MS) return { state: "unconfirmed", waitedMs: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, DELIVERY_POLL_MS));
    }
  };

  /** The handoff bar: a RESUME file for THIS seat, big enough to count. Same test the forced-handoff
   *  gate applies before it blocks tools — reused, not reinvented. The dirs searched are the
   *  configured durable dir and the scratch, and the ORDER is what the refusal text prints, so a lane
   *  refused for a file it believes it wrote can see which dir it was actually looked for in. */
  const resumeSearchDirs = (): string[] =>
    [RESUME_DIR, RESUME_FALLBACK].filter((d) => d !== "");

  const resumeCandidates = (): Array<{ path: string; bytes: number | null }> =>
    resumeSearchDirs().map((d) => {
      const p = resumePath(d, nick, BOOT);
      try {
        return { path: p, bytes: statSync(p).size };
      } catch {
        return { path: p, bytes: null };
      }
    });

  /**
   * The handoff bar by **nick + freshness**, not by boot tag. Reads what is actually on disk in
   * the searched dirs and asks `pickResumeHandoff`, which is pure and headless-testable.
   *
   * WHY THE TAG STOPPED BEING THE KEY: a well-formed 156-byte handoff named for an OLD boot tag was
   * refused for a seat whose BOOT was a NEW tag, and the boot tag is re-minted by every renew.
   * Requiring it meant a renewed seat's
   * NEXT renew is refused forever — the second false-negative generator, which had to be cleared
   * before a force envelope existed. `startedAt` is this process's own session start (set in the
   * session_start handler beside the exit-log breadcrumb), so a file older than it describes a DIFFERENT
   * task and still refuses: that is the paired negative, not an accident.
   *
   * The old exact-name probe is kept as the FAST path: when the current boot tag does have a file, we
   * use it and skip the scan entirely. Nothing that works today stops working.
   */
  const resumeScan = (): { ok: boolean; picked: string | null; reason: string; truncated: boolean } => {
    // FAST PATH, and it keeps the SHARED byte bar shared: `wakePathFor` is the same predicate the wake
    // pointer uses, so the gate and the pointer still cannot disagree about what counts as a handoff.
    // That sharing used to be a one-line expression, and a shipped cell pinned it by LITERAL; the
    // literal moved and the cell now pins the call. Deleting the shared bar to get green
    // would have been the weaken-the-check class; keeping the bar and re-pinning the call is not.
    // The exact-hit branch lives in wakePickPath now; the shipped cell pins THAT call instead.
    const hit = wakePathFor(resumeCandidates(), RESUME_MIN_BYTES);
    if (hit !== null) return { ok: true, picked: hit, reason: "exact boot-tag match", truncated: false };
    // The floor is BOOT_AT_MS — the moment this SESSION RUN started (the factory re-runs per
    // replacement, tabichat#3, so this is per-run, NOT process-wide; the earlier wording here claimed
    // "this PROCESS" and is corrected forward). A previous session's handoff is therefore
    // refused by this gate, and that refusal is the deliberate law (a prior session cannot arm a
    // later one) — the wake pointer is where a pre-renew handoff must be admitted, see resumePickAt.
    const files = resumePathsOf().files;
    return pickResumeHandoff(files, nick, BOOT_AT_MS);
  };

  /** The same disk walk the gate does, hoisted so the gate and the wake fallback cannot scan two
   *  differently-shaped dirs. Returns stats by name AND a name->full-path map,
   *  because `pickResumeHandoff` is pure and returns a NAME — the pointer needs a PATH. */
  const resumePathsOf = (): { files: ResumeFileStat[]; pathOf: Map<string, string> } => {
    const files: ResumeFileStat[] = [];
    const pathOf = new Map<string, string>();
    for (const d of resumeSearchDirs()) {
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch (e) {
        // A dir that is not there is the missing-dir case, named in the refusal text; here it only means this dir
        // contributes no candidates. Keep the failure local and non-fatal.
        continue;
      }
      for (const n of names) {
        if (!n.startsWith("RESUME-") || !n.endsWith(".md")) continue;
        const full = `${d.replace(/\/+$/, "")}/${n}`;
        try {
          const st = statSync(full);
          if (st.isFile()) {
            files.push({ name: n, bytes: st.size, mtimeMs: st.mtimeMs });
            // durable-then-scratch order: the FIRST dir that carries a name owns it.
            if (!pathOf.has(n)) pathOf.set(n, full);
          }
        } catch {
          /* raced away or unreadable: not a candidate */
        }
      }
    }
    return { files, pathOf };
  };

  /**
   * WHICH file the renewed seat's wake line points at, under an EXPLICIT floor.
   * Exact boot-tag hit first (fast path, unchanged predicate, shared byte bar); on a miss the
   * nick+freshness scan answers, because a lane may name its handoff from its session id, and the
   * boot tag the probe holds is the RENEWING run's — a name that cannot reliably pre-exist.
   * The floor is carried in (the caller passes the renewing session's BOOT_AT_MS at renew-request
   * time), NOT read from whatever closure happens to be live at callback time: the law is "written
   * during the session that asked to be replaced", and pinning it as a parameter keeps a future
   * refactor from silently swapping in the new run's boot — the exact re-mint defect this shape names.
   */
  const resumePickAt = (floorMs: number): string | null => {
    const { files, pathOf } = resumePathsOf();
    return wakePickPath(resumeCandidates(), RESUME_MIN_BYTES, files, pathOf, nick, floorMs);
  };

  const handoffOnDisk = (): boolean => resumeScan().ok;

  /** The slice of the pi context the admin routes touch. */
  type AdminCtx = {
    isIdle: () => boolean;
    compact: () => void;
    shutdown: () => void;
    ui: { notify: (text: string, level?: string) => void };
  };

  const runAdmin = async (
    action: AdminAction,
    by: string,
    ctx: AdminCtx,
    // the requester-correlation answer (tabichat#3): a refusal the RUNTIME route decides still owes
    // the requester a named outcome, exactly like a verdict refusal does. Absent on the human and
    // auto-renew doors, which have no waiting requester id.
    answer?: (outcome: AdminOutcome, reason: string) => void,
  ) => {
    ctx.ui.notify(`[tabichat][laneadmin] ${adminNotice(action, by)}`, "warning");
    if (action === "compact") {
      ctx.compact();
      return;
    }
    if (action === "shutdown") {
      // The existing session_shutdown handler takes it from here: presence goes offline, and the
      // socket closes kindly so anything queued (an ack, an advisory) still leaves.
      ctx.shutdown();
      return;
    }
    // renew: the MQTT callback's context has no newSession(), but the COMMAND context does, and
    // pi's gate runs an extension command when expandPromptTemplates is set. So dispatch our own
    // /renew rather than claim the route is closed. The ceiling asserted in the old
    // text of this file was a misreading of a correct type fact.
    //
    // TWO THINGS THIS OWES, both measured against pi's 1.3.0 source, not assumed:
    //  1. await, because sendUserMessage runs the whole prompt path — including waitForIdle() and
    //     newSession() inside the command handler — and a fired-and-forgot promise would be a
    //     session ending behind our back;
    //  2. a catch, because the gate FALLS THROUGH when the command is not registered: the literal
    //     "/renew" would then reach the model as a prompt. That is a broken command path, not a
    //     refusal, and it gets said that way.
    // THE LATCH, checked BEFORE dispatching (tabichat#3 AC1): a second in-flight replacement is the
    // fork. The authoritative stamp+clear lives in the renew COMMAND handler below (every door runs
    // through it); this early read exists so a REMOTE requester gets a named refusal rather than a
    // silence and a 15 s timeout. laneadmin.ts:renewInFlightRefusal owns the decision, both halves.
    const latch = renewInFlightRefusal(RENEW_INFLIGHT.get(nick) ?? null, Date.now());
    if (!latch.ok) {
      ctx.ui.notify(`[tabichat][laneadmin] ${latch.reason}`, "warning");
      answer?.("refused", latch.reason);
      return;
    }
    try {
      await pi.sendUserMessage(RENEW_COMMAND, { expandPromptTemplates: true });
    } catch (e) {
      ctx.ui.notify(`[tabichat][laneadmin] ${renewDispatchFailed(String(e))}`, "warning");
    }
  };

  const takeAdmin = (msg: AdminMsg, ctx: AdminCtx) => {
    const v = adminVerdict({
      action: msg.action,
      by: msg.by,
      to: msg.to,
      self: nick,
      allow: STEER_NICKS,
      env: process.env,
      idle: ctx.isIdle(),
      resumeWritten: handoffOnDisk(),
      // The loud refusal (c) is wired at the REMOTE bar only. The self-renew site keeps the shipped
      // sentence, because that lane is asking about its own dir and already printed the forced-handoff
      // path beside it; the remote case is the one where the asker is a different seat and the refused
      // seat must say WHERE it looked.
      resumeSearched: resumeSearchDirs(),
    });
    // THE ANSWER. The requester can only see that a publish happened, so the lane that
    // judged the request says what it decided, pinned to the request's own id. No id, nothing to
    // correlate — an old client's publish stays as unobservable as it was, and that is said in the
    // report rather than papered over. Bystander lanes answer nothing: the recipient field already
    // decided they are not the addressee, and nine answers to one request is the noise the bystander
    // rule exists to end.
    const answerAdmin = (outcome: AdminOutcome, reason: string) => {
      const rid = typeof msg.id === "string" ? msg.id : "";
      if (!rid || !room) return;
      // shape (ii): the answer is pinned under THIS lane's own leaf, which is what lets the broker
      // refuse a peer's forged answer. The requester hears it on `_ctl/admin/+/<id>`.
      const t = adminResultTopic(room, nick, rid);
      if (!t) return;
      if (!client) return; // same rule as the receipt board: a dead socket is not a refused write

      client.publish(
        t,
        JSON.stringify(
          adminResultPayload(rid, nick, (msg.by ?? "").trim(), (msg.action ?? "").trim(), outcome, reason, Date.now()),
        ),
        {
          retain: true,
          // The same window as the receipt board. An answer is one topic per request id, and a lane
          // that died mid-answer left it there with no sweep of its own to reach it.
          properties: { messageExpiryInterval: ACK_EXPIRY_S },
        },
      );
      // #10: this is the publish whose loss hurts most — the requester's tool is sitting on a
      // 15-second window, and if the broker ate this answer it prints "nothing answered" while this
      // lane believes it answered. Both sides are right about what they saw and wrong about the wire.
      watchSend(t, "admin outcome");
    };
    if (!v.ok) {
      // speak=false means the recipient field named another lane: this seat is a bystander and
      // stays silent, so one targeted request cannot make nine terminals talk.
      if (v.speak) {
        ctx.ui.notify(`[tabichat][laneadmin] refused — ${v.reason}`, "warning");
        answerAdmin("refused", v.reason);
      }
      return;
    }
    if (v.arm) {
      pendingAdmin = v.action;
      pendingBy = v.by;
      ctx.ui.notify(`[tabichat][laneadmin] ${pendingNotice(v.action, v.by)}`, "warning");
      answerAdmin("armed", "mid-turn — will run at the next idle boundary");
      return;
    }
    answerAdmin("run", "accepted and dispatched now");
    // fire-and-forget on purpose: the MQTT callback must not block on the dispatch, and the renew
    // path it starts ends this session, so there is nothing to wait FOR here.
    void runAdmin(v.action, v.by, ctx, answerAdmin);
  };
  // percent of the last advisory; -1 = none yet, reset by a compaction
  let lastCtxWarn = -1;
  // same anti-noise discipline for the absolute rule: the token count it last fired on, -1 = none
  let lastCtxWarnTokens = -1;
  // Lane breadcrumb state: how the newest turn ended, and when this session started.
  let lastTurn: EndState = "unknown";
  // The upstream-error OBSERVATION, held until the boundary that can report it.
  // `agent_end` hands the messages but not the retry decision (`AgentEndEvent` has no
  // `willRetry`, and pi schedules the retry after this emit returns), so the note is built
  // there and printed at `agent_settled`. Every `agent_end` overwrites it, which is what
  // makes a clean run after an errored one clear the pending note instead of carrying it.
  let pendingUpstreamNote: string | null = null;
  let startedAt = 0;
  const EXIT_LOG = process.env.MQTT_EXIT_LOG || EXIT_LOG_DEFAULT;
  // The `ask_owner` tool is deliberately absent. An owner ask is plain text typed in the
  // lane's own terminal, not a registered tool. Nothing registers that tool name any more, and no other file in
  // this extension uses the "[ask_owner]" notice tag.

  // Model-facing room access. /say and /room are human-typed slash commands,
  // which an agent cannot invoke; these tools are the agent's path to the room.
  pi.registerTool(
    defineTool({
      name: "chat_post",
      label: "Chat post",
      description:
        `Publish a message to the tabichat room right now, from any turn. This session's room `
        + `nick is "${nick}"; write the token {me} wherever your own nick belongs — it is `
        + `replaced with the real nick before publishing, so never type a nick yourself. `
        + `Set "to" to address someone: it travels on the wire as the RECIPIENT FIELD, and that `
        + `field is the ONLY thing that decides who receives the message — the visible "@<to> " `
        + `prefix is text for humans and older receivers, and an address written into the body `
        + `routes nothing while "to" is set. Use it for short verdicts and pointers to a task `
        + `file. This tool is the `
        + `ONLY way anything reaches the room: your terminal reply, your tool output and your `
        + `turn prose are never published, so anything the room must see has to be sent here by `
        + `name. Room text is public and human-readable; never put credentials or ceremony text `
        + `in it. A line sent to a lane that is ALREADY working normally queues behind its whole `
        + `run and lands after it has posted its verdict; when you are adding something that `
        + `changes what that lane should be doing, set steer true so the addressee sees it at its `
        + `next tool-result boundary, mid-task. That is an interrupt: reserve it for a `
        + `lane-changing addendum, never for status chatter, and only the lead and the owner `
        + `nicks are honoured. Before your detail goes anywhere, write it to a file, and post four `
        + `things here: who it is for, which file holds the substance, what to do with it, and when `
        + `to stop. The length cap is ${POST_MAX_DEFAULT} characters — that number is POST_MAX_DEFAULT `
        + `in roommsg.ts, which is where a lane reads it, and MQTT_POST_MAX overrides it per lane — so `
        + `the refusal, not your memory, states the figure. If a post is refused for length, do not `
        + `shorten it and send it again: a refusal publishes nothing, and every attempt pastes the whole `
        + `draft back into your own window, so the cost grows with each try. No file, no post.`,
      parameters: Type.Object({
        message: Type.String({
          description: "text to publish; {me} expands to this session's room nick",
        }),
        to: Type.Optional(
          Type.String({
            description:
              `the recipient field: a nick (or a comma-separated list), e.g. ${LEAD_NICK}. This `
              + `field alone decides delivery — naming someone here is the only way to reach them, `
              + `and a mention typed into the message body is inert prose.`,
          }),
        ),
        steer: Type.Optional(
          Type.Boolean({
            description:
              "true = deliver as an interrupt: an addressee already working sees this at its next "
              + "tool-result boundary instead of after it finishes its whole run. Only a "
              + "lane-changing addendum justifies it. Honoured only from the lead and the owner "
              + "nicks (MQTT_STEER_NICKS adds more); from anyone else it queues as normal.",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        // ctx is USED here, not spare: the over-cap refusal below calls ctx.ui.notify.
        // Naming this param _ctx made that line a ReferenceError and swallowed the refusal.
        if (!client || !room)
          return {
            content: [
              { type: "text", text: offlineReason("chat_post") },
            ],
          };
        let text = expandMe(params.message, nick);
        // The addressee is a FIELD, and the visible "@<to> " prefix is a courtesy to the human
        // clients and to older receivers — it is NOT how delivery is decided any more (mention.ts).
        // A token quoted in the body therefore routes nothing while this field is set.
        const to = recipientField(params.to);
        if (to && !text.startsWith(`@${to}`)) text = `@${to} ${text}`;
        if (!text) {
          return {
            content: [
              {
                type: "text",
                text: "chat_post: refused — nothing left after trimming; the room wants one real line, not blank space (nothing was published)",
              },
            ],
          };
        }
        // measured before anything goes on the wire: a post over the cap is refused outright, so
        // the room never carries a worklog and the lane is told where that text belongs
        const fit = postLengthVerdict(text, nick, OWNER_NICK, POST_MAX);
        if (!fit.ok) {
          const note = postTooLongNote(fit.len, fit.max);
          ctx.ui.notify(`[tabichat] ${note}`, "warning");
          return { content: [{ type: "text", text: note }] };
        }
        const id = msgId(nick, ++msgSeq, BOOT);
        // the flag rides on the payload as one extra field, so a receiver that predates it keeps
        // working unchanged; when it is absent nothing new goes on the wire at all
        const asked = params.steer === true;
        const honoured = asked && STEER_NICKS.includes(nick);
        // roomPayload owns what goes on the wire, and it omits BOTH optional keys when they are
        // absent, so a post that names nobody and asks no steer is byte-identical to the old one.
        const topicUsed = publishRoom(roomPayload({ nick, message: text, id, ts: Date.now(), to, steer: asked }));
        // iid 21 AC1: the result a lane reads must mean "the broker took it", not "the call returned".
        // The wait is bounded by the same window the alarm already uses, so this adds no new knob and
        // no new state about delivery — it hands the existing answer to the one caller that was
        // invented without it.
        const delivery = await awaitDelivery(topicUsed, id);
        return {
          content: [
            {
              type: "text",
              // the echo names the FIELD that decides delivery, so a sender never reads the
              // rendered "@<to> " prefix as something the body could have done on its own
              text: `posted as ${nick} to ${room}: ${text} (id ${id}; recipient field ${to ? `"${to}"` : "unset — body text decides"})${steerNote({ requested: asked, honoured, allow: STEER_NICKS })} — ${deliveryClause(delivery, ACK_WATCH_MS)}`,
            },
          ],
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "chat_read",
      label: "Chat read",
      description:
        `Read the tabichat room. scope "room" (default) gives recent lines newest last, each `
        + `stamped [HH:MM:SS chat:<nick>]; pass unseen_only true to get ONLY the lines this `
        + `session has not been shown yet (the cursor advances, so a line is handed over once `
        + `and replayed history never reads as news). scope "inbox" lists the mentions THIS lane `
        + `actually received — each with its message id and arrival stamp, plus a per-sender tally. `
        + `Only a line that addresses you (@<your-nick> or @all) is ever injected into your context, so an `
        + `inbox that does not hold a message means it never arrived at this lane: before you say `
        + `anyone re-sent, ignored or lost anything, quote this scope. scope "acks" shows delivery receipts from `
        + `the control topic — proof a named lane RECEIVED a given message id, which is how you `
        + `tell "ignored" from "never arrived"; receipts are also retained per message id, so a lane that starts later still sees the ones that flew before it woke up, and id= (optionally <id>|<nick>) plus since_min= ask about one dispatch. scope "peers" lists the presence beats ` 
        + `THIS seat has heard per nick — online, stale (no beat lately, or a beat this clock cannot rank) ` 
        + `or offline (a beat said so) — with the age it measured by. It is not a process check and it is ` 
        + `not a census of the room: a seat that has heard no beat prints no row, and an absent row is not ` 
        + `a gone seat. Read-only: publishes nothing.`,
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({ description: "'room' (default), 'inbox', 'acks', 'peers', or 'outbox' (this session's own publishes, with their ids)" }),
        ),
        limit: Type.Optional(Type.Number({ description: "how many lines, default 10 (not used with unseen_only)" })),
        unseen_only: Type.Optional(Type.Boolean({ description: "true = only lines not yet shown to this session" })),
        id: Type.Optional(
          Type.String({
            description:
              "with scope=acks: the message id to look up, or <message id>|<nick> for one lane's receipt; "
              + "with scope=inbox: show only the mentions this lane received under that message id",
          }),
        ),
        since_min: Type.Optional(Type.Number({ description: "with scope=acks: only receipts newer than this many minutes" })),
      }),
      async execute(_id, params, _signal, _onUpdate, _ctx) {
        if (!room)
          return {
            content: [{ type: "text", text: offlineReason("chat_read") }],
          };
        const scope = String(params.scope ?? "room").toLowerCase();
        if (scope === "outbox") {
          // iid 21 AC2: the one read that answers "what has this session published, under which id", so a
          // lane never has to notice a loss by accident. The source is the session's own in-memory
          // out-tail — the same rows the journal append already builds — because the question this row
          // asks is about THIS session's publishes, and reading the journal file here would put a second
          // reader of the replay path in front of the boot-order pins that keep that path single. The
          // tail is bounded and this read says so, and names the journal for anyone who wants more: a
          // list of ten that does not say "ten is all this holds" is how a seat concludes it posted
          // nothing earlier.
          const tail = [...outTail];
          const want = Math.min(Math.max(Math.trunc(Number(params.limit ?? 10)) || 10, 1), tail.length || 1);
          const shown = tail.slice(-want);
          const lines = outboxView(shown, tail.length);
          const where = roomLogTarget && roomLogTarget.ok
            ? `this session's tail (keeps the last ${OUT_TAIL_MAX}); the durable record is the journal at ${roomLogTarget.path}`
            : `this session's tail (keeps the last ${OUT_TAIL_MAX}) — the journal is OFF on this seat, so nothing older than the tail was ever kept`;
          const head = shown.length
            ? `${shown.length} publish(es) listed, newest last — source: ${where}`
            : `this session has published nothing (${where})`;
          return {
            content: [{ type: "text", text: lines.length ? `${lines.join("\n")}\n${head}` : head }],
          };
        }
        if (scope === "peers") {
          // the board, not the bare rows: this scope is the one a seat acts on, so it travels with
          // the sentence naming what was measured
          return {
            content: [{ type: "text", text: renderPeersBoard([...peers.entries()], Date.now(), nick, room) }],
          };
        }
        if (scope === "acks") {
          const rows = queryAcks(acks, {
            id: params.id ? String(params.id) : undefined,
            sinceMin: typeof params.since_min === "number" ? params.since_min : undefined,
            limit: params.limit,
            cap: BUFFER_MAX,
          }).map(renderAck);
          // iid 22: the LOOKUP stays the lookup — a lane's own handle is still what it searched for —
          // but the answer now says WHICH NAMESPACE it searched in. An id no shipped minter builds used
          // to come back as "no delivery receipts for X", which a lane reads as a lost publish when the
          // truth is that no publish was ever in that namespace. Silence in one namespace must not read
          // as failure in another. A three-field id of the minter's own shape gains nothing: the note is
          // empty for it, so the ordinary echo and the ordinary receipt read exactly as they did.
          const askedId = params.id ? String(params.id) : "";
          const asked = askedId ? ` for ${askedId}${idNamespaceNote(askedId)}` : "";
          const none = `no delivery receipts${asked} in this lane's ${BUFFER_MAX}-receipt window; retained boards under ${controlTopic(room)}/ still hold older ones`;
          return {
            content: [{ type: "text", text: rows.length ? rows.join("\n") : none }],
          };
        }
        if (scope === "inbox") {
          // the one-call refutation of "I got that six times": what THIS lane was addressed, counted
          // from the wire, not from the lane's memory of the run
          const want = params.id ? String(params.id).trim() : "";
          const rows = want ? inbox.filter((r) => r.id === want) : inbox;
          const n = Math.min(Math.max(params.limit ?? 10, 1), BUFFER_MAX);
          const shown = rows.slice(-n).map(renderInbound);
          const tally = inboxTally(rows);
          // a line can be RECEIVED and still WAITING (option B): say so, because a lane that reads
          // its inbox must not conclude a held mention has already reached its own context.
          const waiting = rows.filter((r) => holdsId(held, r.id ?? "")).length;
          const waitingNote = waiting
            ? ` — ${waiting} of these ${held.length} are HELD for delivery after this run settles`
            : "";
          if (shown.length) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `${shown.join("\n")}\ninbox: ${rows.length} mention(s) received by ${nick}` +
                    `${want ? ` with id ${want}` : ""} since this lane started — ${tally}` +
                    `${rows.length > shown.length ? ` (${shown.length} shown)` : ""}` +
                    waitingNote +
                    " — this list, not your memory, is the record of what reached this lane",
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `inbox: this lane (${nick}) has received NO mention` +
                  `${want ? ` with id ${want}` : ""} since it started, out of ${buffer.length} room line(s) heard. ` +
                  `Only a line that addresses this lane is ever injected, so if it is not in this list it never ` +
                  `arrived here — say that plainly instead of accusing a sender.`,
              },
            ],
          };
        }
        if (params.unseen_only) {
          const got = takeUnseen(buffer, readCursor);
          readCursor = got.cursor;
          // hist lines are NEVER news: the replay block sets the cursor past them at boot, and a
          // board merged mid-run must not surface as unseen either (belt beside the cursor).
          const fresh = got.lines.filter((l) => !l.hist);
          return {
            content: [
              {
                type: "text",
                text: fresh.length
                  ? fresh.map(renderLine).join("\n")
                  : `no unseen room lines in ${room} (${readCursor} line(s) seen since start)`,
              },
            ],
          };
        }
        const want = params.limit ?? 10;
        const n = Math.min(Math.max(want, 1), BUFFER_MAX);
        const lines = buffer.slice(-n);
        // showing them here counts as having seen them, so a later unseen_only
        // read does not hand the same lines over twice — the boundary is the STAMP, not the position
        // (a saturated window shifts; an index would silently eat later lines forever)
        readCursor = lastSeq(buffer);
        return {
          content: [
            {
              type: "text",
              text: lines.length
                ? lines.map(renderLine).join("\n")
                : `no room lines heard yet in ${room}`,
            },
          ],
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "context_usage",
      label: "Context usage",
      description:
        `Report THIS session's context-window usage from pi's own estimate: tokens used, ` +
        `window size, percent, which model the window belongs to, and whether a fresh session is ` +
        `due (advisory threshold ${CTX_WARN}%` +
        (CTX_TOKENS > 0 ? `, or ${CTX_TOKENS} tokens absolute (lifted to part of a large declared window)` : ", no absolute tripwire set") +
        `). The window is a DECLARATION in pi's model config, not a measurement of the serving ` +
        `host — if the two disagree, the percentage is wrong, so quote the model and window with ` +
        `any usage claim. Publishes nothing — say it in the room with chat_post if the task calls ` +
        `for it. Returns "unknown" when the model declares no contextWindow or no response has ` +
        `been measured yet.`,
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return { content: [{ type: "text", text: ctxReport(ctx) }] };
      },
    }),
  );

  pi.registerFlag("tabichat", {
    description:
      "join the tabichat MQTT room (env: MQTT_NICK/MQTT_ROOM; the broker comes from the site config " +
      "key \"mqttUrl\" or MQTT_URL — REQUIRED, there is no shipped default)",
    type: "boolean",
  });
  pi.registerFlag("room", {
    description: "tabichat room name (overrides MQTT_ROOM; no built-in default)",
    type: "string",
  });
  // Layer 1 of auto-renew (laneadmin.ts documents all four). Absent is NOT false: an unset flag has
  // to fall through to the env and the site file, so the value is read as three states, not two.
  pi.registerFlag("auto-renew", {
    description:
      "renew this seat at the context floor once its handoff exists (overrides LANE_AUTO_RENEW and ~/.pi/agent/tabichat.json)",
    type: "boolean",
  });

  // --- broker location (SITE-AGNOSTIC by design) ------------------------------------------------
  // Site file `mqttUrl` → MQTT_URL env → REFUSE. No fourth step, because a fourth step would be a
  // guess and the whole point is that this repo does not know any venue's address. Resolved once
  // at setup beside the policy file it reads, exactly like the auto-renew layers above.
  const broker = resolveBrokerUrl({
    site: siteConfig[BROKER_URL_KEY],
    env: process.env[BROKER_URL_ENV],
    configPath: sitePath,
  });
  const brokerUrl = broker.ok ? broker.url : "";
  const brokerRefusal = broker.ok ? "" : broker.message;
  // The transport is decided HERE, once, from the RESOLVED url — not from a second read of
  // MQTT_URL. A decision made against an address this seat will not use is a decision about a
  // broker it will never reach, and it is exactly the drift a hard-coded default creates: the
  // answer is not a preference the socket may ignore. A `mqtts://` URL whose pinned CA cannot be
  // read is a REFUSAL to connect, not a plaintext session
  // (features/tabichat-mqtt-broker-auth.md phase 3, "no silent downgrade"), and the project rule
  // is that TLS verification is never traded for connectivity. An unconfigured broker resolves to
  // the empty string, which is not a scheme any client speaks, so it reads `refuse` here as well
  // as being refused by the broker layer itself — two loud doors, no third guess.
  //
  // The PEM reader is injected so the whole truth table runs headless (tools/test_tlsopts.ts).
  const TRANSPORT: TransportDecision = transportDecision(
    brokerUrl,
    process.env as Record<string, string | undefined>,
    makePemReader((path) => readFileSync(path, "utf8")),
  );
  // shape (B) write gate. READ is unconditional (dual-read), WRITE is not: a lane that writes
  // chat/<room>/msg/<nick> while the broker is still on the phase-1 ACL, or while any reader has
  // not migrated, goes silently invisible — the publish SUCCEEDS at the client. Default off.
  const SENDER_TOPIC = senderTopicEnabled(process.env as Record<string, string | undefined>);
  /**
   * The honest reason this seat has no room: NO BROKER, or no room named — never both blamed at
   * once. A lane that gets "start pi with --room" when the actual fault is an unconfigured broker
   * is being sent to fix the wrong door, so the refusal above is repeated verbatim here instead of
   * paraphrased into something else. Same words, one source.
   */
  const offlineReason = (who: string) =>
    brokerRefusal !== ""
      ? `${who}: ${brokerRefusal}`
      : `${who}: not in a room — start pi with --tabichat --room <name>`;

  // The four layers are resolved at session_start, NOT here: pi flag values are not readable from
  // the factory (its own session_start handler says so in a shipped comment), so resolving the flag
  // at setup would silently drop layer 1 and every `--auto-renew` launch would read as "off" — the
  // exact class of bug where a correct file is dead code because the wiring line never ran.
  let autoRenewArmed = false;
  let autoRenewSource = "default off";
  // The precedence itself lives in laneadmin.ts:resolveAutoRenewLayered — one implementation, both
  // truth-table halves tested there. A local copy here would be a second policy that can drift.
  // one per boot, hard: a seat that wakes and immediately sits back over the floor must not renew
  // forever. Only a new process clears it — and PROCESS is now the literal word (tabichat#3).
  // The old closure `let autoRenewedThisBoot` reset on every replacement, because the factory body
  // RE-RUNS then (one renew, three BOOT tags, one process); a forked seat therefore
  // held a FRESH cap per fork and could renew once per copy. Both stores below live on globalThis
  // (keys declared above the factory), so the cap and the in-flight latch are true facts about the
  // PROCESS, not about whichever session is newest.
  const RENEW_INFLIGHT = ((globalThis as Record<PropertyKey, unknown>)[RENEW_INFLIGHT_KEY] ??=
    new Map<string, number>()) as Map<string, number>;
  const AUTO_RENEWED = ((globalThis as Record<PropertyKey, unknown>)[AUTO_RENEWED_KEY] ??=
    new Set<string>()) as Set<string>;
  // tabichat#5 — the control-line ledger. PROCESS-scoped for the same reason #3 made the renew
  // stores process-scoped: the factory body re-runs on every session replacement, so a closure Map
  // would be EMPTY in exactly the renewed seat that needs the answer — and AC4 of this row is about
  // an order resurrected across a replacement. Keyed by CHANNEL (the subject of the order), never by
  // author: a hold from the lead and a lift from the owner must order against each other.
  const CTL_LEDGER = ((globalThis as Record<PropertyKey, unknown>)[CTL_LEDGER_KEY] ??=
    new Map<string, CtlEntry>()) as Map<string, CtlEntry>;
  // tabichat#4 — lines the belt caught before they were ever handed to pi. Process-scoped for the same
  // reason as the two stores above: the session that PARKS the line is not the session that must
  // deliver it, and a closure array would die with the runner that was replaced.
  const INBOUND_PARK = ((globalThis as Record<PropertyKey, unknown>)[INBOUND_PARK_KEY] ??=
    [] as Array<{ topic: string; payload: string; nick: string; ts: number }>) as Array<{
    topic: string;
    payload: string;
    nick: string;
    ts: number;
  }>;

  // iid 20 — the socket handle, process-scoped for the same reason as the four stores above: the
  // factory body RE-RUNS on a session replacement, so a closure binding is per-RUN and the run that
  // comes next cannot reach what this run left connected. Measured on one unchanged seat:
  // four established sockets and four live `message` handlers in one pi process, so every room line
  // was handled four times. `client` below is this run's view of that ONE holder, which is what lets
  // the incoming run close its predecessor's socket instead of racing a shutdown handler for it.
  const MQTT_CLIENT = ((globalThis as Record<PropertyKey, unknown>)[MQTT_CLIENT_KEY] ??=
    { current: null as mqtt.MqttClient | null }) as { current: mqtt.MqttClient | null };
  let client: mqtt.MqttClient | null = MQTT_CLIENT.current;
  // #585: the socket belongs to the PROCESS, the context belongs to the SESSION. `/renew` and
  // `/reload` replace the session inside this same process, so a callback that kept the ctx it
  // was registered with reads a dead session, the throw has no catch, and pi exits on
  // uncaughtException. The ctx is therefore held in a handle refreshed on EVERY session_start
  // (see the first line of that handler), and the socket's callbacks read it through liveCtx()
  // — so the prior-client teardown below closes the socket and never the context.
  //
  // CORRECTED BY MEASUREMENT — "EVERY session_start" was the wrong half. A session
  // REPLACED by newSession() does NOT re-fire session_start in this process, so the handle kept the
  // dead ctx and a seat died on the very next inbound line (assertActive → uncaughtException → pi
  // exits). The live context is handed to the `withSession` callback of newSession/fork/
  // switchSession (types.d.ts:292-335), and the /renew handler re-arms there. Two belts now: that
  // re-arm, and a try/catch around the inbound handler so a context mistake can never be a crash.
  let currentCtx: ExtensionContext | null = null;
  // Same non-null idiom this file already uses for the socket (`client!`): the callbacks below
  // are registered inside session_start, always after the handle is set, so there is no path
  // where a socket event arrives with no context. Null here would be a wiring bug, not a race.
  const liveCtx = (): ExtensionContext => currentCtx!;
  /**
   * tabichat#19 — the park drain, one function with two callers: socket `connect`, and the renew
   * re-arm. The socket belongs to the process and a replaced session does not reconnect it, so the
   * old single caller could leave a full park sitting there for the life of the seat — which is why
   * iid 4's replay path was never OBSERVED landing in a fresh seat.
   *
   * Assigned inside `session_start` (it calls `handleInbound`, which lives in that scope) and read
   * through this factory-scoped handle, exactly like `liveCtx` reads the context.
   */
  let drainPark: ((why: string) => number) | null = null;
  /**
   * tabichat#19 — the SEND handle, and why the ctx handle alone was never enough.
   *
   * The inbound path hands lines to pi through `pi.sendUserMessage`. In pi 1.4.0 that method is
   * guarded by an `assertActive()` that reads the staleness flag on the SHARED extension runtime
   * (loader.js:309-311 -> runtime.assertActive at :115), and that flag is set by
   * `AgentSession.dispose()` -> `runner.invalidate()` -> `runtime.invalidate()` (loader.js:145-150)
   * and is never cleared: the replacement session's runner is built over the SAME runtime object
   * (`new ExtensionRunner(extensions, extensionsResult.runtime, ...)`, agent-session.js:2983). So
   * from the first replacement onward in a process every hand-off throws, for the life of the
   * seat. The `liveCtx()` handle covers the CONTEXT (the new runner is fresh); it cannot cover the
   * `pi` API object, which closes over the shared runtime. Measured: 1255 throws across all 8 lanes
   * with 0 `withSession did not fire` warnings — the re-arm ran, and the send still threw.
   *
   * The fix is the same shape as the ctx handle: a handle re-armed in `withSession`, pointing at
   * the REPLACEMENT SESSION's own `sendUserMessage` (types.d.ts:334, `ReplacedSessionContext`),
   * which is bound to the live session and reads nothing stale. Before any replacement the load-time
   * API is correct, so that stays the initial value.
   */
  type SendUser = (
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ) => Promise<void>;
  let sendUser: SendUser = (content, options) => pi.sendUserMessage(content, options);
  /**
   * The session's binding of `emitNotice`: the two halves, wired to this file's real surfaces. The
   * durable half is `diag`, which is also the channel that tells the operator ONCE that diagnostics
   * are being DROPPED (`diagFaultTold`) — so an `error` line whose record write fails now says so,
   * where before the mirror in `notifySafely` wrote to the sink directly and stayed quiet about it.
   * That is the failure case only: when the write succeeds, what is printed is what was always printed.
   *
   * `record-only` is the arm nineteen-… the shape this leg found: sixteen hand-written records and two
   * hand-paired bypasses used to decide durability for themselves. They now say which ARM they are on
   * and nothing else, so the answer cannot differ site from site. What any of them prints, where it
   * prints it, and whether it reaches the UI are unchanged — promotion of an internal fault to the
   * line is a decision of its own (report piece 5), not a side effect of a refactor.
   */
  const notice = (
    arm: NoticeArm,
    text: string,
    o: { ctx?: ExtensionContext | null; level?: string; stack?: string } = {},
  ): void =>
    emitNotice(arm, text, {
      record: (t, st) => diag("ERROR", t, st),
      present: (t, l) => {
        (o.ctx ?? liveCtx()).ui.notify(t, l);
      },
    }, o.level, o.stack);

  /**
   * A record-only fault that also OWES THE SEAT a tell: recorded first (the durable half never
   * depends on the tell), then queued for the next model-facing send. One tell per kind per session,
   * so a recurring fault is never a recurring interruption.
   */
  const noticeLost = (kind: LossKind, text: string, o: { stack?: string } = {}): void => {
    notice("record-only", text, o);
    lossTeller.tell(kind, text);
  };

  /**
   * Notify WITHOUT ever being a crash vector.
   *
   * `liveCtx()` hands back the session's context, and after a renew or a reload that context is
   * disposed: touching it throws `assertActive`, and a throw inside an MQTT socket callback escapes
   * through the emitter as an uncaughtException and ends the seat. That is the #585 family, and the
   * reason this file's own belts exist. So any transport line I print from a SOCKET callback goes
   * through here, because a security notice that kills the lane it is warning is worth nothing.
   *
   * WHAT ACTUALLY REACHES WHOM. The sentence here used to read "the message always reaches stderr,
   * where a stale context cannot take it away", and that became false: the operator gets one
   * line on the UI when the UI is reachable, and stderr carries it ONLY when it is not — the `catch`
   * in `emitNotice` decides that, and it is a fallback, never a second publish. The history of the
   * duplicate is worth keeping where it was made: this line used to go to the UI AND to
   * `console.error` on every call, which is how routine internal events ended up printed in the
   * operator's input area — an unacceptable face for a routine event. The instinct behind it — never
   * lose a warning — was sound, but "never lose it" is a FALLBACK rule, not a
   * double-publish rule. An `error` line is additionally kept in the durable diagnostic file BEFORE
   * the UI is touched, so a seat with a dead UI still leaves a greppable record behind. A `warning` or
   * `info` line does neither: shown, not kept, and never echoed to the terminal.
   */
  const notifySafely = (ctx: ExtensionContext | null, text: string, level = "warning"): void =>
    notice(level === "error" ? "record-and-present" : "present-only", text, { ctx, level });

  // every room line we have heard, newest last — the agent's only view of the room
  const buffer: RoomLine[] = [];
  // the mentions this lane actually received (@nick or @all), newest last. This is the answer to
  // "did that message arrive / how many times did it arrive", which a lane otherwise asserts from
  // memory — and a fresh lane once asserted six re-dispatches that never reached the wire.
  const inbox: RoomLine[] = [];
  // mentions received while the lane was BUSY, held here instead of stacking as one visible pi
  // queue block each (mentionq.ts). Drained oldest-first at `agent_settled`.
  const held: HeldMention[] = [];
  // the lane's RUN STATE, and the thing option B actually gates on. True between `agent_start` and
  // `agent_settled` — pi emits the settle from the run's `finally`, so the two are paired — and
  // cross-checked with `ctx.isIdle()` at the decision, so a missed event can only ever fall back to
  // the shipped per-mention queue, never stall a held line (see mentionq.ts).
  let runActive = false;
  // one-shot, and it expires in the run that set it: the flush's own `agent_end` is suppressed once
  // when that turn OWES a notice, and a zero-owed `agent_end` spends the flag instead of leaving it
  // armed (see the guard in the `agent_end` handler below). A flag that survived a notice-free turn
  // would silence a later turn that had nothing to do with this flush.
  let flushedThisRun = false;
  const heldCount = (): number => held.length;
  // delivery receipts heard on the control topic (P2): who got what, and when
  const acks: Ack[] = [];
  // who we believe is in the room, per-nick presence record, from beats + LWTs (P5)
  const peers = new Map<string, PeerSeen>();
  // forced-handoff state: fires once per crossing, lifts when the file exists, and gives
  // up loudly rather than hanging a lane
  let forced = false;
  let gaveUp = false;
  let blockRefusals = 0;
  let resumeFile = "";
  let resumeDirLive = RESUME_DIR;
  // how far chat_read has already shown the buffer (P3: unseen-since-cursor)
  let readCursor = 0;
  // The moment THIS factory run started, in ms — i.e. PER SESSION RUN, not per process: the factory
  // body re-runs on every replacement and re-mints this const along with BOOT (tabichat#3). The
  // wording here used to claim "THIS process", which a BOOT face-change contradicted; corrected
  // forward, digits unchanged. What the
  // floor really is: the start of the run that OWNS this closure. That is exactly right twice over —
  // the auto-renew gate refuses a handoff older than its own run (a prior session cannot arm a
  // later one, the deliberate law), and the wake callback closes over the RENEWING run's value, so
  // `fallbackPick: () => resumePickAt(BOOT_AT_MS)` admits a handoff written during the session that
  // asked to be replaced, which is what the wake pointer must believe. Pinned by test_laneadmin.
  const BOOT_AT_MS = Date.now();
  // outbound message sequence, for per-message ids (P2)
  let msgSeq = 0;
  // this lane's boot tag (roommsg.ts:msgId): the sequence restarts at 0 every session, so
  // without it a restarted lane mints ids its previous session already used — and the
  // receipt board keys on the id, so receipts from two sessions land on one entry.
  const BOOT = bootTag();
  // presence beat handle (P5)
  let hb: ReturnType<typeof setInterval> | null = null;
  // tabichat#10 — the ack-watch sweep handle, same lifecycle as `hb` (started on connect, cleared on
  // shutdown), because a watch with no sweeper is a list that only ever shrinks on success.
  let ackSweep: ReturnType<typeof setInterval> | null = null;
  // how often we restate our presence; a peer that misses three beats reads stale
  const HB_MS = (() => {
    const n = Number.parseInt(process.env.MQTT_HB_MS ?? "", 10);
    return Number.isFinite(n) && n >= 5_000 ? n : HEARTBEAT_MS_DEFAULT;
  })();

  /**
   * Publish to the room (what people read).
   *
   * The flat topic is the shipped path and stays the default. `MQTT_SENDER_TOPIC=1` moves the WRITE
   * to the per-sender leaf `chat/<room>/msg/<nick>`, which is what the phase-2 broker ACL makes
   * authoritative (tlsopts.ts:senderTopicEnabled says why the write is gated and the read is not).
   * A refusal to build the topic — a nick with nothing topic-leaf-safe in it — falls back to the
   * flat topic AND SAYS SO: publishing to `chat/<room>/msg/` would land a line nobody ever reads.
   */
  /**
   * #10 — register one publish with the ack watchdog. ONE function, because the rule that makes it
   * correct is the same at every site: a publish handed to a socket that is NOT connected is QUEUED
   * by mqtt.js and is not a refusal, so watching it would raise a false alarm; and a publish to a
   * connected socket is only confirmed when it comes back on our own subscription. Overflow is
   * said, never trimmed in silence. Returns nothing; it is a note to the sweeper, not a decision.
   *
   * iid 21 finding 1 — `id` is the publish's own message id, and it is what the watch is keyed on.
   * A room line goes to `chat/<room>`, the topic EVERY lane shares, so a topic-only watch can be
   * settled by anybody's inbound; the id is the one field that says which publish came back.
   */
  const watchSend = (topic: string, kind: string, id = "") => {
    if (!ACK_WATCH_MS || !client || !client.connected || !topic) return;
    const key = ackWatchKey({ topic, id });
    // a fresh attempt clears its own stale verdict, so a re-post is judged on its own echo
    lostKeys.delete(key);
    const w = watchAck(ackWatch, topic, kind, Date.now(), id);
    ackWatch = w.pending;
    // finding 2: the cap dropped OLDER publishes that were never echoed. They left `ackWatch` with no
    // record, and an absent watch was the face the waiting publish read as delivered — the opposite
    // of the sentence printed three lines below. Record each one, so both channels answer alike.
    for (const x of w.evicted) noteLost(ackWatchKey(x));
    if (w.dropped) {
      notifySafely(
        null,
        `[tabichat][ack-watch] ${w.dropped} older publish${w.dropped > 1 ? "es were" : " was"} dropped ` +
          `from the watch list (cap ${ACK_WATCH_MAX}) — their delivery is UNCONFIRMED, not proven missing`,
        "warning",
      );
    }
  };
  /** What the alarm calls a room line, so the operator can tie a loss to a post they just made. */
  const ROOM_SEND_KIND = "room line";
  /**
   * The ONE tail every room publish runs once its bytes reached the socket: the turn's publish
   * counter, this seat's own journal, and — only with the flag — the retained tail board.
   *
   * It is a named function at this scope rather than a local inside `publishRoom` because the
   * pre-renew lead hold CANNOT go through `publishRoom`: that function publishes fire-and-forget,
   * and `session_shutdown` closes the socket about a second after each publish, so an unawaited
   * hold races the very session change it exists to announce. A room line that reaches every peer
   * and never reaches its author's journal leaves the author unable to answer "did I send that?" —
   * so BOTH paths call this one tail, and the awaited path calls it only AFTER the publish
   * callback succeeded (a write the socket refused is neither counted nor kept).
   */
  const roomSendTail = (payload: Record<string, unknown>): void => {
    if (!client || !room) return;
    // iid 29 — the ONE room-publish counter, on the one tail every room publish calls. A room
    // write that got this far went to the socket, so this is the fact the end-of-turn notice needs.
    publishedThisTurn++;
    journalAppend("out", {
      id: typeof payload.id === "string" ? payload.id : "",
      nick: typeof payload.nick === "string" ? payload.nick : nick,
      to: typeof payload.to === "string" ? payload.to : undefined,
      ts: typeof payload.ts === "number" ? payload.ts : Date.now(),
      message: typeof payload.message === "string" ? payload.message : String(payload.message ?? ""),
    });
    // A2, flag-gated and DEFAULT OFF: the retained per-lane tail board. On the phase-1 ACL a write
    // to `hist/<leaf>` is a QoS 0 publish the broker refuses WITHOUT any error, so this stays dark
    // until the generated ACL grants it (docs/broker/README.md cutover table).
    if (!HIST_BOARD) return;
    const ht = histTopic(room, nick);
    if (!ht) {
      notice("record-only", `[tabichat][hist] MQTT_HIST_BOARD=1 but nick "${nick}" has no topic-leaf-safe form; the ` +
          `tail board was NOT published — an empty leaf aims at a trailing-separator topic nobody reads.`);
      return;
    }
    client!.publish(
      ht,
      JSON.stringify(
        histBoardPayload({
          nick,
          leaf: topicLeaf(nick),
          journalPath: roomLogTarget && roomLogTarget.ok ? roomLogTarget.path : "",
          outLines: outTail,
        }),
      ),
      { retain: true },
    );
  };
  const publishRoom = (payload: Record<string, unknown>): string => {
    if (!client || !room) return "";
    // iid 21 finding 1 — the id THIS payload carries is what its own echo will carry back, so it is
    // the key the watch is registered under. Read from the payload rather than passed in, because
    // every room publish already mints its id here (`msgId(nick, ++msgSeq, BOOT)`), and a second
    // id-space would be a second answer to the same question.
    const sendId = typeof payload.id === "string" ? payload.id : "";
    // ONE tail for both publish branches, shared with the awaited hold. The zero-arg local name
    // stays because `tools/test_roommsg.ts` pins this arm's shape — watch on the topic it ACTUALLY
    // used, then the tail, then the return — and the body lives in `roomSendTail` alone.
    const afterRoomSend = () => roomSendTail(payload);
    if (SENDER_TOPIC) {
      const t = msgTopic(room, nick);
      if (!t) {
        // FILE, not the terminal: this is true of EVERY publish once the setting is wrong, so printing
        // it at the operator is the flood this leg exists to end. The fault itself is real (the
        // per-sender ACL silently does not apply) — see the report's follow-on note.
        noticeLost("sender-acl-inert", `[tabichat] ${SENDER_TOPIC_ENV}=1 but nick "${nick}" has no topic-leaf-safe form; ` +
            `posted to the flat room topic instead, so the per-sender ACL does NOT apply to this line.`);
      } else {
        client.publish(t, JSON.stringify(payload));
        watchSend(t, ROOM_SEND_KIND, sendId);
        afterRoomSend();
        // iid 21: the topic ACTUALLY used is returned, because that is the topic the echo lands on.
        return t;
      }
    }
    client.publish(`chat/${room}`, JSON.stringify(payload));
    // #10: the flat write is the one that disappears at the cutover. `docs/tls-operations.md` says
    // a phase-2 ACL applied before clients migrate makes every seat "publish into a void and report
    // no error" — this is that report. Nothing else on the client side can see it: the publish call
    // succeeds, the socket stays open, the broker says nothing.
    // iid 21 finding 1: the flat topic is shared, so the watch carries the publish's own id.
    watchSend(`chat/${room}`, ROOM_SEND_KIND, sendId);
    afterRoomSend();
    return `chat/${room}`;
  };
  /** Publish to the control topic — machinery, never shown as chat. */
  const publishCtl = (payload: unknown) => {
    if (!room || !client) return;
    client.publish(controlTopic(room), JSON.stringify(payload));
    // #10: the lane-admin REQUEST rides here, so a refused write means a renew that will never be
    // adjudicated and the requester sits out its whole window. The bare topic is granted by BOTH ACL
    // phases today, which is why this is belt-and-braces rather than the fix — but "granted today"
    // is exactly the kind of fact an ACL edit can void without anyone's suite going red.
    watchSend(controlTopic(room), "control request");
  };
  /**
   * Pin a receipt to its own retained board, one topic per message id (P6). The
   * flat publish above only reaches whoever is connected at that moment; MQTT
   * replays the retained copy to anyone who subscribes later, so a restarted lane
   * can still answer "did that recipient acknowledge message <id>?".
   */
  const publishCtlRetained = (id: string, payload: unknown) => {
    if (!room) return;
    // shape (ii): `_ctl/<acknowledging-nick>/<message-id>`. `nick` is THIS lane, always — the whole
    // point is that a receipt is written under the writer, so a peer cannot pin one for somebody
    // else. Read from the payload's `by` instead and a forged ack would land on your own board.
    const t = ackTopic(room, nick, id);
    if (!t) return; // id unusable as a topic leaf; the flat receipt still went out
    if (!client) return; // nothing was sent at all; an alarm here would blame the ACL for a closed socket
    client.publish(t, JSON.stringify(payload), {
      retain: true,
      // The broker-side half of the window: a receipt whose own lane is gone has no sweep left to
      // clear it, so the leaf carries the expiry the site already asked for (`expiryIntervalSeconds`).
      properties: { messageExpiryInterval: ACK_EXPIRY_S },
    });
    // #10: `publish()` resolving is NOT delivery. A QoS 0 write the ACL refuses disappears with no
    // error event, no close and no broker-log line (measured on the loopback fixture at both
    // phases), so the only client-side signal is our own subscription getting it back.
    watchSend(t, "delivery receipt");
    // #10's other half, and it only exists because of shape (ii): N lanes now occupy N topics where
    // they used to overwrite one, so a receipt we pinned must be un-pinned or the board grows for as
    // long as the broker keeps state. Tracked here, cleared by sweepAckWatch on the same timer.
    // UNCONDITIONAL, deliberately: the pin is what makes a receipt clearable, so a lane that skipped
    // pinning for some knob value could never clear and would leak exactly the way AC3 forbids.
    {
      const p = pinAck(pinnedAcks, t, Date.now());
      pinnedAcks = p.pinned;
      if (p.dropped) {
        notifySafely(null, `[tabichat][ack-board] ${p.dropped} of my own retained receipts passed the ${ACK_RETAIN_MAX}-entry watch cap and will be cleared at the next sweep`, "warning");
      }
    }
  };
  /**
   * tabichat#10 — name every control-child publish the broker took and never gave back. Runs on a
   * timer, not on a callback, because the failure has no callback: an ACL-refused QoS 0 write is
   * silent by protocol (`docs/tls-operations.md:148`), so waiting for an error is waiting for
   * something that never comes. ONE line per sweep, on both channels that survive scrollback — the
   * notify for the operator at the keyboard, stderr for the audit after the fact — and the watch
   * entries are REMOVED as they are reported, so a swallowed receipt alarms once and not every tick.
   */
  const clearMyReceipts = () => {
    // NO `!ACK_RETAIN_MS` guard here — that early return was a real defect found on this leg: window 0
    // is documented as "no board" and `receiptClears(..., 0)` correctly returns every entry as due, so
    // the guard turned the one value that means "clear it" into "keep it forever".
    if (!pinnedAcks.length || !client?.connected) return;
    const { keep, clear } = receiptClears(pinnedAcks, Date.now(), ACK_RETAIN_MS);
    if (!clear.length) return;
    pinnedAcks = keep;
    // MQTT's clear is an EMPTY retained payload on that exact topic — not a tombstone object, which
    // would keep the entry alive with different bytes. Only my own leaves are in this list, which is
    // the grant doing its job: I cannot clear a peer's receipt and neither can they clear mine.
    for (const x of clear) client.publish(x.topic, clearPayload(), { retain: true });
    // NO OPERATOR LINE. This sweep is an hourly timer clearing THIS seat's own expired receipts — it needs
    // nothing from anyone, its effect is observable on the board itself, and announcing it into the UI (and
    // previously into stderr too) is exactly the noise an hourly timer must not make.
    // The two lines that DO carry consequences stay: the watch-cap note above (`passed the ${ACK_RETAIN_MAX}-entry
    // watch cap`) and the ack-watch loss below (`[tabichat][ack-watch]`, an error). Silence here is not a lost alarm.
  };
  const sweepAckWatch = () => {
    clearMyReceipts();
    if (!ACK_WATCH_MS || !ackWatch.length) return;
    // THE RECONNECT RULE, and it is the difference between an alarm and noise: while the socket is
    // down mqtt.js QUEUES publishes to send on resubscribe, so a watch that ages out mid-reconnect
    // reports a refusal that never happened. Ageing is therefore paused, not reset — the moment the
    // socket returns the window resumes, and a genuinely refused write still surfaces one window later.
    if (!client || !client.connected) return;
    const { live, lost } = expireAcks(ackWatch, Date.now(), ACK_WATCH_MS);
    ackWatch = live;
    // iid 21: write down what aged out, so the waiting publish can tell a recorded miss from a
    // delivered one. The notify below stays exactly as it was — it is the bystanding seat's channel,
    // and the defect was that the PUBLISHING seat had no channel of its own, not that this one existed.
    for (const x of lost) noteLost(ackWatchKey(x));
    if (!lost.length) return;
    notifySafely(null, `[tabichat][ack-watch] ${ackLostLine(lost, Date.now())}`, "error");
  };

  /** Restate our presence so the room can tell live from quiet (P5). */
  const beat = () => {
    if (!client || !room) return;
    client.publish(
      presenceTopic(room, nick),
      JSON.stringify({ nick, status: "online", ts: Date.now() }),
      { retain: true },
    );
  };
  const upsertPeer = (who?: string, status?: string, ts?: number) => {
    if (!who) return;
    // an unstamped record from the older shared presence topic must not mark a
    // live peer gone the moment the broker replays it to us (P5)
    const incoming: PeerSeen = {
      status: status === "offline" ? "offline" : "online",
      ts: typeof ts === "number" ? ts : 0,
    };
    if (!peerRecordWins(peers.get(who), incoming)) return;
    peers.set(who, incoming);
  };
  // ids already taken into the buffer: one message must read as ONE line however
  // many times it arrives - stacked handlers, retained replay, or a redelivery after a reconnect
  let seenRoomIds: string[] = [];
  // the SAME ledger for lane-admin requests (tabichat#3): one request id is one dispatch, however
  // many copies the broker delivers or a reconnect redelivers. Room lines had this;
  // control lines did not, and the missing half was the fork. A request with NO id (an older
  // client) can never be a repeat, so it is never deduped — noteRoomId says that, and says it
  // already at both halves.
  let seenAdminIds: string[] = [];
  // set when a mention was injected into this lane: its turn owes no room post,
  // and the lane is told that once the turn ends (P1)
  let owedTurns = 0;
  /**
   * iid 29 — how many room publishes THIS TURN handed bytes to the socket. `owedTurns` alone could
   * not say whether the seat spoke: it is written by the inbound arm and cleared by the notice, and
   * no publish path ever touched it, so "nothing was published" was a sentence the file never
   * measured. Bumped at `publishRoom`'s own tail (both branches), reset at `agent_start` so a
   * between-turn advisory cannot spend a later turn's silence. Counting it does not quiet the
   * notice on any path where the seat really did stay in the terminal.
   */
  let publishedThisTurn = 0;

  pi.on("session_start", async (_event, ctx) => {
    // #585 FIRST ACT, before every guard below: the handle is refreshed on every session start that
    // DOES fire, so a restart of the lane hands the live context to the callbacks the socket already
    // holds. What this line does NOT cover (and the reason /renew has its own
    // re-arm): a session replaced by newSession() inside this same process never re-fires here.
    currentCtx = ctx;
    // defensive reset: a restart inside the same process is not mid-run, whatever the last session
    // left behind. Before the flag guard, so it happens on every session_start.
    runActive = false;
    // flag values are only readable from session_start (not the factory)
    if (pi.getFlag("tabichat") !== true) return;
    // A person loses track of which seat is which nick. Stamp this
    // lane's own room nick in the footer (key sorts between "fs-gate" and "upstream"), set
    // before the client guard so a session restart inside the same process re-labels it.
    ctx.ui.setStatus("nick", `@${nick}`);
    // Auto-renew policy, resolved per session (see the layer comment at setup for why it is here and
    // not at the factory). Stated once, with the layer that answered, because a seat that renews
    // itself must be explainable: "who turned this on" is the first question a surprised owner asks.
    {
      const r = resolveAutoRenewLayered({
        flag: pi.getFlag(AUTO_RENEW_FLAG),
        env: process.env[AUTO_RENEW_ENV],
        site: siteConfig.autoRenew,
      });
      autoRenewArmed = r.armed;
      autoRenewSource = r.source;
      if (siteConfigNote !== "")
        ctx.ui.notify(
          `[tabichat][renew] site config ${sitePath} was NOT read (${siteConfigNote}) — policy is falling back to ` +
            `the flag/env layers only. Fix the file; a silently ignored policy file is how a box stops agreeing with itself.`,
          "warning",
        );
      // TWO CHANNELS, deliberately, because a scratch-lane run showed that pi's
      // "info"-level notify is TRANSIENT (a toast that clears), so the policy line I printed first
      // never reached the owner's reading of the screen while the warning-level ctx advisory beside
      // it stayed in scrollback. A setting that decides whether a seat destroys its own session must
      // be visible after the fact, so: a persistent status entry (survives redraw), and the notify at
      // "warning" (survives scrollback). OFF prints nothing — silence is the correct face for the
      // default, and thirteen seats printing "auto-renew off" is noise the recipient-field law exists
      // to prevent.
      // THE STATUS LINE reads `tabichat 🍄`, not `auto-renew ON`. THE NOTIFY KEEPS ITS WORDS. It is the
      // only printed answer to "why is this seat allowed to end its own session" — it names the CONFIG
      // LAYER that armed the policy and the threshold — and the status-only reading is what is shipped
      // while the question "both surfaces?" is outstanding. Restoring text here is a provenance
      // decision, not a revert: if both is chosen, the layer + threshold need a new home.
      // This is the FIRST emoji in a shipped UI string in this repo (`git grep -lP '[\x{1F300}-\x{1FAFF}]'`
      // → 0 files at `c51ec6d`), so its rendering is asserted by a human seat, not by this suite.
      // THE KEY IS THE POSITION, so the key is part of the wording decision. pi sorts the footer's
      // status line by KEY (`a.localeCompare(b)`, `dist/modes/interactive/components/footer.js:256` at
      // 1.4.0) and prints only the TEXT, so a badge's place on that line is decided by a string nobody
      // sees. The old key `renew` sorted AFTER the `ponytail` plugin's key, which parked the mushroom near
      // the far right — the exact end of the line that `truncateToWidth` (`:260`) cuts FIRST on a narrow
      // terminal. `nick-tabichat` sorts immediately AFTER `nick`, so the seat reads `@<nick> tabichat 🍄
      // … ponytail …`. It is asserted by a cell in
      // tools/test_laneadmin.ts that runs THE SAME comparator over the REAL key set, not by this comment.
      // Do not "tidy" this key back to `renew`: it is not a name clash, it is a sort slot. This comment
      // sits ABOVE the `if` on purpose — the `OFF prints nothing` cell reads that block within a bounded
      // window, and burying this note inside it would silently break a check that is not about it.
      if (autoRenewArmed) {
        ctx.ui.setStatus("nick-tabichat", "🍄 tabichat");
        ctx.ui.notify(
          `[tabichat][renew] auto-renew ON for this seat (from ${autoRenewSource}): at or over ${CTX_FORCE}% with a ` +
            `handoff on disk it dispatches ${RENEW_COMMAND} once per boot, and the fresh seat is told its handoff path`,
          "warning",
        );
      }
      // ORDER: glyph first, then the word. THE KEY IS UNCHANGED (`nick-tabichat`), so the sort slot
      // and its neighbours are untouched; only the printed text moved. Re-paired in
      // tools/test_laneadmin.ts rather than weakened: those cells still require exactly ONE mushroom in
      // the shipped bytes and
      // still require the persistent footer status to exist. NOTE WHERE THIS COMMENT SITS: below the
      // `if`, on purpose — the `OFF prints nothing` cell reads the block ABOVE within a bounded window,
      // and prose placed inside that block breaks the cell.
    }
    // A seat says at START, on the two channels that survive scrollback, where its
    // handoffs will go and whether that place is durable. The status line is the one a person can read
    // after the fact; stderr is the one a later audit can grep. Before this, the whole question was
    // invisible: a lane wrote its handoff into tmpfs on a box whose configured dir could not be created,
    // and nothing anywhere said that the notes would not outlive the boot.
    {
      const durable = RESUME_RES.ok && RESUME_DIR !== RESUME_SCRATCH;
      // THE DIAGNOSTIC FILE'S OWN DESTINATION IS SAID ONCE, AT STARTUP. A refused path means every
      // diagnostic this seat produces is going nowhere, and silence about that is the deaf-seat class
      // this repo has been burned by; a deliberate `off` is an ANSWER and prints nothing. It is here
      // rather than inside the broker-refusal block because a seat that DID connect still needs to be
      // told its log is broken.
      if (!DIAG.target.ok && !DIAG.target.deliberate)
        ctx.ui.notify(`[tabichat][diag] ${DIAG.target.reason}`, "warning");
      // THE FOOTER ENTRY IS GONE: a status line has no business printing a filesystem path.
      // What REMAINS is the loud half, and it is the
      // half that matters: a refusal still goes to stderr (greppable by a later audit) AND to a session-start
      // notify, and a non-durable dir still goes to stderr. The footer only ever displayed a path that is
      // already in the launcher env and in every lane's own RESUME filename; the durable-vs-tmpfs fact is
      // reported where an audit can find it, not pasted on the operator's status line.
      if (!RESUME_RES.ok) {
        // TWO surfaces, one of them printed: the file keeps the reason for a later audit, the notify is
        // the startup fault the operator still has to see (spec: a startup refusal stays at the UI).
        diag("WARN", `[tabichat][ctx] ${RESUME_RES.reason}`);
        ctx.ui.notify(`[tabichat][ctx] ${fallbackNote(RESUME_SCRATCH)}`, "warning");
      } else if (!durable) {
        // Consequence-bearing, so it stays operator-visible — on the NOTIFY surface plus the file,
        // not as raw text in the input area, which is the point of keeping it off that surface.
        const nonDurableNote = `[tabichat][ctx] ${fallbackNote(RESUME_DIR)}`;
        diag("WARN", nonDurableNote);
        ctx.ui.notify(nonDurableNote, "warning");
      }
    }
    // NO BROKER, LOUDLY (site-agnostic by design): the refusal is the ANSWER, not a step
    // before the real one. Both channels, because a "warning" toast that clears is how a
    // misconfiguration reads to the operator as a broken product — the two-channel finding already
    // recorded for the renew policy. Nothing is guessed, nothing is retried elsewhere.
    if (brokerRefusal !== "") {
      ctx.ui.setStatus("broker", "NO BROKER");
      // ONE CALL, not a hand-pair (iid 11): the record lands before the toast, and the two halves
      // cannot be pulled apart by an edit that touches one of them.
      notifySafely(ctx, brokerRefusal, "error");
      return;
    }
    room = String(pi.getFlag("room") ?? "") || process.env.MQTT_ROOM || "";
    if (!room) {
      ctx.ui.notify("[tabichat] --tabichat given but no room: pass --room <name> or set MQTT_ROOM", "warning");
      return;
    }
    // ROOM JOURNAL, resolved and replayed BEFORE the socket can deliver a live line.
    // The rules are in roomlog.ts; this block is the wiring and the one load-bearing act: take the
    // newest lines back into the buffer as HISTORY — no injection, no re-journal, cursor past them.
    {
      roomLogCap = parseRoomLogCap(process.env[ROOMLOG_MAX_ENV], ROOMLOG_MAX_DEFAULT);
      roomLogAgeDays = parseRoomLogAgeDays(process.env[ROOMLOG_MAX_AGE_ENV], ROOMLOG_MAX_AGE_DEFAULT_DAYS);
      const replayN = parseRoomLogCap(process.env[ROOMLOG_REPLAY_ENV], ROOMLOG_REPLAY_DEFAULT);
      roomLogTarget = resolveRoomLogTarget(
        { env: process.env[ROOMLOG_ENV], site: siteConfig[ROOMLOG_SITE_KEY], home: process.env.HOME, room, nick },
        (d) => ROOMLOG_IO.isInGitTree(d),
      );
      if (!roomLogTarget.ok) {
        // an explicit `off` is an answer and gets one INFO line; a refusal is a fault and gets ERROR.
        // Either way NOTHING is written and the reason says which knob answered.
        diag(roomLogTarget.deliberate ? "INFO" : "ERROR", `[tabichat][roomlog] ${roomLogTarget.reason}`);
      } else {
        // boot order is the CONTRACT: modes first (`ensure`, dir 0700 / file 0600),
        // then the cap trim of THIS seat's own file (the single-writer moment), then the replay.
        try {
          ROOMLOG_IO.ensure(roomLogTarget.path);
        } catch (e) {
          noticeLost("journal-not-prepared", `[tabichat][roomlog] could not prepare ${roomLogTarget.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
        const tr = trimRoomLog(ROOMLOG_IO, roomLogTarget.path, roomLogCap, roomLogAgeDays);
        if (tr.ok && tr.trimmed > 0)
          diag("INFO", `[tabichat][roomlog] journal at ${roomLogTarget.path} was ${tr.trimmed} line(s) past its bounds (${roomLogCap}-line cap, ${roomLogAgeDays >= 0 ? `${roomLogAgeDays}-day age` : "no age bound"}): oldest dropped at boot, newest kept — said, not silent`);
        if (!tr.ok)
          notice("record-only", `[tabichat][roomlog] boot trim failed: ${tr.reason}`);
        const t = loadRoomLogTail(ROOMLOG_IO, roomLogTarget.path, replayN);
        if (t.malformed > 0)
          notice("record-only", `[tabichat][roomlog] ${t.malformed} unreadable line(s) in ${roomLogTarget.path} — skipped in replay, the rest stands`);
        let added = 0;
        for (const rec of t.records) {
          const seen = noteRoomId(seenRoomIds, rec.id);
          seenRoomIds = seen.seen;
          if (seen.dup) continue; // a live copy is already in the buffer; history never doubles it
          pushRoomLine(buffer, {
            nick: rec.nick,
            message: rec.text,
            ts: rec.ts,
            id: rec.id || undefined,
            ...(rec.to ? { to: rec.to } : {}),
            hist: true,
          }, BUFFER_MAX);
          added++;
        }
        // history is not news: the first unseen read must start AFTER this block. The boundary is
        // the newest STAMP, not an array position, and it moves only when the block
        // actually added lines — a same-process re-start where everything deduped must not silently
        // mark still-unread LIVE lines as seen.
        if (added > 0) readCursor = lastSeq(buffer);
        if (added > 0)
          diag("INFO", `[tabichat][roomlog] replayed ${added} line(s) of room history from ${roomLogTarget.path} (marked hist; not injected; unseen reads start after them)`);
      }
    }
    // fail loudly, never silently: with no declared contextWindow there is no
    // percent to warn on, and the lane must know its advisory is disabled
    if (!ctx.getContextUsage()) {
      ctx.ui.notify(
        `[tabichat][ctx] no context window for this model — fresh-session advisory OFF; add "contextWindow" for this model to ~/.pi/agent/models.json (a virtual model declares none until its first response routes to a physical one)`,
        "warning",
      );
    } else {
      // Say the denominator out loud, once, at the start: every percentage this lane later quotes
      // divides by it, and so does pi's own compaction. It is a DECLARATION from pi's model config,
      // not a measurement of the serving host — that distinction is the whole lesson of the day.
      const u0 = ctx.getContextUsage();
      const s0: CtxSample | null = u0
        ? { tokens: u0.tokens ?? null, contextWindow: u0.contextWindow, percent: u0.percent ?? null }
        : null;
      ctx.ui.notify(
        `[tabichat][ctx] ${ctxDeclarationLine(s0, ctxModelLabel(ctx.model), CTX_WARN, CTX_TOKENS)}`,
        "info",
      );
    }
    // A transport refusal is LOUD and it is FINAL: no socket, no retry, and the reason printed on
    // two channels (a transient notify is unreadable after the fact — the finding that made
    // the renew notice go to setStatus as well). A lane that is offline and says why is recoverable;
    // a lane that is plaintext and believes it is encrypted is the thing the feature row exists to
    // stop, and it is the one configuration a mis-launched seat cannot detect from the inside.
    if (TRANSPORT.mode === "refuse") {
      const why = TRANSPORT.reasons.join(" | ") || brokerRefusal || "no reason recorded";
      ctx.ui.setStatus("chat", "OFFLINE (transport refused)");
      notifySafely(ctx, `[tabichat][transport] REFUSED to connect — ${why}`, "error");
      return;
    }
    if (TRANSPORT.mode === "tls") {
      // one informative line at start; the WARNINGS (insecure opt-in) are per-connect below, which
      // is the ruled condition, not this one
      notifySafely(
        ctx,
        `[tabichat][transport] ${TRANSPORT.notes.join("; ")} — ${redactUrl(brokerUrl)}`,
        "info",
      );
    }
    // iid 20 — the guard used to be `if (client) return;`, and that early return was the duplication:
    // a replaced session got here, saw its predecessor's socket, left, and nothing ever closed it — the
    // handle was a per-run binding, so no later run could even reach it to end it. Now the handle is
    // process-scoped and this is the ONE close point: whatever the store holds, whether an earlier run
    // left it there or this run put it there, is ended and unhooked immediately before the connect.
    // One client per process is then a property of the code path, not of which shutdown handler runs
    // last. Behavior change named: a second session_start inside one run now reconnects rather than
    // returning with the socket it already had.
    //
    // PLACEMENT, finding C at 9ba3207d1: this sits BELOW the three early returns that can stop this run
    // from ever connecting (`brokerRefusal`, `!room`, `TRANSPORT.mode === "refuse"`), and it has to.
    // Above them, a run that cannot resolve its config force-closed the socket it inherited, returned,
    // and left nothing to re-arm it — pre-fix, `if (client) return;` sat above all three and kept that
    // socket alive. A run that does not connect must not be the thing that closes the connection.
    // `storeShared` is the state AT ENTRY, so it is read before the call below empties the holder.
    const storeSharedAtEntry = MQTT_CLIENT.current !== null;
    const prior = endPriorClient(MQTT_CLIENT, "session_start, before connect");
    client = null;
    if (prior.unhooked || !prior.ended || prior.destroyed) diag("WARN", `[tabichat][client] ${prior.note}`);
    // iid 20 — a MEASUREMENT, not a behaviour change: what the holder held when this
    // run arrived, beside how many sockets THIS PROCESS holds to the broker right now. Zero `[tabichat][client]`
    // rows means two different things without it — an empty store is what a working shutdown-first renewal
    // leaves behind AND what a channel the run could never reach looks like — so `storeShared=false count=2`
    // is the guinea's own face, printed by the code rather than inferred from silence. The tag is
    // `[tabichat][client-face]`, deliberately NOT `[tabichat][client]`, so the two greps that read the
    // latter keep their meaning; grep `storeShared=` to read this one. `count` comes from node's own handle list rather than
    // an `ss` shell-out, because `node:child_process` has no stub in this repo's scoped typecheck and the
    // two ways to make it compile (a new stub, or a new APPROVED entry) are both outside this file's fence;
    // `process._getActiveHandles()` is this pid's view, needs no import, and answers "?" when no port is
    // present rather than inventing one. shortcut: counts connected handles on the broker PORT only, no
    // host check; upgrade if a seat ever faces two brokers on one port.
    diag(
      "INFO",
      `[tabichat][client-face] ${clientFaceNote(
        storeSharedAtEntry,
        countBrokerSockets(
          typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [],
          (() => {
            try {
              return new URL(brokerUrl).port;
            } catch {
              return "";
            }
          })(),
        ),
      )}`,
    );
    client = mqtt.connect(brokerUrl, {
      ...(TRANSPORT.tls ?? {}),
      // MQTT 5.0, and this connect is what makes the expiry above mean anything: the
      // Message-Expiry-Interval property exists in v5 only, and mqtt.js does not encode it on a v4
      // packet. The request is connection-level, so it is stated at the one place a client is built.
      // A broker that will not speak v5 REFUSES the connect and the seat says so through the ordinary
      // socket-error path; it does not quietly fall back to 3.1.1 and lose the expiry while looking
      // healthy (pinned by src/tools/test_retention.ts). Measured on the loopback fixture against the
      // shipped `docs/broker/tabichat.conf` bytes: a v5 session and a 3.1.1 session coexist on one
      // listener and deliver to each other, and the topic rules, the will and the retained replay
      // behave as they did.
      protocolVersion: 5,
      clientId: `pi-${nick}-${Math.random().toString(16).slice(2, 8)}`,
      // our own retained presence record, so a lane that dies marks ITSELF
      // offline instead of leaving the room guessing (P5)
      will: {
        topic: presenceTopic(room, nick),
        payload: JSON.stringify({ nick, status: "offline", ts: Date.now() }),
        qos: 0,
        retain: true,
      },
    });
    // iid 20 — publish the handle the moment it exists, so the next run of this process can find it.
    // One construction site, one store write, no second client anywhere.
    MQTT_CLIENT.current = client;
    client.on("connect", () => {
      // EVERY connect, not once at boot: a reconnect is a different moment and a warning printed
      // only at load is a warning nobody is looking at when the session is actually insecure.
      // through notifySafely, not a bare ctx.ui.notify: this runs inside a SOCKET callback, and the
      // ctx captured here belongs to whichever session first armed the socket
      for (const w of TRANSPORT.perConnectWarnings)
        notifySafely(liveCtx(), `[tabichat][transport] ${w}`, "warning");
      client!.subscribe(`chat/${room}`);
      // dual-read, shape (B): the per-sender topic is heard alongside the flat one, and a repeat
      // that arrives on BOTH is collapsed by the id ledger (roommsg.ts:noteRoomId), so this cannot
      // produce a duplicate line. Unconditional, because it is inert until any lane writes there.
      client!.subscribe(msgWild(room));
      // A2 tail boards are heard ONLY with the flag on — default OFF, and the phase-1 broker
      // refuses the write side anyway (docs/broker/README.md, two-pass law).
      if (HIST_BOARD) client!.subscribe(histWild(room));
      // ONE control filter, not two (tabichat#3). MQTT 3.1.1 §4.7: `sport/#` ALSO matches `sport`,
      // and mosquitto 2.1.2 delivers one copy PER matching subscription — measured on the two-seat
      // fixture: subscribing to BOTH `_ctl` and `_ctl/#` yields 2 copies of every control
      // message; `_ctl/#` alone yields 1. The seat used to hold both filters, so every lane-admin
      // request was adjudicated TWICE; on a heavy seat both dispatches beat the stale-ctx window
      // and ran two concurrent newSession() calls — a fork (three live sessions, three
      // boot tags, every @all line paid per copy). Requests, receipts and boards all live UNDER
      // `_ctl`, so the wildcard alone hears the whole control tree, exactly once each.
      client!.subscribe(`${controlTopic(room)}/#`);
      client!.subscribe(presenceWild(room));
      client!.subscribe(legacyPresenceTopic(room));
      beat();
      if (!hb) hb = setInterval(beat, HB_MS);
      // #10: sweep on a fraction of the window so a loss is named close to the window, not one full
      // window late. "Window 0 starts no timer" became a leak the moment shape (ii)
      // made this timer the board's ONLY clear path — so it is started unconditionally and its period
      // is a third of the tightest live window. A lane that silences the alarm still clears receipts.
      if (!ackSweep) {
        const live = [ACK_WATCH_MS, ACK_RETAIN_MS].filter((n) => n > 0);
        const win = live.length ? Math.min(...live) : ACK_RETAIN_DEFAULT_MS;
        ackSweep = setInterval(sweepAckWatch, Math.max(250, Math.floor(win / 3)));
      }
      liveCtx().ui.notify(`[tabichat] connected as ${nick} (room ${room})`, "info");
      // tabichat#4 — drain anything an earlier session of THIS process parked for us.
      // tabichat#19: the same drain now also runs on the renew re-arm, because a replaced session
      // does NOT reconnect the socket — `connect` may never fire again in this process, and a park
      // that is only ever emptied on `connect` is a park that never drains. One function, both
      // callers, so the two faces cannot drift.
      drainPark?.("socket connect");
    });
    client.on("error", (err: Error) => {
      // BELTED, and this leg is the reason it matters more now: a TLS misconfiguration reports
      // itself HERE (bad CA, refused handshake, a broker that wants a certificate we did not give
      // it), so every transport fault this branch introduces arrives on the one line that was a
      // bare `liveCtx().ui.notify` outside any catch. That is the #585 death family — a disposed
      // context, a throw escaping through the MQTT emitter, pi ending the seat — and the socket
      // callback that reports the most new errors must not also be the one that can kill the lane.
      // The URL is redacted because mqtt.js puts it in error objects (tlsopts.ts:userinfoError).
      // liveCtx(), not a captured ctx: the #585 structural gate (tools/test_ctx_handle.ts) requires
      // every socket callback to read the handle, and the belt is what makes reading it safe.
      notifySafely(liveCtx(), `[tabichat] error: ${redactUrl(String(err?.message ?? err))}`, "error");
    });
    // A stale or broken context inside this callback must never end the seat. A remote renew can
    // replace the session while this handle keeps the dead ctx, `liveCtx().isIdle()` then throws
    // `assertActive` in here, and the throw escapes through the MQTT emitter as an uncaughtException
    // — pi exits and the lane's work stops mid-turn. The fix for THAT is the withSession re-arm
    // above; this is the belt, because a socket callback is not allowed to be a crash vector. The
    // error is LOUD (full text on stderr) and the line is dropped, so the lane survives and the room
    // can still hear from it. This catches nothing of the ack/queue/bookkeeping logic's own correctness.
    client.on("message", (topic, payload) => {
      try {
        handleInbound(topic, payload);
      } catch (e) {
        // ONE LINE, no stack. The first version of this belt printed `e.stack` and the lane's TUI
        // rendered it as raw text — a renewed seat left "at Socket.ondata (node:internal/streams/
        // readable:1009:22)" sitting in the harness. Those frames are
        // node internals: they name nothing about the lane and read like corruption of the seat.
        // The detail worth keeping is WHICH error on WHICH topic. TABICHAT_ERR_STACK=1 restores the
        // full trace — into the FILE now, which is where a trace belongs and is where a person
        // reads one (the gate in diaglog.ts is the same single `stackOn` switch).
        noticeLost("inbound-handler-threw",
          `[tabichat] inbound line dropped, handler threw: ${errOneLine(e)} (topic ${topic})`,
          { stack: e instanceof Error ? e.stack ?? String(e) : String(e) },
        );
        // tabichat#4 — THE ALARM STAYS, verbatim and on the same two channels it is on today. What is
        // added is a SECOND sentence, and it says what happened to the line rather than leaving the
        // reader to infer that it evaporated. A pi invalidation is the one class worth replaying into
        // the next session; every other handler bug is a bug and gets re-parked NOTHING, so a real
        // defect cannot be hidden behind a retry that happens to work.
        const stale = isStaleCtxError(e);
        const p = parkInbound(INBOUND_PARK, { topic, payload: payload.toString(), nick, ts: Date.now() }, handedOff, stale);
        if (p.parked) {
          INBOUND_PARK.splice(0, INBOUND_PARK.length, ...p.park);
          diag("INFO",
            `[tabichat] that line was PARKED, not discarded: the next session of this process will be ` +
              `handed it when its socket connects (park holds ${INBOUND_PARK.length}).`,
          );
        }
        if (p.dropped)
          noticeLost("park-overflowed", `[tabichat] inbound park OVERFLOWED — ${p.dropped} oldest parked line(s) discarded beyond ` +
              `the ${INBOUND_PARK_MAX}-line cap. Those lines are genuinely lost; the fresh seat was ` +
              `never going to catch up this far.`);
        if (!stale && !handedOff)
          noticeLost("inbound-not-parked", `[tabichat] not parked: this is not a pi session-context invalidation, so replaying it ` +
              `into a fresh session would mask a handler bug. The line IS lost — fix the throw.`);
      }
    });
    function handleInbound(topic: string, payload: Buffer): void {
      let msg: { nick?: string; message?: string; id?: string; ts?: number; status?: string; kind?: string; by?: string; to?: string; action?: string; steer?: boolean };
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }
      // tabichat#4 — `handedOff` is measured at the two sites that actually take the line (the held
      // list and pi's queue). The belt parks ONLY a line that was never handed off: an owned line
      // replayed is a duplicate mention, and this fix must not create the defect it fixes. The flag is
      // FACTORY-scoped, not local, because the belt that reads it is a SIBLING of this function, not a
      // caller of it — a `let` here was invisible to the catch, which is a scope error, not a style
      // choice. Single-threaded JS makes the one-flag handoff safe: `handleInbound` is synchronous, so
      // the catch always reads the value THIS call set.
      handedOff = false;
      // control topic: delivery receipts, kept out of the room buffer (P2). The
      // flat topic and the per-message retained board carry the SAME receipt, so
      // the two copies collapse to one entry instead of reading as two deliveries (P6).
      // #10 — settle OUR OWN carried write before anything else consumes the line, on ANY topic:
      // a room publish echoes back to us exactly like a control child does (measured at both phases
      // on the loopback fixture: `chat/<room>` echoes under phase 1, `chat/<room>/msg/<nick>` under
      // phase 2 — the same asymmetry `docs/tls-operations.md` describes, seen from the client side).
      // Every other lane's traffic echoes to us too, and `settled: false` for a topic nobody watched
      // is the normal case, never a miss, so this cannot alarm on peer noise. It runs BEFORE the
      // control branch below because that branch RETURNS for control traffic, and a receipt for our
      // own message arrives on `_ctl/...` — settling after it would never settle anything that matters.
      // iid 21 finding 1 — a frame carrying THIS publish's own id settles it first, and a frame
      // carrying somebody else's cannot. The block below keeps the topic settle #10 was written for
      // (a `_ctl/<id>` child's topic is unique to its publish, so the topic is the same fact), and its
      // shape stays exactly as pinned: the id comparison lives in `settleAck`'s own predicate, on
      // `ackWatchKey`, not in a wider hot-path block. A payload with no id settles nothing by id.
      if (ackWatch.length && msg.id) ackWatch = settleAck(ackWatch, msg.id).pending;
      if (ackWatch.length) {
        const st = settleAck(ackWatch, topic);
        ackWatch = st.pending;
      }
      if (topic === controlTopic(room) || topic.startsWith(`${controlTopic(room)}/`)) {
        // Remote lane administration rides the control topic as well: machinery, never chat. It is
        // checked BEFORE the ack gate below, which would otherwise swallow it whole (kind "lane-admin"
        // carries no ack shape, so isAck() would return false and the request would vanish silently).
        if (isLaneAdmin(msg)) {
          // #3: dedupe by REQUEST ID before the verdict, so the second copy of one publish neither
          // dispatches a second replacement nor answers a second outcome onto the same board.
          const ad = noteRoomId(seenAdminIds, msg.id);
          if (ad.dup) return;
          seenAdminIds = ad.seen;
          takeAdmin(msg, liveCtx());
          return;
        }
        // A lane-admin OUTCOME (laneadmin.ts:ADMIN_RESULT_KIND) is machinery the requester waits
        // on, not something a third lane acts on: it fails isLaneAdmin() above and isAck() below,
        // so it is dropped here on purpose. Only the publisher ever reads that topic.
        if (!isAck(msg)) return;
        const a: Ack = { kind: "ack", id: msg.id as string, to: msg.to ?? "?", by: msg.by as string, ts: typeof msg.ts === "number" ? msg.ts : Date.now() };
        const next = recordAck(acks, a, BUFFER_MAX);
        acks.length = 0;
        acks.push(...next);
        return;
      }
      // presence (per-nick now, plus the older shared topic for unmixed rooms)
      if (topic === legacyPresenceTopic(room) || topic.startsWith(`${legacyPresenceTopic(room)}/`)) {
        upsertPeer(msg.nick, msg.status, msg.ts);
        return;
      }
      // TAIL BOARD (flag-gated): a peer's retained last-ten, merged as HISTORY — never
      // injected, never re-journaled, deduped against the live copy by the id ledger. Authorship is
      // the TOPIC leaf (what the broker's ACL let that certificate write), same rule as msg/<leaf>.
      if (topic.startsWith(`chat/${room}/hist/`)) {
        const leaf = nickFromHistTopic(topic, room);
        if (!leaf) return;
        if (typeof msg.nick === "string" && msg.nick.trim() !== "" && topicLeaf(msg.nick) !== leaf) {
          notice("record-only", `[tabichat][hist] board line dropped, authorship conflict: topic names "${leaf}", payload nick "${msg.nick}". Nothing was merged.`);
          return;
        }
        if (leaf === topicLeaf(nick)) return; // our own board echoing back: those lines are already live here
        const board = (msg as unknown as { lines?: unknown }).lines;
        const rows = Array.isArray(board) ? board : [];
        let merged = 0;
        for (const raw of rows) {
          const rec = raw as RoomLogRecord;
          if (!rec || typeof rec.nick !== "string" || typeof rec.text !== "string" || typeof rec.ts !== "number") continue;
          const seen = noteRoomId(seenRoomIds, typeof rec.id === "string" ? rec.id : "");
          seenRoomIds = seen.seen;
          if (seen.dup) continue;
          pushRoomLine(buffer, {
            nick: rec.nick,
            message: rec.text,
            ts: rec.ts,
            id: typeof rec.id === "string" && rec.id ? rec.id : undefined,
            ...(rec.to ? { to: rec.to } : {}),
            hist: true,
          }, BUFFER_MAX);
          merged++;
        }
        if (merged > 0)
          diag("INFO", `[tabichat][hist] merged ${merged} line(s) from ${leaf}'s tail board into the buffer (history, marked hist, not injected)`);
        return;
      }
      // SHAPE (B), BROKER-FIRST AUTHORSHIP — the rule itself lives in roommsg.ts:authorVerdict so it
      // is unit-checked on both halves (tools/test_roommsg.ts); this is the wiring, and a socket
      // callback is the worst place in the file to hold a decision nobody can test headless.
      // A line on `chat/<room>/msg/<leaf>` gets its author from the TOPIC, which is the leaf the
      // broker's ACL let that certificate write; the payload `nick` is a string someone typed.
      // A disagreement is DROPPED AND SAID, never re-labelled quietly.
      const av = authorVerdict(topic, room, msg.nick ?? "");
      if (!av.ok) {
        notice("record-only", `[tabichat] line dropped, authorship conflict: ${av.why}. Nothing was delivered.`);
        return;
      }
      if (av.mismatch) notifySafely(liveCtx(), `[tabichat] authorship note: ${av.why}`, "warning");
      const from = av.author || msg.nick;
      const text = msg.message;
      // Normalized ONCE: the same value decides delivery below and is what the room line carries,
      // so chat_read can never show an addressee that differs from the one that routed the line.
      const inboundTo = recipientField(msg.to);
      if (!from || !text || from === nick) return; // echo prevention
      // one message, one line: a repeat of an id we already took is dropped before the buffer and
      // before any mention can be injected, so a duplicate can neither be read nor wake a turn
      const seen = noteRoomId(seenRoomIds, msg.id);
      if (seen.dup) return;
      seenRoomIds = seen.seen;
      const inboundLine: RoomLine = {
        nick: from,
        message: text,
        ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
        id: msg.id,
        // the recipient FIELD rides along so chat_read can show who a line was actually addressed
        // to, rather than making a lane infer it from prose (mention.ts)
        ...(inboundTo ? { to: inboundTo } : {}),
      };
      pushRoomLine(buffer, inboundLine, BUFFER_MAX);
      // every line the seat TAKES INTO the buffer is journaled — control receipts,
      // presence and boards returned above and never reach here.
      journalAppend("in", { id: msg.id ?? "", nick: from, to: inboundTo, ts: inboundLine.ts, message: text });
      upsertPeer(from, "online", Date.now());
      // FIELD-FIRST, TEXT-FALLBACK: a payload that carries a recipient
      // field is delivered by that field ALONE, so an address quoted in prose — the all-lanes value
      // included — decides nothing. Only a fieldless line (a human tabichat_cli.py post, /say, an older
      // client) still gets the whole-body scan, and that scan stays whole-token: "@allen" must not
      // wake "@all", "@worker10" must not wake "@worker1" (see mention.ts).
      const mentioned = receives(inboundTo, text, nick);
      // P2: tell the sender we have it, on the control topic, so they can tell
      // "delivered and unanswered" apart from "never arrived at all". Only for
      // messages that address us, and only when they carry an id (an older
      // client's message has none, so there is nothing to acknowledge).
      if (mentioned && msg.id) {
        const ack = ackPayload(msg.id, nick, from, Date.now());
        publishCtl(ack);
        publishCtlRetained(msg.id, ack);
      }
      // Two ways to hand a mention to a lane that is mid-run (see steer.ts): queue it behind the
      // run (the shipped behaviour, and still the default) or, only when the sender asked AND is
      // on the allowlist, steer it — which pi delivers at the lane's next tool-result boundary.
      const cls = deliveryClass({
        idle: liveCtx().isIdle(),
        sender: from,
        flag: wantsSteer(msg),
        allow: STEER_NICKS,
      });
      // tabichat#5 — a control line is ordered by MESSAGE STAMP, not by arrival, and a line that is
      // strictly older than the newest order this process has already obeyed for that channel is
      // LABELLED superseded. Labelled, never dropped: this is the control plane, and a guard that
      // silently retires a room line would be the fail-loudly violation this project books on sight.
      // It changes no authority decision — the recipient field and the steer allowlist above still
      // decide who may say anything (row AC5).
      let ctlHead = "";
      const ctl = controlChannelOf({ nick: from, message: text });
      if (ctl) {
        const v = ctlAdmit(CTL_LEDGER.get(ctl.channel), {
          ts: inboundLine.ts,
          id: msg.id ?? "",
        });
        if (v.kind === "superseded") {
          ctlHead = `${supersededHeader(ctl.channel, v.by)}\n`;
          // TWO CHANNELS: a notify is transient and this lane may never re-read the
          // body it is about to receive. stderr is what a later audit can still find.
          diag("INFO",
            `[tabichat][ctl] superseded control line from ${from} on "${ctl.channel}" ` +
              `(stamp ${inboundLine.ts} < ${v.by.ts}) — delivered labelled, not dropped`,
          );
        } else {
          CTL_LEDGER.set(ctl.channel, {
            ts: inboundLine.ts,
            id: msg.id ?? "",
            nick: from,
            held: ctl.held,
          });
        }
      }
      const head =
        (cls === "steer" ? `${steerHeader(from)}\n\n` : "") + ctlHead;
      // ONLY a line that addresses this lane reaches its context (roommsg.ts:planInbound). An unaddressed line stays in the buffer, where chat_read can still
      // reach it, and is otherwise silent: no flood, and nothing to mistake for an instruction.
      const plan = planInbound({ mentioned, head, line: inboundLine });
      if (plan.kind === "buffer-only") return;
      inbox.push(inboundLine);
      if (inbox.length > BUFFER_MAX) inbox.shift();
      owedTurns++;
      if (owedTurns > 20) owedTurns = 20;
      // A busy lane collects no visible pi queue block per mention: EVERY non-steer mention that arrives while the run is
      // in flight waits HERE and shows as one footer line, then drains at `agent_settled` in
      // arrival order. Delivery is DEFERRED, never dropped: the line is already in `inbox`
      // (citable by chat_read) and the sender was acked above, before this decision. Honoured
      // steers are exempt — an interrupt is the point.
      //
      // The gate used to read `ctx.hasPendingMessages()`, and that is the defect: a lane that is
      // mid-run has an EMPTY pi queue because it is executing rather than waiting on input, so the
      // predicate was false on essentially every mid-run arrival and nothing was ever held. Busy
      // state is the correct condition, and both signals used here are public API this file already
      // calls — the `agent_start`/`agent_settled` events and `ctx.isIdle()` (steer.ts already
      // derives the delivery class from the same isIdle).
      const decision = holdDecision({
        enabled: MERGE_MENTIONS,
        cls,
        alreadyHeld: heldCount(),
        busy: runActive && !liveCtx().isIdle(),
      });
      if (decision === "hold") {
        const { held: grown } = noteHeld(held, {
          id: msg.id ?? "",
          nick: from,
          ts: inboundLine.ts,
          body: plan.body,
        });
        held.splice(0, held.length, ...grown);
        // HANDED OFF the moment the line is in the held list — that list has an owner and a drain.
        // The setStatus on the NEXT line is the one that threw in the owner's specimen, so the flag is
        // set BEFORE it: a line already held must never be parked, or the fresh seat would read it twice.
        handedOff = true;
        liveCtx().ui.setStatus(HOLD_BADGE_KEY, holdBadge(held.length));
        return;
      }
      // Every other arm ends here, including `decision === "queue"`: a switch-off lane, a mention
      // that lands while the lane is NOT running, and anything arriving once the hold list reached
      // HOLD_MAX. That last one is the guarantee that a held mention is never discarded — past the
      // cap the line goes to pi exactly as it did before option B, because `holdDecision` refuses to
      // answer "hold" at the cap (tools/test_mentionq.ts pins both halves).
      if (cls === "turn") {
        handedOff = true;
        sendUser(plan.body);
      } else {
        handedOff = true;
        sendUser(plan.body, { deliverAs: cls });
      }
    }
    // tabichat#19 — the drain, wired here because `handleInbound` is in this scope. Emptying the park
    // BEFORE the loop: a replay that throws must not re-park into the list being drained.
    drainPark = (why: string): number => {
      const backlog = takeParked(INBOUND_PARK);
      INBOUND_PARK.splice(0, INBOUND_PARK.length);
      if (!backlog.length) return 0;
      diag("INFO",
        `[tabichat][ctl] replaying ${backlog.length} inbound line(s) parked by a replaced session (${why})`,
      );
      for (const b of backlog) {
        try {
          handleInbound(b.topic, Buffer.from(b.payload));
        } catch (e) {
          notice("record-only",
            `[tabichat] parked line replay threw: ${errOneLine(e)} (topic ${b.topic}) — dropped, not re-parked`,
            { stack: e instanceof Error ? e.stack ?? String(e) : String(e) },
          );
        }
      }
      return backlog.length;
    };
  });

  // One-line report shared by the context_usage tool and the /ctx command.
  // Structural parameter: the tool context, the command context and the event context all expose
  // getContextUsage() and a current model, and this needs nothing else.
  type CtxUsageReader = {
    getContextUsage: () => CtxSample | null | undefined;
    model?: { provider?: string; id?: string } | undefined;
  };
  const ctxReport = (ctx: CtxUsageReader): string => {
    const who = ctxModelLabel(ctx.model);
    const usage = ctx.getContextUsage();
    const rules =
      `threshold ${CTX_WARN}%` +
      (CTX_TOKENS > 0
        ? ` or ${ctxEffectiveFloor(usage?.contextWindow ?? 0, CTX_TOKENS, CTX_WARN)} tokens absolute`
        : ", no absolute tripwire");
    if (!usage)
      return `context_usage: no context window declared for ${who} — percent advisory OFF; add "contextWindow" to ~/.pi/agent/models.json (${rules})`;
    if (usage.percent === null || usage.tokens === null)
      return `context_usage: unknown until the next model response (window ${usage.contextWindow} declared for ${who}; ${rules})`;
    const s: CtxSample = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    const pctDue = freshSessionDue(s, CTX_WARN, lastCtxWarn);
    const absDue = absoluteSessionDue(s, CTX_TOKENS, lastCtxWarnTokens, CTX_WARN);
    return (
      `context_usage: ${Math.floor(s.percent)}% = ${s.tokens}/${s.contextWindow} tokens ` +
      `(window declared for ${who}; ${rules}${lastCtxWarn >= 0 ? `, last advisory ${lastCtxWarn}%` : ""}) — ` +
      (pctDue || absDue
        ? `FRESH SESSION DUE (${pctDue ? "percent" : "absolute tokens"}): tell the lead and the owner in one room line`
        : "no fresh session due") +
      ` — the window is a DECLARATION in pi's model config, not a measurement of the serving host`
    );
  };

  // A turn that answered a mention ends without anything reaching the room (P1).
  // Say so here, once, so a lane is never fooled into thinking it has spoken.
  pi.on("agent_end", async (_event, ctx) => {
    if (!owedTurns) {
      // Nobody was waiting on this turn, so this is not the turn our flush set the flag for. Spend
      // the flag here rather than carry it to one that is owed: returning armed was L-1.
      flushedThisRun = false;
      return;
    }
    // our own held flush is what ended this settle; the lane has not had a turn to publish in,
    // so the "nothing was published" notice would be a lie. Suppress exactly once.
    if (flushedThisRun) {
      flushedThisRun = false;
      return;
    }
    owedTurns = 0;
    // iid 29: the notice states a fact about publication, so publication is what decides it. A turn
    // that reached the socket is not the turn this sentence is true of; a turn that published nothing
    // still prints it — that half is asserted in tools/test_owed_notice.ts, and silencing the notice
    // by default would be the weaken-the-check class.
    if (publishedThisTurn) return;
    ctx.ui.notify(
      "[tabichat] turn finished — nothing was published: your reply stayed in this terminal. Call chat_post if the room needs it.",
      "info",
    );
  });

  // OPTION B gate input. The run begins here; `agent_settled` below ends it.
  pi.on("agent_start", async () => {
    runActive = true;
    // iid 29 — the turn's publish budget starts here, so a publish that belongs to an earlier turn
    // (or to a between-turn advisory) cannot answer for this one.
    publishedThisTurn = 0;
  });

  // OPTION B drain, COALESCED (the fix asked for: "build held-flush"). `agent_settled` is the event
  // whose own doc comment promises "no automatic retry,
  // compaction, or queued continuation will run", i.e. pi's own queue is empty here.
  //
  // ONE `sendUserMessage` per settle, not one per held line. pi 1.1.0 sets `_isEmittingAgentSettled`
  // while it emits this event and `prompt()` pushes any call made in that window into
  // `_deferredSettledActions`; when the handlers return it splices that list and awaits it
  // BACK-TO-BACK with no delay. So a per-line drain launched N full-context requests at a ~0 s gap —
  // the measured 6/11 = 54.5% cell at >=500k prompt tokens (`handoff-400-lane-deaths-20261005.md`
  // §2.17). One message deletes N-1 of those launches.
  //
  // What does not fit the budget (HELD_FLUSH_MAX_LINES / HELD_FLUSH_MAX_CHARS, whichever fills
  // first, minimum one line, never truncated) is RE-HELD, not dropped, and drains at the NEXT
  // settle — which spaces chunk launches by a whole lane turn (the >=15 s cell, 1/63 = 1.6%).
  // Oldest first, so the lane reads them in the order the room said them.
  //
  // ACCEPTED WORST CASE IS 2 TURNS, not N+1: the FIRST mid-run mention still goes to pi as a
  // `followUp` (that block is pi-owned and out of scope), and everything after it arrives here as
  // one batch.


  /**
   * tabichat#5 AC4 — a HELD control line is only as current as the moment it arrived, and it can be
   * drained long after a newer order for the same channel landed (or be handed to pi's queue by
   * `session_shutdown` and so cross a session replacement entirely). So the supersession check runs
   * AGAIN at every drain, against the process ledger, and an order that has since been lifted ships
   * LABELLED. Nothing is dropped here either — the line was acked to its sender on arrival, and a
   * control plane that discards an order it already receipted is a lie on the wire.
   * A line that IS the ledger's own current entry compares equal and ships plain.
   *
   * IN PLACE, deliberately. The first version read `heldBatchBody(labelSuperseded(send))`, and that
   * broke a SHIPPED assertion in tools/test_mentionq.ts ("the drain is COALESCED: one message from the
   * whole send list"), which pins the literal `heldBatchBody(send)`. Re-pairing another row's gate to
   * suit my call shape is the weaken-the-check class; labelling the list before the call keeps both
   * green with no edit to that cell. The helper also refuses to label a line twice, so a re-held tail
   * drained at the next settle cannot accumulate a second header.
   */
  const labelSuperseded = (lines: HeldMention[]): void => {
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i];
      if (h.body.startsWith(SUPERSEDED_MARK)) continue; // already labelled; never stack a second one
      const ctl = controlChannelOf({ nick: h.nick, message: h.body });
      if (!ctl) continue;
      const v = ctlAdmit(CTL_LEDGER.get(ctl.channel), { ts: h.ts, id: h.id });
      if (v.kind !== "superseded") continue;
      diag("INFO",
        `[tabichat][ctl] held control line from ${h.nick} on "${ctl.channel}" drained superseded ` +
          `(stamp ${h.ts} < ${v.by.ts}) — shipped labelled, not dropped`,
      );
      lines[i] = { ...h, body: `${supersededHeader(ctl.channel, v.by)}\n${h.body}` };
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    // the lane is no longer running, so the next mention is a turn, not a hold. Cleared BEFORE the
    // early return below: a settle with nothing held must still end the run state.
    runActive = false;
    // The loss tell (iid 11 piece 5) is measured BEFORE the plan, so it takes room out of the same
    // budget instead of adding to the turn: a held line that no longer fits stays held — cut by
    // nothing, dropped by nothing.
    const lossBlock = lossTeller.peek();
    // THE GUARANTEE: a seat is told it lost work even when nobody talked to it. The tell is a duty of
    // its own, so a quiet room ships it alone rather than leaving it queued until some later send
    // happens to carry it. The price is the extra turn this send starts; the size of the price is the
    // number of kinds, because each kind is told once per session.
    if (!held.length) {
      if (!lossBlock) return;
      sendUser(lossBlock, { expandPromptTemplates: false });
      // our own send is what ended this run, so the owed-turn notice is suppressed here for the same
      // reason it is suppressed on the held path below: the lane never had a turn to publish in.
      flushedThisRun = true;
      // committed only once the text was handed over, so a send that never happened cannot mark a kind
      // as told and lose the tell for the rest of the session.
      lossTeller.commit();
      return;
    }
    const { deliver } = takeHeld(held);
    const heldBudget = Math.max(1, HELD_FLUSH_MAX_CHARS - (lossBlock ? lossBlock.length + 2 : 0));
    const { send, rehold } = planHeldFlush(deliver, HELD_FLUSH_MAX_LINES, heldBudget);
    held.splice(0, held.length, ...rehold);
    // label the drained control lines BEFORE the batch is built, so the shipped coalesce assertion
    // (`heldBatchBody(send)`, one message from the whole list) stays literally true.
    labelSuperseded(send);
    ctx.ui.setStatus(HOLD_BADGE_KEY, holdBadge(held.length));
    flushedThisRun = true;
    // a held line was acked to its sender when it ARRIVED, and owedTurns was counted then, so the
    // drain only has to hand over the text with one extra line saying why it is late. The header
    // counts the lines IN THIS MESSAGE, not the size of the group it was drained from.
    // expandPromptTemplates is false so a held line that begins with "/" cannot be dispatched as an
    // extension command (pi's own deferred re-call already does this; stated so it stays true).
    sendUser(`${lossBlock}${lossBlock ? "\n\n" : ""}${heldHeader(send.length)}\n\n${heldBatchBody(send)}`, {
      expandPromptTemplates: false,
    });
    // committed only once the text was handed over, so a send that never happened cannot mark a kind
    // as told and lose the tell for the rest of the session.
    lossTeller.commit();
  });

  // Fresh-session advisory, two independent rules, one post per turn:
  //   percent  — at or over CTX_WARN of the DECLARED window (useless if that declaration lies)
  //   tokens   — at or over the absolute floor MQTT_CTX_TOKENS sets, lifted to the part of a large
  //              declared window where a trip still means something (ctxEffectiveFloor)
  // ROOM ONCE, to lead + owner. THE FOOTER WIDGET IS GONE: a footer entry that prints a measurement on
  // every turn is noise on the line a person reads, and the number is available where it is asked for.
  // `ctxStatusText` stays exported and
  // tested in ctxwarn.ts so the number is still one call away if the advisory needs it; only the always-on
  // footer entry is removed. A seat already booted keeps its old footer until it restarts — this is boot-time
  // wiring, not a live mutation, and the same is true of the badge key change in mentionq.ts.
  pi.on("agent_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.tokens === null) return;
    const s: CtxSample = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    // forced handoff, checked BEFORE the advisory's own early return: at 75% (the owner's number) the
    // lane must write its state down, because a lane past that point degrades quietly — which is what
    // today's 78% lead seat looked like from the outside
    forced = rearmForce(forced, s.percent, CTX_FORCE);
    if (gaveUp && (s.percent ?? 0) < CTX_FORCE) gaveUp = false;
    if (forceDue(s, CTX_FORCE, forced) && !gaveUp) {
      // The old loop tried each dir and fell through on ANY throw, in silence, so
      // every lane wrote its handoff into tmpfs without ever saying so. The dir that was
      // chosen is now announced, and a scratch choice is announced AS scratch.
      let chosen = "";
      for (const d of [RESUME_DIR, RESUME_FALLBACK]) {
        if (d === "") continue;
        try {
          mkdirSync(d, { recursive: true });
          chosen = d;
          break;
        } catch (e) {
          diag("WARN",
            `[tabichat][ctx] ${resumeDirUnusable(
              String((e as { code?: string })?.code) === "EACCES" || String((e as { code?: string })?.code) === "EPERM" ? "unwritable" : "missing",
              d,
            )} (${errOneLine(e)})`,
          );
        }
      }
      if (chosen === "") {
        // Nothing is writable at all. Say it on stderr AND in the notify below, and still hand the lane
        // a path to write to: a forced handoff with nowhere to go must not become a silent no-op.
        chosen = RESUME_SCRATCH;
        notice("record-only", `[tabichat][ctx] no RESUME dir was usable — falling back to ${RESUME_SCRATCH}, which is tmpfs`);
      }
      resumeDirLive = chosen;
      if (chosen === RESUME_SCRATCH)
        ctx.ui.notify(`[tabichat][ctx] ${fallbackNote(chosen)}`, "warning");
      resumeFile = resumePath(resumeDirLive, nick, BOOT);
      forced = true;
      blockRefusals = 0;
      const targets = ctxWarnTargets(nick, OWNER_NICK);
      const line = forceRoomLine(nick, s, CTX_FORCE, resumeFile, targets);
      ctx.ui.notify(
        `[tabichat][ctx] FORCED HANDOFF — write ${resumeFile} (tools blocked until it exists).\n${RESUME_TEMPLATE}`,
        "warning",
      );
      if (client && room) {
        publishRoom({ nick, message: line, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
      } else {
        ctx.ui.notify("[tabichat][ctx] forced handoff armed; no room connection, so nothing was posted", "warning");
      }
    }
    // AUTO-RENEW: a seat renews ITSELF at the floor once its handoff exists. This runs
    // BEFORE the advisory's early return, because "nothing to warn about" is exactly when the renew
    // decision still has to be made. The decision is a pure function (laneadmin.ts:autoRenewVerdict,
    // both truth-table halves tested), and the action reuses runAdmin — the same path a remote renew
    // travels. That reuse is the safety property, not a shortcut: a self-renew inherits the context
    // re-arm and the wake pointer because it is literally the same call, so there is
    // no second, less-tested route to a replaced session.
    const arv = autoRenewVerdict({
      armed: autoRenewArmed,
      percent: s.percent,
      floorPct: CTX_FORCE,
      renewedThisBoot: AUTO_RENEWED.has(nick),
      resumeWritten: handoffOnDisk(),
      // The seat's own nick, so this door runs the same handoff audit the remote gate runs (iid 17).
      // `resumeWritten` only says a file exists; naming the seat is what lets the audit read the newest
      // one for THIS lane and judge its content, its age, and — where the launcher declares one — its leg.
      nick: nick,
    });
    if (arv.ok) {
      AUTO_RENEWED.add(nick);
      ctx.ui.notify(
        `[tabichat][renew] auto-renew: ${Math.floor(s.percent ?? 0)}% is at or over the ${CTX_FORCE}% floor and ` +
          `the handoff is on disk — dispatching ${RENEW_COMMAND} (one per boot)`,
        "warning",
      );
      if (client && room) {
        publishRoom({
          nick,
          message:
            `@${LEAD_NICK} @${OWNER_NICK} ${nick} auto-renewing at ${Math.floor(s.percent ?? 0)}% — handoff is ` +
            `on disk, this seat will wake fresh and will be told its handoff path. Nothing was asked of anyone.`,
          id: msgId(nick, ++msgSeq, BOOT),
          ts: Date.now(),
        });
      }
      await runAdmin("renew", "auto-renew", ctx);
      return;
    }
    // At or over the floor and HELD is worth saying, because from outside it looks like a lane that
    // ignored its own policy. Under the floor is not — that would print on every turn forever.
    if (autoRenewArmed && !AUTO_RENEWED.has(nick) && (s.percent ?? 0) >= CTX_FORCE && !arv.ok)
      ctx.ui.notify(`[tabichat][renew] auto-renew held: ${arv.reason}`, "warning");
    const pctDue = freshSessionDue(s, CTX_WARN, lastCtxWarn);
    const absDue = absoluteSessionDue(s, CTX_TOKENS, lastCtxWarnTokens, CTX_WARN);
    if (!pctDue && !absDue) return;
    const trigger: CtxTrigger = pctDue ? "percent" : "tokens";
    // advance BOTH counters: a turn that fired one rule must not immediately fire the other
    lastCtxWarn = Math.floor(s.percent ?? 0);
    lastCtxWarnTokens = s.tokens ?? -1;
    const line = ctxWarnLine(s, ctxWarnTargets(nick, OWNER_NICK), trigger, ctxEffectiveFloor(s.contextWindow, CTX_TOKENS, CTX_WARN));
    ctx.ui.notify(
      `[tabichat][ctx] ${line} (window ${s.contextWindow} declared for ${ctxModelLabel(ctx.model)})`,
      "warning",
    );
    if (client && room) {
      publishRoom({ nick, message: line, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
    } else {
      ctx.ui.notify("[tabichat][ctx] not in a room — advisory shown in this terminal only", "warning");
    }
  });

  // The force in action: from the crossing onward a tool call is blocked BEFORE it runs, except reads,
  // writes to the lane's own RESUME path, and read-only git (so the handoff records TRUE git state).
  // The block lifts on its own the moment that file exists with real content — no human step — and after
  // GIVE_UP_AFTER unanswered refusals the gate stops blocking and says so in the room, because a lane
  // that hangs the fleet is worse than a lane that skips its notes.
  pi.on("tool_call", async (event, ctx) => {
    if (!forced) return undefined;
    const exists = resumeFile !== "" && existsSync(resumeFile);
    if (resumeWritten(exists, exists ? statSync(resumeFile).size : 0)) {
      forced = false;
      ctx.ui.notify(`[tabichat] RESUME file present (${resumeFile}) — block lifted, carry on.`, "info");
      return undefined;
    }
    const tool = String(event.toolName ?? "");
    const input = (event.rawInput ?? {}) as { path?: unknown; file_path?: unknown; command?: unknown };
    const target = String(input.path ?? input.file_path ?? "");
    const isSelf = target !== "" && target === resumeFile;
    if ((WRITE_TOOLS_SELF.includes(tool) && isSelf) || READ_TOOLS_SELF.includes(tool)) return undefined;
    if (tool === "bash" && typeof input.command === "string" && bashAllowedWhileForced(input.command)) {
      return undefined;
    }
    blockRefusals++;
    if (giveUpNow(blockRefusals, false)) {
      forced = false;
      gaveUp = true;
      const line = giveUpLine(nick, Math.floor(CTX_FORCE), resumeFile);
      // The same entry as the broker refusal above, for the same reason (iid 11): the record is laid
      // down first and the toast second, in one call, and the ordering is the belt — a give-up line
      // that a disposed context swallowed is the worst kind of silence.
      notifySafely(ctx, `[tabichat] ${line}`, "error");
      if (client && room) {
        publishRoom({ nick, message: line, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
      }
      return undefined; // let this call through: a stalled lane is worse than an un-noted one
    }
    return { block: true, reason: forceBlockNote(resumeFile) };
  });

  // A provider error ends a run and leaves the process alive and quiet, which looks exactly
  // like a lane that stopped working. This handler is the OBSERVATION only. pi hands
  // the messages here but not the retry outcome: `AgentEndEvent` carries no `willRetry` field
  // (pi annotates only its own session-listener copy in `agent-session.js`), and the retry
  // decision runs in `_handlePostAgentRun()` AFTER this emit returns. So nothing user-visible
  // prints from here — the handler below at `agent_settled` carries the notice, the boundary
  // that promises no automatic retry, compaction or queued continuation will run.
  //
  // What deliberately STAYS at agent_end: `lastTurn = endStateOf(msgs)` and the
  // exit breadcrumb beside it are per-run facts, and this is the boundary that receives the
  // run's messages. Nothing here goes to the room.
  //
  // The shape is unchanged and now reads at the emit site below: the
  // product tag AT THE FRONT, UPSTREAM named as the cause, and no restatement of the
  // provider's payload, which pi already prints. Both halves live in buildNote, so the footer
  // and the toast cannot drift into two shapes: neither site adds or moves a tag. This reverses
  // the trailing-tag form shipped earlier; see test_notice_prefix.ts for the
  // emit-site lock.
  pi.on("agent_end", async (event) => {
    const msgs = ((event as { messages?: unknown }).messages ?? []) as EndMessage[];
    lastTurn = endStateOf(msgs);
    pendingUpstreamNote = upstreamErrorNote(msgs);
  });

  // The notice's boundary. `agent_settled` is pi's final, notification-only event:
  // "Fired after an agent run has fully settled and no automatic retry, compaction, or queued
  // continuation will run" (AgentSettledEvent, types.d.ts). That is the only point where a seat
  // may say anything about retries, and all it may say is what settle guarantees: nothing more
  // is coming. Whether pi retried before settling is not observable from an extension, so the
  // line does not claim it, and this handler does not re-implement pi-ai's classifier.
  //
  // A SEPARATE registration, beside the held-mention drain above rather than inside it: that
  // handler returns early when nothing is held, and a notice must not inherit the drain's state
  // or its ordering. This one therefore runs for every settle — clean, aborted, or errored.
  pi.on("agent_settled", async (event, ctx) => {
    const note = pendingUpstreamNote;
    pendingUpstreamNote = null;
    // An `aborted` settle is a human interrupt, not an upstream fault (the same rule that makes
    // upstreamErrorNote return null for an aborted stopReason, kept across the move).
    const aborted = Boolean((event as { aborted?: unknown }).aborted);
    if (!note || aborted) {
      ctx.ui.setStatus("upstream", undefined);
      return;
    }
    ctx.ui.setStatus("upstream", note);
    ctx.ui.notify(note, "warning");
  });

  // Lane breadcrumb: a start line, then an exit line carrying pi's own reason and how
  // the last turn ended. A lane that never writes its exit line was killed too hard to
  // say goodbye - that absence is the whole point of writing the pair.
  pi.on("session_start", async (event, ctx) => {
    startedAt = Date.now();
    lastTurn = "unknown";
    const usage = ctx.getContextUsage();
    const res = appendExitLine(
      EXIT_LOG,
      exitLine({
        kind: "start",
        pid: process.pid,
        nick,
        room,
        reason: String((event as { reason?: string }).reason ?? "?"),
        lastTurn: "unknown",
        ctxPercent: usage?.percent ?? null,
      }),
    );
    if (!res.ok) ctx.ui.notify(`[tabichat][exitlog] cannot write ${EXIT_LOG}: ${res.error}`, "warning");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    const res = appendExitLine(
      EXIT_LOG,
      exitLine({
        kind: "exit",
        pid: process.pid,
        nick,
        room,
        reason: String((event as { reason?: string }).reason ?? "?"),
        lastTurn,
        ctxPercent: usage?.percent ?? null,
        uptimeMs: startedAt ? Date.now() - startedAt : undefined,
      }),
    );
    if (!res.ok) ctx.ui.notify(`[tabichat][exitlog] cannot write ${EXIT_LOG}: ${res.error}`, "warning");
    // SAFETY VALVE (option B): a seat that dies must not take held mentions with it. They were
    // acked to their senders on arrival, so a silent drop would be a lie on the wire. Hand them
    // back to pi's own queue path and say so, loudly, in the terminal that is closing.
    if (held.length) {
      const { deliver } = takeHeld(held);
      held.splice(0, held.length);
      ctx.ui.setStatus(HOLD_BADGE_KEY, "");
      ctx.ui.notify(
        `[tabichat] session ending with ${deliver.length} held mention(s) — returning them to the normal queue`,
        "warning",
      );
      labelSuperseded(deliver);
      for (const h of deliver) sendUser(h.body, { deliverAs: "followUp" });
    }
  });

  // A compaction frees context, so either advisory may be earned again later.
  pi.on("session_compact", async () => {
    lastCtxWarn = -1;
    lastCtxWarnTokens = -1;
  });

  pi.registerCommand("say", {
    description: "publish a message to the tabichat room (usage: /say <text>)",
    handler: async (args, ctx) => {
      const text = foldToOneLine(String(args ?? ""));
      if (!client || !room) {
        ctx.ui.notify("[tabichat] not in a room — start pi with --tabichat --room <name>", "warning");
        return;
      }
      if (!text) {
        ctx.ui.notify("[tabichat] /say needs something to say (blank text is not published)", "warning");
        return;
      }
      publishRoom({ nick, message: text, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
      ctx.ui.notify(`[tabichat] said ${text.length} chars to ${room}`, "info");
    },
  });

  pi.registerCommand("room", {
    description: `show recent tabichat room lines (usage: /room [n], max ${BUFFER_MAX})`,
    handler: async (args, ctx) => {
      if (!room) {
        ctx.ui.notify("[tabichat] not in a room — start pi with --tabichat --room <name>", "warning");
        return;
      }
      const wanted = parseInt(String(args ?? "").trim(), 10);
      const n = Number.isNaN(wanted) ? 10 : Math.min(Math.max(wanted, 1), BUFFER_MAX);
      const lines = buffer.slice(-n);
      if (!lines.length) {
        ctx.ui.notify(`[tabichat] room ${room}: no lines heard yet`, "info");
        return;
      }
      const text = lines.map(renderLine).join("\n");
      ctx.ui.notify(`[tabichat] last ${lines.length} line(s) in ${room}:\n${text}`, "info");
    },
  });

  pi.registerCommand("peers", {
    description: "the presence beats this seat has heard, per nick (online / stale / offline, with age) — not a process check",
    handler: async (_args, ctx) => {
      if (!room) {
        ctx.ui.notify("[tabichat] not in a room — start pi with --tabichat --room <name>", "warning");
        return;
      }
      ctx.ui.notify(`[tabichat] peers in ${room}:\n${renderPeersBoard([...peers.entries()], Date.now(), nick, room)}`, "info");
    },
  });

  pi.registerCommand("ctx", {
    description: "show this session's context-window usage and advisory state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`[tabichat] ${ctxReport(ctx)}`, "info");
    },
  });

  // The renewal door. The REMOTE route dispatches this very command, so both
  // doors run through the code below — which is why the ctx handling here is the careful kind.
  //
  // THE LESSON, bought with a real session: `pi.on("session_start")` does NOT re-fire
  // for the replacement session, so the #585 handle (`currentCtx`, refreshed there) stays bound to
  // the DEAD runner and the next inbound line throws `assertActive` out of the MQTT callback — no
  // catch, `uncaughtException`, pi exits. pi's own type says where the live context is handed over:
  // `newSession({ withSession })`, and `ReplacedSessionContext` is "fresh command-capable context
  // bound to the replacement session" (types.d.ts:292-335, 1.3.0). So re-arm the handle THERE.
  pi.registerCommand("renew", {
    description: "start a fresh session now (the door both the human and a remote renew request open)",
    handler: async (_args, ctx) => {
      // THE LATCH, and it is authoritative HERE rather than only in runAdmin, because this handler is
      // the one door every renew in the process actually passes through — human /renew, remote admin
      // request and auto-renew at the floor all arrive here. Check-then-stamp with NO await between:
      // JS is single-threaded, so this pair serialises concurrent dispatches — whoever lands first
      // stamps, and every other in-flight dispatch refuses. A refusal happens before the hold line
      // is published, so a duplicate emits NO second room-wide notice at all (issue AC2 — the
      // dedupe answer is "not emitted", not "suppressed after the fact"), and it is keyed on the
      // in-flight EVENT, never on text, so a legitimate second renew later still renews (AC4).
      // laneadmin.ts:renewInFlightRefusal owns the decision; its backstop window means a stamp that
      // never cleared (a throw inside newSession) strands renewals for 15 minutes, not forever.
      {
        const stamp = RENEW_INFLIGHT.get(nick) ?? null;
        const latch = renewInFlightRefusal(stamp, Date.now());
        if (!latch.ok) {
          ctx.ui.notify(`[tabichat][renew] ${latch.reason}`, "warning");
          // TWO CHANNELS, and this refusal is exactly the class that needs them: a transient
          // toast is unreadable after the fact, and a REFUSAL is a decision somebody must be able
          // to find later. The second channel is the durable diagnostic file now, not the terminal
          // the operator is typing into.
          diag("WARN", `[tabichat][renew] ${latch.reason}`);
          return;
        }
        RENEW_INFLIGHT.set(nick, Date.now());
      }
      // THE LEAD HOLD, and it lives HERE rather than at each caller on purpose: the human typing
      // /renew, a remote admin request and auto-renew at the floor all land in this handler, so one
      // insertion covers all three doors. A lead seat that replaces its session without telling the
      // room is a failure this office has produced on the record — lanes finish real work, address
      // the lead, and the verdict lands nowhere. The requirement already existed as a promise in a seat
      // contract; a promise broken on the record is not a control.
      //
      // Awaited, deliberately: session_shutdown closes the socket after ~1 s per publish, and a
      // fire-and-forget hold would race the very session change that makes it necessary. to="all"
      // because a hold is a fleet fact; steer=true because a normal post queues behind each lane's
      // WHOLE run, which is exactly the traffic a hold exists to intercept.
      if (client && room && shouldHoldBeforeRenew(nick, LEAD_NICK)) {
        const hold = leadHoldLine(nick);
        const holdPayload = roomPayload({ nick, message: hold, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now(), to: "all", steer: true });
        try {
          await new Promise<void>((resolve, reject) => {
            client.publish(
              `chat/${room}`,
              JSON.stringify(holdPayload),
              {},
              (err) => (err ? reject(err) : resolve()),
            );
            // The watch is armed on the SAME tick the write is handed over — exactly where
            // `publishRoom`'s flat arm arms it — and never after the `await`: by then the broker's
            // echo may already have come back and found nothing to settle, which would leave a
            // delivered hold to age out as an alarm. Topic is the FLAT room topic, whatever
            // MQTT_SENDER_TOPIC says, because that is the hold's delivery shape and the topic the
            // echo will actually arrive on.
            watchSend(`chat/${room}`, ROOM_SEND_KIND, typeof holdPayload.id === "string" ? holdPayload.id : "");
          });
          // iid 29 counted it; leg 1123 JOURNALS it. This hand-off is a room line — `chat/<room>`,
          // `to:"all"`, `steer:true`, minted by this seat — so it runs the same tail every other room
          // publish runs, and runs it AFTER the await: a hold the socket refused is counted nowhere,
          // kept nowhere, and the `catch` below still says so loudly. Before this the hold consumed a
          // counter number and reached every peer while the author's own journal held nothing, so the
          // seat that sent it could not answer "did I send that?" about a line it had in fact sent.
          roomSendTail(holdPayload);
          ctx.ui.notify(`[tabichat][renew] lead hold published (steered, to=all) before the session change`, "info");
        } catch (e) {
          // Loud, and the renew still proceeds: a lead whose socket is gone cannot notify anybody, but
          // refusing the renew would strand it at 100 % for no reason. Say which half failed.
          ctx.ui.notify(
            `[tabichat][renew] lead hold NOT published (${errOneLine(e)}) — the renew proceeds; lanes may post into this seat until it restores`,
            "warning",
          );
        }
      }
      await ctx.waitForIdle();
      let rearmed = false;
      const r = await ctx.newSession({
        withSession: async (next) => {
          // FIRST ACT: the socket belongs to the process and is still holding this callback path,
          // so the handle must point at the live context before anything else happens.
          currentCtx = next;
          rearmed = true;
          // The replacement is LIVE from this line on — release the latch so a later, deliberate
          // renew of this seat may run (AC4: the paired negative of the fork guard). Every other
          // terminal path below releases it too; the backstop window covers the paths that cannot.
          RENEW_INFLIGHT.delete(nick);
          // tabichat#19: the CONTEXT is not the only thing the dead session owned — `pi.sendUserMessage`
          // throws for the rest of the process (see the `sendUser` handle above), so every hand-off
          // from here on goes through the replacement session's own send.
          sendUser = (content, options) => next.sendUserMessage(content, options);
          next.ui.setStatus("nick", `@${nick}`);
          // tabichat#19 — THIRD ACT, and the reason iid 4's replay was never OBSERVED: the socket is
          // already connected when a session is replaced, so the `connect` drain never ran for the
          // fresh seat. Drained AFTER the send handle is re-armed, or a replayed line would throw on
          // the dead `pi.sendUserMessage` and be re-parked instead of delivered.
          drainPark?.("renew re-arm");
          next.ui.notify("[tabichat][renew] new session started", "info");
          // This is the wake half: a renewed seat is an ERASED seat, and
          // nothing above makes it read its own handoff — a seat woke at a fresh prompt with
          // RESUME-<lane>-*.md already on disk and pi told it "no prior context". The decision and the
          // delivery live in laneadmin.ts:wakeRenewedSeat so the gate can EXECUTE them against a fake
          // next, not grep for them; it never throws, so a cosmetic miss cannot become a dead seat.
          await wakeRenewedSeat(next, {
            resumeCandidates,
            minBytes: RESUME_MIN_BYTES,
            // On an exact-name miss the pointer runs the nick+freshness scan under
            // the FLOOR CARRIED FROM THIS RUN (the renewing session's BOOT_AT_MS). This closure is
            // the renewing run's — withSession is invoked later but the function object and its
            // lexical BOOT_AT_MS were minted here — and passing it explicitly makes that a contract
            // with a test, not an accident of scoping.
            fallbackPick: () => resumePickAt(BOOT_AT_MS),
            leadNick: shouldHoldBeforeRenew(nick, LEAD_NICK) ? nick : "",
            stderr: (t) => console.error(t),
            stackEnvOn: process.env.TABICHAT_ERR_STACK === "1",
          });
        },
      });
      // `cancelled` means no replacement happened, so this ctx is still the live one and safe to use.
      if (r.cancelled) {
        RENEW_INFLIGHT.delete(nick);
        ctx.ui.notify("[tabichat][renew] cancelled — the session change did not happen", "warning");
      } else if (!rearmed) {
        // The session WAS replaced and withSession never ran: the handle is stale and the next
        // inbound line would have killed the seat. There is NO usable UI here — a dead ctx cannot
        // print — so stderr stays as the operator's only channel (spec: this one is consequence-
        // bearing and stays at the UI), and the file is added as the record beside it.
        RENEW_INFLIGHT.delete(nick);
        const staleHandleLine =
          "[tabichat][renew] WARNING: session replaced but withSession did not fire — the live context handle is STALE. " +
          "Inbound room lines are caught and dropped rather than crashing the seat; restart this lane.";
        notice("record-only", staleHandleLine);
        console.error(staleHandleLine);
      }
    },
  });

  // A request that arrived mid-turn lands here, once the turn is over. Renew is the one route that
  // cannot finish by itself, and runAdmin says so rather than pretending.
  pi.on("agent_end", async (_event, ctx) => {
    const action = pendingAdmin;
    if (!action) return;
    const by = pendingBy;
    pendingAdmin = null;
    pendingBy = "";
    await runAdmin(action, by, ctx);
  });

  pi.registerCommand("mqtt-status", {
    description: "MQTT chat connection status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `[tabichat] flag=${pi.getFlag("tabichat") === true} nick=${nick} room=${room} url=${redactUrl(brokerUrl) || "<unset>"} ` +
          `source=${broker.ok ? broker.source : "NONE"} transport=${TRANSPORT.mode}${TRANSPORT.mode === "refuse" ? ` (${TRANSPORT.reasons[0] ?? brokerRefusal ?? ""})` : ""} senderTopic=${SENDER_TOPIC ? "per-nick" : "flat"} connected=${client?.connected ?? false}` +
          (brokerRefusal !== "" ? ` — REFUSING: ${brokerRefusal}` : ""),
        "info",
      );
    },
  });

  pi.on("session_shutdown", async () => {
    if (hb) {
      clearInterval(hb);
      hb = null;
    }
    if (ackSweep) {
      clearInterval(ackSweep);
      ackSweep = null;
    }
    if (client && room) {
      // Say so on our own presence record first, then close the socket kindly so
      // anything already queued (an ack, an advisory) still leaves. Forcing the
      // close drops it — measured: publishes made at the last turn end were lost.
      const done = (p: unknown) =>
        Promise.race([p as Promise<unknown>, new Promise((r) => setTimeout(r, 1000))]);
      try {
        await done(
          client.publish(
            presenceTopic(room, nick),
            JSON.stringify({ nick, status: "offline", ts: Date.now() }),
            { retain: true },
          ),
        );
      } catch {
        /* the broker is gone; there is nothing to flush to */
      }
      try {
        await done(client.end());
      } catch {
        /* same */
      }
    }
    // iid 20 — hand the holder to the SAME helper the start path uses, and only while it still points
    // at this run's client, so a shutdown that lands after a replacement cannot wipe the incoming run's
    // handle. pi closes the old instance BEFORE the new one starts (docs/extensions.md:512, restated at
    // :1474), so clearing the holder alone emptied it on the one path that matters: the incoming run's
    // endPriorClient then read `no prior client`, unhooked nothing, and the retained socket kept its
    // connect/error/message listeners. The graceful close above already ran, so the helper's end(true)
    // is mqtt.js's idempotent branch (client.js:818 returns `this` when already disconnecting); what is
    // being asked of it here is removeAllListeners over CLIENT_EVENTS plus the store drop, and the
    // helper does both even when the close throws.
    if (MQTT_CLIENT.current === client) endPriorClient(MQTT_CLIENT, "session_shutdown");
    client = null;
  });
}
