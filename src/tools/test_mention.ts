// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for room addressing: the recipient FIELD, the legacy body scan, and the seam between
// them. The rule this table guards, in the requester's own words: broadcasting is a property
// of the RECIPIENT FIELD only, and an address quoted in the body is inert while a field is set.
//   bun  tools/test_mention.ts                                (exit 1 on any failure)
//   node --experimental-strip-types tools/test_mention.ts     (no bun on this box — same result)
// Positive and negative halves both required: a gate that only passes the
// positive case is untested.

import { ALL_LANES, addressedTo, mentions, recipientField, receives } from "../extensions/tabichat/mention.ts";

let failed = 0;
let ran = 0;

/** One assertion, reported the same way everywhere: got vs want, JSON-compared. */
const check = (name: string, got: unknown, want: unknown): void => {
  ran++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok    ${name}: ${g}`);
  }
};

// ============================ 1. THE LEGACY BODY SCAN ==========================================
// `mentions()` is the whole-body scan. It survives as the FIELDLESS path only (a human
// tabichat_cli.py line — it publishes no `to` field — /say, a pre-field sender); rows 1a-1c are its own whole-token discipline.
type Case = { text: string; nick: string; want: boolean; why: string };

const CASES: Case[] = [
  // positive: direct mentions
  { text: "@lane1 read the file", nick: "lane1", want: true, why: "leading mention" },
  { text: "@LANE1 read the file", nick: "lane1", want: true, why: "case-insensitive" },
  { text: "hey @lane1, go", nick: "lane1", want: true, why: "mid-line, trailing comma" },
  { text: "@lane1.", nick: "lane1", want: true, why: "sentence-final full stop" },
  { text: "@lead-agent ack", nick: "lead-agent", want: true, why: "hyphenated nick" },
  // positive: room-wide mention
  { text: "@all say PING", nick: "lane10", want: true, why: "@all wakes every lane" },
  { text: "@ALL ship it", nick: "lane10", want: true, why: "@all case-insensitive" },
  { text: "@all: one line only", nick: "lane10", want: true, why: "@all + colon" },
  // negative: another lane's mention
  { text: "@lane2 read the file", nick: "lane1", want: false, why: "mention for someone else" },
  { text: "asked @lane2 and @lane3", nick: "lane1", want: false, why: "no mention of us" },
  { text: "no mentions here", nick: "lane1", want: false, why: "plain room line" },
  // negative: prefix traps (the defect this matcher fixes)
  { text: "@lane1z go", nick: "lane1", want: false, why: "longer nick must not match" },
  { text: "@lane1x go", nick: "lane1", want: false, why: "name char follows" },
  { text: "@lead go", nick: "lead", want: true, why: "a bare @lead IS a mention of nick 'lead'" },
  { text: "@lead-agent go", nick: "lead", want: false, why: "@lead inside @lead-agent" },
  { text: "@allen go", nick: "all", want: false, why: "@all inside @allen (fixed defect)" },
  { text: "@allen go", nick: "lane10", want: false, why: "room-wide path: @allen must not wake @all" },
  { text: "@allow that", nick: "all", want: false, why: "@all inside @allow (fixed defect)" },
  { text: "@allow that", nick: "lane10", want: false, why: "room-wide path: @allow must not wake @all" },
  { text: "@all-fix the room", nick: "lane10", want: false, why: "hyphen is a name char: @all-fix is a different token" },
  { text: "owner@all.example", nick: "lane10", want: false, why: "e-mail, not a mention" },
];

for (const c of CASES) {
  ran++;
  const got = mentions(c.text, c.nick);
  if (got !== c.want) {
    failed++;
    console.log(`FAIL  [${c.nick}] ${JSON.stringify(c.text)} -> ${got}, want ${c.want}  (${c.why})`);
  } else {
    console.log(`ok    [${c.nick}] ${JSON.stringify(c.text)} -> ${got}  (${c.why})`);
  }
}

// ============================== 2. THE RECIPIENT FIELD ===========================================
// `receives(to, text, nick)` is the ONE delivery decision: index.ts calls it for the inject gate
// AND for the receipt gate, so every row below is also a statement about who publishes a receipt.
type FieldCase = { text: string; to: string | undefined; nick: string; want: boolean; why: string };

// the body of the reported defect, verbatim in shape: a verdict QUOTING addresses in prose
const DEFECT_TEXT = "lane10 report: 3 direct @lane5, 4 @all) — tally of my inbox";

const FIELD_CASES: FieldCase[] = [
  // THE REPORTED DEFECT: field set, quoted prose inert
  { text: DEFECT_TEXT, to: "lane11", nick: "lane12", want: false, why: "THE reported defect: a quoted token in a body must not deliver" },
  { text: DEFECT_TEXT, to: "lane11", nick: "lane5", want: false, why: "...nor does a quoted own-nick" },
  { text: DEFECT_TEXT, to: "lane11", nick: "lane15", want: false, why: "...nor any third seat" },
  { text: DEFECT_TEXT, to: "lane11", nick: "lane11", want: true, why: "the field's own addressee still receives" },
  { text: DEFECT_TEXT, to: "@lane11", nick: "lane11", want: true, why: "a leading @ in the field is the same address" },
  { text: DEFECT_TEXT, to: "LANE11", nick: "lane11", want: true, why: "the field is case-folded" },
  { text: "@lane2 look", to: "lane11", nick: "lane2", want: false, why: "a field for lane11 beats a real @lane2 in the body — body is inert" },
  // an intended broadcast survives, off the field alone
  { text: DEFECT_TEXT, to: ALL_LANES, nick: "lane12", want: true, why: "intended broadcast reaches every seat (the stated intent)" },
  { text: "hold all comms while the lead seat refreshes", to: ALL_LANES, nick: "lane2", want: true, why: "broadcast with no token in the body at all" },
  { text: DEFECT_TEXT, to: "@ALL", nick: "lane10", want: true, why: "broadcast field is case-folded and @-tolerant too" },
  // field discipline: whole tokens, same NAME_CHARS rule as the text path
  { text: "x", to: "allen", nick: "all", want: false, why: "field 'allen' is not the all-lanes value" },
  { text: "x", to: "allen", nick: "lane10", want: false, why: "field 'allen' names no seat here, and must not wake the room" },
  { text: "x", to: "all-fix", nick: "lane10", want: false, why: "field 'all-fix' must not wake the room" },
  { text: "x", to: "lane1", nick: "lane1z", want: false, why: "shorter field must not wake the longer nick" },
  { text: "x", to: "lane1z", nick: "lane1", want: false, why: "longer field must not wake the shorter nick" },
  { text: "x", to: "lead", nick: "lead-agent", want: false, why: "field 'lead' does not name 'lead-agent'" },
  { text: "x", to: "lead-agent", nick: "lead", want: false, why: "...nor the other way round" },
  { text: "x", to: "lane14, lane12", nick: "lane14", want: true, why: "a comma list names both addressees" },
  { text: "x", to: "lane14, lane12", nick: "lane12", want: true, why: "...and the second one" },
  { text: "x", to: "lane14, lane12", nick: "lane1", want: false, why: "...and nobody else" },
  // LEGACY PATH: no field => the body scan still decides (human tabichat_cli.py, /say, old clients)
  { text: "@all ping", to: undefined, nick: "lane12", want: true, why: "legacy: a real broadcast with no field still reaches the room" },
  { text: "@lane2 look", to: undefined, nick: "lane1", want: false, why: "legacy negative half still holds" },
  { text: "@lane2 look", to: undefined, nick: "lane2", want: true, why: "legacy positive half still holds" },
  { text: "no mentions here", to: "", nick: "lane1", want: false, why: "a blank field is no field: the scan finds nothing" },
  { text: "@lane1 go", to: "", nick: "lane1", want: true, why: "NEGATIVE HALF on the blank-field guard: an empty field must not silence a line" },
  { text: "@lane1 go", to: "@", nick: "lane1", want: true, why: "a field naming nobody is treated as no field, not as a black hole" },
  { text: "@lane1 go", to: "!!!", nick: "lane1", want: true, why: "...same for punctuation only" },
  // DOCUMENTED LIMITATION, stated and not hidden: a FIELDLESS post that quotes the all-lanes token
  // in prose still delivers to everyone. This is exactly why chat_post must set the field, and why
  // the body-@all conduct rule stays useful until every sender is field-bearing.
  { text: DEFECT_TEXT, to: undefined, nick: "lane10", want: true, why: "DOCUMENTED LIMITATION: fieldless + a token in prose still delivers" },
];

for (const c of FIELD_CASES) {
  ran++;
  const got = receives(c.to, c.text, c.nick);
  if (got !== c.want) {
    failed++;
    console.log(`FAIL  field=${JSON.stringify(c.to)} [${c.nick}] ${JSON.stringify(c.text)} -> ${got}, want ${c.want}  (${c.why})`);
  } else {
    console.log(`ok    field=${JSON.stringify(c.to)} [${c.nick}] ${JSON.stringify(c.text)} -> ${got}  (${c.why})`);
  }
}

// addressedTo() alone, so a field failure names the matcher rather than the fallback
check("addressedTo: field names the reader", addressedTo("lane11", "lane11"), true);
check("addressedTo: field names the room", addressedTo(ALL_LANES, "lane12"), true);
check("NEGATIVE HALF — addressedTo never reads the body", addressedTo("lane11", "lane12"), false);

// ============================== 3. RECEIPT FAN-OUT ===============================================
// The ack gate fires on the SAME `receives()` decision (index.ts), so the set of seats that publish
// a receipt for one send is exactly what this filters. Before this change, a token quoted in prose
// made every seat answer one dispatch; one field must produce receipts from its addressee(s) only.
const ROSTER = ["lane11", "lane12", "lane1", "lane2", "lane5", "lane15", "lane10", "lane17"];
const ackSet = (to: string | undefined, text: string): string[] =>
  ROSTER.filter((n) => receives(to, text, n));

const FANOUT: { to: string | undefined; text: string; want: string[]; why: string }[] = [
  { to: "lane11", text: DEFECT_TEXT, want: ["lane11"], why: "one field, one receipt, despite two quoted tokens in the body" },
  { to: "lane14, lane12", text: "x", want: ["lane12"], why: "a two-name field acks only the seat that is on this roster (lane14 is not)" },
  { to: ALL_LANES, text: DEFECT_TEXT, want: ROSTER, why: "an intended broadcast still acks from every seat" },
  { to: undefined, text: DEFECT_TEXT, want: ROSTER, why: "LIMITATION HALF: fieldless + a quoted token fans out again" },
  { to: undefined, text: "@lane2 look", want: ["lane2"], why: "a legacy fieldless line acks exactly the seat it names" },
];

for (const f of FANOUT) {
  ran++;
  const got = ackSet(f.to, f.text);
  if (JSON.stringify(got) !== JSON.stringify(f.want)) {
    failed++;
    console.log(`FAIL  acks field=${JSON.stringify(f.to)} -> [${got.join(", ")}], want [${f.want.join(", ")}]  (${f.why})`);
  } else {
    console.log(`ok    acks field=${JSON.stringify(f.to)} -> [${got.join(", ")}]  (${f.why})`);
  }
}

// ========================= 4. WHAT chat_post PUTS ON THE WIRE ====================================
// chat_post normalizes `to:` through recipientField() before publishing it, so these are the
// publisher's own rules, not the receiver's. An empty result means NO field goes on the wire.
check("a named addressee is published trimmed", recipientField("  lane11  "), "lane11");
check("a leading @ is dropped from the field", recipientField("@all"), ALL_LANES);
check("a comma list is kept as one field", recipientField("lane14, lane12"), "lane14, lane12");
check("no addressee publishes no field", recipientField(undefined), "");
check("NEGATIVE HALF — an @ alone is not an addressee", recipientField("@"), "");
check("NEGATIVE HALF — blanks are not an addressee", recipientField("   "), "");
check("NEGATIVE HALF — a field is never invented from nothing", recipientField("!!!"), "");

console.log(
  failed
    ? `\n${failed}/${ran} check(s) FAILED`
    : `\nall ${ran} checks pass (${CASES.length} legacy scan + ${FIELD_CASES.length} field + 3 matcher + ${FANOUT.length} fan-out + 7 publisher)`,
);
process.exitCode = failed ? 1 : 0;
