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

/** Control traffic (acks, liveness) lives OUT of the room so it never reads as chat. */
export const controlTopic = (room: string): string => `chat/${room}/_ctl`;
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
}

/** One rendered room line: [HH:MM:SS chat:nick] text */
export const renderLine = (l: RoomLine): string =>
  `[${tsLabel(l.ts)} chat:${l.nick}] ${l.message}`;

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

/** How a lane sees one inbound line: [chat:<nick> id=<id> @HH:MM:SS] text */
export const renderInbound = (l: RoomLine): string =>
  `[chat:${l.nick}${lineTag(l.id, l.ts)}] ${l.message}`;

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
 * capped, at 1500 first and 2500 now — raised on the lead's
 * recommendation "RAISE to ~2500 — keep the refusal, never lift", after three posts bounced at 1500 in
 * one round and a 1,792-character merge order died inside a refused draft. The REFUSAL IS THE POINT AND
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
  `chat_post: refused — ${len} characters over the ${max} cap, nothing was published. ` +
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
 */
export const ackTopic = (room: string, id: string): string => {
  const leaf = sanitizeAckId(id);
  return leaf ? `${controlTopic(room)}/${leaf}` : "";
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
