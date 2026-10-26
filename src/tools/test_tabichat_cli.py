#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Truth table for the tabichat scrollback client.

    cd src && .venv/bin/python tools/test_tabichat_cli.py      (exit 1 on any failure)

This client exists for ONE reason: a human must be able to read what they missed. It was written to
live beside a second client (the ask, verbatim: "leave chat_cli.py as-is. create a
new chat client call tabichat ... to live alongside the regular chat_cli.py"); that client was
retired on 2026-10-24 on his later word, so every rule below is a rule about THIS file only, and
`tools/test_wrap_rows.py` is the file that owns the two shapes of /clear.

The halves that matter most are the negative ones, per the project's truth-table law:
  - a window function that always returns the live tail must FAIL here — that is the bug being
    treated ("it works well, but adds only an extra page of chat");
  - a scroll clamp that runs past the newest line or before the oldest must FAIL;
  - a buffer cap that trims from the WRONG end must FAIL, because that deletes live chat and
    keeps stale chat;
  - a key handler that treats a lone Escape as anything at all must FAIL — hitting Escape
    mid-sentence must not quit, must not send, must not scroll;
  - a word wider than the terminal must be BROKEN here, because passing it whole is how a
    fixed-frame client starts painting more lines than the screen holds (the wrap-rows harness
    demands the same invariant, and it is a deploy gate).
"""

import os
import pty
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import tabichat_cli as tb  # noqa: E402

failed = 0


def check(name, got, want):
    global failed
    g, w = repr(got), repr(want)
    if g != w:
        failed += 1
        print(f"FAIL  {name}: got {g}, want {w}")
    else:
        print(f"ok    {name}: {g}")


def says(name, hay, needle):
    check(name, needle in hay, True)


def never(name, hay, needle):
    check(name, needle in hay, False)


def visible(s):
    return tb.ANSI_RE.sub("", s)


def reset_state(cap=5000, height=26, width=80):
    tb.ENTRIES.clear()
    tb.MATRIX.clear()
    tb.HISTORY_CAP = cap
    tb._WIDTH = width
    tb._HEIGHT = height
    tb.go_live()


# --- the cap comes from the environment, and a typo must not erase your memory ---
check("cap: unset keeps the default", tb.cap_from_env(None), tb.HISTORY_CAP_DEFAULT)
check("cap: empty keeps the default", tb.cap_from_env(""), tb.HISTORY_CAP_DEFAULT)
check("cap: 20000 is honoured", tb.cap_from_env("20000"), 20000)
check("cap: junk keeps the default", tb.cap_from_env("lots"), tb.HISTORY_CAP_DEFAULT)
check("cap: ZERO refused (a typo must not give a 0-message buffer)", tb.cap_from_env("0"), tb.HISTORY_CAP_DEFAULT)
check("cap: negative refused", tb.cap_from_env("-5"), tb.HISTORY_CAP_DEFAULT)
check("cap: surrounding spaces still parse", tb.cap_from_env(" 4321 "), 4321)
check("the default is MUCH bigger than the old 500 rows", tb.HISTORY_CAP_DEFAULT, 5000)
check("the env var is the documented one", tb.HISTORY_ENV, "TABICHAT_HISTORY")

# --- window math: the heart of the feature ------------------------------------
check("live paints the newest tail", tb.scroll_window(100, 24, 0), (76, 100))
check("one screen back", tb.scroll_window(100, 24, 24), (52, 76))
check("at the oldest line", tb.scroll_window(100, 24, 76), (0, 24))
check("scroll past the top clamps, it does not wrap", tb.scroll_window(100, 24, 5000), (0, 24))
check("negative scroll clamps to live", tb.scroll_window(100, 24, -7), (76, 100))
check(
    "THE BUG BEING TREATED: deeper scroll MUST move the window off the tail",
    tb.scroll_window(100, 24, 50) != tb.scroll_window(100, 24, 0),
    True,
)
check(
    "the window stays `avail` rows tall at every depth (a shrinking frame flashes)",
    {tb.scroll_window(100, 24, s)[1] - tb.scroll_window(100, 24, s)[0] for s in (0, 1, 12, 40, 75, 76)},
    {24},
)
check("every depth reaches a DIFFERENT window", len({tb.scroll_window(100, 24, s) for s in range(0, 77, 7)}) >= 11, True)
check("short buffer shows what exists", tb.scroll_window(10, 24, 0), (0, 10))
check("short buffer ignores a stale scroll", tb.scroll_window(10, 24, 40), (0, 10))
check("empty buffer paints nothing", tb.scroll_window(0, 24, 0), (0, 0))
check("avail of 0 still means at least one row", tb.scroll_window(100, 0, 0), (99, 100))

# --- row counting + the footer -------------------------------------------------
_matrix = [["a1", "a2"], ["b1"], ["c1", "c2", "c3"]]
check("visible_rows counts WRAPPED rows, not entries", tb.visible_rows(_matrix), 6)
check("visible_rows on an empty buffer", tb.visible_rows([]), 0)
check("visible_rows honours a ceiling", tb.visible_rows(_matrix, cap=3), 3)
check("live shows no footer", tb.status_row(0, 5, 100, 24), "")
check("scrolled says how deep", "26 row(s) back" in tb.status_row(50, 0, 100, 24), True)
check("scrolled counts what arrived meanwhile", "3 new" in tb.status_row(50, 3, 100, 24), True)
check("footer names the way out", "/live newest" in tb.status_row(50, 0, 100, 24), True)

# --- wrapping: one row per screen line, at the width we paint into --------------
rows = tb._wrap_display_rows("x" * 200, 40)
check("an over-long word is BROKEN, not passed through", len(rows) > 1, True)
check("a broken word still fits", all(len(visible(r)) <= 40 for r in rows), True)
check("breaking lost no characters", sum(visible(r).count("x") for r in rows), 200)
check("a word that fits stays whole", len(tb._wrap_display_rows("y" * 30, 40)), 1)
check("a whole word keeps its characters", visible(tb._wrap_display_rows("y" * 30, 40)[0]), "y" * 30)
cl = tb._wrap_display_rows(f"{tb.MENTION}{'z' * 90}{tb.RESET}", 40)
check("a broken coloured word re-opens the colour", all(r.startswith(tb.MENTION) for r in cl), True)
check("a coloured break loses no character", sum(visible(r).count("z") for r in cl), 90)
check("a short entry is one row", tb._wrap_display_rows("hello", 80), ["hello"])
check("an empty entry is still one row (the frame counts rows)", tb._wrap_display_rows("", 80), [""])
check("embedded newlines become separate rows", len(tb._wrap_display_rows("one\ntwo\nthree", 80)), 3)
check("two real spaces stay two real spaces", tb._wrap_display_rows("a  b", 80), ["a  b"])
coloured = tb._wrap_display_rows(f"{tb.AMBER}12:00:00{tb.RESET} {tb.BLUE}wren{tb.RESET}: hi", 80)
check(
    "a colour code earns no phantom space (the chat_cli lesson)",
    visible(coloured[0]),
    "12:00:00 wren: hi",
)

# --- markdown-lite: display only, the sender's characters survive ---------------
md = tb.md_inline("run `alembic upgrade head` now")
says("inline code is tinted", md, tb.CYAN + "alembic upgrade head")
says("the backticks the sender typed are STILL THERE", md, "`")
check("a line with no markup is untouched", tb.md_inline("plain words"), "plain words")
bold = tb.md_inline("this is **important** ok")
says("bold is rendered", bold, tb.BOLD + "important")
says("bold markers stay visible too", bold, "**")
never("markdown never invents a newline", bold, "\n")
blk = tb.md_block("look:\n```\nSELECT   1;\n```")
check("a fenced block keeps its inner spacing verbatim", "SELECT   1;" in blk[2], True)
check("the fence markers are still printed", len(blk), 4)
check("an unfenced entry returns None (single-row path)", tb.md_block("no fences here"), None)
check(
    "a fenced block is NOT reflowed",
    tb.md_block("```\n" + "x" * 300 + "\n```")[1].count("x"),
    300,
)

# --- the buffer: a CAP IN MESSAGES that trims from the right end -----------------
reset_state(cap=5)
for i in range(12):
    tb.note(f"message {i}")
check("buffer cap trims to MESSAGES", len(tb.ENTRIES), 5)
check("the NEWEST survived (trimming the wrong end deletes live chat)", tb.ENTRIES[-1], "message 11")
check("the OLDEST is what went", tb.ENTRIES[0], "message 7")
check("MATRIX stays one list per entry", len(tb.MATRIX), len(tb.ENTRIES))
reset_state(cap=5)
tb.note("a" * 300)          # one message, many rows
check("a cap of 5 messages is unaffected by one long post", len(tb.ENTRIES), 1)
check("a fresh entry is stored UNWRAPPED (the wrap happens at paint)", tb.MATRIX[0], [])
tb.buffer_rows()            # the paint pass
n, r, s, u = tb.depth()
check("depth reports entries", n, 1)
check("depth reports MORE rows than entries for a long post", r > n, True)
check("depth starts live", (s, u), (0, 0))

# --- scrolling: parked, counted, returned ---------------------------------------
reset_state(cap=500, height=10)
for i in range(50):
    tb.note(f"line {i}")
tb.buffer_rows()            # force the wrap so rows exist
scroll, total = tb.set_scroll(10)
check("scroll moves the window", scroll, 10)
check("a scrolled session knows the total", total >= 50, True)
tb.note("arrived while parked")
check("a new line while scrolled does NOT yank the reader forward", tb._SCROLL, 10)
check("it is counted instead", tb._UNREAD, 1)
tb.set_scroll(500)
check("an absurd scroll is clamped, not crashed", tb._SCROLL <= total, True)
tb.go_live()
check("going live clears the depth", tb._SCROLL, 0)
check("going live clears the counter", tb._UNREAD, 0)

# --- /grep reaches the whole buffer, /show jumps to a row ------------------------
reset_state(cap=500)
for i in range(30):
    tb.note(f"row {i} says hello-{i}")
got = tb.grep_rows("hello-3")
check("grep returns (hits, total, index)", len(got), 3)
hits, total, index_of = got
check("grep found the needle", len(hits) > 0, True)
check("grep sees the whole buffer, not one screen", total >= 30, True)
check("the only match is the exact one (hello-23 does NOT contain hello-3)", len(hits), 1)
h2 = tb.grep_rows("hello-1")
check("a broader needle finds every real match", len(h2[0]), 11)   # 1, 10..19
check("newest match first", visible(h2[0][0][1]).startswith("row 19"), True)
check("grep with no needle is a bare list (the usage path)", tb.grep_rows(""), [])
check("grep for absent text finds nothing", tb.grep_rows("definitely-not-here")[0], [])
check("grep ignores ANSI when matching", len(tb.grep_rows("row 5 says")[0]) > 0, True)
check("jump_to_row accepts a real row", tb.jump_to_row(2), True)
check("jumping left the window parked somewhere valid", 0 <= tb._SCROLL, True)
tb.go_live()
check("jump_to_row on an empty buffer says no", (reset_state(), tb.jump_to_row(0))[1], False)

# --- keys, through a REAL pty (pump_key reads an fd; there is no honest fake) ------
def keys(seq, park=5):
    """Park the window `park` rows deep, feed pump_key one key sequence, report the verdict.

    A PIPE, not a pty: pump_key only needs a readable fd, and a pipe whose write end is closed
    gives a deterministic EOF instead of an indefinite block. A pty did block here (the reader
    sat in wait_woken on a half-consumed sequence), and a test suite that can hang is worse than
    one that fails.
    """
    rfd, wfd = os.pipe()
    try:
        tb.go_live()
        tb.set_scroll(park)
        os.write(wfd, seq)
        os.close(wfd)
        wfd = -1
        got = tb.pump_key(rfd)
        return got, tb._SCROLL
    finally:
        if wfd >= 0:
            os.close(wfd)
        os.close(rfd)


# A key test needs a buffer to scroll THROUGH: set_scroll clamps against the real row count, so
# on an empty screen every scroll answer is 0 and every assertion would be a tautology. This 200
# -line buffer is what makes "PageUp moved the window" mean something.
reset_state(cap=500, height=26)
for i in range(500):                     # deep enough that no scroll answer is a clamp artefact
    tb.note(f"key-test line {i}")
tb.buffer_rows()
tb.set_scroll(5)

got, scroll_after = keys(b"\x1b[5~")
check("PageUp is handled without quitting or sending", got, None)
check("PageUp moved the window BACK", scroll_after > 5, True)
got, scroll_after = keys(b"\x1b[6~")
check("PageDown is handled", got, None)
check("PageDown moved the window FORWARD", scroll_after < 5, True)
got, scroll_after = keys(b"\x1b[H")
check("Home is handled", got, None)
check("Home goes to the oldest line", scroll_after >= 5 + max(tb._HEIGHT - 2, 1), True)
got, scroll_after = keys(b"\x1b[F")
check("End goes live", (got, scroll_after), (None, 0))
got, scroll_after = keys(b"\x1b[A")
check("Up arrow scrolls one row", scroll_after, 6)
got, scroll_after = keys(b"\x1b[B")        # CSI B is Down/Ctrl-Arrow-B, not a bare Ctrl-B
check("Down arrow moves the window forward", scroll_after < 5, True)
got, scroll_after = keys(b"\x1b\x1b")
check("a lone Escape does not quit", got != "quit", True)
check("a lone Escape does not send", got != "send", True)
check("a lone Escape does not scroll", scroll_after, 5)
got, scroll_after = keys(b"\x01")
check("Ctrl-A returns to live", (got, scroll_after), (None, 0))
got, scroll_after = keys(b"\x02")
check("Ctrl-B alone scrolls", (got, scroll_after > 5), (None, True))
got, scroll_after = keys(b"\x06")
check("Ctrl-F alone scrolls forward", (got, scroll_after < 5), (None, True))
got, _ = keys(b"\x03")
check("Ctrl-C still quits", got, "quit")
got, _ = keys(b"\r")
check("Enter is a send", got, "send")
got, _ = keys(b"a")
check("a plain character is inert as a return value (it lands in LINE)", got, None)
check("typing pins the reader to live", tb._SCROLL, 0)

# --- the composed frame ----------------------------------------------------------
reset_state(cap=500, height=26)
for i in range(4):
    tb.note(f"line {i}")
tb.buffer_rows()
matrix = [list(r) for r in tb.MATRIX]
frame = tb.render_frame(tb.visible_rows(matrix), 24, (80, 26), matrix, 0)
says("frame homes the cursor", frame, "\x1b[H")
says("frame clears the screen", frame, "\x1b[J")
check("frame ends with the prompt", visible(frame.rstrip("\r\n").split("\r\n")[-1]).startswith("> "), True)
check("a live frame costs at most rows line breaks", frame.count("\r\n") <= 26, True)
# THE ECHO REGRESSION (owner, 2026-10-09: "it is not accepting my keypresses. no text being
# generated by my typing in the input area"). The first version wrote the prompt and forgot the
# line buffer entirely. This is the check that would have caught it before the owner typed a
# single character — and it is a UNIT check, so it costs no terminal.
echoed = tb.render_frame(4, 24, (80, 26), matrix, 0, 0, "hello world")
check("the typed line is PAINTED after the prompt", "hello world" in visible(echoed), True)
check("the prompt and the typed text share one line", visible(echoed).rstrip().split("\r\n")[-1], "> hello world")
check("an empty input line still paints the bare prompt", visible(tb.render_frame(4, 24, (80, 26), matrix, 0, 0, "")).rstrip().split("\r\n")[-1], ">")
check(
    "a scrolled frame echoes too (parked in the past must not disable typing)",
    " Typing while parked" in visible(tb.render_frame(100, 24, (80, 26), [["r%d" % i] for i in range(100)], 40, 3, " Typing while parked")),
    True,
)
scrolled = tb.render_frame(100, 24, (80, 26), [["r%d" % i] for i in range(100)], 40, 3)
says("a scrolled frame carries the footer", scrolled, "row(s) back")
says("the footer reports the unread count", scrolled, "3 new")
check("a scrolled frame still fits the screen", scrolled.count("\r\n") <= 26, True)
says("/clear erases the terminal scrollback too", tb.CLEAR_SEQ, "\x1b[3J")

# --- the wire format is untouched by any of this ----------------------------------
# This is what makes rendering markdown in the client acceptable at all: nothing here
# changes what leaves or enters the room, so the lanes' plain-text rule and the pi TUI
# (which renders room lines literally) are unaffected.
sample = {"nick": "dust", "message": "try `alembic upgrade head`", "id": "dust-1", "ts": 1.0}
enc = tb.json.dumps(sample)
says("the published payload is plain JSON text", enc, '"message": "try `alembic upgrade head`"')
never("no markup is added to an outgoing message", enc, "\033[")

print()
if failed:
    print(f"{failed} check(s) FAILED")
    sys.exit(1)
print("all tabichat scrollback checks green")
