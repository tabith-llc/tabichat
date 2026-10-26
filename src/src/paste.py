# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Pasted-block handling for the room CLI (lead requirement P4).

Two rules live here, both pure, both checked by tools/test_paste.py:

* One Enter inside a pasted burst belongs to the MESSAGE; only a human's Enter
  sends. A multi-line paste used to publish one message per line about a second
  apart, which read to the room as separate statements (and to the lead as a
  lane saying the same thing twice).
* Room text is ONE line, and a message that is empty after folding is refused
  rather than published.

The terminal is in raw mode, so a paste arrives as ordinary bytes at line
speed: the burst itself is the signal. Bracketed-paste escapes would be the
other route, but this CLI swallows escape sequences in pump_key, so timing is
what the input loop can actually rely on.
"""

import select

# An Enter this soon after the previous byte, with more bytes already waiting,
# came from a paste and not from a person's thumb.
PASTE_WINDOW_S = 0.12


def fold_message(raw):
    """Fold a message onto one line. Returns "" for whitespace-only input."""
    out = []
    for seg in (raw or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        seg = " ".join(seg.replace("\t", " ").split())
        if seg:
            out.append(seg)
    return " ".join(out).strip()


def enter_is_paste(last_byte_at, fd, now_mono, window=PASTE_WINDOW_S):
    """True when this Enter is a newline INSIDE a paste, False when it sends.

    Both halves matter: a person pressing Enter after a pause sends, and a
    person pressing Enter twice in a row still sends (the second Enter has no
    bytes waiting, so it is not treated as paste).
    """
    if last_byte_at is None:
        return False
    if (now_mono - last_byte_at) > window:
        return False
    try:
        return bool(select.select([fd], [], [], 0)[0])
    except (OSError, ValueError):
        return False
