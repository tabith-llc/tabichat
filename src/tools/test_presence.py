#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for presence-record precedence (P5).

    python3 tools/test_presence.py      (exit 1 on any failure)

The half that matters most is the negative one: an unstamped record left on the
older shared presence topic must NOT mark a live peer as gone.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from presence import (  # noqa: E402
    MS_CEILING_S,
    PEERS_INSTRUMENT,
    STALE_S,
    norm_ts,
    peer_age,
    peer_record_wins,
    peer_state,
)

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(name)
        print(f"FAIL  {name}: got {got!r}, want {want!r}")
    else:
        print(f"ok    {name}: {got!r}")


# --- which record wins -------------------------------------------------------
check("nothing held yet: any record lands", peer_record_wins(None, ("online", 500)), True)
check(
    "stamped record beats an unstamped one",
    peer_record_wins(("online", 500), ("offline", 0)),
    False,
)
check("stamped record beats an unstamped one (both directions)",
      peer_record_wins(("online", 0), ("offline", 500)), True)
check("newer stamp wins", peer_record_wins(("online", 500), ("offline", 600)), True)
check("older stamp is refused", peer_record_wins(("online", 600), ("offline", 500)), False)
check("a replay of the same stamp still lands", peer_record_wins(("online", 500), ("offline", 500)), True)
check("unstamped may replace unstamped", peer_record_wins(("online", 0), ("offline", 0)), True)

# --- liveness ----------------------------------------------------------------
NOW = 10_000.0
check("fresh beat is online", peer_state(("online", NOW - 5), NOW), "online")
check("quiet past the allowance is stale", peer_state(("online", NOW - 91), NOW), "stale")
check("an unstamped record proves nothing", peer_state(("online", 0), NOW), "stale")
check("unknown peer is offline", peer_state(None, NOW), "offline")
check("declared offline stays offline", peer_state(("offline", NOW), NOW), "offline")

# --- presence fidelity (R-2717 item 3), mirrored from roommsg.ts --------------
# The stamp is the PEER'S clock; the age is taken against OURS. A record further ahead than one whole
# allowance cannot be timed here at all, and it used to read `online` for as long as the skew held the
# age negative — which is how a seat whose process was gone stayed live on a liveness board.
check("a beat ahead within the allowance still ranks", peer_state(("online", NOW + 30), NOW), "online")
check("a stamp ahead past the allowance is not proof of life", peer_state(("online", NOW + 600), NOW), "stale")
check(
    "PAIRED NEGATIVE — the bound is symmetric: a stamp 89s ahead ranks, 91s ahead does not",
    (peer_state(("online", NOW + 89), NOW), peer_state(("online", NOW + 91), NOW)),
    ("online", "stale"),
)
check(
    "PAIRED NEGATIVE — an unrankable stamp never outranks a declared offline",
    peer_state(("offline", NOW + 600), NOW),
    "offline",
)
check("the age of a real beat is its age", peer_age(("online", NOW - 42), NOW), "42s")
check(
    "THE READING THAT LIED: a future stamp used to print '0s' (just now); it prints its skew instead",
    peer_age(("online", NOW + 600), NOW),
    "ahead 600s",
)
check("an unstamped row never gets an invented age", peer_age(("online", 0), NOW), "no stamp")
check("no record says no record", peer_age(None, NOW), "no record")

# --- ONE FIELD, TWO UNITS (leg 1149) ----------------------------------------
# The wire says ms; the human client published seconds; both readings meet in this file. A ms beat
# read against this face's seconds clock sits ~56 years ahead, so it read `stale` forever and the client
# reprinted `joined` on every beat; the same seconds beat read against the seat face's ms clock sits 56
# years behind, so it lost every ranking — a last-will included, which is a peer who cannot clear their
# own row. The guard plant at the end is the paired negative: the fix must be a normalization, not a
# way to rank anything at all.
def ms(seconds):
    return int(seconds * 1000)


# A REALISTIC epoch, and that is not a detail: the ceiling that separates the units is an absolute
# bound (1e11 seconds is the year 5138), so a unit cell written against this file's toy clock of
# 10_000 seconds cannot be told apart from a seconds stamp at all — the first draft of these cells
# failed for exactly that reason, and a cell that passes only because its numbers are imaginary is
# worth nothing. Measured at the pen: 2026 is ~1.78e9 seconds, ~1.78e12 ms.
EPOCH_S = 1_780_000_000.0
EPOCH_MS = ms(EPOCH_S)

check("an ms beat reads online against a seconds clock", peer_state(("online", ms(EPOCH_S + 5)), EPOCH_S), "online")
check("and its row says which unit it arrived in",
      peer_age(("online", ms(EPOCH_S + 5)), EPOCH_S), "ahead 5s [ms stamp, read as ms]")
check("a native seconds row still prints no unit note", peer_age(("online", NOW - 30), NOW), "30s")
check("a seconds stamp outranks an older ms record",
      peer_record_wins(("online", ms(EPOCH_S + 100)), ("online", EPOCH_S + 200)), True)
check("PAIRED — an OLDER seconds stamp still loses to a newer ms record",
      peer_record_wins(("online", ms(EPOCH_S + 200)), ("online", EPOCH_S + 100)), False)
check("a client last-will in seconds is accepted against an older ms beat",
      peer_record_wins(("online", ms(EPOCH_S - 10)), ("offline", EPOCH_S + 1)), True)

# Six beats, one `joined`. The count is the claim the owner felt, so this rebuilds the loop that prints
# it (record-wins gate, then the state transition) rather than asserting the state alone.
joined = 0
online = None
prev = None
for i in range(6):
    incoming = ("online", ms(EPOCH_S + i))
    if not peer_record_wins(online, incoming):
        continue
    online = incoming
    if peer_state(online, EPOCH_S + i) == "online" and peer_state(prev, EPOCH_S + i) != "online":
        joined += 1
    prev = online
check("six ms beats for one peer print EXACTLY ONE joined line", joined, 1)
check("and the peer reads online after the first of them", peer_state(online, EPOCH_S + 6), "online")

check("GUARD KEPT — a seconds stamp far ahead is still stale", peer_state(("online", EPOCH_S + 10_000), EPOCH_S), "stale")
check("GUARD KEPT — the same moment arriving in ms is stale too",
      peer_state(("online", ms(EPOCH_S + 10_000)), EPOCH_S), "stale")
check("GUARD KEPT — and its row prints the skew, never a clamped zero",
      peer_age(("online", ms(EPOCH_S + 600)), EPOCH_S), "ahead 600s [ms stamp, read as ms]")
check("norm_ts leaves a seconds stamp alone", norm_ts(EPOCH_S), EPOCH_S)
check("and reads a ms stamp down, to the second", norm_ts(EPOCH_MS), EPOCH_S)
check("PAIRED — it leaves the toy clock of this file's other cells alone", norm_ts(NOW + 30), NOW + 30)

# The two faces must not drift: this sentence is what a reader of either board sees, and a paraphrase
# on one side is the same silent-failure class as an unstamped record outranking a stamped one.
ROOMMSG = os.path.join(os.path.dirname(__file__), "..", "extensions", "tabichat", "roommsg.ts")
with open(ROOMMSG, encoding="utf-8") as fh:
    ts_src = fh.read()
check(
    "the instrument sentence is the SAME string on both faces",
    PEERS_INSTRUMENT in ts_src,
    True,
)
check(
    "and the allowance that decides 'cannot rank' is the same number on both faces",
    (STALE_S, "PEER_STALE_AFTER_MS_DEFAULT = 90_000" in ts_src),
    (90.0, True),
)
# The unit ceiling is the same single number on both faces, for the same reason the allowance is: two
# constants that must agree, written in two languages with no build step between them, are how the
# first peer's stamp starts meaning one thing here and another thing there.
check(
    "and the unit ceiling that separates the two units is the same number on both faces",
    (MS_CEILING_S, "BEAT_MS_FLOOR = 1e11" in ts_src),
    (1e11, True),
)

if FAILED:
    print(f"\n{len(FAILED)} check(s) FAILED")
    sys.exit(1)
print("\nall checks pass")
