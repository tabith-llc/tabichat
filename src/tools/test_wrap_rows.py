#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for room-line rows and for BOTH shapes of /clear.

    cd src && .venv/bin/python tools/test_wrap_rows.py      (exit 1 on any failure)

WHY THIS FILE WAS REBUILT (leg 506, 2026-10-24). It used to import `chat_cli`, and it could not:
it named FOUR symbols that exist in no client at all — `clear_screen`, `frame_rows`, `_CLEAR`,
`CLEAR_SEQ` — so `python3 tools/test_wrap_rows.py` died at the import line with rc 1 at base
`1b69e32`, and `deploy-tabichat.sh`'s GATES array never mentioned this file, which is why a whole
day of "13 of 13 green" gates never covered it. `chat_cli.py` is now deleted, so the file is
rewritten against `tabichat_cli`'s REAL names (`_wrap_display_rows`, `_render_entry`, `render_frame`,
`VIEW`, `CLEAR`, `CLEAR_KEEP`, `apply_clear`, `apply_clear_keep`) — no invented ones — and it is
wired into the deploy gate so it cannot sit dead again.

Two invariants under test.

ONE SCREEN LINE PER ROW, AT THE WIDTH WE PAINT INTO. `_wrap_display_rows` never emits a row wider
than the width it is given — including a single word wider than the terminal, which it BREAKS — and
rows are made at PAINT time from the unwrapped buffer, so a resize re-wraps instead of leaving rows
the terminal has to wrap for us. A row longer than the screen costs a line the frame never counted,
everything below shifts by one, and a fixed-frame client turns into a wall of duplicated lines.

/CLEAR HAS TWO SHAPES AND THEY DIFFER IN ONE THING: whether the buffer survives.
  /clear         screen AND buffer gone.   /clear screen   screen blank, buffer intact.
The second is the promise `chat_cli.py` held ("erase the chat lines on screen (keeps the room)",
its `:17` and its `:596`) and the only capability that would have died with that file, so it is
tested here on the real `submit()` path, not on a copy of it.

The spacing half is the older invariant and stays: the wrapper reproduces spaces and never invents
them. A colour code is not a word break — the first version added a space before any word that
followed a non-empty row, and every room line showed "HH:MM:SS <nick> : body", with a space the
sender never sent after the timestamp colour and a second one before the colon closing the nick.

The half that matters most is the negative one, in both directions: spaces the sender DID sent have
to survive or the fix trades one wrong answer for another, and a clear that silently destroyed the
peer list, the room, or the buffer has to FAIL this file.
"""

import contextlib
import io
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import tabichat_cli as tb  # noqa: E402

FAILED = []
WIDE = 200
NARROW = 40


def check(name, got, want):
    if got == want:
        print(f"ok   {name}")
        return
    FAILED.append(name)
    print(f"FAIL {name}\n       got: {got!r}\n      want: {want!r}")


def visible(row):
    """The row as a terminal shows it, colour codes removed."""
    return tb.ANSI_RE.sub("", row)


def room_line(nick, body, stamp="21:18:47"):
    """One room line exactly as note() gets it from the send and receive paths."""
    return f"{tb.AMBER}{stamp}{RESET_KEEP} {tb.BLUE}{nick}{RESET_KEEP}: {body}"


RESET_KEEP = tb.RESET


def reset(cap=5000, height=26, width=80):
    """A known-empty buffer with a known window, and both clear handshakes unarmed."""
    tb.ENTRIES.clear()
    tb.MATRIX.clear()
    tb.HISTORY_CAP = cap
    tb._WIDTH = width
    tb._HEIGHT = height
    tb.VIEW = 0
    tb.CLEAR.clear()
    tb.CLEAR_KEEP.clear()
    tb.go_live()


def paint(view_from=None):
    """The rows the renderer would draw right now: wrap what is unwrapped, then slice at VIEW."""
    v = tb.VIEW if view_from is None else view_from
    out = []
    for i, entry in enumerate(tb.ENTRIES):
        if i < v:
            continue
        out.extend(tb._wrap_display_rows(tb._render_entry(entry, WIDE), WIDE))
    return out


def run_clear(command):
    """Drive the REAL path: submit() sets the handshake, the renderer's handler applies it.

    The `3J` the handler writes to stdout is swallowed here — it is asserted separately, once, and
    a bare erase sequence in the middle of this file's own output is unreadable noise.
    """
    with contextlib.redirect_stdout(io.StringIO()):
        tb.submit(command)
        if tb.CLEAR.is_set():
            tb.CLEAR.clear()
            tb.apply_clear()
        if tb.CLEAR_KEEP.is_set():
            tb.CLEAR_KEEP.clear()
            tb.apply_clear_keep()


# --- positive: a clean line keeps the shape the send path built --------------
row = tb._wrap_display_rows(room_line("dust", "@ultra test send"), WIDE)
check("a clean line is one row", len(row), 1)
check("clean line visible text", visible(row[0]), "21:18:47 dust: @ultra test send")
# The two cells that used to be byte-shape assertions on chat_cli's wrapper. tabichat's wrapper
# flushes a pending space AFTER re-opening the next colour, so the raw bytes read
# `\x1b[0m\x1b[38;5;75m dust` where chat_cli emitted `\x1b[0m \x1b[38;5;75mdust`. The VISIBLE text —
# which is the invariant, and the only thing a terminal shows — is identical in both. Assert the
# invariant, not one file's incidental byte order: exactly one space, no space before the colon.
check("exactly one space between stamp and nick", re.search(r"\S\s{2,}\S", visible(row[0])) is None, True)
check("no space before the colon", " :" in visible(row[0]), False)
check("the nick is coloured", f"{tb.BLUE}" in row[0], True)

# --- positive: a mention mid-body keeps its own single space -----------------
mid = f"{tb.AMBER}21:18:47{RESET_KEEP} {tb.BLUE}ultra{RESET_KEEP}: {tb.MENTION}@dust{RESET_KEEP} report ready"
mid_rows = tb._wrap_display_rows(mid, WIDE)
check("mid-body mention is one row", len(mid_rows), 1)
check("mid-body mention spacing", visible(mid_rows[0]), "21:18:47 ultra: @dust report ready")

# --- negative half: spaces the sender really sent are NOT eaten -------------
check("a real double space survives", visible(tb._wrap_display_rows("a  b", WIDE)[0]), "a  b")
check("a real single space survives", visible(tb._wrap_display_rows("a b", WIDE)[0]), "a b")
check("a leading space opens no row", visible(tb._wrap_display_rows("   lead in", WIDE)[0]), "lead in")
check("a trailing space closes no row", visible(tb._wrap_display_rows("trail it   ", WIDE)[0]), "trail it")
check(
    "a body that starts with spaces keeps them after the colon",
    visible(tb._wrap_display_rows(room_line("dust", "  indented"), WIDE)[0]),
    "21:18:47 dust:   indented",
)

# --- negative half: an empty body gains no space either ---------------------
check(
    "empty body, no space before colon",
    visible(tb._wrap_display_rows(f"{tb.AMBER}21:18:47{RESET_KEEP} {tb.BLUE}dust{RESET_KEEP}:", WIDE)[0]),
    "21:18:47 dust:",
)

# --- wrapping still behaves: width honoured, colour re-opened, no gaps ------
rows = tb._wrap_display_rows(room_line("flash5", "word " * 39 + "end"), NARROW)
check("long line wraps", len(rows) > 1, True)
check("every row fits the width", all(len(visible(r)) <= NARROW for r in rows), True)
check("no row opens with a space", any(visible(r).startswith(" ") for r in rows), False)
check("wrapping lost no words", sum(visible(r).count("word") for r in rows), 39)
check("a body inside no colour invents none", rows[1].startswith(tb.BLUE), False)

# A body that IS inside a colour must carry that colour onto its continuations.
coloured = f"{tb.AMBER}21:18:47{RESET_KEEP} {tb.BLUE}flash5{RESET_KEEP}: {tb.MENTION}" + "word " * 39 + "end" + RESET_KEEP
crows = tb._wrap_display_rows(coloured, NARROW)
check("a coloured body wraps too", len(crows) > 1, True)
check("continuation rows re-open the colour", all(r.startswith(tb.MENTION) for r in crows[1:]), True)
check("coloured wrap keeps every word", sum(visible(r).count("word") for r in crows), 39)

# --- embedded newlines still split into one row per source row --------------
check("embedded newline splits rows", len(tb._wrap_display_rows("one\ntwo", WIDE)), 2)
blank = tb._wrap_display_rows("one\n\ntwo", WIDE)
check("blank source row is kept as a blank row", len(blank), 3)
check("the middle row is blank", blank[1], "")

# --- a word wider than the terminal is broken, never overflowed -------------
long_word = "x" * 100
lrows = tb._wrap_display_rows(long_word, NARROW)
check("an over-long word is broken", len(lrows) > 1, True)
check("a broken word still fits", all(len(visible(r)) <= NARROW for r in lrows), True)
check("breaking lost no characters", sum(visible(r).count("x") for r in lrows), 100)

# Negative half: a word that DOES fit is never cut, or this would chop every
# long-ish path and URL in the room into pieces.
check("a word that fits stays whole", len(tb._wrap_display_rows("y" * 30, NARROW)), 1)
check("a whole word keeps its characters", visible(tb._wrap_display_rows("y" * 30, NARROW)[0]), "y" * 30)

# A broken word inside a colour must carry that colour onto each piece.
clrows = tb._wrap_display_rows(f"{tb.MENTION}{'z' * 90}{RESET_KEEP}", NARROW)
check("a broken coloured word re-opens the colour", all(r.startswith(tb.MENTION) for r in clrows[1:]), True)
check("a coloured break loses no character", sum(visible(r).count("z") for r in clrows), 90)

# --- rows are made at PAINT time, not when the line arrived ------------------
reset(cap=5000)
long_entry = room_line("dust", "word " * 60 + "end")
tb.note(long_entry)
check("note() keeps one entry per message", len(tb.ENTRIES), 1)
check("note() stores it UNWRAPPED", tb.ENTRIES[0], long_entry)
check("note() leaves the wrap to the paint", tb.MATRIX[0], [])

narrow_rows = tb._wrap_display_rows(tb._render_entry(long_entry, 50), 50)
check("the same entry fits a narrower terminal", all(len(visible(r)) <= 50 for r in narrow_rows), True)
check("narrowing lost no words", sum(visible(r).count("word") for r in narrow_rows), 60)
check(
    "a narrower window costs more rows, not a broken screen",
    len(narrow_rows) > len(tb._wrap_display_rows(tb._render_entry(long_entry, WIDE), WIDE)),
    True,
)

# Negative half: a short line in a wide terminal is still exactly one row, so
# this does not spend rows it does not need to.
check(
    "a short line in a wide terminal is one row",
    len(tb._wrap_display_rows(tb._render_entry(room_line("dust", "short note"), WIDE), WIDE)),
    1,
)

# --- the buffer is capped in MESSAGES, and the cap is the documented one -----
check("the cap env var is the documented one", tb.HISTORY_ENV, "TABICHAT_HISTORY")
check("the shipped default is 5000 messages", tb.HISTORY_CAP_DEFAULT, 5000)
check("a junk cap value keeps the default", tb.cap_from_env("lots"), tb.HISTORY_CAP_DEFAULT)
check("a zero cap keeps the default", tb.cap_from_env("0"), tb.HISTORY_CAP_DEFAULT)
reset(cap=200)
for i in range(500):
    tb.note(f"line {i}")
check("the cap trimmed to MESSAGES, not rows", len(tb.ENTRIES), 200)
check("the NEWEST survived", tb.ENTRIES[-1], "line 499")
check("the OLDEST is what went", tb.ENTRIES[0], "line 300")

# --- /clear, the destructive shape ------------------------------------------
reset(cap=5000)
tb.ROOM = "tabith"
tb.ONLINE["bob"] = ("online", 0.0)
for i in range(3):
    tb.note(f"before the clear {i}")
check("a buffer exists before the clear", len(tb.ENTRIES), 3)
run_clear("/clear")
check("/clear leaves no entry behind", list(tb.ENTRIES), [])
check("/clear leaves no rows to paint", paint(), [])
check("/clear paints no receipt line", any("clear" in visible(r).lower() for r in paint()), False)
# Negative half: a blank screen is not a logout. The room, the peer set and the
# connection must come through it untouched.
check(
    "/clear leaves the room and the peers alone",
    (tb.ROOM, list(tb.ONLINE)),
    ("tabith", ["bob"]),
)

# --- /clear screen, the non-destructive shape (the chat_cli promise) --------
reset(cap=5000)
tb.ROOM = "tabith"
tb.ONLINE["bob"] = ("online", 0.0)
for i in range(3):
    tb.note(f"before the clear {i}")
before = list(tb.ENTRIES)
run_clear("/clear screen")
check("/clear screen blanks the view", paint(), [])
# THIS IS THE WHOLE POINT: the screen is empty and nothing was destroyed.
check("/clear screen keeps every message", list(tb.ENTRIES), before)
check("/clear screen keeps the wrapped matrix", len(tb.MATRIX), 3)
check(
    "/clear screen leaves the room and the peers alone",
    (tb.ROOM, list(tb.ONLINE)),
    ("tabith", ["bob"]),
)
# A line that arrives after the blank must show; the mark is not a freeze.
tb.note("after the clear")
check("a line arriving after /clear screen is painted", [visible(r) for r in paint()].count("after the clear"), 1)
check("and the older lines are still in the buffer", len(tb.ENTRIES), 4)
# /grep reaches the WHOLE buffer, mark included — that is what "keeps" is for.
hits, total, _ = tb.grep_rows("before the clear 1")
check("/grep still finds what /clear screen hid", len(hits), 1)
check("/grep counts the whole buffer, not the view", total >= 4, True)

# The reader reaching back IS the request to see it again: PgUp, /top and /show all reset the mark.
tb.set_scroll(2)
check("a scroll-back ends the blank", tb.VIEW, 0)
check("and the old text is on screen again", any("before the clear 0" in visible(r) for r in paint()), True)
run_clear("/clear screen")
tb.go_top()
check("/top ends the blank too", tb.VIEW, 0)
run_clear("/clear screen")
check("a /show jump ends the blank", (tb.jump_to_row(0), tb.VIEW), (True, 0))

# The mark is an ENTRY index and the cap trims from the FRONT, so the two interact: a mark that is
# not shifted would point past the end and hide live messages off the bottom of a blank screen.
reset(cap=5)
for i in range(5):
    tb.note(f"marked {i}")
run_clear("/clear screen")
check("the mark sits at the end of a full buffer", (tb.VIEW, len(tb.ENTRIES)), (5, 5))
tb.note("arrived after")
tb.note("and again")
check("the cap fired and trimmed two", len(tb.ENTRIES), 5)
check("THE MARK MOVED WITH THE TRIM", tb.VIEW, 3)
check("so the two new lines are the ones painted", len(paint()), 2)
check("and nothing painted is older than the clear", any("marked 4" in visible(r) for r in paint()), False)

# --- both clears put the scrollback erase on the wire ------------------------
reset()
tb.note("a line to erase")
with contextlib.redirect_stdout(io.StringIO()) as captured:
    tb.submit("/clear")
    tb.CLEAR.clear()
    tb.apply_clear()
check("/clear emits the xterm scrollback erase", "\x1b[3J" in captured.getvalue(), True)
reset()
tb.note("a line to blank")
with contextlib.redirect_stdout(io.StringIO()) as captured2:
    tb.submit("/clear screen")
    tb.CLEAR_KEEP.clear()
    tb.apply_clear_keep()
check("/clear screen emits it too", "\x1b[3J" in captured2.getvalue(), True)
check("the erase sequence is the ED=3 one", tb.CLEAR_SEQ, "\x1b[3J")

# --- submit() must not silently accept a third meaning of /clear -------------
reset()
tb.note("keep me")
run_clear("/clear sideways")
check("an unknown /clear argument is the documented destructive default", list(tb.ENTRIES), [])

# --- the two promises are stated where an operator reads them ---------------
help_text = " ".join(tb.HELP)
check("/help states the destructive promise", "blank the screen and drop the buffer" in help_text, True)
check("/help states the non-destructive promise", "KEEP the buffer" in help_text, True)
DOC = tb.__doc__ or ""
check(
    "the module docstring states both shapes",
    "/clear screen" in DOC and "blank the screen AND drop the buffer" in DOC,
    True,
)

print()
if FAILED:
    print(f"{len(FAILED)} check(s) FAILED: {', '.join(FAILED)}")
    sys.exit(1)
print("all wrap-rows and /clear-shape checks pass")
