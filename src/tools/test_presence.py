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

from presence import peer_record_wins, peer_state, peer_age, PEERS_INSTRUMENT, STALE_S  # noqa: E402

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

if FAILED:
    print(f"\n{len(FAILED)} check(s) FAILED")
    sys.exit(1)
print("\nall checks pass")
