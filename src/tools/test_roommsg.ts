// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the room message plumbing (P2-P5).
//   bun tools/test_roommsg.ts      (exit 1 on any failure)
// Positive and negative halves both required: each rule gets the case that must
// pass AND the case that must be rejected.
import {
  ackKey,
  ackPayload,
  ackTopic,
  ageLabel,
  authorVerdict,
  bootTag,
  ackLostLine,
  ACK_RETAIN_DEFAULT_MS,
  ACK_RETAIN_ENV,
  ACK_RETAIN_MAX,
  clearPayload,
  pinAck,
  type PinnedAck,
  receiptClears,
  ACK_WATCH_DEFAULT_MS,
  ACK_WATCH_ENV,
  ACK_WATCH_MAX,
  ACK_ALARM_MAX,
  AckWatch,
  controlTopic,
  expireAcks,
  queryAcks,
  settleAck,
  watchAck,
  recordAck,
  renderAck,
  renderInbound,
  roomPayload,
  sanitizeAckId,
  type Ack,
  expandMe,
  foldToOneLine,
  isAck,
  inboxTally,
  legacyPresenceTopic,
  lineTag,
  msgId,
  msgTopic,
  msgWild,
  nickFromMsgTopic,
  noteRoomId,
  planInbound,
  postLengthVerdict,
  postMax,
  postTooLongNote,
  peerRecordWins,
  peerState,
  peerAge,
  renderPeersBoard,
  PEERS_INSTRUMENT,
  presenceTopic,
  presenceWild,
  renderLine,
  renderPeers,
  takeUnseen,
  pushRoomLine,
  lastSeq,
  tsLabel,
  type PeerSeen,
  type RoomLine,
} from "../extensions/tabichat/roommsg.ts";
import { recipientField, receives } from "../extensions/tabichat/mention.ts";

let failed = 0;
let okCount = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else {
    okCount++;
    console.log(`ok    ${name}: ${g}`);
  }
};

// --- P4: one line per message, pasted blocks folded -------------------------
check("plain text passes through", foldToOneLine("one line only"), "one line only");
check(
  "pasted block folds to ONE message",
  foldToOneLine("first line\nsecond line\nthird line"),
  "first line second line third line",
);
check("blank lines drop out", foldToOneLine("a\n\n\nb\n"), "a b");
check("CRLF pasted from Windows folds", foldToOneLine("a\r\nb\r\n"), "a b");
check("space runs collapse", foldToOneLine("too    many     spaces"), "too many spaces");
check("tabs collapse", foldToOneLine("a\t\tb"), "a b");
check("whitespace-only becomes empty (refused upstream)", foldToOneLine("  \n\t "), "");
check("empty stays empty", foldToOneLine(""), "");
check("{me} expands then folds", expandMe("hi\n{me} here", "ultra"), "hi ultra here");
check(
  "{me} in a one-line message still works",
  expandMe("{me} ready", "ultra"),
  "ultra ready",
);

// --- P2: ids, control topic, acks ------------------------------------------
// The boot tag is the whole point of these checks. `msgSeq` restarts at 0 in every
// session of a lane (index.ts), so an id built from nick+seq alone is handed to TWO
// different messages, and receipts are filed by id — so a lookup reports a delivery that
// belongs to the lane's earlier message. Observed live: two receipts 8h44m apart for one
// id (flash1-11), one of them from a message the reader had never seen.
check("message id carries nick, seq and boot", msgId("ultra", 7, "a1b2c3"), "ultra-7-a1b2c3");
// arity is the guard: a third parameter with a default value would let a call site go on
// minting ids without a boot tag, which is the bug wearing a new signature
check("msgId demands three arguments", msgId.length, 3);
check(
  "ids differ per seq within one boot",
  msgId("ultra", 7, "a1b2c3") !== msgId("ultra", 8, "a1b2c3"),
  true,
);
check(
  "one seq in two boots cannot collide (a restarted lane)",
  msgId("flash1", 11, "a1b2c3") !== msgId("flash1", 11, "d4e5f6"),
  true,
);
check("boot tag is fixed-width hex, drawn deterministically", bootTag(() => 0), "000000");
check("boot tag uses the whole draw", bootTag(() => 0.5), "080000");
// Math.random() never returns 1, so the largest reachable draw is just under
// 0x100000; padded it still lands inside six chars.
check("the largest draw still fits six chars", bootTag(() => 0.9999999), "0fffff");
check(
  // shape (ii), leg 496: the board entry lives under the ACKNOWLEDGING lane, so the same id written
  // by two lanes occupies two topics and neither can overwrite the other.
  "receipt board topic takes a boot-tagged id unchanged, under the acknowledger's leaf",
  ackTopic("tabith", "ultra", "ultra-7-a1b2c3"),
  "chat/tabith/_ctl/ultra/ultra-7-a1b2c3",
);
{
  // THE COLLISION THAT THE OLD SHAPE HAD, measured rather than asserted: one id, two writers. Under
  // `_ctl/<id>` both writers addressed the SAME topic, so MQTT's one-retained-payload-per-topic rule
  // meant the second ack erased the first and a late joiner could be told "only flash3 got it".
  const a = ackTopic("tabith", "flash3", "lead-agent-17");
  const b = ackTopic("tabith", "clerk", "lead-agent-17");
  check("two lanes acking ONE id get TWO different topics (the collapse is gone)", a !== b, true);
  check("and neither topic is the old forgery-addressable flat child", [a, b].some((t) => t === "chat/tabith/_ctl/lead-agent-17"), false);
}
{
  // both halves: two boots of one seq, receipts from two lanes. Neither receipt may be
  // read as the other's, and neither may replace the other.
  const morning = msgId("flash1", 11, "a1b2c3");
  const tonight = msgId("flash1", 11, "d4e5f6");
  let log = recordAck([], ackPayload(morning, "dust", "flash1", 1000), 50);
  log = recordAck(log, ackPayload(tonight, "lead-agent", "flash1", 2000), 50);
  check("receipts of two boots both stay on the board", log.length, 2);
  check(
    "lookup by one boot's id returns only that message's receipts",
    queryAcks(log, { id: tonight, limit: 10 }).map((a) => a.by),
    ["lead-agent"],
  );
  // the reject half of "two processes differ": the mint must be deterministic, or every
  // double arrival would read as a different message and dedupe would die
  check(
    "same inputs mint the same id (no hidden per-call state)",
    msgId("flash1", 11, "a1b2c3"),
    morning,
  );
  // dedupe still holds on a tagged id: the flat topic and the retained board hand the same
  // receipt over twice, and that must read as ONE delivery (recordAck's documented case)
  let twice = recordAck([], ackPayload(tonight, "dust", "flash1", 3000), 50);
  twice = recordAck(twice, ackPayload(tonight, "dust", "flash1", 3500), 50);
  check("a tagged id's double arrival still collapses to one receipt", twice.length, 1);
  check(
    "a tagged id's double arrival keeps the newer stamp",
    queryAcks(twice, { id: tonight, limit: 10 }).map((a) => a.ts),
    [3500],
  );
  check(
    "the id|lane query form still resolves a tagged id",
    queryAcks(twice, { id: `${tonight}|dust`, limit: 10 }).length,
    1,
  );
  check(
    "the id|lane form rejects a lane that never acked",
    queryAcks(twice, { id: `${tonight}|lead-agent`, limit: 10 }).length,
    0,
  );
  // since_min still cuts on time with tagged ids in the log
  check(
    "since_min keeps what is inside the window",
    queryAcks(log, { sinceMin: 1, limit: 10, nowMs: 2000 }).map((a) => a.ts),
    [1000, 2000],
  );
  check(
    "since_min drops what is older than the window",
    queryAcks(log, { sinceMin: 1, limit: 10, nowMs: 200_000 }),
    [],
  );
}
check("control topic is not the room topic", controlTopic("tabith"), "chat/tabith/_ctl");
check(
  "control topic is outside the room topic",
  controlTopic("tabith") !== "chat/tabith",
  true,
);
const ack = ackPayload("flash1-3", "ultra", "flash1", 1000);
check("ack shape", ack, { kind: "ack", id: "flash1-3", to: "flash1", by: "ultra", ts: 1000 });
check("well-formed ack is accepted", isAck(ack), true);
check("ack missing id is rejected", isAck({ kind: "ack", by: "ultra" }), false);
check("wrong kind is rejected", isAck({ kind: "chat", id: "x", by: "y" }), false);
check("null is rejected", isAck(null), false);

// --- P5: per-nick presence, liveness ---------------------------------------
check("per-nick presence topic", presenceTopic("tabith", "flash1"), "chat/tabith/presence/flash1");
check(
  "two nicks get two retained records",
  presenceTopic("tabith", "flash1") !== presenceTopic("tabith", "flash2"),
  true,
);
check("wildcard covers the per-nick form", presenceWild("tabith"), "chat/tabith/presence/#");
check(
  "per-nick topic is inside the wildcard (and not equal to the legacy topic)",
  presenceTopic("tabith", "flash1").startsWith(legacyPresenceTopic("tabith") + "/"),
  true,
);

const now = 1_000_000_000_000;
const seen = (status: string, ts: number): PeerSeen => ({ status, ts });
check("no record held: any record lands", peerRecordWins(undefined, seen("online", 500)), true);
check(
  "an unstamped record cannot outrank a stamped one",
  peerRecordWins(seen("online", 500), seen("offline", 0)),
  false,
);
check(
  "a stamped record outranks an unstamped one",
  peerRecordWins(seen("online", 0), seen("offline", 500)),
  true,
);
check("newer stamp wins", peerRecordWins(seen("online", 500), seen("offline", 600)), true);
check("older stamp is refused", peerRecordWins(seen("online", 600), seen("offline", 500)), false);
check("unstamped may replace unstamped", peerRecordWins(seen("online", 0), seen("offline", 0)), true);
check("fresh beat reads online", peerState(seen("online", now - 5_000), now), "online");
check(
  "an unstamped record proves no liveness (stale, not online)",
  peerState(seen("online", 0), now),
  "stale",
);
check("beat older than the allowance reads stale", peerState(seen("online", now - 91_000), now), "stale");
check("unknown peer reads offline", peerState(undefined, now), "offline");
check("explicit offline reads offline", peerState(seen("offline", now), now), "offline");
check(
  "an old OFFLINE record does not become stale-but-present",
  peerState(seen("offline", now - 10 * 60_000), now),
  "offline",
);
check("a peer clock slightly ahead reads online", peerState(seen("online", now + 30_000), now), "online");
// THE FIDELITY PAIR (R-2717 item 3, the s305 lesson). The stamp is the PEER'S clock and the age is
// taken against OURS, so a record further ahead than one whole allowance is not a beat that can be
// timed — it is a clock this seat cannot rank. It used to read `online`, permanently, for as long as
// the skew held the age negative: a seat whose process was gone stayed live on the peers board and
// this office staffed lanes off it. An unrankable stamp is `stale` now, and it says so in its age.
check(
  "a stamp ahead by more than the allowance is not proof of life (stale, not online)",
  peerState(seen("online", now + 10 * 60_000), now),
  "stale",
);
check(
  "a stamp ahead by exactly the allowance still ranks (the bound is not a cliff in the unsafe direction)",
  peerState(seen("online", now + 90_000), now),
  "online",
);
check(
  "PAIRED NEGATIVE — an explicit offline beats a fresh-looking stamp: the stamp is not the claim",
  peerState(seen("offline", now + 10 * 60_000), now),
  "offline",
);
check(
  "PAIRED NEGATIVE — a future stamp does not make a missing record live",
  peerState(undefined, now),
  "offline",
);
check("a beat 42s old prints its age", peerAge(seen("online", now - 42_000), now), "42s");
check(
  "THE ROW NAMING THAT LIED: a future stamp used to clamp to '0s', which reads as just-now — it prints its skew instead",
  peerAge(seen("online", now + 600_000), now),
  "ahead 10m00s",
);
check("an unstamped row says unstamped, never an age", peerAge(seen("online", 0), now), "no stamp");
check(
  "the listing carries the skew, not a clamped zero",
  renderPeers([["flash7", seen("online", now + 600_000)]] as [string, PeerSeen][], now, "ultra"),
  ["? flash7 stale ahead 10m00s"],
);
check("age label seconds", ageLabel(42_000), "42s");
check("age label minutes", ageLabel(192_000), "3m12s");
check("age label hours", ageLabel(7_500_000), "2h05m");
check("age label never goes negative", ageLabel(-5_000), "0s");
const listing = renderPeers(
  [
    ["ultra", seen("online", now)],
    ["flash1", seen("online", now - 10_000)],
    ["flash2", seen("online", now - 400_000)],
    ["flash3", seen("offline", now - 1_000)],
  ] as [string, PeerSeen][],
  now,
  "ultra",
);
check("self is left out of the listing", listing.some((l) => l.includes("ultra")), false);
check(
  "an unstamped peer says so instead of inventing an age",
  renderPeers([["flash9", seen("online", 0)]] as [string, PeerSeen][], now, "ultra"),
  ["? flash9 stale no stamp"],
);
check(
  "listing lines read <mark> <nick> <state> <age>",
  listing.map((l) => l.split(" ").slice(1, 3)),
  [
    ["flash1", "online"],
    ["flash2", "stale"],
    ["flash3", "offline"],
  ],
);
check(
  "online peers sort before stale, stale before offline",
  listing.map((l) => l.split(" ")[2]),
  ["online", "stale", "offline"],
);
check(
  "markers: live peer is *, quiet peer is ?, gone peer is -",
  listing.map((l) => l.split(" ")[0]),
  ["*", "?", "-"],
);

// --- presence fidelity: the surface names its own instrument (R-2717 item 3) ----------------
// The rows alone read as a census of the room, and a census is a claim about processes. Nothing here
// looks at a process: the reading is the last beat THIS seat heard, ranked against THIS seat's clock.
// The board now prints that sentence with the rows — and on the empty face, which is the one that was
// acted on twice.
const board = renderPeersBoard(
  [
    ["ultra", seen("online", now)],
    ["flash1", seen("online", now - 10_000)],
    ["flash2", seen("online", now - 400_000)],
  ] as [string, PeerSeen][],
  now,
  "ultra",
  "dust-6",
);
check("the board still renders every peer row", board.includes("* flash1 online 10s"), true);
check(
  "and it states the instrument, verbatim, beside the rows",
  board.split("\n").some((l) => l === PEERS_INSTRUMENT),
  true,
);
check(
  "the instrument sentence names the two things it actually measured",
  [PEERS_INSTRUMENT.includes("beat THIS seat heard"), PEERS_INSTRUMENT.includes("not a process check")],
  [true, true],
);
check("the board counts its rows and says how many were stamped", board.includes("rows: 2 (stamped: 2; unstamped: 0)"), true);
check(
  "PAIRED — an unstamped record is counted as unstamped, not silently ranked as life",
  renderPeersBoard([["flash9", seen("online", 0)]] as [string, PeerSeen][], now, "ultra", "dust-6").includes(
    "rows: 1 (stamped: 0; unstamped: 1)",
  ),
  true,
);
const empty = renderPeersBoard([["ultra", seen("online", now)]] as [string, PeerSeen][], now, "ultra", "dust-6");
check(
  "THE FACE THAT COST TWO LANES: an empty board says it heard nothing, and never that the room is empty",
  [
    empty.includes("no other peer heard of in dust-6"),
    empty.includes("this seat's subscription, not about the room"),
    empty.includes(PEERS_INSTRUMENT),
  ],
  [true, true, true],
);

// --- P3: timestamps and the unseen cursor ----------------------------------
check("timestamp renders HH:MM:SS", /^\d{2}:\d{2}:\d{2}$/.test(tsLabel(now)), true);
check(
  "rendered line carries the time and the nick",
  renderLine({ nick: "flash1", message: "hello", ts: now }),
  `[${tsLabel(now)} chat:flash1] hello`,
);
// --- the RECIPIENT FIELD on the rendered line (owner request 2026-10-16) -----------------------
// A line that carries a field must show it, so chat_read reports the real addressee instead of
// letting a lane infer one from prose. It renders as `to=<value>`, NEVER as `@<value>`: the `@`
// form is the body token this change makes inert, and a broadcast must not read as one here.
check(
  "a field-bearing line shows its addressee",
  renderLine({ nick: "wren", message: "@wren go", ts: now, to: "flash1" }),
  `[${tsLabel(now)} chat:wren to=flash1] @wren go`,
);

// --- the recipient FIELD across the wire: publish -> JSON -> receive, no broker involved -------
// This is the only way to prove the field actually SURVIVES the transport instead of merely being
// named at a call site: a key dropped by the publisher, or read off the wrong name by the receiver,
// fails here. The reader set is the room; the line quotes addresses in prose on purpose.
const WIRE_TEXT = "verdict for @wren: 3 direct @flash5, 4 @all in my inbox";
const wireOf = (to: string | undefined): Record<string, unknown> =>
  JSON.parse(JSON.stringify(roomPayload({ nick: "librarian", message: WIRE_TEXT, id: "librarian-9-abcd12", ts: now, ...(to ? { to } : {}) })));
const wireReads = (payload: Record<string, unknown>, reader: string): boolean =>
  receives(recipientField(payload.to as string | undefined), payload.message as string, reader);

check("the publisher writes the field when an addressee was named", wireOf("wren").to, "wren");
check("NEGATIVE HALF — no addressee means no field key at all", "to" in wireOf(undefined), false);
check(
  "...and a fieldless payload is byte-identical to the shape older senders wrote",
  JSON.stringify(wireOf(undefined)),
  JSON.stringify({ nick: "librarian", message: WIRE_TEXT, id: "librarian-9-abcd12", ts: now }),
);
check("across the wire the field still addresses only its own reader", wireReads(wireOf("wren"), "wren"), true);
check(
  "THE DEFECT HALF — a seat quoted in that same body receives nothing across the wire",
  wireReads(wireOf("wren"), "courier"),
  false,
);
check(
  "...nor the seat whose nick sits in the prose with no field naming it",
  wireReads(wireOf("wren"), "flash5"),
  false,
);
check("a room-wide field still reaches every reader across the wire", wireReads(wireOf("all"), "courier"), true);
check(
  "DOCUMENTED LIMITATION HALF — a fieldless line decides by its body, so the quoted broadcast still reaches everyone",
  wireReads(wireOf(undefined), "courier"),
  true,
);
check(
  "...and that is exactly why the publisher must set the field: the same line WITH a field is inert prose",
  wireReads(wireOf("wren"), "courier"),
  false,
);
check(
  "...and a real broadcast typed with no field reaches everyone, as it always did",
  wireReads(JSON.parse(JSON.stringify(roomPayload({ nick: "wren", message: "@all hold comms", id: "wren-1-abcd12", ts: now }))), "courier"),
  true,
);
check(
  "the steer flag and the field are independent keys, both optional",
  JSON.stringify(wireOf("wren")).includes("steer"),
  false,
);
check(
  "...and a steer asked for lands beside the field",
  JSON.parse(JSON.stringify(roomPayload({ nick: "wren", message: "x", id: "wren-2-abcd12", ts: now, to: "flash1", steer: true }))).steer,
  true,
);
check(
  "NEGATIVE HALF — a fieldless line renders exactly as before (no invented addressee)",
  renderLine({ nick: "wren", message: "@flash1 go", ts: now }),
  `[${tsLabel(now)} chat:wren] @flash1 go`,
);
check(
  "...and a blank field renders as no field at all",
  renderLine({ nick: "wren", message: "hi", ts: now, to: "  " }),
  `[${tsLabel(now)} chat:wren] hi`,
);
check(
  "the broadcast field is shown as a field, not as a body token",
  renderLine({ nick: "wren", message: "hold", ts: now, to: "all" }).includes(" to=all"),
  true,
);
check(
  "the inbox line carries the field too, after the provenance tag",
  renderInbound({ nick: "wren", message: "@wren go", ts: now, id: "wren-2-0eff46", to: "flash1" }),
  `[chat:wren id=wren-2-0eff46 @${tsLabel(now)} to=flash1] @wren go`,
);
const buf = ["a", "b", "c"];
const first = takeUnseen(buf, 0);
check("unread lines come back once", first.lines, ["a", "b", "c"]);
check("cursor advances past what was handed over", takeUnseen(buf, first.cursor).lines, []);
check("a cursor mid-buffer resumes there", takeUnseen(buf, 2).lines, ["c"]);
check("a cursor past the end yields nothing, not the world", takeUnseen(buf, 99).lines, []);
check("a negative cursor is clamped, not sliced from the end", takeUnseen(buf, -1).lines, ["a", "b", "c"]);
check("the cursor still advances when nothing was new", takeUnseen(buf, 99).cursor, 3);

// --- LEG 804 D1: the unseen boundary is a MONOTONIC STAMP, not an index into a shifting window ---
// The defect (peer review 803, lead-verified on the OFFICIAL dev face with no journal at all):
// `cursor = buffer.length` is an absolute index; once `shift()` fires every later line lands BELOW
// the stored cursor and `unseen_only` is deaf FOREVER. Leg 800 made saturation the boot default
// (replay 50 == BUFFER_MAX 50), so it bit every busy seat every session. The fix is `pushRoomLine`
// stamping arrival numbers that never move, and `takeUnseen` comparing stamps, not positions.
{
  const CAP = 50;
  const win: RoomLine[] = [];
  for (let i = 1; i <= CAP; i++) pushRoomLine(win, { nick: "old", message: `pre ${i}`, ts: i }, CAP);
  let cursor = lastSeq(win); // a reader caught up at saturation: cursor 50, buffer 50
  let surfaced = 0;
  for (let j = 1; j <= 5; j++) {
    pushRoomLine(win, { nick: "wren", message: `live ${j}`, ts: 9000 + j }, CAP);
    const g = takeUnseen(win, cursor);
    cursor = g.cursor;
    surfaced += g.lines.length;
  }
  check("D1 ACCEPTANCE: a wrapped window still surfaces every later line (5/5, was 0/5 on dev)", surfaced, 5);
  check("D1: the window never exceeds the cap", win.length, CAP);
  check("D1: stamp mode is detected from the lines, not from a caller flag", takeUnseen(win, cursor).lines.length, 0);
  // replay-saturated boot (800's default state): history stays history — marked, never news —
  // and the five live lines AFTER it all surface (spec acceptance 2)
  const rb: RoomLine[] = [];
  for (let i = 0; i < CAP; i++) pushRoomLine(rb, { nick: "lead", message: `retained ${i}`, ts: 1000 + i, id: `h${i}`, hist: true }, CAP);
  const bootCursor = lastSeq(rb);
  let liveSurfaced = 0;
  let histLeak = 0;
  let liveCursor = bootCursor;
  for (let j = 1; j <= 5; j++) {
    pushRoomLine(rb, { nick: "wren", message: `live ${j}`, ts: 9000 + j, id: `l${j}` }, CAP);
    const g = takeUnseen(rb, liveCursor);
    liveCursor = g.cursor;
    histLeak += g.lines.filter((l) => l.hist).length;
    liveSurfaced += g.lines.filter((l) => !l.hist).length;
  }
  check("D1 after a replay-saturated boot: all 5 live lines surface", liveSurfaced, 5);
  check("D1 after a replay-saturated boot: no history line EVER surfaces as unseen", histLeak, 0);
  // NEGATIVE CONTROL (acceptance 3): the identical scenario with NO stamps — the shipped legacy
  // shape, which is what dev does today — MUST reproduce the deafness. If this cell ever goes
  // green-by-convergence, the instrument has stopped biting.
  const legacy: { nick: string; message: string }[] = [];
  for (let i = 1; i <= CAP; i++) legacy.push({ nick: "old", message: `pre ${i}` });
  let lc = legacy.length;
  let lsurfaced = 0;
  for (let j = 1; j <= 5; j++) {
    legacy.push({ nick: "wren", message: `live ${j}` });
    if (legacy.length > CAP) legacy.shift();
    const g = takeUnseen(legacy, lc);
    lc = g.cursor;
    lsurfaced += g.lines.length;
  }
  check("NEGATIVE CONTROL: the un-stamped index shape stays deaf (0/5) — proof the stamp is what closes D1", lsurfaced, 0);
  // a reader who NEVER saw a shift keeps the old experience exactly (acceptance 4)
  const small: RoomLine[] = [pushRoomLine([], { nick: "a", message: "1", ts: 1 }, 50)];
  const s1 = takeUnseen(small, 0);
  check("below the cap the read is the same one line, once", [s1.lines.length, s1.cursor], [1, 1]);
}

// --- P6: per-message retained receipts (a late joiner must still be able to ask) ---
const A = (id: string, by: string, to: string, ts: number) => ackPayload(id, by, to, ts);

check("sanitize keeps a normal id", sanitizeAckId("lead-agent-17"), "lead-agent-17");
check("sanitize keeps a dot inside", sanitizeAckId("v1.2-3"), "v1.2-3");
check("sanitize removes topic wildcards", sanitizeAckId("a/#b"), "a_b");
check("sanitize collapses a run of unsafe chars to one separator", sanitizeAckId("a  b"), "a_b");
check("sanitize removes dotdot", sanitizeAckId("../x"), "x");
check("sanitize blanks to empty", sanitizeAckId("   "), "");
check("ackTopic shape", ackTopic("tabith", "wren", "lead-agent-17"), "chat/tabith/_ctl/wren/lead-agent-17");
check("ackTopic refuses an unusable id", ackTopic("tabith", "wren", "  "), "");
// The NEW level is the writer's nick, and it is attacker-influenced only in the sense that it comes
// from MQTT_NICK at boot — still sanitised, because a nick that smuggles a level would aim the write
// somewhere the per-nick grant does not cover (or somewhere it does not own).
check("ackTopic refuses an unusable nick instead of falling back to the flat shape",
  ackTopic("tabith", "   ", "lead-agent-17"), "");
check("NEGATIVE THAT WOULD BE A SECURITY REGRESSION: a blank nick must NOT silently write `_ctl/<id>`",
  ackTopic("tabith", "", "lead-agent-17"), "");
// Values below are what the shipped sanitiser MEASURES (printed at this pen), not what a reader of
// the rule would guess. Two results are worth reading twice:
//  - "a/#" collapses to `a`, so the topic keeps ONE level and the wildcard is gone;
//  - a bare "#" or "+" sanitises to EMPTY, and empty means NO topic at all — a nick that would
//    wildcard the control tree produces an unwritable address, which is the refusal we want.
// The `../..` case is NOT a traversal: the dots are stripped, leaving `flash3`. That lands on another
// lane's leaf, which the BROKER then refuses because the write grant is per-nick — so this cell
// asserts the sanitiser's job (one level, no wildcard), and the grant is what test_ack_watch_broker.ts
// proves. Stating the division out loud, because a reader could otherwise take this cell to mean
// "no cross-lane write is possible at the client layer", which is not true and was never the design.
check("a nick carrying separators collapses to one safe leaf", ackTopic("tabith", "a/#", "x"), "chat/tabith/_ctl/a/x");
check("a bare wildcard nick yields NO topic (it cannot wildcard the control tree)", ackTopic("tabith", "#", "x"), "");
check("and neither does a single-level wildcard nick", ackTopic("tabith", "+", "x"), "");
check("dotdot is stripped, not treated as traversal (the broker's grant is the boundary, not this)",
  ackTopic("tabith", "../../flash3", "x"), "chat/tabith/_ctl/flash3/x");
check("a nick with spaces collapses to a single leaf", ackTopic("tabith", "a b/c", "x"), "chat/tabith/_ctl/a_b_c/x");
check("ackKey pairs message and lane", ackKey({ id: "lead-agent-17", by: "flash3" }), "lead-agent-17|flash3");

const flat = A("lead-agent-17", "flash3", "lead-agent", 1000);
const replayed = A("lead-agent-17", "flash3", "lead-agent", 1500);
const other = A("lead-agent-17", "flash1", "lead-agent", 1100);
check("same receipt twice collapses to one", recordAck([], flat).concat([]).length, 1);
check("flat then retained stays one", recordAck(recordAck([], flat), replayed).length, 1);
check("collapse keeps the newer stamp", recordAck(recordAck([], flat), replayed)[0].ts, 1500);
check("a different lane is a different receipt", recordAck(recordAck([], flat), other).length, 2);
const five = [1, 2, 3, 4, 5].reduce((log, n) => recordAck(log, A(`m-${n}`, "flash3", "lead", n * 100), 3), [] as Ack[]);
check("bounded log drops the oldest", five.length, 3);
check("bounded log keeps the newest", five[2].id, "m-5");
check("bounded log drops the newest-oldest", five[0].id, "m-3");

check("query newest last", queryAcks(five, { limit: 2, nowMs: 1000 }).map((a) => a.id), ["m-4", "m-5"]);
check("query by id finds it", queryAcks(five, { id: "m-4", nowMs: 1000 }).map((a) => a.id), ["m-4"]);
check("query by id answers empty for a receipt the cap dropped", queryAcks(five, { id: "m-1", nowMs: 1000 }).length, 0);
check("query by id rejects a miss", queryAcks(five, { id: "m-9", nowMs: 1000 }).length, 0);
check("query by id|nick finds it", queryAcks(recordAck([], other), { id: "lead-agent-17|flash1", nowMs: 1000 }).length, 1);
check("query by id|nick rejects the wrong lane", queryAcks(recordAck([], other), { id: "lead-agent-17|flash9", nowMs: 1000 }).length, 0);
const nowT = 1_700_000_000_000;
const spread: Ack[] = [A("s-old", "flash3", "lead", nowT - 5 * 60_000), A("s-mid", "flash3", "lead", nowT - 2 * 60_000), A("s-new", "flash3", "lead", nowT - 30_000)];
check("query window keeps the recent, drops the stale", queryAcks(spread, { sinceMin: 3, nowMs: nowT }).map((a) => a.id), ["s-mid", "s-new"]);
check("query window to one minute keeps only the newest", queryAcks(spread, { sinceMin: 1, nowMs: nowT }).map((a) => a.id), ["s-new"]);
check("query window with everything old answers empty", queryAcks(spread, { sinceMin: 1, nowMs: nowT + 60 * 60_000 }).length, 0);
check("query limit is clamped to the cap", queryAcks(five, { limit: 99, cap: 3, nowMs: 1000 }).length, 3);
check("receipt renders one line", renderAck(flat).endsWith(" ack] flash3 received lead-agent-17 (sent by lead-agent)"), true);
check("receipt line has no newline", renderAck(flat).includes("\n"), false);

// --- 2026-10-07 duplicate room lines (owner order, verbatim: "i want these things to not appear in
// the room"). A message that arrives more than once must render once, in a lane and in a tap.
check("first sight of an id is not a duplicate", noteRoomId([], "lead-agent-3-0bb40d").dup, false);
check("...and it enters the ledger", noteRoomId([], "lead-agent-3-0bb40d").seen, ["lead-agent-3-0bb40d"]);
check("second sight of the same id IS a duplicate", noteRoomId(["lead-agent-3-0bb40d"], "lead-agent-3-0bb40d").dup, true);
check("a duplicate does not grow the ledger", noteRoomId(["a"], "a").seen.length, 1);
check("a different seq from the same lane is not a duplicate", noteRoomId(["a-1-x"], "a-2-x").dup, false);
check("the same seq under a different boot tag is not a duplicate", noteRoomId(["a-1-aaaaaa"], "a-1-bbbbbb").dup, false);
check("an id-less line is never called a duplicate", noteRoomId(["a"], undefined).dup, false);
check("an id-less line leaves the ledger untouched", noteRoomId(["a"], undefined).seen, ["a"]);
check("a blank id counts as no id", noteRoomId(["a"], "   ").dup, false);
check("the ledger is bounded to the cap", noteRoomId(["a", "b", "c"], "d", 3).seen, ["b", "c", "d"]);
check("the caller's array is never mutated", (() => { const base = ["a"]; const r = noteRoomId(base, "b"); return JSON.stringify([base, r.seen]); })(), '[["a"],["a","b"]]');

// --- the room-post length cap: the owner's own posts are unlimited, agents are
// capped, at 1500 first and 2500 now — the refusal behavior is unchanged. Paired halves:
// the owner is exempt, a lane is not; the boundary is exact.
// NOTE for whoever re-pairs these next: the literal 1500s in the recordAck cells above ("replayed",
// "collapse keeps the newer stamp") are EPOCH-STYLE TIMESTAMPS, not the cap — they are not this rule.
const longText = (n: number) => "x".repeat(n);
check("cap default is the owner's number", postMax(undefined), 2500);
check("cap override parses", postMax("400"), 400);
check("cap junk keeps the default", postMax("banana"), 2500);
check("cap 0 means no cap", postLengthVerdict(longText(9000), "flash1", "dust", postMax("0")).ok, true);
check("cap negative means no cap", postLengthVerdict(longText(9000), "flash1", "dust", -1).ok, true);
check("agent post under the cap is accepted", postLengthVerdict(longText(2499), "flash1", "dust", 2500).ok, true);
check("agent post AT the cap is accepted (boundary)", postLengthVerdict(longText(2500), "flash1", "dust", 2500).ok, true);
check("agent post one over the cap is refused", postLengthVerdict(longText(2501), "flash1", "dust", 2500).ok, false);
check("...and the refusal reports length and cap", postLengthVerdict(longText(2600), "lead-agent", "dust", 2500), { ok: false, len: 2600, max: 2500 });
check("NEGATIVE HALF — the owner posts unlimited", postLengthVerdict(longText(50000), "dust", "dust", 2500).ok, true);
check("a lane named like the owner is not exempt by accident", postLengthVerdict(longText(2501), "dusty", "dust", postMax(undefined)).ok, false);
check("no owner nick configured means nobody is exempt", postLengthVerdict(longText(2501), "dust", "", postMax(undefined)).ok, false);
check("the refusal names the file as the place for long text", postTooLongNote(2600, 2500).includes("report file"), true);
check("the refusal says nothing was published", postTooLongNote(2600, 2500).includes("nothing was published"), true);
// Wording law (canary ultra, 2026-10-08): the old text read "2684 characters over the 2500 cap", which a
// lane reads as 2,684 characters OVER the limit. The note must state the total, the excess, and the cap as
// three distinct facts so no lane has to guess which number is which.
check("the refusal states the total, not as if it were the excess", postTooLongNote(2600, 2500).includes("2600 characters, 100 over the 2500 cap"), true);
check("the refusal never says 'N characters over the M cap' with N as the total", /\d+ characters over the/.test(postTooLongNote(2600, 2500)), false);

// --- 2026-10-08 provenance on inbound lines. A lane published six re-dispatches it had never
// received, and nothing inside that lane could refute it: the only message ids a lane ever saw
// were the ones its own posts printed, and the invented ids copied exactly that shape. Every
// inbound line now carries the same id and stamp chat_read will show for it.
const stamp = 1_759_900_000_000;
const leadLine: RoomLine = {
  nick: "lead-agent",
  message: "@anna first ticket order",
  ts: stamp,
  id: "lead-agent-2-0eff46",
};
check("the tag carries the message id", lineTag("lead-agent-2-0eff46", stamp).includes("id=lead-agent-2-0eff46"), true);
check("...and the same stamp chat_read shows for that line", lineTag("lead-agent-2-0eff46", stamp), ` id=lead-agent-2-0eff46 @${tsLabel(stamp)}`);
check("an id-less line says id=none instead of hiding the gap", lineTag(undefined, stamp), ` id=none @${tsLabel(stamp)}`);
check("a blank id says id=none too", lineTag("   ", stamp), ` id=none @${tsLabel(stamp)}`);
check(
  "an inbound line reads [chat:<nick> id=<id> @HH:MM:SS] text",
  renderInbound(leadLine),
  `[chat:lead-agent id=lead-agent-2-0eff46 @${tsLabel(stamp)}] @anna first ticket order`,
);
check(
  "NEGATIVE HALF — no id is invented for a line that arrived without one",
  renderInbound({ ...leadLine, id: undefined }).includes("id=none"),
  true,
);

// --- the tally: the count a lane used to assert from memory, now computed from the wire
check("one mention tallies as one", inboxTally([leadLine]), "lead-agent x1");
check("a real repeat (distinct ids) tallies as two", inboxTally([leadLine, { ...leadLine, id: "lead-agent-3-0eff46" }]), "lead-agent x2");
check("senders are counted separately", inboxTally([leadLine, { nick: "dust", message: "@anna stop", ts: stamp, id: "dust-1-aaaaaa" }]), "lead-agent x1, dust x1");
check("NEGATIVE HALF — an empty inbox tallies as nothing, never as a guess", inboxTally([]), "");

// --- the injection law: a lane does not need to see all chat
// messages in the room (the ones it missed since its last turn). it needs only the
// change message addressed to @its-nick or @all, and that is the rule. Both halves: an addressed line is injected,
// an unaddressed line is never injected, and the old flood header is gone from the tree.
const unaddressed: RoomLine = { nick: "flash1", message: "@lead-agent report landed", ts: stamp, id: "flash1-1-0a1d1f" };
check("an addressed line is injected", planInbound({ mentioned: true, head: "", line: leadLine }).kind, "inject");
check(
  "...as its own provenance line and nothing else",
  planInbound({ mentioned: true, head: "", line: leadLine }),
  { kind: "inject", body: renderInbound(leadLine) },
);
check(
  "a steered mention keeps its header ahead of the line",
  planInbound({ mentioned: true, head: "STEER-HEADER\n\n", line: leadLine }),
  { kind: "inject", body: `STEER-HEADER\n\n${renderInbound(leadLine)}` },
);
check("NEGATIVE HALF — an unaddressed line is never injected", planInbound({ mentioned: false, head: "", line: unaddressed }), { kind: "buffer-only" });
check("...not even when a steer header was already prepared", planInbound({ mentioned: false, head: "STEER-HEADER\n\n", line: unaddressed }), { kind: "buffer-only" });
check(
  "no plan hands over the old room-lines flood block",
  JSON.stringify([
    planInbound({ mentioned: true, head: "", line: leadLine }),
    planInbound({ mentioned: false, head: "", line: unaddressed }),
  ]).includes("room lines since your last turn"),
  false,
);

// THE VERDICT MOVED TO THE END OF THIS FILE. It sat here, above 58 more `check()` calls (the shape-(B)
// per-sender block and the whole 496 AC3 block), so a FAIL in any of them printed and the process still
// exited 0. Same class as the laneadmin defect, booked on this leg with it.

// ---------------------------------------------------------------------------
// Shape (B) per-sender topics (features/tabichat-mqtt-broker-auth.md —
// "shape B chosen (no impersonation + lock)"). The topic leaf IS the author, because the broker's
// ACL lets only the matching authenticated identity write it — measured on the loopback fixture in
// tools/test_broker_auth.ts. So the builders are load-bearing and get both halves:
//   - a nick that cannot be a topic leaf must yield "" (an empty leaf would aim the publish at
//     `chat/<room>/msg/`, a topic nobody subscribes, which is a silently lost post);
//   - `msg/+` reads every sender, and a line on `msg/<leaf>` reports that leaf and nothing else —
//     `msg/a/b` and `msg/` are not senders.
// ---------------------------------------------------------------------------
console.log("\n== shape B: per-sender topics ==");
check("msgTopic builds the sender leaf", msgTopic("tabith", "wren"), "chat/tabith/msg/wren");
check("msgWild reads every sender", msgWild("tabith"), "chat/tabith/msg/+");
check("a nick with a separator in it cannot forge a topic level", msgTopic("tabith", "a/b"), "chat/tabith/msg/ab");
check("a nick of nothing topic-safe yields empty, not a mis-routed publish", msgTopic("tabith", "/#"), "");
check("an empty nick yields empty", msgTopic("tabith", ""), "");
check("a nick padded with spaces still finds itself", msgTopic("tabith", "  flash6 "), "chat/tabith/msg/flash6");
check("nickFromMsgTopic reports the author the broker asserted", nickFromMsgTopic("chat/tabith/msg/flash6", "tabith"), "flash6");
check("a flat room topic is not a sender topic", nickFromMsgTopic("chat/tabith", "tabith"), "");
check("a two-level leaf is not a sender", nickFromMsgTopic("chat/tabith/msg/a/b", "tabith"), "");
check("an empty leaf is not a sender", nickFromMsgTopic("chat/tabith/msg/", "tabith"), "");
check("the wildcard subscription itself is not a sender", nickFromMsgTopic("chat/tabith/msg/+", "tabith"), "+");
check("another room's topic reports nothing", nickFromMsgTopic("chat/other/msg/wren", "tabith"), "");
// The dual-read collapse: a line that arrives on BOTH the flat topic and the sender topic during the
// migration window must still render once. That is noteRoomId's job and it is asserted here because
// the pairing is what makes dual-read safe to ship before single-write does.
{
  const id = "wren-7-a84e80";
  let seen: string[] = [];
  const first = noteRoomId(seen, id);
  seen = first.seen;
  const second = noteRoomId(seen, id);
  check("dual-read: the same id on the second topic is a duplicate", [first.dup, second.dup], [false, true]);
  const third = noteRoomId(seen, undefined);
  check("dual-read: an id-less line is never called a duplicate", third.dup, false);
}

// authorVerdict is the rule the socket path consults (index.ts), so it is checked HERE rather than
// only through a live broker: what a lane DOES with a disagreement has to be as testable as what the
// broker does, or the client half of shape (B) ships unverified.
console.log("\n== shape B: authorVerdict (topic-first, and loud on a conflict) ==");
const avFlat = authorVerdict("chat/tabith", "tabith", "wren");
check("a flat-topic line is delivered with the payload nick (phase 1's limit, named)", [avFlat.ok, avFlat.author, avFlat.mismatch], [true, "wren", false]);
const avOwn = authorVerdict("chat/tabith/msg/wren", "tabith", "wren");
check("own leaf agrees with the payload: delivered, no ceremony", [avOwn.ok, avOwn.author, avOwn.mismatch], [true, "wren", false]);
const avClash = authorVerdict("chat/tabith/msg/wren", "tabith", "flash6");
check("a leaf and payload that disagree are REFUSED", avClash.ok, false);
check("the refusal keeps the authenticated author, not the typed one", avClash.author, "wren");
check("and it says both names, so a lane can act on it", (avClash as { why: string }).why.includes('asserts "wren"'), true);
check("the refusal is flagged as a mismatch", avClash.mismatch, true);
const avNoNick = authorVerdict("chat/tabith/msg/ultra", "tabith", "");
check("a payload with no nick still lands, authored by the topic", [avNoNick.ok, avNoNick.author], [true, "ultra"]);
check("but the lane is told where the author came from", avNoNick.mismatch, true);
const avOther = authorVerdict("chat/other/msg/wren", "tabith", "wren");
check("another room's sender topic is not ours: falls back to the flat rule", [avOther.ok, avOther.author, avOther.mismatch], [true, "wren", false]);

// ─── tabichat#10 THE ACK WATCHDOG ────────────────────────────────────────────────────────────
// The decision half only. What the BROKER does with a refused QoS 0 write is proven physically in
// test_broker_auth.ts; these cells prove that the client can tell carried from swallowed, and that
// the alarm fires on the right side of every boundary. Each check that asserts "no alarm" is a
// paired negative for the one beside it — an alarm that always fires is as useless as one that
// never does, and here the always-fires version would make every lane doubt every receipt it holds.
console.log("\n== #10 ack watchdog: register, settle, expire, alarm ==");
const P0: AckWatch[] = [];
const T0 = 1_000_000;
const ctlT = "chat/tabith/_ctl/flash4-1-abc123";

const w1 = watchAck(P0, ctlT, "delivery receipt", T0);
check("a publish is registered as one watched topic", [w1.pending.length, w1.dropped], [1, 0]);
check("NEGATIVE: a blank topic registers NOTHING (an unusable id must not raise a false alarm)",
  watchAck(P0, "", "delivery receipt", T0).pending.length, 0);
check("NEGATIVE: a whitespace-only topic is the same blank", watchAck(P0, "   ", "x", T0).pending.length, 0);

const s1 = settleAck(w1.pending, ctlT);
check("the self-echo SETTLES the watch — that is the delivery signal", s1.settled, true);
check("and the topic is gone, so no later sweep can alarm on a carried publish", s1.pending.length, 0);
check("NEGATIVE: an echo of a topic nobody watched is NOT an alarm and NOT a settle",
  [settleAck(s1.pending, "chat/tabith/_ctl/somebody-else").settled, settleAck(P0, "x").pending.length],
  [false, 0]);

// settled against s1.pending, the list AFTER the first echo — not w1.pending, the list BEFORE it.
// My first draft of this cell passed w1.pending and read `true`, i.e. it re-settled a topic that was
// still watched, and the paired negative it was supposed to be became a copy of the positive. Same
// class the fleet books: an instrument whose baseline is the wrong input still returns a confident
// answer, and here the confident answer was the wrong one.
const s2 = settleAck(s1.pending, ctlT);
check("a SECOND echo of the same topic settles nothing (a re-delivery is not a second delivery)",
  [s2.settled, s2.pending.length], [false, 0]);

const e1 = expireAcks(w1.pending, T0 + 2999, ACK_WATCH_DEFAULT_MS);
check("NEGATIVE (boundary): at 2,999ms under a 3,000ms window it is still LIVE, no alarm",
  [e1.lost.length, e1.live.length], [0, 1]);
const e2 = expireAcks(w1.pending, T0 + ACK_WATCH_DEFAULT_MS, ACK_WATCH_DEFAULT_MS);
check("at exactly the window it is LOST — the boundary is >=, not >", [e2.lost.length, e2.live.length], [1, 0]);
check("and the lost entry carries the topic and the act so the alarm can name them",
  [e2.lost[0].topic, e2.lost[0].kind], [ctlT, "delivery receipt"]);

const e3 = expireAcks(w1.pending, T0 + 50_000, 0);
check("NEGATIVE: window 0 means the watch is OFF — never alarm, never lose", [e3.lost.length, e3.live.length], [0, 1]);
check("NEGATIVE: a negative window is the same off state",
  expireAcks(w1.pending, T0 + 50_000, -5).lost.length, 0);

const alarm = ackLostLine(e2.lost, T0 + ACK_WATCH_DEFAULT_MS);
check("the alarm names the act, the age, and the only cause a lane can act on",
  [alarm.includes("NOT DELIVERED"), alarm.includes("delivery receipt"), alarm.includes("3000ms"),
    alarm.includes("acl"), alarm.includes(ctlT)].every(Boolean), true);
check("it says the delivery NEVER happened, in words a lane cannot read as success",
  alarm.includes("Nothing was acknowledged"), true);
check("and it refuses to over-claim: a slow broker looks identical from here",
  alarm.includes("slow broker"), true);
check("NEGATIVE: no lost entries, no alarm text — an empty list must not print a phantom",
  ackLostLine([], T0), "");
const two = watchAck(watchAck(P0, ctlT, "delivery receipt", T0).pending, "chat/tabith/_ctl/admin/b", "admin outcome", T0 + 1);
const al2 = ackLostLine(two.pending, T0 + ACK_WATCH_DEFAULT_MS);
check("the alarm COUNTS them…", al2.includes("2 control publishes"), true);
check("…and names EVERY miss, kind AND topic, not just the first (an anonymous swallowed receipt is the bug this alarm replaces)",
  [al2.includes("delivery receipt"), al2.includes("admin outcome"), al2.includes(ctlT),
    al2.includes("chat/tabith/_ctl/admin/b")].every(Boolean), true);
check("…each with its OWN unconfirmed age, since they were published at different times",
  [al2.includes("3000ms"), al2.includes("2999ms")].every(Boolean), true);
// NEGATIVE PAIR for the collapse clause: under the cap there is NO "+N more", so the clause cannot
// be a constant that always prints (the same "filter that filters nothing" trap, applied to a string).
check("NEGATIVE: nothing is collapsed at the cap boundary — no '+N more' when the count is under it",
  al2.includes("more this window"), false);
const over = Array.from({ length: ACK_ALARM_MAX + 2 }, (_, i) => ({ topic: `t${i}`, kind: `k${i}`, ts: T0 + i }));
const alOver = ackLostLine(over, T0 + ACK_WATCH_DEFAULT_MS);
check("and ABOVE the cap it names the first four and COUNTS the rest, so the total is never lost",
  [alOver.includes(`"k0" on t0`), alOver.includes(`"k${ACK_ALARM_MAX - 1}" on t${ACK_ALARM_MAX - 1}`),
    // the NEGATIVE half of the same clause: the entries past the cap are NOT named — and if this
    // asserted the opposite it would be checking that the cap does not exist.
    !alOver.includes(`t${ACK_ALARM_MAX}`), alOver.includes(`+2 more this window`),
    alOver.includes(`${over.length} control publishes`)].every(Boolean), true);

const re = watchAck(w1.pending, ctlT, "delivery receipt", T0 + 500);
check("a re-publish of the SAME topic replaces its own watch instead of stacking two alarms",
  [re.pending.length, re.dropped], [1, 0]);
const capT = watchAck(
  Array.from({ length: ACK_WATCH_MAX }, (_, i) => ({ topic: `t${i}`, kind: "k", ts: T0 + i })),
  "overflow", "k", T0 + 999,
);
check("the bound bites and the overflow is REPORTED, never a silent trim",
  [capT.pending.length, capT.dropped, capT.pending[0].topic, capT.pending[capT.pending.length - 1].topic],
  [ACK_WATCH_MAX, 1, "t1", "overflow"]);
check("NEGATIVE: the same list under the cap reports dropped 0 — the counter is not always nonzero",
  watchAck(Array.from({ length: 3 }, (_, i) => ({ topic: `t${i}`, kind: "k", ts: i })), "x", "k", 9).dropped, 0);

check("the env knob is the documented one and the default is the shipped window",
  [ACK_WATCH_ENV, ACK_WATCH_DEFAULT_MS], ["MQTT_ACK_WATCH_MS", 3000]);

/* wrapped in a block on purpose: the sections above declare `now`, `r1`, `P0` at file scope,
   and reusing a name in a 700-line test file is a redeclaration that kills the whole run.
   Sharing the file's `check` keeps the reporting identical. */
{
// ─── leg 496 AC3 — the clear path, which is not optional under shape (ii) ───────────────────────
// Under `_ctl/<id>` N acks collapsed into one retained payload; under `_ctl/<nick>/<id>` they are N
// retained payloads. That is the board doing what P6 always wanted, and it is also unbounded growth
// unless every lane clears what it pinned. So the clear path is part of the shape, and these cells are
// the reason the AC3 physical run has something to be testing.
console.log("\n== 496 AC3: pin, age, clear ==");
const PIN0: PinnedAck[] = [];
const now = 2_000_000;
const p1 = pinAck(PIN0, "chat/t/_ctl/wren/m1", now);
check("a board entry I wrote is remembered so I can clear it later", [p1.pinned.length, p1.dropped], [1, 0]);
check("NEGATIVE: a blank topic is not pinnable (an unusable leaf must not become a phantom clear)",
  pinAck(PIN0, "", now).pinned.length, 0);
const p2 = pinAck(p1.pinned, "chat/t/_ctl/wren/m1", now + 500);
check("re-acking the same id replaces my own entry rather than stacking two clears",
  [p2.pinned.length, p2.pinned[0].ts], [1, now + 500]);
const aged = pinAck(pinAck(PIN0, "a", now - 70_000).pinned, "b", now - 5_000).pinned;
const r1 = receiptClears(aged, now, 60_000);
check("the aged entry is due to clear, the young one stays", [r1.clear.length, r1.keep.length], [1, 1]);
check("NEGATIVE (boundary): at exactly the window it is due — `>=`, the same convention as the watchdog",
  receiptClears([{ topic: "a", ts: now - 60_000 }], now, 60_000).clear.length, 1);
check("NEGATIVE: one millisecond short is NOT cleared (a board must not evaporate early)",
  receiptClears([{ topic: "a", ts: now - 59_999 }], now, 60_000).clear.length, 0);
check("window 0 means clear-everything, not never — the convention the docs state",
  receiptClears(aged, now, 0).clear.length, 2);
check("and a NEGATIVE window is the off switch: nothing ages out",
  [receiptClears(aged, now, -1).clear.length, receiptClears(aged, now, -1).keep.length], [0, 2]);
check("the clear payload is EMPTY, not a JSON tombstone (an object would keep the entry alive)",
  clearPayload(), "");
const over = Array.from({ length: ACK_RETAIN_MAX }, (_, i) => ({ topic: `t${i}`, ts: now + i }));
const p3 = pinAck(over, "newest", now + 999);
check("the pin list is BOUNDED and the overflow is reported, never silently trimmed",
  [p3.pinned.length, p3.dropped, p3.pending === undefined, p3.pinned[p3.pinned.length - 1].topic],
  [ACK_RETAIN_MAX, 1, true, "newest"]);
check("NEGATIVE: the same list under the cap reports dropped 0 — the counter is not always nonzero",
  pinAck([{ topic: "x", ts: 1 }], "y", 2).dropped, 0);
// AC3's real question is not "can one entry be cleared" (the broker run answers that physically) but
// "does the board STOP GROWING". Shape (ii) replaces one overwritten payload with one topic per
// (lane, message), so an unbounded board is a leak on the control plane. This simulates a lane that
// acks 10,000 messages inside one process lifetime and asserts the retained set stays bounded by the
// cap AND empties when the window passes — the two mechanisms that make accumulation stop.
{
  let board: PinnedAck[] = [];
  let held = 0, droppedTotal = 0, cleared = 0;
  const W = 60_000, T0 = 10_000_000;
  for (let i = 0; i < 10_000; i++) {
    const r = pinAck(board, `chat/t/_ctl/wren/m${i}`, T0 + i * 1_000);   // one ack per second
    board = r.pinned; droppedTotal += r.dropped;
    held = Math.max(held, board.length);
    const c = receiptClears(board, T0 + i * 1_000 + 1, W);                // sweep on the same tick
    cleared += c.clear.length; board = c.keep;
  }
  check("AC3 accumulation STOPS: 10,000 acks never grow the board past the cap",
    [held <= ACK_RETAIN_MAX, held > 0], [true, true]);
  check("AC3 and the aged entries really are released (cleared > 0, final board holds only the young tail)",
    [cleared > 0, board.length <= Math.ceil(W / 1_000) + 1], [true, true]);
  // MEASURED, not guessed: pin at 1/s, sweep at +1ms with a 60s window, and `receiptClears` ages on
  // `now - ts >= W`, so 60 entries are inside the window and the 61st is the one just released — peak 61,
  // settled 60. My first draft typed 60 for both and went red on correct bytes: that is the same
  // over-narrow-assertion class as a line-number cite.
  check("AC3 the board PLATEAUS at (window x rate), not at the cap — a normal lane never reaches the backstop",
    [held, droppedTotal, board.length], [61, 0, 60]);
  check("AC3 NEGATIVE (the instrument can bite): with the clear window OFF and no backstop, the SAME loop grows without bound — so it is the window that stops accumulation, not luck",
    (() => { let b: PinnedAck[] = []; for (let i = 0; i < 1_000; i++) b = pinAck(b, `x${i}`, T0 + i * 1_000, 1_000_000).pinned; return [b.length, receiptClears(b, T0 + 2_000, -1).clear.length]; })(),
    [1_000, 0]);
}
check("the knob is the documented one and the default is an hour, not a day or a minute",
  [ACK_RETAIN_ENV, ACK_RETAIN_DEFAULT_MS], ["MQTT_ACK_RETAIN_MS", 3_600_000]);

}

// ─── THE VERDICT, AT THE END ────────────────────────────────────────────────────────────────────
// Nothing above this line may exit. See the note where the old block used to sit: 58 checks were
// running after the verdict and their failures could not reach the exit code.
console.log();
if (failed) {
  console.log(`${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log(`all checks pass (${okCount} cells)`);
}
