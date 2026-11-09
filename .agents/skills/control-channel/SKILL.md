---
name: control-channel
description: "tabichat lane-control channel: renew vs compact vs shutdown, the flags each act needs on the receiving lane, who may ask, the RESUME bar, lane_admin exit codes, why a provider 400 ends a turn and not a process. Load before administrating any lane."
---

# control-channel

Read `references/control-channel.md` before acting. Rules that bind regardless of what it says:

1. Load this only when the current task names this work. Speculative reading is a context violation.
2. Cite by file and symbol, never by line number.
3. Re-derive any number it contains before you publish it, with the command that prints it.
4. `compact` is the act for "this lane is carrying too much"; `renew` is the act for "this lane must forget and
   restart". Choosing `renew` when `compact` would do destroys a transcript, and a refused act is the guard
   working, not a bug to route around.
