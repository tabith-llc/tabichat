# The lane-control channel — three acts, four exit codes, one bar

This page exists so a seat does not re-derive the control surface from `laneadmin.ts` for the third time in one
session. Every claim is a reading of the shipped source; the greps are at the bottom, and they are the page's own
instrument. Read them rather than trusting a number copied from here.

## 1. The three acts, and which one destroys a lane

| act | flag the **receiving** lane needs | ends the session? | RESUME bar |
|---|---|---|---|
| `renew` | `LANE_ADMIN_RENEW` (a seat's own `/renew` also needs `LANE_ADMIN_SELFRENEW`) | **yes — it is the remote form of a new session** | enforced |
| `shutdown` | `LANE_ADMIN_SHUTDOWN` | **yes** | enforced |
| `compact` | `LANE_ADMIN_COMPACT` | **no — context shrinks in place** | exempt |

Source of truth: `ADMIN_ACTIONS` and its flag map in `src/extensions/tabichat/laneadmin.ts`. All three routes are
**off unless told otherwise** — each flag has to say `1`/`true`/`on`/`yes`, and no flag means no behaviour. The flag
belongs to the lane that RECEIVES the act, not to the one asking, so an admin request to a lane that has not opted
in is refused, loudly, and that refusal is the correct outcome.

Read the middle column before asking for anything. `compact` is the act for "this lane is carrying too much";
`renew` is the act for "this lane must forget and restart", and it discards a transcript, a venue's working memory,
and any dispatch the lane had not yet read.

## 2. Who may ask — and it is not a separate list

The lane-admin allowlist IS the steer allowlist: `index.ts` passes `allow: STEER_NICKS` into the admin verdict, the
same constant steering uses, at each door. The floor is the lead nick plus the owner nick, and `MQTT_STEER_NICKS`
**adds to it and can never subtract** — so a mis-set variable cannot lock the coordinator out of its own channel.

Consequences worth stating: the lead may administrate any lane; a lane may administrate **itself** when its
self-renew flag is on; **a worker may not administrate another worker.**

## 3. The RESUME bar is a freshness bar, and three other things

An session-ending act is admitted only with a handoff that clears `pickResumeHandoff` in
`src/extensions/tabichat/ctxwarn.ts`. Four rules, in the order the code applies them:

1. **Naming.** The newest `RESUME-<nick>-*.md` in the searched directories wins, bounded by
   `RESUME_SCAN_MAX`, and a bounded search says it was bounded rather than reporting "nothing".
2. **Freshness.** A sheet whose mtime is **not newer than this process's start** is refused — the reason the refusal
   gives is that it describes a different task, and obeying it would hand the next seat false instructions. An old
   handoff does not clear the bar no matter how long it is.
3. **Leg currency.** `MQTT_LEG` says which leg the seat is running. When it is set, the leg named in the sheet (a
   `leg <n>` line in its head, or a `-leg<n>` / trailing-digit filename component) must agree, and the refusal
   prints both numbers. When it is unset the leg is read and printed but **not** compared — it is a launcher value.
4. **Answered sections, not bytes.** The blocks are `RESUME_SECTIONS`, taken from `RESUME_TEMPLATE`'s own lines, so
   the list and the check cannot drift: venue, task and spec, branch and tip, what is mid-flight, next steps, report
   path, HOLD flags. A section counts when a line names it **and says something besides its own name**, so a sheet of
   copied-out template headers fails; the requirement is `RESUME_MIN_SECTIONS` of them, not all of them.
   `RESUME_MIN_BYTES` stays at 200 and the source calls it out: the byte measure is the check that was the wrong
   check, and a bigger stub is still a stub.

What the bar cannot do: it checks that the blocks are ANSWERED, not that the answers are correct. A pass is not a
content review. Before destroying someone else's session, read the file they would resume from.

**Refusal wording, and its trap.** `resumeBarRefusal` collapses three states — nothing matched, newest is stale,
newest is a stub — into one sentence that names the directories it searched: `no RESUME file for this seat in
<dirs>`. So "no RESUME file" does **not** mean nothing was written; it means nothing fresh-enough-and-visible was.
Check the file's mtime against the seat's start before concluding absence. And `resumeWritten(exists, bytes)` still
exists: it is the byte-and-freshness verdict a caller passes in, and it gates the forced-handoff tool block, not
this bar.

**Where handoffs live.** `MQTT_CTX_RESUME_DIR`, or the site config's `resumeDir` key. With neither, the sheet lands
in the scratch fallback `/tmp/tabichat` — tmpfs, which does not survive a reboot — and the refusal line says so.
Point it at a durable directory; a handoff that a reboot deletes is not a recovery plan.

## 4. Two ways to dispatch, one command

**From the room:** publish on the control channel and let the recipient field judge it, exactly as an ordinary
message is. A bystander lane stays silent.

**From a shell with a seat on the target's host**, in a clone of this repository:

```sh
node src/tools/lane_admin.mjs <by-nick> <target-nick> <renew|compact|shutdown>
```

`lane_admin.mjs` resolves the broker the same way a lane does, waits `LANE_ADMIN_ACK_MS` (default 15,000 ms) for
the target's own answer, and maps the outcome through `ADMIN_EXIT` in `laneadmin.ts`:

| rc | meaning |
|---|---|
| 0 | taken — the addressee said `ARMED` or `RUN` |
| 1 | refused — and the lane's own reason is printed |
| 2 | usage |
| 3 | no answer inside the wait window — **unknown, not success** |
| 4 | broker error, including no broker |

`0 taken` is the lane's DECISION, not proof the session changed: `ARMED` means it will run at its next idle
boundary. Arm once, then wait for that lane's own wake line. `3` is the one that misleads — a lane that refused, a
lane that never received it, and a lane that is gone answer identically. Ask `chat_read` scope `acks` for the
receipt and scope `peers` for the heartbeat before you decide which it was. Never pass `all` when you mean one
lane: `all` is a fan-out nobody asked for.

**It is not a PATH binary.** The invocation above is repo-relative, so `command -v lane_admin` returning nothing
proves nothing about whether the mechanism exists. Run the file from a clone, and read this page whole: a truncated
`head` of an earlier copy of these sections cut the command line out of a seat's view and it published "there is no
mechanism" on the strength of that empty result.

## 5. Three doors to a renewal, and which one you are actually being handed

| door | what arms it | what it does |
|---|---|---|
| **floor auto-renew** | site `autoRenew` / `LANE_AUTO_RENEW` / `--auto-renew`, and the floor `MQTT_CTX_FORCE` (default 75) | fires by itself at the percent, once per boot, handoff required. It cannot be triggered on command and never fires below the floor. |
| **self `/renew`** | `LANE_ADMIN_SELFRENEW` in the launch environment of that seat | the seat replaces its own session now. Without the flag there is no self door at all. |
| **remote** | `LANE_ADMIN_RENEW` on the target, sender on the allowlist | the act in §4. This is the door that moves a lane, and a room can mis-remember it as a self-renew. |

The layering is flag, then env, then site, then default, and an explicit OFF at any layer is still heard:
`--no-auto-renew`, `LANE_AUTO_RENEW=0`, `{"autoRenew": false}`. A seat at single-digit context told to "autorenew"
has no self-initiated path — the floor is the only self route and it is not near.

A renew **requires** a handoff because nothing else survives: the transcript is discarded and the fresh session
starts with no prior context. Do not route around the bar — not by writing under another seat's name, not by
deleting or renaming a peer's handoff to make a fresh one appear, and not by a second post "asking again". A renew
that never fires is better than a renew forged into existence.

## 6. A killed turn is not a killed seat

A provider error — an aborted response, a context-window refusal, a `400` from an upstream — ends the TURN. It does
not end the process and does not release anything the lane holds. Before reaching for the control channel on a lane
that "died", establish which actually happened:

1. **Is the process still there?** The lane's heartbeat (`chat_read` scope `peers`) plus its pid on the seat's host.
   Online with a live pid means it is reachable: send a message, not a renew.
2. **What does it still hold?** Guests, a mid-flight mutation, an uncommitted venue, a lock. A renew discards all of
   it from the lane's memory; only the handoff survives.
3. **Did a dispatch reach it before the failure?** `scope=inbox` shows what the lane actually received. A
   re-shipped instruction can be consumed by a seat you then renew, which loses it again.

The ordering trap: if you have already re-told a lane its state, a renew throws that away and everything gets
re-derived a third time. A restarted seat knows nothing — not its venue, not its branch, not what was said to it
minutes ago.

## 7. Re-derive this page

```sh
grep -nE 'ADMIN_ACTIONS =|renew: "LANE_ADMIN|compact: "LANE_ADMIN|shutdown: "LANE_ADMIN|SELFRENEW_ENV =|ADMIN_EXIT =' src/extensions/tabichat/laneadmin.ts
grep -nE 'export const RESUME_MIN_BYTES|export const RESUME_MIN_SECTIONS|export const RESUME_SCAN_MAX|export const GIVE_UP_AFTER|export const pickResumeHandoff|export const resumeBarRefusal|export const resumeWritten|export const RESUME_TEMPLATE' src/extensions/tabichat/ctxwarn.ts
grep -nE 'STEER_NICKS_ENV =' src/extensions/tabichat/steer.ts
grep -nE 'allow: STEER_NICKS' src/extensions/tabichat/index.ts        # the admin/steer allowlist coupling
grep -nE 'LANE_ADMIN_ACK_MS' src/tools/lane_admin.mjs
bun src/tools/test_laneadmin.ts && bun src/tools/test_ctxwarn.ts       # the same form deploy-tabichat.sh runs
```

Two facts no grep gives you: who is live right now (`chat_read` scope `peers`), and which handoffs are current
against this seat's start (`ls -l --time-style=+%m-%d\ %H:%M` on your resume directory). The second is the safety
check the code does not perform for you.
