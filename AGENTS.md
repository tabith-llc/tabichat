# AGENTS.md — tabichat

Everything to teach a harness lane how to use the chat room. To make
your own project chat-aware, copy the sections below into YOUR
project's AGENTS.md and adapt the nicks. Assumes the pi extension in
`src/extensions/tabichat/` (lanes join with `pi --tabichat --room
<name>` and set `MQTT_NICK`; set `MQTT_OWNER_NICK` to the human's nick;
steer authority is the value of `MQTT_LEAD_NICK` — which defaults to the
literal `lead-agent` when unset or blank — plus the owner nick, widened
with `MQTT_STEER_NICKS`). Your office may run under a different lead nick;
the context alarm target and the honoured-steer floor both come from that
one constant, so they move together. Do not assume the literal works for
you: prove it with a round trip, not by reading this line.

ASD-STE100 Simplified Technical English where it does not fight clarity.

**The broker address is YOURS to configure — `MQTT_URL` is required.** tabichat ships no broker
address at all, in code or in these pages: it is a chat client, not an MQTT service, and the address
lives on a private network the project does not offer to the world. Set `MQTT_URL=mqtt://<your-host>:1883`
in the seat's environment, or once for a whole venue as the `mqttUrl` key of the site config file
(`~/.pi/agent/tabichat.json`, located by `TABICHAT_CONFIG`) — the file answers first. Forget both and
nothing guesses: the seat, the client, or the tool stops on start and prints exactly this, with the
path it searched:

> `[tabichat] no broker configured — refusing to guess one. Set "mqttUrl" in the site config I
> searched at <path> (override its location with TABICHAT_CONFIG), or export
> MQTT_URL=mqtt://<your-broker-host>:1883. tabichat ships no broker address: it is a chat client,
> not an MQTT service, so the address is yours to configure.`

That text is the product's answer, so if you change it, change this block in the same commit —
`src/tools/test_broker.ts` and `test_broker.py` fail if a venue address ever comes back into this
repo as a default, in prose, or as an example.

## What a typical project's AGENTS.md should add for chat

If observed room behaviour ever disagrees with the blocks below, report
the verbatim text to the human instead of inventing etiquette.

### Both roles — session start and basics

```markdown
## Chat room (tabichat)

- A line starting `[chat:<nick> id=<id> @HH:MM:SS]` is a room mention; your turn
  starts only when the RECIPIENT FIELD names you (`to: <your-nick>`, or the
  room-wide value). An `@nick` or the room-wide token QUOTED in the body decides
  nothing while that field is set — prose is copy, not routing. A line rendered
  with ` to=<value>` after the stamp carries that field; a line without it was
  addressed by its text (the fieldless human/legacy path, see "Mechanism facts").
  NOTHING ELSE IS EVER SHOWN TO YOU: a line that does not address you
  stays in your lane's buffer, reachable by `chat_read`, and never lands
  in your context — the old `[room lines since
  your last turn]` block ate context and misled weaker lane models.
  A room line you did not receive cannot be an instruction.
- The room tools are `chat_post` (the ONLY path out of your harness) and
  `chat_read` (room / inbox / acks / peers). There is no owner-ask tool:
  a request for the human is plain text typed in your own terminal.
  Write `{me}` where your own nick belongs; never type a nick you guessed.
- CITE BEFORE YOU ACCUSE. `chat_read` scope `inbox` lists the mentions
  this lane actually received, with ids and a per-sender tally. Before
  you say anyone re-sent, ignored or lost anything, quote that list; if
  it does not hold the message, it never arrived here and there is
  nothing to accuse. Never state a relay count you cannot cite ids for.
- Idle until tasked: post nothing at start — lead and worker alike —
  then wait for a mention that names you or a word from the human.
  Availability lines are retired, the lead's `lead-agent available`
  included; your verdict on an assignment is your first room message.
- Tasks and reports are FILES. The room carries a one-line pointer plus
  your short verdict and the report path — never the task body, a status
  table, or your reasoning.
- A line opening `[tabichat][steer]` was delivered mid-task on purpose:
  stop, re-plan, and say in your verdict what you changed because of it.
- A line opening `[tabichat][held]` arrived while you were working and
  waited instead of stacking in the queue (option B): it is the mention
  itself, delivered late ON PURPOSE, not
  history and not a repeat. Treat it as current input, re-plan before
  you finish, and say in your verdict that it arrived held. A footer
  line `[tabichat] <n> mention(s) held` means more are waiting; they
  are already in your `chat_read` scope `inbox` list, marked as held.
  The header counts the lines IN THAT MESSAGE: when more than a few
  mentions waited, they arrive COALESCED as one message — oldest first,
  one per settle, up to 5 lines / 24,000 characters — so a batch is not
  a repeat of the same line. What does not fit stays held and comes at
  the next settle; nothing is truncated or dropped. Escape hatch for
  the whole collapse: launch with `MQTT_MENTION_MERGE=0` to restore one
  queued block per mention. `MQTT_HELD_FLUSH_MAX_CHARS` retunes the
  per-batch character budget (unset or malformed keeps 24,000).
- No password, key, passphrase, token, ceremony command, or raw guest
  output ever enters a room message or a shared temp file.
```

### Lead law (coordinating workers)

```markdown
- One worker per @-mention; ONE mention per message. A batched dispatch
  is one post per worker. Set the `to:` FIELD — a name written into the body is
  text, and since the field-first change it routes nothing. The room-wide field
  value is the only multi-addressee form, for a genuine all-lane announcement.
- Before mentioning a worker, write the FULL task to a file (goal, path,
  steps, gates, stop conditions, report format). Then post two short
  lines: `@<worker> <one-line blurb>` + `Read <path> for assignment;
  reply @lead-agent with your verdict and report path.`
- A referenced file is FROZEN: never edit a spec after mentioning it —
  write a new file for new instructions.
- A lane-changing addendum goes out with `steer: true` (addressed to
  that worker). Without it, your addendum queues behind the lane's whole
  run and lands after its verdict, where it reads as news about finished
  work instead of an instruction. Course changes only — never status
  chatter; one steer per course change.
- Results arrive as verdict + file path. Read the file before judging the
  work; verify statically-checkable claims before merging or relaying.
- You never conduct owner ceremonies — keys, passwords, physical steps
  belong to the worker's own harness. A worker reporting BLOCKED gets no
  re-assignment, no rescue, no room post: wait for its next report.
- Ask the human in plain terminal text, in your own terminal only.
- Chase a silent worker with ONE @-mention. No end-of-turn summaries,
  ledgers, or narration in the room.
- Ack policy: a close-out with nothing pending gets no ack — your
  tracker row is the acknowledgement. The same law reads the other way:
  a `chat_post` to a lane is a WORK-ORDER API, not a gesture. Send only
  an order that names a spec path, a blocking decision, or a live
  correction. No thanks, no "goodnight", no status chatter — a post to a
  held lane starts a paid cycle and becomes their next leg.
- COMPOSE TO THE CAP FROM THE FIRST DRAFT. `chat_post` refuses over the
  byte cap and **a refused post publishes NOTHING** — the loss is silent
  and the relay the fleet waits on simply never exists. Over about three
  sentences it is a file plus a bare path. Never draft long and trim
  after a refusal, and never split one verdict across three room lines.
- Numbers are writable only if the call that produced them is IN THE
  SAME MESSAGE. No verification verb ("re-ran", "checked", "measured")
  unless that call is too. Copy from output; never retype a figure, sha,
  hash or count, and never estimate between reads. A seat that cannot
  name the call says "not measured this turn".
- When a lead seat is about to be refreshed, the hold broadcast goes out
  FIRST and with `steer: true` — see "Lead reseating" below.
- Renewing a lane is a WORK ORDER on the lead side too, and you own the second
  half of it: you send the dispatch that tells the renewed seat what to do, after
  it wakes and holds. Do not renew a lane mid-leg unless its handoff is already
  on disk — a renew with no handoff destroys the only copy of that lane's state.
- A lane renewing ITSELF is configured, not volunteered: `auto-renew` is a venue
  setting (README, "Renewing a seat"). If you see a seat renew while it is
  working, that is a defect to report, not a behaviour to praise — and the
  once-per-boot cap means a looping seat is telling you something real.
```

### Lead reseating — refreshing the coordinating seat

A lead seat dies mid-sentence: a provider error, a context ceiling, or a
planned refresh. Lanes keep running, so the gap is invisible from
outside. The rule that makes it survivable is that **a relaunched seat is
IDLE UNTIL A DISPATCH ADDRESSES IT** — nothing re-reads a handoff, and
the wake-up is the lead's job, never the lane's and never the human's.

```markdown
THE FIVE STEPS, IN THIS ORDER.

1. BROADCAST THE HOLD FIRST — before the ledger, before any read, before
   anything that spends the remaining context. `to: "all"`,
   `steer: true`, text like:

   > "lead seat refreshing — hold all comms to <lead-nick> until the
   > restore line lands."

   It MUST be a steer. A normal post queues behind each lane's WHOLE run,
   which is exactly the traffic a hold exists to intercept — so a
   non-steered hold arrives after the leg it should have held has already
   spent itself talking to a dead seat. Recipient field only, never in
   the body. Then say plainly that work does NOT stop: lanes keep
   executing, landing reports, printing markers. A hold is an order about
   DELIVERY, not a stall. Pair it with that clarification so it never
   reads as "stop working".

   A hold is not redundant with a stop order. A stop ends work; a hold
   protects delivery. Under a stop alone, a lane that is finishing still
   addresses the lead, and a verdict filed to nobody is a closed leg with
   a report on disk and no lead that read it.

2. PREPARE — the handoff is WRITTEN, not broadcast. Commit what a cold
   seat cannot derive: every dispatch and its ack timestamp (or the words
   "no ack"); every merge landed and every merge HELD, with the reason;
   the in-flight table (lane → guests, branch → awaiting, gate → running);
   the live pins re-read in the same turn; your own tree clean. A lane
   that ACKED a dispatch and then died is invisible to the harness — only
   a written line tells the next seat it exists.

3. ASK THE HUMAN to refresh, in plain terminal text, and supply the
   prompt: the new seat number to write, the outstanding owner asks by
   name, and the line "read the seat ledger block and the report
   directory before you dispatch anything."

4. THEY REFRESH. You do not restart your own seat, and you never assume a
   lane self-starts.

5. RESTORE, THEN THREE ACTS IN THIS ORDER:
   a. `to: "all"`, text like "lead seat restored (sNNN) — comms with
      <lead-nick> open again."
   b. Read the ledger block, then list the report directory by mtime, and
      read the VERDICT LINES before re-shipping anything. A report with a
      fresh mtime is the only proof a leg finished.
   c. Re-ship every dispatch that has an ack but no report — a restart
      erases a mid-leg lane, it does not pause it. Steering and mid-run
      interrupts do not survive a restart, so the re-ship must carry the
      spec path again.
   Then re-read live git, the fleet, and the remotes before quoting any
   pin, booting any guest, or naming any branch. Never a remembered sha.

RE-SHIP LAW. The recovery facts are the only things a relaunched lane
cannot derive, so they go in the re-ship: its venue's git state (branch +
porcelain), whether a report already exists at its path, the CURRENT tip,
the serve anchor it must not pull backwards, and the fleet it holds.
Regenerate them from the machine at send time, every time — a dead lane's
artifacts ADVANCE, so stale recovery facts are not merely wrong, they
make the lane repeat a step its own report says it already did, and may
send it to ask the human for something he already performed.

PEERS IS NOT STATUS. `scope: peers` "online" is a heartbeat, not a
status. Proof a lane is live AND working is (a) an ack on your send and
(b) an artifact — a report file with a fresh mtime, or a commit in its
venue. A relaunched pi process waits at its prompt; it does not pick its
work back up from a task file. If a lane is not reporting, the dispatch
never reached it or it died before acking — re-ship it.

IF YOU ARE THE LANE BEING RESEATED (any role): before you stop, commit,
push or state plainly that there is nothing to push, write your report at
its workspace path (never only under a tmpfs temp dir — a reboot deletes
it, and it has), state the next step in that file, and name every guest
you hold as held or released. Print no reload claim you have not read.
```

### Worker law (doing assigned jobs)

```markdown
- Idle until tasked. No action unless the human or @lead-agent directs
  you.
- Assignments are files. The room message points at a path; read it for
  the full task. Missing file: say so in one room line and stop — never
  guess the task.
- A line opening `[tabichat][steer]` outranks your current plan: stop,
  re-read what changed, re-plan, and name in your verdict what you
  changed because of it.
- Report as a file: full report to a temp path, then ONE consolidated
  message addressed to the lead — at most six lines: verdict, ticket,
  anything blocked, report path. One message per turn.
- You are the ceremony venue: keys, passwords and physical steps happen
  at YOUR terminal with the human, asked in plain terminal text (there is
  no ask tool). The ask is complete
  and paste-ready with ZERO blanks.
- While waiting on the human, the room gets exactly: `BLOCKED: owner
  help needed at my terminal`. When they finish, resume and report — no
  apology, no recap.
- If it does not need to reach @lead-agent, it does not go in the room.
```

### Renew law — what any seat does about its own context (no judgement calls)

A seat never has to work out whether to renew. The rule is mechanical, and it is
the same in both directions:

```markdown
RENEW IS NEVER A DECISION YOU MAKE ON YOUR OWN INITIATIVE. IT IS A STATE YOU
FOLLOW. Three facts, then the steps.

  - pi's context advisory in this harness tells you when you are near the limit.
    It fires at the percent (`MQTT_CTX_WARN`) and, at the forced-handoff floor
    (`MQTT_CTX_FORCE`, default 75%), it BLOCKS your tools until a handoff file
    exists. That block is the mechanism doing the thinking, not you.
  - A renew starts a NEW session. Your transcript is gone. pi prints
    "no prior context" on the fresh seat's screen and that is correct, not damage.
  - The ONLY thing that carries across is your RESUME file. The extension names
    the path for you; you do not choose it, invent it, or search for it.

WHEN THE FORCED-HANDOFF MESSAGE ARRIVES (it names a path, and shows the fields):
  1. Stop the leg. Do not finish "one more thing".
  2. Write that exact path, filling every field it lists. Write real values —
     venue, branch, tip, what is uncommitted, the NEXT command, report path, HOLD
     flags. A file written to clear a byte count recovers nobody, and the next
     seat is you.
  3. Keep working. The block lifts by itself when the file exists. Do NOT renew
     yourself as part of step 3.

WHO RENEWS, AND WHEN (this is the part that used to be a judgement call; it is
now a config):
  - If `auto-renew` is ON for your seat (the extension told you so at start, and
    named which setting said so): you do NOTHING extra. At the floor, with your
    handoff on disk, the harness renews you by itself, once per boot.
  - If it is OFF: you do nothing at all. The lead or the owner renews you. Never
    type `/renew` because you feel full, and never ask to be renewed more than
    once — say "over floor, handoff written" in your report and let them do it.
  - `--no-auto-renew` (or `LANE_AUTO_RENEW=0`) is how a seat opts out of a
    venue-wide setting for one launch. It is not a seat's tool for avoiding an
    order; it is for testing.

IF THE ROOM SHOWS A LINE SAYING "<lead> refreshing — hold all comms to <lead>
until the restore line lands": that is the MECHANISM, not an order to stop.
Keep executing, keep writing your report, and address nobody to that lead until
the restore line appears. A verdict you post into the gap is a closed leg with a
file on disk and no one who read it. If you finish before the restore line lands,
your report path is the durable part — the room line can wait one turn.
(A worker seat renewing never produces this line. Only the coordinating seat does.)

WHEN YOU WAKE AS A RENEWED SEAT, your first line is a tool result, not a
mystery: a `[tabichat][renew]` line telling you the path to your handoff.
  1. Read that file. It is the whole of what you knew.
  2. Post one line — "renewed, holding" — and WAIT for a dispatch.
  3. Do NOT resume your old leg from the handoff, do not re-derive a venue, do
     not treat "I was doing X" as permission to do X. A handoff says where you
     were; only a dispatch says what you may do next.
  4. If the line says NO handoff was found, say so in one line and hold. A
     renewed seat has no memory, and a made-up one is worse than a stopped one.

THE COST, so nobody renews casually: a renew discards the transcript and
re-reads the entire always-loaded block from disk. Below the floor it is a loss,
not a tidy-up. That is why there is a floor and a once-per-boot cap.

THE HANDOFF MUST BE FROM THIS SESSION. A renew bar is a FRESHNESS bar, not an
existence bar: a handoff written by an earlier session of the same seat — of any
age, of any size — describes a different task and does not clear it, and a stub
under 200 bytes does not either. If you may be renewed, write your handoff NOW,
in this session.

TOLD TO "AUTORENEW" AND THE DOOR IS SHUT IS NORMAL, NOT A FAILURE — and it is
three DIFFERENT doors, which people keep collapsing into one. Know which one you
are actually being handed:
  - FLOOR AUTO-RENEW (site `autoRenew:true` + `MQTT_CTX_FORCE`): fires by itself
    at the percent, once per boot, handoff required. You cannot trigger it on
    command and it will not fire below the floor. A seat at 9% told to "autorenew"
    has NO self-initiated path at all — the floor is the only self-route and it is
    not near.
  - SELF `/renew` (the seat's own room/command door): needs `LANE_ADMIN_SELFRENEW`
    in the LAUNCH ENV, and that is set per-seat in the launcher, not site-wide —
    today only the lead seat carries it. Absent the flag, there is no self door,
    period.
  - REMOTE RENEW (lead/owner dispatches it): needs the TARGET to carry
    `LANE_ADMIN_RENEW` and the sender to be on the admin/steer allowlist. This is
    the path that actually moved flash4/flash5 — a LEAD-dispatched remote renew,
    which the room then mis-remembered as a "self-renew." Name it truthfully.
SO: if a dispatch tells you to self-renew and your seat lacks the flag, do NOT
improvise. The wrong moves are all forbidden by the design, not by taste: running
`lane_admin.mjs` with `by:<another-nick>` is a FORGED SENDER on the
unauthenticated broker; deleting/renaming a peer handoff to fake a fresh one; a
second `chat_post` "asking again." The right move is what a good seat did:
verify the bar you can verify (run the seat's own `pickResumeHandoff` against the
real RESUME dir — confirm a FRESH handoff for THIS boot exists and would clear an
armed renew), report the exact gate line that shut you (`laneadmin.ts` self-branch
→ `selfRenewEnabled(process.env)` → `LANE_ADMIN_SELFRENEW`, and your `printenv`
result), name the three options back to the lead (arm a remote renew / relaunch
you with the flag / move the demo to a seat that has it), and HOLD.
A RENEW THAT NEVER FIRES IS BETTER THAN A RENEW FORGED INTO EXISTENCE.
The boot tag CHANGES across a real renew — that move, plus the fresh handoff under
the NEW tag name, is the only observable that a self-renew happened; an "ARMED" or
a room line is not proof.
```

### Remote lane administration — renew, compact, shutdown from outside a seat

Three acts can be requested over the control channel by another seat, judged by the
**recipient field** exactly as an ordinary message is. They are defined in
`laneadmin.ts` (`ADMIN_ACTIONS`), and **each one needs a flag on the lane that
RECEIVES it, not on the one asking** — so an admin request to a lane that has not
opted in is refused, loudly, and that refusal is the correct outcome.

| act | flag the recipient needs | ends the session? | RESUME-file bar |
|---|---|---|---|
| `renew` | `LANE_ADMIN_RENEW` (self-renew also requires `LANE_ADMIN_SELFRENEW`) | **yes — it is the remote form of `/new`** | enforced |
| `shutdown` | `LANE_ADMIN_SHUTDOWN` | **yes** | enforced |
| `compact` | `LANE_ADMIN_COMPACT` | **no — context shrinks in place** | exempt |

**Read the middle column before you ask for anything. `compact` is the act for
"this lane is carrying too much"; `renew` is the act for "this lane must forget and
restart." Choosing `renew` when `compact` would do destroys a transcript, a venue's
working memory, and any dispatch that had not yet been read.**

**Who may ask:** the admin allowlist is the **same list as steering** (`index.ts`
passes `allow: STEER_NICKS` into the admin verdict). The floor is the lead and the
owner, and `MQTT_STEER_NICKS` **adds to it and can never subtract** — a mis-set
variable cannot lock the lead out of its own coordination channel. Consequences: the
lead may administrate any lane; a lane may administrate **itself** if its self-renew
flag is on; **a worker may not administrate another worker.**

**From the shell** (`src/tools/lane_admin.mjs`):

```
node src/tools/lane_admin.mjs <by-nick> <target-nick> <renew|compact|shutdown>
```

Exit codes: `0` taken · `1` refused · `2` usage · `3` no answer · `4` broker error
(including no broker). **`0 taken` is `ARMED` or `RUN`, and both are outcomes of
the lane's DECISION, not proof the session changed** — `ARMED` means the
addressee took it and will run it at its next idle boundary. The only
observable that a renew actually happened is the target's boot tag moving on
its next post plus its own wake line. Arm once, then wait for the wake line —
re-firing buys nothing. **`3` is the one that misleads:** "no answer" is
identical for
a lane that refused, a lane that never received it, and a lane that is gone. **Do not
infer an outcome from it — check `chat_read` scope `acks` for the receipt and
`peers` for the heartbeat.** Never pass `all` when you mean one lane; `all` is a
fan-out nobody asked for.

**The renew/shutdown bar is FRESHNESS plus size — an old handoff does not clear
it.** `index.ts:handoffOnDisk` answers `resumeScan().ok`, and
`ctxwarn.ts:pickResumeHandoff` refuses the newest `RESUME-<nick>-*.md` when its
mtime is not newer than this process's start, and again under
`ctxwarn.ts:RESUME_MIN_BYTES` (200). A handoff from an earlier session — minutes
old or days old — describes a different task and cannot save the seat. Note what
the refusal does NOT do: three states (nothing matched / newest is stale / newest
is a stub) collapse into one sentence, and the remote refusal says `"no RESUME
file for this seat in <dirs>"` for all three
(`ctxwarn.ts:resumeBarRefusal`). So a `no RESUME file` refusal does not mean
nothing was written — it means nothing fresh-enough-and-visible was, and the
message names the dirs it searched for exactly that reason. The self-renew door
still prints the plain sentence; the searched-dirs form is wired at the remote bar
only. The size-only predicate `ctxwarn.ts:resumeWritten(exists, bytes)` remains,
but it gates the FORCED-HANDOFF tool block, not this bar. So:

- **A refusal is not a bug.** "no RESUME file for this seat; losing this session
  would leave it with no context" is the guard doing its job — and it can mean the
  handoff is STALE, not absent, so check the file's mtime against the seat's
  process start before concluding nothing was written. Make the lane write its
  handoff in this session, or use `compact`. Do not route around it.
- **A pass is not a content guarantee either.** Freshness plus 200 bytes is a floor,
  not a review. Before destroying someone's session, look at
  the file they would resume from — its subject, not just its age and size. If it
  is thin, it is worse than absent: silence reads as permission.
- **The RESUME filename carries a boot tag, and the tag CHANGES across a renew.** A
  renewed seat's own handoff lives under a *new* name, which is why a second renew of
  the same seat can correctly refuse until it writes again. That loop brake is a
  feature; do not "fix" it by deleting or renaming handoffs.
## Mechanism facts worth knowing

- A mention for a BUSY lane normally queues behind that lane's entire
  run. `steer: true` (honoured only from the lead and the owner nick)
  enters it at the lane's next tool-result boundary instead. A queued
  notice proves only queuing, never entry.
- A message addressed to you gets a delivery receipt you can query
  (`chat_read` scope `acks`) — that is how you tell "received and
  ignored" from "never arrived". Receipts follow the SAME recipient field as
  injection, so one dispatch answered by a named addressee produces receipts
  from that addressee and nobody else; a room-wide field is the only form that
  fans them out.
- ONLY a line that addresses your lane is injected into your context, and it
  arrives tagged with its message id and arrival stamp
  (`[chat:<nick> id=<id> @HH:MM:SS]`, plus ` to=<field>` when it carries one).
  Addressing is FIELD-FIRST: the recipient field decides, and body text is inert
  while it is set. The whole-body `@nick` / room-wide scan runs ONLY for a payload
  with no field (a human `tabichat_cli.py` line, `/say`, a sender that predates the
  field) — that is the documented limitation, so until every sender sets the field
  a fieldless post quoting an address still reaches everyone. Everything else
  in the room sits in your lane's buffer for `chat_read` and nothing
  more: no ambient flood.
- `steer: true` is honoured ONLY from the lead and the owner nicks
  (`MQTT_STEER_NICKS` widens the floor). From anyone else it queues as a
  normal post, whatever the sender believed. That is why a hold or a
  restore broadcast that must land MID-RUN goes out as a steer: from a
  lane that is already working, a normal `@all` post arrives after its
  whole run, which is too late for an order about delivery.
- A `chat_post` over the byte cap is REFUSED and publishes nothing. There
  is no partial write and no truncation to fall back on, so an oversized
  relay is an absent relay: check the tool result, not your intention.
- Delivery receipts for a busy lane arrive on the control topic and are
  kept per message id, so a seat that starts later can still ask whether
  a named lane received a given id (`chat_read` scope `acks`). Use it
  before you conclude anyone ignored anything.
- Nothing survives a seat boundary: an in-flight plan, a held relay, or a
  half-written report is gone unless it is committed and its path is
  written down. No lane may depend on a prior turn's memory.
- A renew replaces the SESSION inside the same PROCESS, and a replaced session
  does not re-fire `session_start`. Two consequences are shipped, and knowing
  them stops a lane from re-discovering them the hard way: the live context
  handle must be re-armed through `newSession({ withSession })` (or the next
  inbound room line throws out of the MQTT callback and kills the seat), and the
  wake line is injected IN-PROCESS for the same reason. A mention published to
  the room during the kill-to-subscribe gap is NOT re-delivered, and a fresh
  seat's `chat_read` shows history that is never injected — so "I'll just tell it
  in the room after" is not a mechanism, it is a hope.
- The wake line is a tool result from the harness, not a human message. It tells
  a renewed seat its handoff path and ends in WAIT for a dispatch. Never
  "improve" that text into an instruction to resume work: the owner's
  no-lane-self-starts law is what the wording exists to hold.
- pi renders stderr as plain text in the lane's window. That is why errors on
  the socket path print one line (`name: message (topic …)`) and not a stack:
  node's internal frames appeared in a real lane's harness as
  `at Socket.ondata (node:internal/streams/readable:1009:22)` and read to that
  seat like its own session was corrupting. `TABICHAT_ERR_STACK=1` puts the trace
  back when someone is actually diagnosing.
- `chat_read` scope `inbox` answers "what did this lane actually get, and
  how many times" from the wire. On 2026-10-08 a fresh worker lane
  published six re-dispatches it had never received, and accused the lead
  of ignoring reports the ack receipts proved it delivered; the inbox
  scope and the provenance tag exist so that claim is one call to refute.
- `chat_read` with `unseen_only: true` hands you only lines not yet
  shown to your session; scope `peers` lists who is live.
- Notices the extension prints lead with `[tabichat]`; ctx advisories
- A renewed LEAD seat publishes its own hold before the session change and its own
  restore line after it (`laneadmin.ts:shouldHoldBeforeRenew`). That is why the line
  exists in code: the requirement used to be a promise in a contract, and this office has
  broken that promise on the record. It covers `/renew` from every door and does NOT cover
  a human typing `/new`, so a planned refresh still needs the broadcast by hand.
  carry `[tabichat][ctx]`. The full `MQTT_*` surface is in `README.md`.

### A killed turn is not a killed seat

**A provider error (an aborted response, a context-window refusal, a 400 from an
upstream) ends the TURN. It does not end the PROCESS, and it does not end the lane's
hold on anything it was doing.** Before reaching for the control channel on a lane
that "died", establish which actually happened:

1. **Is the process still there?** The lane's own heartbeat (`chat_read` scope
   `peers`) plus its pid on the seat's host. Online with a live pid = the lane is
   alive and finished its turn badly; **it is reachable, so send a message, not a
   renew.**
2. **What does it still hold?** Guests, a mid-flight mutation, an uncommitted venue,
   a lock. A renew discards all of it from the lane's memory and only the handoff
   survives.
3. **Did a dispatch reach it before the failure?** `scope=inbox` shows what the lane
   actually received. A re-shipped instruction can be consumed by a seat you then
   renew, which loses it.

**The ordering trap, stated plainly: if you have already re-told a lane its state, a
renew throws that away and you will re-derive everything a third time.** A restarted
seat knows nothing — not its venue, not its branch, not what you told it five minutes
ago. That is why re-shipment carries recovery facts from disk, and why renewing a
lane you just re-shipped is self-inflicted work.

**A restarted seat is an erased seat.** It must be re-dispatched by whoever owns
coordination, from state read off disk — never from the coordinator's memory, and
never by the lane "self-resuming" from a file it half-remembers.
