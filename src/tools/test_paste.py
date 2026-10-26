#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for the paste/fold rules (P4).

    python3 tools/test_paste.py      (exit 1 on any failure)

Positive and negative halves both required: a paste Enter must be swallowed and
a human Enter must send. The fd half runs on a real os.pipe(), so select() is
really consulted rather than mocked.
"""

import os
import select
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from paste import PASTE_WINDOW_S, enter_is_paste, fold_message  # noqa: E402

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(name)
        print(f"FAIL  {name}: got {got!r}, want {want!r}")
    else:
        print(f"ok    {name}: {got!r}")


# --- folding -----------------------------------------------------------------
check("plain line passes through", fold_message("one line only"), "one line only")
check(
    "pasted block folds to one message",
    fold_message("first line\nsecond line\nthird line"),
    "first line second line third line",
)
check("blank lines drop out", fold_message("a\n\n\nb\n"), "a b")
check("CRLF folds", fold_message("a\r\nb\r\n"), "a b")
check("space runs collapse", fold_message("too    many     spaces"), "too many spaces")
check("tabs collapse", fold_message("a\t\tb"), "a b")
check("whitespace-only folds to empty", fold_message("  \n\t "), "")
check("empty stays empty", fold_message(""), "")

# --- Enter: paste newline vs human send -------------------------------------
r, w = os.pipe()
try:
    now = time.monotonic()
    os.write(w, b"x")  # bytes still waiting: a paste is mid-flight
    check("fast Enter with bytes pending is a paste", enter_is_paste(now, r, now), True)
    check(
        "window is a sane short span",
        0.01 <= PASTE_WINDOW_S <= 1.0,
        True,
    )
    # drain, then the same fast Enter has nothing behind it: it sends
    while select.select([r], [], [], 0)[0]:
        os.read(r, 64)
    check("fast Enter with nothing pending sends", enter_is_paste(now, r, now), False)
    # bytes pending again, but the last byte is old: a person, not a paste
    os.write(w, b"y")
    old = now - 5.0
    check("slow Enter sends even with bytes pending", enter_is_paste(old, r, now), False)
    check("no previous byte at all sends", enter_is_paste(None, r, now), False)
    check("a bad fd is not a paste", enter_is_paste(now, -1, now), False)
finally:
    os.close(r)
    os.close(w)

if FAILED:
    print(f"\n{len(FAILED)} check(s) FAILED")
    sys.exit(1)
print("\nall checks pass")
