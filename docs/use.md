# tabichat — Use

← back to the [README](../README.md)

> The names this page configures are settings, not defaults: the section
> **"Site names are settings — they MUST BE CONFIGURED"** further down this
> page is the single source for which values to set for your site.

## Use

Give each agent its own terminal (`MQTT_NICK` must be unique per participant):

```bash
MQTT_NICK=lead-agent pi --tabichat --room demo --model <provider/model>
MQTT_NICK=worker1 pi --tabichat --room demo --model <provider/model>
```

And your own room window — one client, and it has scrollback (PageUp to read
what
you missed), so a room you actually read all day stays readable:

```bash
cd src && .venv/bin/python src/tabichat_cli.py demo
```

Scrolling: PageUp/PgDn half a screen, Ctrl-B/Ctrl-F a full one, Ctrl-A back to
live.
The buffer counts MESSAGES (`TABICHAT_HISTORY`, default 5000), `/grep`
searches all of it, `/depth` says how far back you can see, and `/fill 400`
puts known lines in the buffer so you can try it without waiting for traffic.
There are two ways to clear the screen and they do different things, so read the
second word before you press return: one blanks the screen and keeps your
scrollback, the other blanks it and drops the buffer too. If the word after
`/clear` is anything other than screen — a typo, a half-remembered flag — you
get
the destructive one. Type `/help` and the client will say both promises back to
you.
A fenced ``` block and `code` are tinted on screen only — the wire stays plain
text, so nothing about what agents send or receive changes.

In the room: `@worker1 say hi`, `@all status check`, `/names`,
`/join <room>`, `/quit`. Inside a pi window: chat normally; use
`/mqtt-status` to debug the room connection. A human post carries no
recipient field, so it is still addressed by its text — the field-first rule
applies to payloads that set the field, and the fallback is what keeps these
hand-typed mentions working.

Agent-side conduct — what to add to your project's AGENTS.md so leads
and workers use the room correctly — is in **[AGENTS.md](../AGENTS.md)**.

### Renewing a seat

A renew starts a **new session for one lane**. The old transcript does not
travel — pi tells you so on the fresh seat's screen ("no prior context"), and
that's correct behaviour, not damage. What carries across is the lane's **RESUME
file**, and the extension hands the fresh seat the path to it.

There are three ways in, and they all end in the same code:

Three doors, one handler:

| door | who asks | how it arrives |
|---|---|---|
| `/renew` typed at the lane's keyboard | the human at that terminal | the command directly |
| a room admin request | the lead or an allowlisted nick | `lane_admin.mjs <by> <target> renew` |
| **auto-renew** | the lane itself | at the context floor, once per boot |

All three end in the same code, so all three re-arm the live context and inject
the wake line. There is no second, less-tested route to a replaced session.

**`ARMED` and `RUN` are outcomes of the decision, not of the session
change.** `src/tools/lane_admin.mjs` exits 0 on either: `ARMED` means the
addressee took the request and will run it at its next idle boundary; `RUN`
means it dispatched now. The only observable that a renew actually happened
is the target's boot tag moving on its next room post, plus its own wake
line. Operator practice: arm once, then wait for the wake line — re-firing
buys nothing.

**A renew will refuse in five cases, and it says each one out loud.** `renew`
and `shutdown` both
require that the seat has a RESUME file that is **fresh** — newer than this
process's start — and clears the 200-byte floor; losing a session with no
usable handoff on disk is exactly the failure the RESUME machinery exists to
prevent. The bar is freshness, not existence, so an old handoff cannot save a
seat: `ctxwarn.ts:pickResumeHandoff` takes the newest `RESUME-<nick>-*.md` by
mtime and refuses it when that mtime is not newer than the seat's current
process start — a handoff from an earlier session describes a different task,
minutes old or days old — and again under the 200-byte floor
(`ctxwarn.ts:RESUME_MIN_BYTES`). Three states collapse into one refusal
sentence — nothing matched, the newest is stale, the newest is a stub — so a
"no RESUME file" answer does not mean nothing was written: it means nothing
fresh-enough-and-visible was. The remote door's refusal names the directories
it searched (`ctxwarn.ts:resumeBarRefusal`), and that is what the message is
for; the code does not tell stale apart from absent at the refusal. The
self-renew door keeps the plain sentence, because that seat is asking about
its own dir. So a lane that may be renewed writes its handoff in the session
it wants recoverable, not an earlier one. A remote request is refused if the
sender names the
receiving lane itself (`X cannot administer its own lane by room message`), if
the
sender is not on the allowlist, if the lane's `LANE_ADMIN_*` flag for that
action
is off, or if the request carries no sender at all. Every refusal is spoken on
the requesting path rather than swallowed — you get an answer, not silence. And
a remote request with no recipient
field is inert on every lane by design — `@all` is a recipient-field value, not
message text.

**The allowlist is a convention, not an identity check.** `by` comes off an
unauthenticated payload: the broker accepts anonymous connects and verifies no
sender, so any LAN peer can write `by: "lead"`. The check stops a mistaken lane,
not a forged request; that is why the wording is "not on the allowlist" rather
than "not authorized", and why `LANE_ADMIN_SHUTDOWN` stays off by default.
Broker
authentication is a separate, held item.

**A renewed LEAD seat is a special case, and the mechanism handles it.** When
the seat being
renewed has `MQTT_NICK` equal to `MQTT_LEAD_NICK`, the `/renew` handler first
publishes a steered,
room-wide hold — on the lane's own `MQTT_LEAD_NICK` value, whatever that is:

```
<lead-nick> refreshing — hold all comms to <lead-nick> until the restore line lands. Work does NOT
stop: keep executing and keep landing reports.
```

The hold exists because a coordinating seat that vanishes quietly costs the
fleet finished work:
lanes address the lead nick, and a verdict filed by nobody is a closed leg with
a report on disk. It
lives in code rather than in a seat contract because the contract version was a
promise, and promises
of that shape have been broken on the record. It covers `/renew` from **every**
door. It does **not**
cover a human typing `/new` — that path never enters this handler, so a planned
refresh still needs
the broadcast by hand, and it needs the restore line by hand too: nothing in
this repository times a
hold out or publishes the restore for you.

The wake line differs by role for the same reason: a renewed **lead** is told
its first act is the
restore line (lanes may be holding verdicts), then to read its handoff and
re-ship anything acked but
unreported; a renewed **worker** is told to read its handoff, post one line, and
hold — and it
publishes nothing room-wide, because one lane's restart is not a fleet event.

**A renewed seat is a blank seat, and the handoff file is the whole recovery
of it.** A seat that wakes from a renew knows nothing but its RESUME file, so
the correct first line is "renewed, holding" — and then waiting for a
dispatch. Self-assigning the next task is not what the handoff authorises; it
says where the lane was, not what it may do.

**Please read this one as the operator's own words, not as a feature note.**
**While the tests for self-auto-renew are ongoing, leave all four layers off**
(a caution, carried here and — since this line was only ever in one
place — in `README.md` and the `Unreleased` section of `CHANGELOG.md`, so the caution is
wherever a reader meets the feature):
after
a seat used self-auto-renew, harness artifacts printed where the operator types
his
own input. The defect is open and no fix ships in 0.1.0. The human-typed
`/renew`
and a room-requested renew (`lane_admin.mjs <by> <target> renew`) are the paths
in
normal use and are unaffected — they are what the fleet runs on today.
Everything in
this section documents the feature as it works today, for when the tests finish.

**Auto-renew is OFF unless you turn it on.** Four layers, highest first, and an
unrecognised value in any of them means OFF — never "guessed on":

```bash
# 1. one launch (also --no-auto-renew to opt ONE seat out of a venue-wide setting)
pi --tabichat --room demo --auto-renew

# 2. one seat
LANE_AUTO_RENEW=1 pi --tabichat --room demo

# 3. the whole venue — one file, every seat that reads it
#    ~/.pi/agent/tabichat.json   (TABICHAT_CONFIG points somewhere else)
{ "autoRenew": true }
```

Here's all a self-renewing seat does: at or over the forced-handoff
floor (`MQTT_CTX_FORCE`, default 75 %) it checks its own handoff exists, and
only
then dispatches `/renew`. Below the floor it says nothing; at or over the floor
and **held** it says why on its terminal. One renew per boot, so a seat that
wakes and immediately sits back over the floor cannot loop.

The floor is not cosmetics: a renew discards the transcript and re-reads the
whole always-loaded context block from disk. A seat renewing at 20 % pays to
re-read its own instructions.

The fresh seat is told, in-process, its own handoff path, and the line it is
told
ends in **wait for a dispatch**. Waking with notes is not authorisation to
resume
work — read [AGENTS.md](../AGENTS.md) for the seat's side of that.

Default is OFF in code. **On this box the site file says
`{ "autoRenew": true }`** — the point of the feature is for the operator not to
manage agents renewing themselves, hands off —
and it was proven live: a lane started with no flag and
no env read the site
layer and announced `auto-renew ON … (from site file (autoRenew))`. **That
announcement is the `notify`
sentence and it still reads that way.** The separate **persistent status line**
now reads **`🍄 tabichat`**
when the policy is armed (the badge was parked for a while before it shipped, the
glyph leads the word, and the key behind it is unchanged); it appears only when armed,
because **OFF prints nothing** — thirteen
seats printing `auto-renew off` is noise, not information.

**Where that badge SITS is decided by its status KEY, not by its text.** pi
joins all extension statuses
on one footer line **sorted by key** and prints only the text, so the key is a
slot, not a label: tabichat
uses `nick-tabichat`, which sorts immediately after the `nick` badge and before
`ponytail`, so the line
reads `@worker1 🍄 tabichat ... ponytail: ...` (an earlier key, `renew`, sorted
*after* `ponytail` and put the badge where the footer truncates it first on a
narrow terminal). Renaming
the key moves the badge; the WORDS on it come from this line's own text, which
is why the glyph could move
ahead of the word without anything shifting position on the footer. A check in
`src/tools/test_laneadmin.ts`
runs the same comparator pi runs, over the keys read out of the source, so this
cannot quietly drift — and
another cell in that file pins the shipped text, so the order and the sentence
above have to agree or the
gate goes red.

**While the open artifact described by the heading "leave all four layers off"
above is under test, that
caution overrides this venue setting:** leave the layers off until the tests
finish.

`MQTT_URL` is **required** — a broker address, e.g.
`mqtt://broker.example:1883`, where
`broker.example` is a **placeholder** and not a default: tabichat ships no
broker address, because it
is a chat client and not an MQTT service: there is no default and it must be
set. Set it
per seat in the environment, or once for the venue in the site config under
`mqttUrl`. Forget it and
nothing guesses: every tool, client and one-shot refuses on start and names the
config file it
searched and the variable it wanted.

Settings — all optional: `MQTT_NICK` (default `bot` — must be unique
per participant),
`MQTT_TLS_CAFILE` / `MQTT_TLS_CERTFILE` / `MQTT_TLS_KEYFILE` — **paths**, never
secret values, to
the tabichat CA and to this lane's own client certificate pair (see
[`docs/broker/README.md`](broker/README.md)); `MQTT_TLS_REQUIRED=1` refuses
a plaintext URL
rather than falling back to one; `MQTT_TLS_SERVERNAME` overrides the TLS server
name for a broker
reached by address; `MQTT_TLS_INSECURE=1` is the only way certificate
verification is ever turned
off, it warns on EVERY connect, and nothing in this project ships it on;
`MQTT_SENDER_TOPIC=1`
publishes to `chat/<room>/msg/<nick>` instead of the flat room topic, and is OFF
because it must not
be turned on before the broker's ACL and every reader has migrated.

`MQTT_ROOMLOG` — the room journal: every room line this seat hears, and every
line it posts, is appended as one record to the file it names, and a fresh
session replays the newest ones into its room buffer BEFORE the socket's first
live line, rendered with a `hist` marker so history can never read as news, and
never injected as a mention. The order is this variable, then the site-config
`"roomLog"`, then a default under the resolved home — and that default is ONE
FILE PER SEAT PER ROOM:
`~/.pi/agent/tabichat-roomlog/<room>/<nick>.jsonl`, the seat name sanitised the
same way topic leaves are. Never tmpfs, and a resolved path inside a git working
tree is refused, because the journal holds room text at rest
and a file in a repo is a file that can be committed. **The journal is room text
at rest on disk**: it is the seat's own file (0600, its directory 0700), but the
words in it are the room's. `MQTT_ROOMLOG=off` is how you turn it off — an
explicit answer, nothing written, said once in the diagnostic log. Turning it off
stops FUTURE writes; it does not erase what is already there. To remove the words
themselves there is one file and one command:
`rm ~/.pi/agent/tabichat-roomlog/<room>/<nick>.jsonl`.
Two seats that share a nick share one journal — that is a nameplate collision to
fix in the launch line, not a second file the code will keep for you.
`MQTT_ROOMLOG_MAX_LINES` (default 500) bounds the file. The write path is
append-only — it never rewrites the file, so no writer can land on another's
bytes — and the cap is enforced when the seat starts: the oldest lines past the
cap are dropped at that moment and the drop is REPORTED to the diagnostic log,
never silent. **So the journal is a window of the newest lines, not a ledger of
every line.** A room line you cannot find in a seat's journal may simply have
been dropped by that window — usually it means the seat has been running long
enough to fill 500 lines, and the oldest ones are gone. Absence from a journal
is a question to ask, never an answer to state.
`MQTT_ROOMLOG_REPLAY` (default 50) is how many of the newest lines a session
takes back.
`MQTT_HIST_BOARD=1` additionally publishes this lane's last ten sends to the
RETAINED topic `chat/<room>/hist/<nick>` — one topic per lane, overwritten on
every publish — so a seat that subscribes late is handed them at subscribe time.
It is OFF by default and must stay off until the broker's generated (phase-2)
ACL grants each lane its own `hist/` leaf: under phase-1 that write is refused
with **no error and no log line** — the same two-pass law as `MQTT_SENDER_TOPIC`,
and the same table row in [`docs/broker/README.md`](broker/README.md).

**Configuring these variables is the easy half.**
[`docs/tls-operations.md`](tls-operations.md) is the
ordering and the failure modes: why the site file outranks `MQTT_URL`, why a
seat cannot report its own
transport, why the CA pin must reach every launcher body *before* any URL flips
to `mqtts://`, and why a
phase-2 ACL applied ahead of client migration makes every lane publish into a
void with **no error and no
log line**. Every trap in it was hit for real.
`MQTT_ROOM` — personal default room, set it in your shell rc if you
always use one; otherwise `--room` is required and the extension will
say so (there is no built-in room default); `MQTT_LEAD_NICK` — the
coordinating seat; a BLANK value falls back to the shipped default
`lead-agent` on purpose, because `MQTT_LEAD_NICK=` in a launch line is a
typo an operator can actually make and an empty lead nick silently disarms
the alarm target and the steer floor; `MQTT_OWNER_NICK` — the
human voice, honoured alongside the lead for steer requests (the code
ships a placeholder default; set this variable explicitly);
`MQTT_CTX_WARN` (default 60) and `MQTT_CTX_TOKENS` (default 0 = off) — the
context advisory's percent and absolute tripwires;
`MQTT_CTX_FORCE` (default 75, clamped 0..99, and never below the warn
threshold) — the forced-handoff floor, see **Handing off a lane that is
running out of context**; `MQTT_CTX_RESUME_DIR` — where a lane's RESUME file
is written. **There is no shipped default**: the order is this variable, then
the site-config `"resumeDir"`, then a refusal that names both knobs and says
the handoff will fall to the tmpfs scratch `/tmp/tabichat` — which does not
survive a reboot. A seat states at start which directory it resolved and
whether that place is durable; set the variable explicitly on any venue that
runs lanes);
`MQTT_STEER_NICKS` —
comma-separated nicks ADDED to the steer allowlist, it never removes
the lead or the owner; `MQTT_MENTION_MERGE` (default ON — set `0` to restore
one pi queue block per mention) and `MQTT_HELD_FLUSH_MAX_CHARS` (default
24000) — the held-mention collapse below; `MQTT_HB_MS` (default 30000, floor
5000) —
presence heartbeat; `MQTT_EXIT_LOG` (default
`/tmp/tabichat/lane-exits.log`) — where a lane records how it ended;
`MQTT_POST_MAX` (default 2500; `0` or less turns the cap off) — the length a
lane's own `chat_post` may reach before it is refused; the owner's nick is
exempt and posts without a limit;
`LANE_AUTO_RENEW` — let a seat renew itself at the context floor (per seat);
`LANE_ADMIN_RENEW`, `LANE_ADMIN_COMPACT`, `LANE_ADMIN_SHUTDOWN` — arm the
remote admin routes on this lane. **All three are OFF unless they say
`1`/`true`/`on`/`yes`.** No flag, no behaviour;
`TABICHAT_CONFIG` — site-wide settings file path (default
`~/.pi/agent/tabichat.json`; its `autoRenew` key is the venue-wide form of the
same switch, its `mqttUrl` key is the venue-wide broker address and answers
BEFORE `MQTT_URL`, and a
file that exists but will not parse is reported on every
seat's terminal, never ignored); `TABICHAT_ERR_STACK=1` — print full error
stacks on stderr instead of the one-line form (for diagnosing only: a stack in a
lane's window reads to that lane like its own seat is corrupting).
The human clients take the same broker over other names: `MQTT_HOST`
(no default — required like `MQTT_URL`, and it accepts `host` or `host:port`),
`MQTT_PORT` (1883 —
the standard MQTT port, which is why a port may default and a host may not),
`MQTT_TOPIC` (`chat/tabith`), and
`TABICHAT_HISTORY` (default 5000 messages of scrollback in
`tabichat_cli.py`).

### Site names are settings — they MUST BE CONFIGURED

tabichat connects named seats to one room, and every name that does the connecting — the
broker address, the coordinating seat, the human's nick, the fixture identities — is a setting,
not something this package can choose for you. The values that ship as fallbacks are
placeholders that document the SHAPE of each setting; a placeholder is not a recommendation.
Please set these to your own site's names before you rely on anything they gate.

| variable | what it names | shipped fallback | what to do |
|---|---|---|---|
| `MQTT_URL` (or site-config `mqttUrl`) | the broker | none — every tool refuses on start and names both doors it searched | set it; there is no default and there is not meant to be one |
| `MQTT_NICK` | this seat | `bot` | give every seat a name that is unique in your room |
| `MQTT_LEAD_NICK` | the coordinating seat | `lead-agent` | set it to your lead seat's real nick. A blank value falls back ON PURPOSE: an empty lead nick quietly disarms the alarm target and the steer floor |
| `MQTT_OWNER_NICK` | the human voice | `owner` | set it to the nick your human actually posts as |
| `MQTT_STEER_NICKS` | seats ADDED to the steer allowlist | empty — lead and owner only | list your own extra seats; this setting only ever adds, and never removes the lead or the owner |
| `TABICHAT_FIXTURE_NICKS` | the identities the test broker fixture mints | the neutral pair `seat-a seat-b`, announced on stderr when unset | for your own test cells, declare the names you need; the fixture mints nothing silently |

The example names in the launch lines above — `lead-agent` and `worker1` — are generic stand-ins
for a coordinating seat and a worker seat, the documented defaults from the table. They are not
names any real room has to use.

One caution about `lead-agent` specifically, because the same string appears twice in this
repository with two unrelated meanings. `tabichat-lead-model` keeps a MODEL-TIER id called
`lead-agent` as a working legacy alias (renamed to `lead-xhigh`; tier resolution reads
`LEAD_MODEL`), and the table above uses the same word as the example LEAD SEAT NICK (nick
resolution reads `MQTT_LEAD_NICK`). These are different planes: setting the tier never renames a
seat, setting the nick never moves a tier, and the nick path does not read the tier value. If you
keep the legacy alias, the string may look like a seat name in `pi --list-models` — that is the
tier, not the room.

And one practical note that saves a confusing minute: a running seat keeps the environment it
booted with, so a nick change takes effect at that seat's NEXT launch, not mid-session.

### What a seat can call

Three tools and six commands — that's the whole agent surface:

| kind | name | what it is for |
|---|---|---|
| tool | `chat_post` | publish to the room; `to` names the addressee and travels on the wire, `steer: true` asks for interrupt delivery (honoured only from the allowlist) |
| tool | `chat_read` | read the room; `scope` is `room` (default), `inbox` (what this lane actually received), `acks` (delivery receipts), or `peers` (the presence beats this seat has heard, with the line naming that instrument); `unseen_only` hands over only lines this seat has not been shown |
| tool | `context_usage` | this session's own token usage, window, percent, and whether a fresh session is due |
| command | `/say <text>` | publish a line to the room (folded to one line) |
| command | `/room [n]` | show recent room lines (max 50) |
| command | `/peers` | the presence beats THIS seat has heard, per nick (online / stale / offline, with the age it measured by) — a beat is not a process check, and a missing row is not a gone seat |
| command | `/ctx` | this session's context usage and advisory state |
| command | `/renew` | replace this session with a fresh one; see **Renewing a seat** |
| command | `/mqtt-status` | `flag= nick= room= url= connected=` — the connection debug line |

Pi flags: `--tabichat` (load the extension), `--room <name>`, and
`--auto-renew` / `--no-auto-renew`.

### Handing off a lane that is running out of context

Two numbers, two different behaviours. At `MQTT_CTX_WARN` the advisory fires and
says nothing more. At
`MQTT_CTX_FORCE` (default 75 %) the lane has to write a RESUME
file — the notes a cold seat needs to pick the work up — and its tools are
blocked until that file exists on disk. Nothing is
killed, no session ends, no running command is aborted. While blocked, reads,
writes to the RESUME path itself, and read-only `git` are allowed — a lane can
prove its own repository state rather than guess it. A file under **200 bytes**
does not clear the bar (it has told the next seat nothing), and after **3**
refusals the block is dropped and the lane says so out loud, in the room,
because a stalled lane is worse than an un-noted one.

### Acks: how a sender learns a lane actually got the line

When a message names a lane and carries an id, that lane publishes a receipt on
the control topic — `chat/<room>/_ctl`, never in the room — and pins a retained
copy under the message id (`chat/<room>/_ctl/<id>`), so a seat that starts later
still sees receipts that flew before it woke. `chat_read` with `scope: "acks"`
reads them; `id=` (optionally `<id>|<nick>`) and `since_min=` ask about one
dispatch. A receipt answers "did this lane receive this id" — it is how you tell
**ignored** from **never arrived**. It is not proof of the sender's identity:
the
broker authenticates no one, so `by` is self-asserted (see the note under
**Renewing a seat** about the same limit on admin requests).

