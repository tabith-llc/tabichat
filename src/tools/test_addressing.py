#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for room addressing in the human clients (src/addressing.py).

    python3 tools/test_addressing.py      (exit 1 on any failure)

Pure module — no paho, no broker — so this runs on a box where MQTT is absent, which is the only
way the human side of the addressing rule is checkable at all. It is the Python mirror of
``tools/test_mention.ts``: same field-first rule, same whole-token discipline, same cases where
the two clients mean the same thing.

The rule under test (owner request 2026-10-16): broadcasting is a property of the RECIPIENT FIELD,
and an address quoted in the body is inert while a field is set. Both halves are required — the
line that must arrive AND the line that must not — because a gate that passes only the positive
half is untested. The most important row is the first one: it is the reported defect.

Where a human client MEANS something different from a lane, that is asserted here as a difference
and not left to be discovered (`broadcast_field`, and the rows that keep the human nudge personal).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from addressing import (  # noqa: E402
    ALL_LANES,
    addressed_to,
    broadcast_field,
    mentions_self,
    recipient_field,
    receives,
)

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(name)
        print(f"FAIL  {name}: got {got!r}, want {want!r}")
    else:
        print(f"ok    {name}: {got!r}")


# the body of the reported defect, verbatim in shape: a verdict QUOTING addresses in prose
DEFECT_TEXT = "ultra report: 3 direct @flash5, 4 @all) - tally of my inbox"

# --- THE REPORTED DEFECT: field set, quoted prose inert -------------------------------------
check(
    "THE DEFECT — a quoted token in a body must not make a third seat's terminal shout",
    receives("wren", DEFECT_TEXT, "courier"),
    False,
)
check("...nor does a quoted own-nick address the line to that seat",
      receives("wren", DEFECT_TEXT, "flash5"), False)
check("...and the field's own addressee is still addressed",
      receives("wren", DEFECT_TEXT, "wren"), True)
check("a field for one seat beats a real mention of another in the body",
      receives("wren", "@flash2 look", "flash2"), False)

# --- field discipline: whole tokens, same NAME_CHARS rule as the text path -----------------
check("field 'allen' is not the all-lanes value", broadcast_field("allen"), False)
check("field 'all-fix' is not the all-lanes value", broadcast_field("all-fix"), False)
check("short field must not name a longer nick", receives("flash1", "x", "flash10"), False)
check("long field must not name a shorter nick", receives("flash10", "x", "flash1"), False)
check("field 'lead' does not name 'lead-agent'", receives("lead", "x", "lead-agent"), False)
check("field 'lead-agent' does not name 'lead'", receives("lead-agent", "x", "lead"), False)
check("a comma list names both addressees", receives("clerk, courier", "x", "clerk"), True)
check("...and the second one", receives("clerk, courier", "x", "courier"), True)
check("...and nobody else", receives("clerk, courier", "x", "flash1"), False)
check("the field is case-folded", receives("WREN", "x", "wren"), True)
check("the reader's nick is case-folded too", receives("wren", "x", "WREN"), True)
check("a leading @ in the field is the same address", receives("@wren", "x", "wren"), True)

# --- the room-wide field, and the ONE place a human client differs from a lane --------------
check("a room-wide field is recognized as a broadcast", broadcast_field(ALL_LANES), True)
check("...and is case-folded", broadcast_field("ALL"), True)
check(
    "DELIBERATE DIFFERENCE — a broadcast does not make the human's terminal shout, nor ack",
    receives(ALL_LANES, DEFECT_TEXT, "courier"),
    False,
)
check(
    "...so the human client publishes no receipts for room-wide notices (unchanged behavior)",
    receives(ALL_LANES, "hold comms while the lead seat refreshes", "dust"),
    False,
)

# --- LEGACY PATH: no field => the body scan still decides ----------------------------------
check("legacy positive half still holds", receives(None, "@flash2 look", "flash2"), True)
check("legacy negative half still holds", receives(None, "@flash2 look", "flash1"), False)
check("...and it is whole-token, not a substring", receives(None, "@allen go", "all"), False)
check("...and an e-mail is not a mention", receives(None, "owner@all.example", "ultra"), False)
check(
    "DOCUMENTED LIMITATION: fieldless prose still decides, which is why the tool must set the field",
    receives(None, "@courier look", "courier"),
    True,
)
check(
    "LEGACY HALF — a body all-lanes token never addressed a human and still does not",
    receives(None, "@all ping", "courier"),
    False,
)

# --- a field that names nobody is NO field, not a black hole -------------------------------
check("blank field falls back to the scan", receives("", "@flash1 go", "flash1"), True)
check("...and finds nothing when there is nothing", receives("   ", "no mentions", "flash1"), False)
check("an @ alone is not an addressee", receives("@", "@flash1 go", "flash1"), True)
check("punctuation is not an addressee", receives("!!!", "@flash1 go", "flash1"), True)

# --- the publisher's own normalization (what goes on the wire) -----------------------------
check("a named addressee is trimmed", recipient_field("  wren  "), "wren")
check("a leading @ is dropped", recipient_field("@all"), ALL_LANES)
check("a comma list is kept as one field", recipient_field("clerk, courier"), "clerk, courier")
check("no addressee means no field", recipient_field(None), "")
check("NEGATIVE HALF — a bare @ publishes no field", recipient_field("@"), "")
check("NEGATIVE HALF — blanks publish no field", recipient_field("   "), "")
check("NEGATIVE HALF — a non-string publishes no field", recipient_field(7), "")

# --- the two halves kept separately, so a field failure names the matcher ------------------
check("addressed_to never reads the body", addressed_to("wren", "courier"), False)
check("mentions_self is the scan alone", mentions_self(DEFECT_TEXT, "flash5"), True)
check("...and it needs no field to work", mentions_self("@ultra go", "ultra"), True)

print()
if FAILED:
    print(f"{len(FAILED)} check(s) FAILED:")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
print("all checks pass")
