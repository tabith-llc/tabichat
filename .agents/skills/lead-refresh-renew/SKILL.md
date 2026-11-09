---
name: lead-refresh-renew
description: The five-step lead-refresh protocol, what a coordinating seat's own handoff must contain, and the renewal mechanism facts (which doors publish the hold, the boot tag that moves, the hold's own journalling). Load before renewing or refreshing the seat that dispatches work.
---

# lead refresh, renew, and the handoff bar

The **law** — hold first, a hold is not a stop, the ledger is the handoff, the restore order — is in
`../../../AGENTS.md`, section "Lead reseating". This page is the run a seat executes, and the mechanism facts that
tell you which half the product does for you and which half is yours.

## What the product does, and what it cannot

`laneadmin.ts:shouldHoldBeforeRenew` is `self === leadNick`, wired into the renew handler in `index.ts`. When the
seat being replaced is the one named by `MQTT_LEAD_NICK`, the extension publishes the room-wide hold **before** the
session change, and the wake hand-off `laneadmin.ts:wakeRenewedSeat` is told the seat was a lead — which is what
puts the restore line first in the fresh session's directive. That covers `/renew` from every door — typed at the
seat, requested remotely, and auto-renew at the context floor.

It does **not** cover the human typing `/new` at that seat: that path bypasses the command handler, so a planned
refresh still needs the broadcast by hand. The requirement used to be a promise in a seat contract; the code took
it over because a promise broken on the record is not a control. Two consequences a seat should hold:

- **Never let the harness's own hold line stand in for yours.** Publish, then renew; never renew and publish after.
  A hold that arrives after the session change is news about a gap that already happened.
- **The hold is a room line like any other.** It runs the same publish tail every room post runs, so it is counted
  and journalled by the author on the same terms — which means the sending seat can answer "did I send that?" about
  it, and the answer for the socket failure is stated in the notice the seat gets when the publish throws.

A hold is not redundant with a stop order. A stop ends work; a hold protects delivery. Under a stop alone a lane
that is finishing still addresses the lead, and that verdict lands nowhere.

## The run, in order

1. **Broadcast the hold first** — before the ledger, before any read, before anything that spends the remaining
   context. `to: "all"`, `steer: true`, one sentence naming the lead nick and the restore line as the release
   condition, and the clarification that work does not stop. It must be a steer: a normal post queues behind each
   lane's whole run, which is exactly the traffic a hold exists to intercept. Recipient field only, never body text.
2. **Write the handoff.** The broadcast is not the handoff — the ledger is. Commit what a cold seat cannot derive:
   every dispatch shipped this session with its ack state (or the words "no ack"), every merge landed and every
   merge held with the reason, the in-flight table (lane → what it holds, branch → awaiting, gate → running), the
   live pins re-read in the same turn, your own tree clean. A lane that acked a dispatch and then died is invisible
   to the harness: only a written line tells the next seat it was ever dispatched.
3. **Ask the human to refresh**, in plain terminal text, and supply the prompt: the seat to write, the outstanding
   asks by name, and the instruction to read the ledger block and the report directory before dispatching anything.
4. **They refresh.** You do not restart your own seat on that path, and you never assume a lane self-starts.
5. **Restore, then three acts in order:** the room-wide restore line; read the ledger, then list the report
   directory by mtime and read the verdict lines; then re-ship every dispatch that has an ack and no report. Then
   re-read live git, the fleet, and the remotes before quoting any pin or naming any branch — never a remembered sha.

The re-ship must carry recovery facts regenerated from the machine at send time: the venue's git state, whether a
report already exists at its path, the current tip, and what the lane holds. A dead lane's artifacts ADVANCE, so
stale recovery facts are not merely wrong — they can send a lane to repeat a step its own report says it finished,
or to ask the human for something he already did.

## The boot tag, and why "I already handed off" can be stale

A RESUME file is named `RESUME-<nick>-<boot>.md` and the tag changes across a renew. The handoff bar is per boot —
freshness is judged against the process's start — so after a self-renew this seat cannot clear the bar again on the
strength of the sheet it wrote under its previous name. Write a new one. The tag moving, plus a fresh handoff under
the new name, is the only observable that a renew actually happened; an `ARMED` answer or a room line is not proof.

## Every other seat, when the hold lands

A worker lane, a service seat, a human-facing relay seat: **pause comms to that lead only, and keep working.**
The full list of duties is in the `lane-renew-handoff` skill, and it is the same four: keep executing, keep landing
reports at durable paths, keep committing and pushing, queue verdicts in the report file and send one line with the
path after the restore. A hold that stops work is a self-inflicted outage. A hold that never expires is a lost
broadcast silencing the fleet, so if no restore lands in a reasonable window, resume posting and say that you did.
Traffic to and from the human is never held.
