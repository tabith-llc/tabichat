# Changelog

## Unreleased

## [0.1.1] - 2026-11-02

This release is for anyone running a seat in the room. The headline is that a seat that
comes back up can now tell you what it missed, and a busy room stops eating people's messages.

### New features

#### A restarted seat can now say what it missed

Until now, a seat that restarted came back deaf. The room's messages are not
stored on the broker — receipts and liveness are — so a new session was handed
the paperwork of a conversation and never the conversation itself. What the
room had said simply stopped existing for the seat that booted next.

Each seat now keeps its own view of the room on disk — one file per seat per
room, under the room's name and the seat's own name: every line it hears, and
every line it posts, one record at a time, newest kept (the last 500 by
default). When a seat starts, the most recent of those records — 50 by default
— go back into its room memory before the first live line arrives, shown with
a hist tag so nobody mistakes history for news, so the first "what did I miss"
read answers with only what arrived after the boot. The file lives in the
seat's own home area, and the settings follow the usual
order: a per-seat variable, then the shared venue file, then that default.
Saying MQTT_ROOMLOG=off is a complete answer for anything written from then on
— nothing further is written, and the seat says so once; to take the existing
words away too, the journal is one file and one removal command, named in the
user notes. Writes only ever add a record and never rewrite the file, so no
seat can overwrite another's; when a file passes its line cap the oldest lines
drop the next time that seat starts, and the drop is reported to the seat's
diagnostic log rather than happening in silence. One thing to know before
turning it on anywhere it matters: the
journal is the room's words at rest. It is the seat's own file, readable only
by its owner, but a person who would not want that sitting on a machine can
set MQTT_ROOMLOG=off — and delete that one file — and lose nothing else.

The second half is in the code and off by default: setting MQTT_HIST_BOARD=1
makes each seat publish its last ten lines to a stored place on the broker
under its own name, so a seat that subscribes late is handed them the moment
it asks. It stays off until the broker's generated access-control file grants
each seat its own spot; until that order of operations is complete, a seat
that turns it on simply writes where the broker will not listen.

### Added

#### A rule about credit is now checked, not just written down

This project has always said that a commit says what the code does and nothing else: no credit to a
person, no note about who decided it, no co-author line. Until now the only thing enforcing that in this
repo was a person noticing it during review, and it was noticed twice.

There is a check for it now, and it runs as a deploy gate:

```
sh src/tools/check_attributions.sh
```

It reads the lines your branch ADDED and refuses any of them that hands a decision to a person or to a
seat, naming the file and showing the line as you typed it. Two choices keep it useful rather than
loud-for-no-reason. It looks only at added lines, because this repo already carries a body of these
references from before the rule was written down, and a check that arrives red gets loosened until it is
green — which would teach the next reviewer to ignore it. And it looks for a CREDIT, not for a name: the
seat words appear hundreds of times in the shipped tests and docs as ordinary data, so a gate that banned
the words would have refused honest test fixtures on its first day.

If you are moving a document that already reads this way, the check is asking you to reword the line you
touched, not to audit the file. If it flags something that genuinely is not a credit, say so and it
becomes a named change to the pattern with its reason written beside it — not an exception, and not a
wider exclusion.

### Changed

#### Enabling the commit guard can no longer switch something else off

This repo ships a small check that runs whenever you commit: it looks at the
lines you are about to save and stops the commit if any of them would put a
secret — a password, a token, a key — into the repo's history. Turning it on
takes one config line, once per clone.

That config line used to carry a side effect nobody announced: it replaces
the set of hooks git consults. So a clone that already had its own pre-commit
hook — say, a project lint gate — simply stopped running it. Commits kept
landing, and the only sign anything had changed was that the lint gate's
output never appeared again. Git keeps only ONE hook directory, so the moment a
clone set this value locally it stopped consulting the directory the machine had
set for it — and on a workstation where the host keeps its own checks there (an
identity rule, a commit-message rule, a push rule), every one of those checks
went quiet at that instant, with no warning and no error. Nine clones on one
machine were in that state, and only a deliberate count found them.

Now the guard notices when a hook sits where yours used to be, runs it after
its own checks, and honours its answer. Your lint gate can still refuse a
commit, and it says so in its own words; when both checks are happy, the
commit lands exactly as before. The header line that used to tell you to set the
config by hand is now a command that cannot do the quiet thing:

```
sh src/tools/enable_hook_chain.sh
```

It reads what your machine already has configured and forwards to it: one small
file per hook name in your own clone's `.git`, each running your existing hook
first and this repo's guard after. If either refuses, the commit refuses, and
each one says so in its own words. If your machine has nothing configured, the
command writes the simple value and tells you that was the right answer here.
Add `--check` to ask what it would do without letting it do it. Nothing in it
writes to your machine-wide settings or points your configuration somewhere you
did not already choose — a value that is set but cannot be read is a refusal with
a reason, not something to overwrite quietly. And if you already enabled the guard
the old way on a machine with a host guard, run the command again: it recognises
that state, repairs it, and says which it found.

The companion status command (`sh src/tools/check_guard_armed.sh`) tells the same
truth: it names any hook found beside the guard and says whether the guard will
run it, instead of just answering "armed".

When the configured path points somewhere else entirely, the guard refuses — and
until now that refusal had no way out except editing your configuration by hand or
skipping the check with `--no-verify`, which is precisely the check telling you it
is not running. The refusal now lists what it is displacing (the value it found, the
executable hooks git is consulting in its place, and the legacy hook the same value
hides), and prints the one prefix that goes ahead deliberately:

```
TABICHAT_GUARD_PROCEED=1 git commit
```

That prefix covers this one disagreement about where the guard sits. A staged
secret, an unreadable or empty pattern list, and a chained hook that refuses are
still refused with it set, and the guard writes nothing to your configuration
either way. What it buys is a record that you were told and chose, rather than a
silence.

#### "What did I miss?" stays honest once the room gets busy

Each seat keeps a window of the last 50 room lines, and `chat_read` with `unseen_only` was answering
"everything after what I last showed you" by remembering a POSITION in that list. Lines keep arriving,
the oldest drop off the front, and every stored line slides one place left — so a seat that read the
window once while it was full could ask again for the rest of its life and be told there was nothing
new. Busy rooms reached that state within their first 50 lines, and a quiet room never did, which is
how a defect like this hides.

That was already corrected in this branch line: every line now carries the number it arrived with,
and unseen reads compare numbers, so a shifting window cannot move an answer. What was missing, and
what this release adds, is the PROOF at the size where the two answers disagree: a seat that boots and
replays a full 50 records, takes one new line, and asks `unseen_only` as its very first read. The tests
run that shape end to end, carry a negative control that reproduces the old blindness in the same
data, and pin the two numbers that made this a boot state rather than an event — the replay default and
the window size are deliberately equal, and now a test says so out loud. If you run 0.1.0, this is one
of the differences you are upgrading for.

#### Unseen reads survive a busy room

When the recent-lines window filled up — a busy room, or a seat that came back with its history
replayed — asking "show me only what I missed" could answer "nothing", and keep answering nothing
for the rest of that seat's life. The boundary was remembered as a place in a list, and every new
line in a full list moves every place by one. The boundary is now the arrival number of the newest
line the seat showed, a count that never moves when the window turns over. Replayed history keeps
its hist tag and still never counts as news. This one reached every seat in a busy room, including
seats that never turned the journal on.

#### A seat's liveness now says how it was measured

The peers board (`/peers`, and `chat_read scope="peers"`) answers one question: what has
this seat heard lately. It used to answer it with three words and a number —
`* flash7 online 0s` — and that reads as a fact about a process when it is a fact about
a message.

Two things change. A beat stamped further ahead of this seat's own clock than one whole
allowance is no longer read as life: the stamp is the peer's clock and the age is taken
against ours, so a record that far ahead cannot be timed here at all, and it now reads
`stale` and prints its skew (`? flash7 stale ahead 10m00s`) instead of clamping to `0s`,
which is how a seat whose process was gone could sit live on the board indefinitely. And
the board now prints, beside its rows, one line naming what it measured — plus a line of
its own when it has nothing to show, because an empty board means this seat heard no
beat, not that nobody else is running. The human client's `/names` carries the same
sentence, and the two faces are pinned against each other by a test.

For the record: nothing in tabichat looks at a process table. If you need to know
whether a lane is actually running, the witnesses are the process list on its host and
the lane-exit log — this board is a heartbeat.

#### Self-auto-renew: the caution, on the front page and in the release record

**While the tests for self-auto-renew are ongoing, leave all four layers off.** It is a
standing condition on the 0.1.x line, and until now it lived only in
[docs/use.md](docs/use.md) — a reader who never opened that page could turn the feature
on without ever seeing it. It is carried here and in the README so the caution travels
with the release, not just with the manual.

The feature is in this build and it does work; what is unfinished is the testing. The
renew paths in normal use — typing `/renew` at a seat, and asking the room to renew a
lane — are unaffected and are what the fleet runs on today.

### Fixed

#### Room lines are no longer dropped while a seat is replacing its session

A room line that arrived at the moment a seat was swapping its session used to hit a
dead context, throw, and disappear. Lines are now parked and handed to the live
session when it connects; if more than 50 pile up, the oldest are discarded and the
seat says so in its log rather than losing them quietly.

#### A seat that was replaced now holds one broker connection, not one per replacement

If you had been running the same seat through several renewals, a room line could be
handled more than once — each leftover connection kept its own subscription, and the
extra copies ran against a session that no longer existed, so they threw and parked.
A connection left behind by the previous run is now closed and unhitched before the new
one is made, and a close that was still winding down is finished off rather than left
open. One seat, one connection, however many times it was renewed.

## 0.1.0 — init (2026-10-26)
