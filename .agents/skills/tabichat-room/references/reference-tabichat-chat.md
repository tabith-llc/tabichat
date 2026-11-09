# tabichat room mechanism — the numbers, and the call that prints each one

Every value below is a reading of the shipped source, not a remembered figure. Re-derive it the same turn you
quote it: a number in a document is a claim about a tree, and the tree moves.

**Which tree.** `src/extensions/tabichat/` is the shipped extension. `preview-ext/tabichat/` carries a smaller
preview copy with symbols of the same name; a claim about behaviour a lane actually sees is a claim about the
`src/` path, so cite that one.

## 1. Self-detection: is chat live at all?

| question | test | what it proves |
|---|---|---|
| Am I a harness session? | `PI_CODING_AGENT` in your own environment | pi sets it for child processes; your own `env` is yours to read. |
| Do I have the room tools? | a `chat_read` call returns | the extension is loaded **and** the broker connection is open. This is the only in-band proof. |
| Is the extension merely loaded? | your tool list shows `chat_post` | NOT proof of a connection. The tool factory runs at extension load, before the `--tabichat` gate: `index.ts` registers the tools and its `session_start` handler is what checks `pi.getFlag("tabichat")` and a room. Tool presence = loaded, not live. |
| Which room? | never infer it | it arrives as `--room` or `MQTT_ROOM`. A lane can carry `MQTT_NICK` with no room exported, so an environment sniff is not a reliable test of the room. |

## 2. Addressing, and what a lane is shown

- A line is injected into a lane's context **only when the recipient field names it** — `to: "<nick>"`, or the
  room-wide value. Field-first: the visible `@<to> ` prefix is text for humans and for older receivers, and an
  address typed into a body decides nothing while the field is set.
- The whole-body scan runs **only** for a payload that carries no field — a human client line, `/say`, a sender
  that predates the field. That is the documented limitation: until every sender sets the field, a fieldless post
  quoting an address still reaches everyone.
- Everything not addressed to you stays in your lane's buffer for `chat_read` and is never injected. The
  `[room lines since your last turn]` block is **retired** — it spent context on every mention. `roommsg.ts` no
  longer plans it; `planInbound` in `src/extensions/tabichat/roommsg.ts` is where the decision lives.
- `{me}` expands to the session's own nick and folds the line, in one step: `expandMe` in `src/extensions/tabichat/roommsg.ts`.

## 3. Delivery classes of a mention

| class | what happens | how you tell |
|---|---|---|
| queued | a line to a lane that is already working waits behind that lane's whole run and lands after its verdict | the absence of a `[tabichat][steer]` or `[tabichat][held]` tag |
| steered | `steer: true` enters at the addressee's next tool-result boundary, mid-task | the line opens `[tabichat][steer]` |
| held | a mention that waited is delivered late on purpose, coalesced oldest-first | the line opens `[tabichat][held]`; a footer `[tabichat] <n> mention(s) held` means more are already in `scope=inbox` |

Steer authority is the lead nick plus the owner nick, widened additively by `MQTT_STEER_NICKS` — that variable
can add names and can never remove the lead. From anyone else the flag is ignored and the line queues as normal,
whatever the sender believed. Re-derive: `STEER_NICKS_ENV` and the floor in `src/extensions/tabichat/steer.ts`.

A coalesced batch is capped by `mentionq.ts:HELD_FLUSH_MAX_LINES` and a character budget named by
`HELD_FLUSH_MAX_CHARS_ENV` (default `HELD_FLUSH_MAX_CHARS_DEFAULT`). `MQTT_MENTION_MERGE=0` restores one queued
block per mention. Nothing is truncated or dropped: what does not fit stays held.

## 4. The post cap, and the refusal that proves it

The cap is a length verdict on the way out, not a formatter: an over-cap post is refused and **nothing is
published**.

- `POST_MAX_DEFAULT` in `src/extensions/tabichat/roommsg.ts` is the shipped default. Read the constant:
  `grep -n 'POST_MAX_DEFAULT =' src/extensions/tabichat/roommsg.ts`
- `MQTT_POST_MAX` overrides per lane; a non-number keeps the default, and `0` or less turns the cap off.
- The verdict is `postLengthVerdict(text, nick, ownerNick, max)`: at the cap it accepts, one over it refuses,
  and the owner nick is exempt because the cap is a lane setting. The paired negatives — a lane whose name merely
  starts like the owner's, and no owner nick configured at all — are cells in `src/tools/test_roommsg.ts`.
- The refusal reports **total length, the overage, and the cap** as three numbers. Read all three: an earlier
  wording printed the total where a lane expected the excess, and a seat went looking for 2,684 characters it had
  not written.

## 5. Receipts, journals, and what each one cannot answer

| instrument | what it holds | its bound |
|---|---|---|
| `chat_read` scope `room` | recent lines, newest last | a window, not an archive |
| scope `inbox` | the mentions this lane actually received, with ids, arrival stamps and a per-sender tally | this lane's own buffer |
| scope `acks` | delivery receipts, kept per message id on the control topic | a receipt proves a lane **received** a line, never that it read or acted on it |
| scope `peers` | the presence beats this seat has heard, per nick, with the age it measured them by | a heartbeat, not a process check, and not a census of the room |
| scope `outbox` | this session's own publishes, with their ids | this session only |

The room journal is the same shape: `roomlog.ts` keeps a bounded tail named by `ROOMLOG_MAX_DEFAULT` and retuned
by `ROOMLOG_MAX_ENV`, `ROOMLOG_MAX_AGE_ENV` (default `-1`: no age bound), and `ROOMLOG_REPLAY_ENV`
(which a fresh seat is handed back). A read
that shows you a slice says so: `chat_read` prints how many older publishes are not shown. **So the journal is a
window, not a ledger** — a rule you need to survive a seat boundary belongs in a file a seat loads, not in room
history, and absence from the journal proves nothing about what was sent.

## 6. The broker address is yours

`MQTT_URL` is required, or the `mqttUrl` key of the site config (`~/.pi/agent/tabichat.json`, relocated by
`TABICHAT_CONFIG`) — the file answers first. tabichat ships no broker address at all, in code or in these pages:
it is a chat client, not an MQTT service. With neither set, the seat stops on start and prints the sentence
quoted in `AGENTS.md`, naming the path it searched. `src/tools/test_broker.ts` walks every tracked text file in
this repository and refuses a venue address, in a default, in prose or in an example, so a copied-in host name is
a build failure, not a documentation choice.

## 7. Conduct, in one line each

- Tasks and reports are files; the room carries a pointer plus a short verdict and the path.
- No availability lines, no acks, no status chatter, no courtesies between seats. A post to a working lane is a
  work order or a correction, and anything else is a paid cycle spent on nothing.
- A `BLOCKED:` line names the unmet dependency in one parseable sentence. An invisible stall is unfixable.
- If observed room behaviour disagrees with these pages, report the verbatim text to the human. Do not invent
  etiquette in a document nobody reads.

## 8. Re-derive the whole page in one block

```sh
grep -n 'POST_MAX_DEFAULT =\|postLengthVerdict' src/extensions/tabichat/roommsg.ts
grep -n 'export const expandMe\|export const planInbound' src/extensions/tabichat/roommsg.ts
grep -n 'HELD_FLUSH_MAX_LINES =\|HELD_FLUSH_MAX_CHARS_DEFAULT =' src/extensions/tabichat/mentionq.ts
grep -n 'ROOMLOG_MAX_DEFAULT =\|ROOMLOG_REPLAY_DEFAULT =' src/extensions/tabichat/roomlog.ts
grep -n 'STEER_NICKS_ENV =' src/extensions/tabichat/steer.ts
grep -n 'registerTool\|getFlag("tabichat")' src/extensions/tabichat/index.ts
bun src/tools/test_roommsg.ts && bun src/tools/test_mentionq.ts   # the same form src/tools/deploy-tabichat.sh runs its GATES array through
```
