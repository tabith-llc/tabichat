// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Room message plumbing for the tabichat extension: ids, timestamps, the control
// topic, per-nick presence and liveness, and one-line folding.
//
// Pure by design — nothing here touches the broker, so every rule below is
// checkable in tools/test_roommsg.ts without a network. index.ts owns the
// clients; this module owns the shapes and the arithmetic.
//
// Why each piece exists (lead requirements P2-P5, owner order 2026-10-05):
//   P2  an id per message + an ack on a NON-room topic, so the lead can tell
//       "never delivered" apart from "received and being ignored" without
//       spending turns on the difference;
//   P3  a timestamp per room line and an unseen-since-cursor read, so replayed
//       history is not acted on as news;
//   P4  whitespace-only publishes refused, and a pasted multi-line block folded
//       into ONE message instead of several lines landing a second apart;
//   P5  per-nick presence with a heartbeat, so a lane that died reads as dead
//       rather than as silent.

/** Default beat: how often a lane restates its presence. */
export const HEARTBEAT_MS_DEFAULT = 30_000;
/** A peer whose last beat is older than this many ms is stale, not present. */
export const PEER_STALE_AFTER_MS_DEFAULT = 90_000;

export type PeerState = "online" | "stale" | "offline";

/**
 * Per-session, per-sender message id: `<nick>-<seq>-<boot>`.
 * The boot tag is not decoration. `msgSeq` restarts at 0 every time a lane starts, so
 * `<nick>-<seq>` alone hands the SAME id to two different messages in two sessions of one
 * lane — and receipts are filed by id (`ackTopic`, `ackKey`), so a receipt lookup then
 * reports a delivery belonging to the lane's earlier message, and one lane's older
 * receipt is silently replaced by the newer one.
 */
export const msgId = (nick: string, seq: number, boot: string): string =>
  `${nick}-${seq}-${boot}`;

/**
 * One lane's boot tag: six hex chars, fixed width so ids read evenly, drawn from an
 * injectable source so the width and the mapping are testable without a random draw.
 */
export const bootTag = (rand: () => number = Math.random): string =>
  Math.floor(rand() * 0x10_0000)
    .toString(16)
    .padStart(6, "0");

/**
 * Fold anything onto ONE line: room text is one line per message by rule, and a
 * pasted block must become one message rather than several. Blank lines drop
 * out, runs of spaces collapse, and whitespace-only input yields "".
 */
export const foldToOneLine = (raw: string): string =>
  raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .trim();

/** {me} -> this lane's nick, then folded. The one expansion room text goes through. */
export const expandMe = (raw: string, nick: string): string =>
  foldToOneLine(raw.split("{me}").join(nick));

/**
 * Build one ROOM payload. Kept as a function (not inline in the publisher) so the publish→wire→
 * receive seam is testable without a broker: `tools/test_roommsg.ts` round-trips what this returns
 * through JSON.parse and runs the delivery decision on the result, which is the only way to prove a
 * recipient FIELD actually survives the wire rather than merely being named in a call site.
 *
 * `to` is the RECIPIENT FIELD (mention.ts): it is written only when the caller named an addressee,
 * exactly like `steer`, so a receiver that predates either field sees the same payload it always
 * did. Older receivers ignore an extra key; the visible "@<to> " prefix in `message` stays, so they
 * keep addressing lines by text until they are restarted on this code.
 */
export const roomPayload = (o: {
  nick: string;
  message: string;
  id: string;
  ts: number;
  to?: string;
  steer?: boolean;
}): Record<string, unknown> => ({
  nick: o.nick,
  message: o.message,
  id: o.id,
  ts: o.ts,
  ...(o.to ? { to: o.to } : {}),
  ...(o.steer === true ? { steer: true } : {}),
});

/** Control traffic (acks, liveness) lives OUT of the room so it never reads as chat. */
export const controlTopic = (room: string): string => `chat/${room}/_ctl`;
/**
 * The per-sender room topic — shape (B): no impersonation, and the writer is locked to its own
 * leaf. A lane PUBLISHES only its own leaf and the broker's ACL, keyed on the
 * authenticated certificate identity, is what makes that stick: `docs/broker/acl-phase1.conf`
 * cannot express it (a `%u` pattern expands to the whole subject DN, `CN=lead-agent`, not `lead-agent`), the
 * generated phase-2 ACL can, and the drop was MEASURED on the loopback fixture.
 *
 * NOT THE DEFAULT PUBLISH PATH. The migration law in the design row is dual-read, single-write,
 * and readers flip only after the last lane has migrated, so the writer stays behind
 * `MQTT_SENDER_TOPIC=1`. Publishing there while the broker is on the phase-1 ACL is invisible, and
 * publishing there before every reader subscribes `msg/+` silences the room — both are the failure
 * this gate exists to prevent.
 */
export const msgTopic = (room: string, nick: string): string => {
  const leaf = (nick ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  // an empty leaf after sanitising would aim the publish at `chat/<room>/msg/` — a different topic
  // with a trailing separator, i.e. nowhere anyone reads. Refuse, do not misroute.
  return leaf ? `chat/${room}/msg/${leaf}` : "";
};
/** The read half of the same shape: every lane hears every sender. */
export const msgWild = (room: string): string => `chat/${room}/msg/+`;
/**
 * The nick a `chat/<room>/msg/<leaf>` topic asserts, or "" when the topic is not of that shape.
 * This is what makes the BROKER the authority on authorship: the leaf is chosen by the ACL the
 * certificate authenticated, not by the JSON the sender typed.
 */
export const nickFromMsgTopic = (topic: string, room: string): string => {
  const pre = `chat/${room}/msg/`;
  if (!topic.startsWith(pre)) return "";
  const leaf = topic.slice(pre.length);
  // one level only: `msg/a/b` is not a sender leaf, and neither is `msg/` or a `+`/`#` echo
  if (!leaf || leaf.includes("/")) return "";
  return leaf;
};

/**
 * The authorship decision for one inbound line (shape B, broker-first).
 *
 * A line that arrived on `chat/<room>/msg/<leaf>` carries its author in the TOPIC, because that leaf
 * is the only topic the broker's ACL lets the authenticated certificate write — measured on the
 * loopback fixture: the own leaf is delivered, another nick's leaf is dropped by the broker, and the
 * flat topic is dropped too. The payload `nick` is a string the sender typed.
 *
 * So when the two disagree, the TOPIC is right and the line is refused. It is refused LOUD rather
 * than re-labelled, for the same reason the project refuses a silent downgrade: a lane that quietly
 * accepts a rewritten author is one ack and one steer away from trusting a forgery, and a silent
 * drop is how a missing mention becomes a "nobody answered me" investigation.
 */
export type AuthorVerdict =
  | { ok: true; author: string; mismatch: false }
  | { ok: true; author: string; mismatch: true; why: string }
  | { ok: false; author: string; mismatch: true; why: string };

export const authorVerdict = (topic: string, room: string, payloadNick: string): AuthorVerdict => {
  const leaf = nickFromMsgTopic(topic, room);
  const typed = (payloadNick ?? "").trim();
  // not a sender topic: the flat room topic, and phase 1 cannot say anything about who wrote it —
  // the payload nick is all there is, and that limit is measured, not hidden (test_broker_auth.ts)
  if (!leaf) return { ok: true, author: typed, mismatch: false };
  if (!typed) {
    // the topic still names an author, so the line is deliverable; the missing field is a client bug
    // and it gets said, because a lane reading `to=` lines from an anonymous sender is a surprise
    return { ok: true, author: leaf, mismatch: true, why: `no nick in the payload; author taken from the topic ${topic}` };
  }
  if (typed === leaf) return { ok: true, author: leaf, mismatch: false };
  return {
    ok: false,
    author: leaf,
    mismatch: true,
    why: `topic ${topic} asserts "${leaf}" but the payload names "${typed}"`,
  };
};
/** One retained presence record PER NICK, so a late joiner is told about everyone. */
export const presenceTopic = (room: string, nick: string): string =>
  `chat/${room}/presence/${nick}`;
/** Wildcard form of the above (the legacy shared topic is a sibling, not a child). */
export const presenceWild = (room: string): string => `chat/${room}/presence/#`;
/** The older shared presence topic, still read so unmixed old clients are visible. */
export const legacyPresenceTopic = (room: string): string => `chat/${room}/presence`;

/** Receipt acknowledgement. Published on the control topic, never in the room. */
export interface Ack {
  kind: "ack";
  /** the id of the message this acknowledges */
  id: string;
  /** who sent that message */
  to: string;
  /** the lane that received it */
  by: string;
  ts: number;
}

export const ackPayload = (id: string, by: string, to: string, ts: number): Ack => ({
  kind: "ack",
  id,
  to,
  by,
  ts,
});

/** True for a well-formed ack payload; anything else on the control topic is ignored. */
export const isAck = (o: unknown): o is Ack => {
  const r = o as Partial<Ack> | null;
  return !!r && r.kind === "ack" && typeof r.id === "string" && typeof r.by === "string";
};

/** What we remember about one peer. ts <= 0 means "no stamp" (an older sender). */
export interface PeerSeen {
  status: string;
  ts: number;
}

/**
 * May an incoming presence record replace what we hold? (P5)
 *
 * A record with no stamp — the older senders on the shared presence topic, which
 * never carried a ts — must never outrank a stamped record. Among stamped
 * records the newer one wins. Without this rule a stale retained record that a
 * late subscriber is handed by the broker marks a live peer as gone the instant
 * it joins, which reads as a peer arriving and leaving in the same second.
 */
export const peerRecordWins = (prev: PeerSeen | undefined, incoming: PeerSeen): boolean => {
  if (!prev) return true;
  if (incoming.ts <= 0) return prev.ts <= 0;
  return incoming.ts >= prev.ts;
};

/**
 * Liveness, three honest states. A peer is "stale" once its beat is older than
 * the allowance — the lane may be wedged, not quiet. A future ts (a peer's clock
 * ahead of ours) is treated as online, never as offline.
 */
export const peerState = (
  seen: PeerSeen | undefined,
  nowMs: number,
  staleAfterMs: number = PEER_STALE_AFTER_MS_DEFAULT,
): PeerState => {
  if (!seen || seen.status === "offline") return "offline";
  // an unstamped record says nothing about liveness: it cannot be proof of life
  if (seen.ts <= 0) return "stale";
  const age = nowMs - seen.ts;
  if (!Number.isFinite(age) || age < -staleAfterMs) return "online";
  return age > staleAfterMs ? "stale" : "online";
};

/** Compact age: 42s, 3m12s, 2h05m. */
export const ageLabel = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

/** HH:MM:SS in the lane's own clock, for display only (payloads carry epoch ms). */
export const tsLabel = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export interface RoomLine {
  nick: string;
  message: string;
  ts: number;
  id?: string;
  /**
   * The RECIPIENT FIELD this line was published with, when it carried one (mention.ts). It is the
   * authoritative addressee: the `@<to> ` prefix in `message` is only text, and a token quoted in
   * prose routes nothing. Absent for a fieldless line — a human `tabichat_cli.py` post, `/say`, or any
   * sender that predates the field — where the body scan is what decided delivery.
   *
   * Rendered as `to=<value>`, never as `@<value>`: an `@` here would be the very body token this
   * change makes inert, and a line that reads `to=all` cannot be mistaken for a broadcast.
   */
  to?: string;
}

/** " to=<field>" when the line names an addressee, "" when it carries no field. */
const toLabel = (to: string | undefined): string => {
  const t = (to ?? "").trim();
  return t ? ` to=${t}` : "";
};

/** One rendered room line: [HH:MM:SS chat:nick to=<field>] text */
export const renderLine = (l: RoomLine): string =>
  `[${tsLabel(l.ts)} chat:${l.nick}${toLabel(l.to)}] ${l.message}`;

/**
 * Provenance for one INBOUND line (owner order 2026-10-08, after a lane published six
 * re-dispatches it had never received). A mention used to arrive as `[chat:<nick>] <text>`
 * with nothing to pin it to, so a claim about what the room sent was unfalsifiable inside the
 * lane: the only message ids a lane ever saw were the ones its own posts printed, and the ids
 * invented in that incident copied exactly that shape (`anna-1-a84e80`). The tag carries the
 * same id and the same stamp `chat_read` shows for that line, so `scope=inbox` can confirm or
 * deny it in one call. An id-less line (an older client) says `id=none` rather than hiding it.
 */
export const lineTag = (id: string | undefined, ts: number): string =>
  ` id=${(id ?? "").trim() || "none"} @${tsLabel(ts)}`;

/** How a lane sees one inbound line: [chat:<nick> id=<id> @HH:MM:SS to=<field>] text */
export const renderInbound = (l: RoomLine): string =>
  `[chat:${l.nick}${lineTag(l.id, l.ts)}${toLabel(l.to)}] ${l.message}`;

/**
 * Per-sender tally of received mentions: `lead-agent x1, dust x2`. This is the number a lane
 * used to assert from memory ("the lead relayed this six times") — here it is counted.
 */
export const inboxTally = (rows: readonly RoomLine[]): string => {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.nick, (by.get(r.nick) ?? 0) + 1);
  return [...by.entries()].map(([n, c]) => `${n} x${c}`).join(", ");
};

/**
 * What a lane is handed AUTOMATICALLY: only what is addressed to it. A lane does not
 * see all the chat messages in the room (the lines it missed since its last turn) — it needs
 * only the message addressed to @its-nick or @all, and that is the whole rule.
 *
 * The lane used to be handed up to 12 unaddressed room lines ahead of every mention, under a
 * `[room lines since your last turn]` header. Two costs, both paid by the fleet: the block eats
 * context on every mention, and it upsets the less capable lane models — a 2026-10-08 incident
 * had a fresh worker lane read unaddressed traffic as six re-dispatches of its own order and
 * accuse the lead in the room of ignoring reports it had, in fact, been acked for. Nothing is
 * lost by removing it: the whole room stays in the buffer, so `chat_read` still answers any
 * question a lane has about it, on purpose and in one call instead of by ambient flood.
 *
 * So: a line that addresses this lane (@nick or @all) is injected with provenance; anything else
 * stays in the buffer only.
 */
export type InboundPlan = { kind: "inject"; body: string } | { kind: "buffer-only" };

/** `head` is the steer header line when the class is a steer, "" otherwise. */
export const planInbound = (o: {
  mentioned: boolean;
  head: string;
  line: RoomLine;
}): InboundPlan =>
  o.mentioned
    ? { kind: "inject", body: `${o.head}${renderInbound(o.line)}` }
    : { kind: "buffer-only" };

/**
 * Lines the reader has not been shown yet, plus the cursor to store afterwards.
 * A cursor past the end (a cleared buffer) yields nothing rather than the world.
 */
export const takeUnseen = <T>(
  buf: readonly T[],
  cursor: number,
): { lines: T[]; cursor: number } => ({
  lines: buf.slice(Math.min(Math.max(cursor, 0), buf.length)),
  cursor: buf.length,
});

/** Rendered peer listing, self excluded, stale and offline last. */
export const renderPeers = (
  peers: readonly [string, PeerSeen][],
  nowMs: number,
  self: string,
  staleAfterMs: number = PEER_STALE_AFTER_MS_DEFAULT,
): string[] => {
  const rank: Record<PeerState, number> = { online: 0, stale: 1, offline: 2 };
  return peers
    .filter(([nick]) => nick !== self)
    .map(([nick, seen]) => {
      const st = peerState(seen, nowMs, staleAfterMs);
      const age = seen.ts > 0 ? ageLabel(Math.max(0, nowMs - seen.ts)) : "no stamp";
      return { nick, st, text: `${nick} ${st === "online" ? "online" : st} ${age}` };
    })
    .sort((a, b) => rank[a.st] - rank[b.st] || a.nick.localeCompare(b.nick))
    .map((p) => `${p.st === "online" ? "*" : p.st === "stale" ? "?" : "-"} ${p.text}`);
};

/**
 * A message id as a topic leaf (P6). MQTT gives `#`, `+` and `/` a meaning in a
 * topic, and a blank or `..` leaf would aim the publish somewhere else entirely,
 * so those forms are removed. "" means the id cannot be used as a leaf; the flat
 * control topic still carries the receipt, so nothing is lost but retention.
 */
export const sanitizeAckId = (id: string): string =>
  id
    .trim()
    .replace(/[\s/#+"'`]+|\.\./g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);

/**
 * Room-post length cap. The owner's own posts are unlimited; agent posts are
 * capped at 2500 (raised from 1500 on the lead's
 * recommendation "RAISE to ~2500 — keep the refusal, never lift", after three posts bounced at 1500 in
 * one round and a 1,792-character merge order died inside a refused draft). The REFUSAL IS THE POINT AND
 * IT IS UNCHANGED: a post over the cap is refused and nothing is published; only the number moved. Room
 * text is read by every lane that picks it up, and a lane can post a whole worklog into the room — one
 * 2026-10-07 post ran to ~2,600 characters — with nothing measuring it, because the rule to keep room
 * text to a verdict line plus a report path was only ever an instruction. The owner's own nick is exempt
 * and posts without a limit.
 *
 * `MQTT_POST_MAX` overrides the cap per lane; 0 or less turns the cap off.
 */
export const POST_MAX_DEFAULT = 2500;

/** Cap from MQTT_POST_MAX, default 2500; a non-number keeps the default, <= 0 means no cap. */
export const postMax = (raw: string | undefined, fallback = POST_MAX_DEFAULT): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

/** The verdict on one outgoing post: the owner posts freely, everyone else fits under the cap. */
export const postLengthVerdict = (
  text: string,
  nick: string,
  ownerNick: string,
  max: number,
): { ok: true } | { ok: false; len: number; max: number } => {
  if (ownerNick && nick === ownerNick) return { ok: true };
  if (max <= 0) return { ok: true };
  return text.length > max ? { ok: false, len: text.length, max } : { ok: true };
};

/** What the lane reads when its post was too long. Nothing went out; the file is the way. */
export const postTooLongNote = (len: number, max: number): string =>
  // `len` is the TOTAL measured length, not the excess — a lane read "2684 characters over the 2500 cap"
  // as 2,684 characters OVER the limit and filed it as a defect (a canary report, 2026-10-08). State both
  // numbers unambiguously: the total, the cap, and the difference.
  `chat_post: refused — ${len} characters, ${len - max} over the ${max} cap, nothing was published. ` +
  `Post one verdict line plus the path to your report file; the long form belongs in that file.`;

/**
 * Duplicate suppression for room lines (owner order 2026-10-07, verbatim: "i want these things to
 * not appear in the room"). Four copies of one dispatch had been read in the room: a message
 * arriving more than once must render ONCE. The cause found that day was a room tap registering its
 * message handler inside the connect handler, so every reconnect added another handler and one
 * message printed once per handler - same text, same timestamp, N lines. Whatever the delivery
 * path, an id we have already taken is a repeat, so every reader keeps one of these lists.
 *
 * An id-less line (an older client that predates ids) is never called a duplicate: there is
 * nothing to compare, and dropping real text is worse than showing a repeat.
 */
export const SEEN_IDS_MAX = 200;

/** `{ dup, seen }`: was this id already taken, and what does the ledger look like afterwards? */
export const noteRoomId = (
  seen: readonly string[],
  id: string | undefined,
  cap = SEEN_IDS_MAX,
): { dup: boolean; seen: string[] } => {
  const leaf = (id ?? "").trim();
  if (!leaf) return { dup: false, seen: [...seen] };
  if (seen.includes(leaf)) return { dup: true, seen: [...seen] };
  const next = [...seen, leaf];
  return { dup: false, seen: next.length > cap ? next.slice(next.length - cap) : next };
};

/**
 * Per-message receipt board (P6): the flat control topic holds a receipt only
 * while it flies past, so a lead that restarts knows nothing about the dispatches
 * it missed. MQTT keeps the LAST retained payload per topic, so pinning one
 * receipt per message id lets the broker hand the whole set to a late joiner.
 *
 * SHAPE (ii) — receipts under the sender (tabichat#10). The board used to be
 * `chat/<room>/_ctl/<message-id>`: ONE topic that every lane
 * wrote, which is why an ACL could not scope it to the writer and any authenticated peer could
 * write a receipt for an id it does not own. The topic is now
 * `chat/<room>/_ctl/<acknowledging-nick>/<message-id>`, so a narrow per-nick WRITE grant covers
 * exactly what a lane owns and refuses everything else — measured both ways in
 * `tools/test_ack_watch_broker.ts`, and the grant itself is `docs/broker/mint-tabichat-pki.sh`.
 *
 * THREE THINGS THIS DOES NOT CHANGE, all of them measured rather than assumed, because a protocol
 * change that quietly moves the read side is the regression this row is about:
 *  - THE READ SIDE IS UNCHANGED. Every client already subscribes the single wildcard
 *    `chat/<room>/_ctl/#` (`index.ts:1236`), and `#` matches across levels, so an old peer hears a
 *    new-shaped receipt and a new peer hears an old-shaped one. The narrow grant is on the WRITE.
 *  - `ackKey` is `id|by` — it never contained a topic — so the dedupe of the two copies of one
 *    receipt survives untouched, and the requester's lookup stays ONE step: it scans the receipts it
 *    has heard by id, it does not subscribe per-id and never did.
 *  - `sanitizeAckId` is applied to the id leaf as before. The NEW level is the nick, which goes
 *    through the SAME function, because a nick containing `/`, `+` or `#` would otherwise address a
 *    level it does not own — the exact hazard `adminResultTopic` already documents for ids.
 *
 * WHAT IT DOES COST, and it is the reason the owner priced this at a day: N lanes acknowledging one
 * message used to collapse into ONE retained payload and now occupy N topics. That is the board
 * behaving as P6 always wanted (a late joiner sees every receipt, not the last), but it is
 * unbounded without a clear path, so `receiptClears` below is part of this shape and not an
 * optional extra.
 */
export const ackTopic = (room: string, by: string, id: string): string => {
  const who = sanitizeAckId(by ?? "");
  const leaf = sanitizeAckId(id);
  // An unusable nick is NOT silently promoted to the old flat shape: a receipt that lands on
  // `_ctl/<id>` is exactly the forgery-addressable topic this change exists to remove. No board
  // entry instead, and the flat control-topic receipt still went out at the call site.
  return who && leaf ? `${controlTopic(room)}/${who}/${leaf}` : "";
};

/**
 * The clear path for the per-sender board (AC3). A retained message is cleared by publishing an
 * EMPTY payload to that exact topic, and under shape (ii) only the writer of its own leaf can do
 * that — which is the grant working, not a limitation. So each lane tracks what IT pinned and ages
 * it out; the board is then bounded by (lanes x window), not by uptime.
 *
 * The window is a knob (`MQTT_ACK_RETAIN_MS`) for one reason: a lane that wants the historical
 * answer for longer than an hour can ask for it, and 0 means "empty the board at the next sweep" rather
 * than "never". Bound is a backstop, not the mechanism — a lane that acks furiously still gets its
 * list trimmed, and a trim is REPORTED (see `clearStale`'s caller), because a silent trim here would
 * leak retained receipts forever and read as the broker's fault.
 */
export const ACK_RETAIN_ENV = "MQTT_ACK_RETAIN_MS";
export const ACK_RETAIN_DEFAULT_MS = 60 * 60_000;
export const ACK_RETAIN_MAX = 256;

/** One retained board entry this lane wrote and will have to clear. */
export interface PinnedAck {
  topic: string;
  ts: number;
}

/** Remember a board entry we own. A blank topic (an unusable nick or id) is not pinnable. */
export const pinAck = (
  pinned: readonly PinnedAck[],
  topic: string,
  ts: number,
  cap = ACK_RETAIN_MAX,
): { pinned: PinnedAck[]; dropped: number } => {
  const t = (topic ?? "").trim();
  if (!t) return { pinned: [...pinned], dropped: 0 };
  const kept = pinned.filter((x) => x.topic !== t);
  kept.push({ topic: t, ts });
  const dropped = kept.length > cap ? kept.length - cap : 0;
  return { pinned: dropped ? kept.slice(dropped) : kept, dropped };
};

/**
 * Which pinned entries have aged out and must be cleared, and which stay. `now - ts >= windowMs`
 * matches the watchdog's boundary on purpose (`>=`, not `>`), and window 0 means "clear everything",
 * not "never" — stated because a reader who assumes the other convention writes the opposite cell.
 */
export const receiptClears = (
  pinned: readonly PinnedAck[],
  now: number,
  windowMs: number,
): { keep: PinnedAck[]; clear: PinnedAck[] } => {
  if (!(windowMs >= 0)) return { keep: [...pinned], clear: [] };
  const keep: PinnedAck[] = [];
  const clear: PinnedAck[] = [];
  for (const x of pinned) (now - x.ts >= windowMs ? clear : keep).push(x);
  return { keep, clear };
};

/** An empty retained payload on the exact topic is MQTT's clear. Never a JSON tombstone. */
export const clearPayload = (): string => "";

/**
 * THE ACK WATCHDOG — tabichat#10. `ackTopic` and `adminResultTopic` are RETAINED CHILD topics
 * (`_ctl/<id>` and `_ctl/admin/<id>`), and a publish the broker's ACL refuses at QoS 0 is dropped
 * with **no error event, no socket close and no line in the broker's log** — measured, not quoted:
 * on the loopback fixture at `docs/broker/acl.conf` phase 2 the publisher saw zero signal while all
 * three child writes vanished, and the same three writes were carried under phase 1. `docs/
 * the "ACL order can go silently wrong" section of `docs/tls-operations.md` states the rule the
 * measurement confirms — cited by heading, because a line number in a comment is a timer.
 *
 * So "did my receipt leave my socket?" is unanswerable from the publish call, and a lane that
 * believes a swallowed receipt is a lane that believes a work order was received when nothing was.
 * What IS observable: the extension already subscribes `_ctl/#`, and mosquitto echoes a client's
 * OWN carried publish back to it. Measured on the same fixture — phase 1, 3 of 3 child topics came
 * back to the publishing client; phase 2, 0 of 3. That echo is the delivery signal, and it costs
 * nothing on the wire: no topic changes, no id-space changes, nothing an older peer must implement.
 *
 * These functions are the decision only. They hold no timer and touch no socket, so the gate can
 * drive them through every corner (settled, expired, never-arrived, capped) without a broker, and
 * the broker cell proves the echo premise the design rests on. Three limits are deliberate: an
 * EMPTY window turns the watch off (a lane on a slow link can opt out rather than get false alarms);
 * the list is BOUNDED, and an overflow drops the OLDEST entries and says how many; and a topic that
 * settles after it expired is simply absent — a late echo is not a retraction of a real alarm.
 */
export const ACK_WATCH_ENV = "MQTT_ACK_WATCH_MS";
export const ACK_WATCH_DEFAULT_MS = 3000;
export const ACK_WATCH_MAX = 64;

/** One retained control-child publish this lane has handed the broker and not yet seen come back. */
export interface AckWatch {
  topic: string;
  /** what it was, so the alarm can name the act rather than a bare topic */
  kind: string;
  ts: number;
}

/** Register one watched publish. A blank topic is not watchable and changes nothing. */
export const watchAck = (
  pending: readonly AckWatch[],
  topic: string,
  kind: string,
  ts: number,
  cap = ACK_WATCH_MAX,
): { pending: AckWatch[]; dropped: number } => {
  const t = (topic ?? "").trim();
  if (!t) return { pending: [...pending], dropped: 0 };
  // one entry per topic: a re-publish of the same retained child (a retry, a reconnect flush)
  // replaces its own watch rather than stacking a second alarm for one delivery.
  const kept = pending.filter((x) => x.topic !== t);
  kept.push({ topic: t, kind, ts });
  const dropped = kept.length > cap ? kept.length - cap : 0;
  return { pending: dropped ? kept.slice(dropped) : kept, dropped };
};

/**
 * The broker carried it: our own publish came back on the subscription. Returns the list WITHOUT
 * that topic, and whether anything actually settled — `settled: false` on a topic nobody was
 * watching is normal (every other lane's receipt echoes to us too) and must never look like a miss.
 */
export const settleAck = (
  pending: readonly AckWatch[],
  topic: string,
): { pending: AckWatch[]; settled: boolean } => {
  const t = (topic ?? "").trim();
  const hit = pending.some((x) => x.topic === t);
  return { pending: hit ? pending.filter((x) => x.topic !== t) : [...pending], settled: hit };
};

/** Split the watch list into what is still in flight and what has aged past the window. */
export const expireAcks = (
  pending: readonly AckWatch[],
  now: number,
  windowMs: number,
): { live: AckWatch[]; lost: AckWatch[] } => {
  if (!(windowMs > 0)) return { live: [...pending], lost: [] };
  const live: AckWatch[] = [];
  const lost: AckWatch[] = [];
  for (const x of pending) (now - x.ts >= windowMs ? lost : live).push(x);
  return { live, lost };
};

/**
 * The alarm. It names the act, the topic, the age, and the ONE cause a lane can act on (the broker
 * refused the write), and it says what is NOT known — a slow broker and a refused publish look the
 * same from here, so the line must not claim a verdict the client cannot reach.
 */
/** How many swallowed topics one alarm NAMES before collapsing to a count. Four is a full board. */
export const ACK_ALARM_MAX = 4;

export const ackLostLine = (lost: readonly AckWatch[], now: number): string => {
  if (!lost.length) return "";
  // the age of the OLDEST miss is the honest one to quote: it is the longest any of them has been
  // unconfirmed, and a range per entry would read as noise on the only channel that survives it.
  const oldest = lost.reduce((a, x) => (x.ts < a.ts ? x : a), lost[0]);
  const age = Math.max(0, Math.round(now - oldest.ts));
  // name EVERY miss up to the cap, kind and topic together. A line that says "2 publishes, first
  // one was X" tells a lane which receipt to distrust and leaves the other anonymous — and the
  // whole point of this alarm is that an anonymous swallowed receipt is the bug it replaces.
  const named = lost
    .slice(0, ACK_ALARM_MAX)
    .map((x) => `"${x.kind}" on ${x.topic} (unconfirmed ${Math.max(0, Math.round(now - x.ts))}ms)`)
    .join("; ");
  const more = lost.length > ACK_ALARM_MAX ? `; +${lost.length - ACK_ALARM_MAX} more this window` : "";
  return `NOT DELIVERED: ${lost.length} control publish${lost.length > 1 ? "es" : ""} this lane handed ` +
    `the broker never came back to its own _ctl/# subscription — the broker accepted the bytes and ` +
    `dropped them, which is what an ACL refusal at QoS 0 looks like (no error, no close, no ` +
    `broker-log line). Lost: ${named}${more}. Nothing was acknowledged and no peer was told: a ` +
    `receipt in this list was NEVER delivered, so nobody may claim the message it answers arrived, ` +
    `and an admin outcome in it left the requester staring at a window that will time out. Check ` +
    `the broker's acl_file grant for the child topics (docs/broker/acl.conf, item 2, and the ` +
    `"ACL order can go silently wrong" section of docs/tls-operations.md — cited by heading, ` +
    `because a line number in a string outlives the edit that moved it). A slow broker can look ` +
    `identical from here, so treat this as "unconfirmed", never as proof.`;
};

/** What makes two receipts the same event: one lane acknowledging one message. */
export const ackKey = (a: Pick<Ack, "id" | "by">): string => `${a.id}|${a.by}`;

/**
 * Add one receipt to a bounded log. The same receipt arrives twice in normal
 * operation — once flying past on the flat topic, once handed over retained from
 * the per-message board — and must read as ONE delivery, so an existing entry for
 * the same lane+message is replaced by the newer stamp rather than duplicated.
 */
export const recordAck = (log: readonly Ack[], a: Ack, cap = 50): Ack[] => {
  const key = ackKey(a);
  const kept = log.filter((x) => ackKey(x) !== key);
  kept.push(a);
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
};

/** One rendered receipt line. */
export const renderAck = (a: Ack): string =>
  `[${tsLabel(a.ts)} ack] ${a.by} received ${a.id} (sent by ${a.to})`;

export interface AckQuery {
  /** message id to look up, or `<message id>|<lane>` for one lane's receipt */
  id?: string;
  /** only receipts newer than this many minutes */
  sinceMin?: number;
  limit?: number;
  nowMs?: number;
  cap?: number;
}

/** Newest last. A query that matches nothing returns [], which is an answer. */
export const queryAcks = (log: readonly Ack[], q: AckQuery = {}): Ack[] => {
  let rows = [...log];
  if (q.id) {
    const want = q.id.trim();
    rows = rows.filter((a) => a.id === want || ackKey(a) === want);
  }
  if (q.sinceMin && q.sinceMin > 0) {
    const cut = (q.nowMs ?? Date.now()) - q.sinceMin * 60_000;
    rows = rows.filter((a) => a.ts >= cut);
  }
  const n = Math.min(Math.max(q.limit ?? 10, 1), q.cap ?? 50);
  return rows.slice(-n);
};
