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

from presence import peer_record_wins, peer_state  # noqa: E402

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

if FAILED:
    print(f"\n{len(FAILED)} check(s) FAILED")
    sys.exit(1)
print("\nall checks pass")
