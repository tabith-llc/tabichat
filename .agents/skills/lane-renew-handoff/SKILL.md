---
name: lane-renew-handoff
description: What a worker lane does at a context floor — the forced-handoff notice, the RESUME file and the bar it has to clear, the close-out gauge, and waking renewed. Load when a [tabichat][ctx] notice appears or a leg closes at a renewal boundary.
---

# lane renew, handoff, and the forced-handoff notice

The **conduct** half of this lives in `../../../AGENTS.md` ("Renew law"). This page is the procedure a lane runs,
and every number in it belongs to `src/extensions/tabichat/ctxwarn.ts` — re-read the symbol rather than this file.

## A renew starts a new session. Your transcript does not travel.

pi prints "no prior context" on the fresh seat's screen and that is correct behaviour, not damage. The only thing
that carries across is your **RESUME file**, and the extension names its path for you — you do not invent it,
choose it, or go looking for it. The directory comes from `MQTT_CTX_RESUME_DIR` or the site config's `resumeDir`;
with neither set, sheets land in the scratch fallback `/tmp/tabichat`, which is tmpfs and does not survive a
reboot. That is a setting to fix once, not a thing to discover at the floor.

## When the forced-handoff notice arrives

`MQTT_CTX_FORCE` (default 75) is the floor. Crossing it posts the notice and **blocks your tools until the handoff
exists** — the block is the mechanism doing the thinking, so:

1. **Stop the leg.** Do not finish "one more thing". The turn you spend on one more thing is the turn you die in.
2. **Write the exact path the notice names**, filling every field it lists.
3. **Carry on.** The block lifts by itself once the file exists. Do not renew yourself as part of step 2.

While the block is up, read-only git and read tools stay available (`bashAllowedWhileForced`), which exists so the
sheet records the **true** venue state instead of a guess. Use them: `git status --porcelain`, your branch or
detached sha, and your tip are answers you can read rather than remember.

If the block refuses you `GIVE_UP_AFTER` times and the file still does not exist, the extension lifts the block
and says so — a stalled lane is worse than an un-noted one. That give-up line is not permission to skip the
handoff; it is the product refusing to hold you hostage, and the next seat of yours still has nothing.

## What the file has to say

`RESUME_TEMPLATE` is the field list, and the bar reads the same list, so the two cannot drift:

```
leg <n> this handoff describes (the number in your dispatch) — name it on the first line
venue / working dir (which clone, which work<N>)
task and the spec file path it came from
branch, tip commit, and ANYTHING uncommitted or unpushed
what is mid-flight right now (the exact next command you would have run)
next steps, in order
report path (where your output lives)
HOLD flags — any "do not do X / do not tell Y" instruction still in force
```

`pickResumeHandoff` admits the sheet on four rules — the newest file for your nick, **newer than this process's
start**, agreeing with the leg your launcher declares (`MQTT_LEG`), and answering at least `RESUME_MIN_SECTIONS` of
the blocks above with something besides the block's own name. `RESUME_MIN_BYTES` stays at 200, and the source says
plainly that the byte measure is the wrong check: a padding file that clears a count recovers nobody, and the next
seat is you. Write values a stranger can act on — venue, branch, tip, what is uncommitted, the next command, the
report path, the holds.

## Renewal timing is not your call

- If `auto-renew` is ON for your seat, the extension told you at start and named which setting said so. At the
  floor, with a handoff on disk, it renews you itself, once per boot. You do nothing extra.
- If it is OFF, you do nothing at all: the lead or the human renews you. Never type `/renew` because you feel
  full, and never ask to be renewed more than once — put "over floor, handoff written" in your report and let them
  act.
- Never renew mid-ceremony, mid-mutation, or while holding a machine you do not own. That is the exception, and it
  is stated in your close line rather than silently taken.

**Close out with the reading.** When a leg ends — report committed and pushed, verdict posted — record the context
figure in your own tracker row before you go idle. Renewal is a cost decision, and a seat that parks warm with no
number on it is a seat somebody has to guess about.

## Waking renewed is not resuming

Your first line as a fresh seat is a `[tabichat][renew]` notice carrying your handoff path. It is a tool result,
not a human message.

1. Read that file. It is the whole of what you knew.
2. Post one line — `renewed, holding` — and **wait for a dispatch**.
3. Do not resume your old leg from the handoff, do not re-derive a venue, and do not treat "I was doing X" as
   permission to do X. A handoff says where you were; only a dispatch says what you may do next.
4. If the notice says **no handoff was found**, say so in one line and hold. A renewed seat has no memory, and an
   invented one is worse than a stopped one.

The boot tag changes across a renew, which is why a second renew of the same seat can correctly refuse until it
writes again. That loop brake is a feature; do not "fix" it by deleting or renaming handoffs.

## When the room says the lead seat is refreshing

That line is the mechanism, published by the coordinating seat's own extension the moment its session is about to
be replaced. **It is not a stop order.** Keep executing, keep landing your report at its durable path, keep
committing and pushing on your branch. Queue, do not drop: verdicts produced during the hold go into the report
file and go out as one line with the path after the restore lands. The hold is on the channel **to that lead**,
never on the work, and it never applies to traffic from the human. If no restore line arrives after a reasonable
window, assume the seat died or forgot and resume posting — say that you did.
