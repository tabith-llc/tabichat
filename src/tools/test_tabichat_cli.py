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
retired later on the same request, so every rule below is a rule about THIS file only, and
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

import inspect
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
coloured = tb._wrap_display_rows(f"{tb.AMBER}12:00:00{tb.RESET} {tb.BLUE}lane11{tb.RESET}: hi", 80)
check(
    "a colour code earns no phantom space (the chat_cli lesson)",
    visible(coloured[0]),
    "12:00:00 lane11: hi",
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
# THE ECHO REGRESSION (owner, : "it is not accepting my keypresses. no text being
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
sample = {"nick": "lane16", "message": "try `alembic upgrade head`", "id": "lane16-1", "ts": 1.0}
enc = tb.json.dumps(sample)
says("the published payload is plain JSON text", enc, '"message": "try `alembic upgrade head`"')
never("no markup is added to an outgoing message", enc, "\033[")

# --- THE PER-NICK SENDER LEAF: what this client reads, and what it writes --------
# Leg 1131. The broker was cut over to `require_certificate true` plus the per-nick ACL, which means a
# client that still READS only `chat/<room>` is deaf and one that still WRITES only `chat/<room>` is
# mute — and both look perfectly healthy on screen, because a refused write comes back rc 0 with no
# error. These cells are the client's half of that. The broker's half is physical and lives in
# `tools/test_tlsenv_paho.py` (the no-certificate cell): THIS file is a pure truth table and must stay
# runnable with no docker and no broker, because `deploy-tabichat.sh` runs it in PYGATES on hosts that
# have neither.
def mqtt_match(filt, topic):
    """MQTT 3.1.1 §4.7 one-level (`+`) filter match. TEST-LOCAL on purpose: the product never matches a
    filter (the broker does), so this exists only to prove the topic the writer picks is really inside
    the filter the reader subscribes. `#` is neither supported nor needed here."""
    f, t = filt.split("/"), topic.split("/")
    return len(f) == len(t) and all(a == b or a == "+" for a, b in zip(f, t))


check("the read half names every sender leaf", tb.msg_wild("tabith"), "chat/tabith/msg/+")
check("(i) a leaf write is INSIDE the filter the client subscribes",
      mqtt_match(tb.msg_wild("tabith"), tb.msg_topic("tabith", "flash1")), True)
check("(i) NEGATIVE: that filter does NOT match the flat topic, so the flat subscription must stay",
      mqtt_match(tb.msg_wild("tabith"), "chat/tabith"), False)
check("(i) NEGATIVE: nor a two-level leaf (`msg/a/b` is nobody's leaf)",
      mqtt_match(tb.msg_wild("tabith"), "chat/tabith/msg/a/b"), False)
check("(ii) the flat topic is still subscribed, and matches itself exactly",
      mqtt_match("chat/tabith", "chat/tabith"), True)
check("(ii) NEGATIVE: a leaf publish does NOT arrive on the flat subscription (one publish, one copy)",
      mqtt_match("chat/tabith", "chat/tabith/msg/flash1"), False)
check("an empty leaf refuses instead of aiming at a trailing separator",
      tb.msg_topic("tabith", "!!!"), "")

# AUTHORSHIP — broker-first, and leg 1120's word for the case the broker cannot place
check("(i) on a sender leaf the TOPIC is the author",
      tb.author_verdict("chat/tabith/msg/wren", "tabith", "wren"), (True, "wren", True, ""))
check("(i) NEGATIVE: a leaf line whose payload names someone else is REFUSED, never re-labelled",
      tb.author_verdict("chat/tabith/msg/wren", "tabith", "dust")[0], False)
forged = tb.author_verdict("chat/tabith/msg/wren", "tabith", "dust")[3]
says("and the refusal names the asserting topic", forged, "chat/tabith/msg/wren")
says("and the name the payload claimed", forged, "dust")
check("a leaf line with NO payload nick is delivered under the topic name",
      tb.author_verdict("chat/tabith/msg/wren", "tabith", "")[:2], (True, "wren"))
check("(ii) a FLAT line's name is typed text: delivered, and NOT verified",
      tb.author_verdict("chat/tabith", "tabith", "wren"), (True, "wren", False, ""))
check("(mark) the client uses leg 1120's word for that, byte for byte", tb.UNVERIFIED, " unverified")
check("(mark) NEGATIVE: a flat verdict is never reported as verified",
      tb.author_verdict("chat/tabith", "tabith", "wren")[2], False)

# THE ID LEDGER + THE RENDERED LINE, driven through the real on_message


class FakeMsg:
    def __init__(self, topic, payload):
        self.topic = topic
        self.payload = payload.encode("utf-8")


class FakeClient:
    def publish(self, *a, **k):
        raise AssertionError("reading a room line must not publish anything")


SAVED = (tb.CLIENT, tb.ROOM, tb.TOPIC, tb.MSG_WILD, tb.PRESENCE, tb.CTL, tb.SELF, list(tb.SEEN_IDS))
tb.CLIENT, tb.ROOM, tb.TOPIC = FakeClient(), "tabith", "chat/tabith"
tb.PRESENCE, tb.CTL, tb.MSG_WILD = "chat/tabith/presence", "chat/tabith/_ctl", tb.msg_wild("tabith")
tb.SELF = "flash1"


def hear(topic, nick, text, mid):
    tb.on_message(tb.CLIENT, None, FakeMsg(topic, tb.json.dumps(
        {"nick": nick, "message": text, "id": mid, "ts": 1.0})))


def room_lines(needle):
    return [visible(e) for e in tb.ENTRIES if needle in visible(e)]


reset_state(cap=500)
tb.SEEN_IDS[:] = []
DUAL = tb.json.dumps({"nick": "wren", "message": "one id two copies", "id": "wren-77", "ts": 1.0})
tb.on_message(tb.CLIENT, None, FakeMsg("chat/tabith/msg/wren", DUAL))   # the leaf copy
tb.on_message(tb.CLIENT, None, FakeMsg("chat/tabith", DUAL))            # the same id, flat
both = room_lines("one id two copies")
check("(iii) a line that arrives on BOTH shapes is displayed ONCE", len(both), 1)
check("(iii) and the copy kept is the broker-vouched one (no unverified mark)",
      "unverified" in both[0], False)

reset_state(cap=500)
tb.SEEN_IDS[:] = []
hear("chat/tabith/msg/wren", "wren", "distinct one", "wren-80")
hear("chat/tabith/msg/wren", "wren", "distinct two", "wren-81")
check("(iii) NEGATIVE: two different ids are two lines", len(room_lines("distinct")), 2)

reset_state(cap=500)
tb.SEEN_IDS[:] = []
NO_ID = tb.json.dumps({"nick": "wren", "message": "no id at all", "ts": 1.0})
tb.on_message(tb.CLIENT, None, FakeMsg("chat/tabith", NO_ID))
tb.on_message(tb.CLIENT, None, FakeMsg("chat/tabith", NO_ID))
check("(iii) NEGATIVE: an absent id is not a key, so the ledger never swallows the line",
      len(room_lines("no id at all")), 2)

reset_state(cap=500)
tb.SEEN_IDS[:] = []
hear("chat/tabith", "wren", "flat only", "wren-90")
check("(mark) a flat line reaches the reader marked unverified",
      "wren unverified: flat only" in room_lines("flat only")[0], True)
reset_state(cap=500)
tb.SEEN_IDS[:] = []
hear("chat/tabith/msg/wren", "wren", "leaf only", "wren-91")
check("(mark) NEGATIVE: a leaf line reaches it unmarked",
      "wren: leaf only" in room_lines("leaf only")[0], True)

reset_state(cap=500)
tb.SEEN_IDS[:] = []
hear("chat/tabith/msg/wren", "dust", "forged body", "wren-92")
check("(i) NEGATIVE: the forged line never reaches the reader", len(room_lines("forged body")), 0)
check("and the drop is SAID on screen, not left silent",
      "authorship conflict" in visible(tb.ENTRIES[-1]), True)

reset_state(cap=500)
tb.SEEN_IDS[:] = []
hear("chat/tabith/msg/flash1", "flash1", "my own echo", "flash1-99")
check("echo prevention holds on the leaf too", len(room_lines("my own echo")), 0)

# D-1 (leg 1135): THE ID AND THE SILENT DROP. The shipped builder is `<nick>-<seq>-<boot>`; a two-part
# id repeats itself across two sessions of one sender because the sequence restarts at 0, and this
# client's ledger keys on that string — so a restarted sender's next line would be swallowed.
check("the id builder is the shipped 3-part shape (roommsg.ts:msgId)",
      tb.msg_id("dust", 7, "ab12cd"), "dust-7-ab12cd")
check("the boot tag is six hex chars at the shipped width", tb.boot_tag(lambda: 0.5), "080000")
# The draw space is 0x100000 values, so the top of the range is 0xfffff — FIVE f's, zero-padded to the
# six-char width. Same range and same padding as `roommsg.ts:bootTag`, which is the point of pinning it.
check("NEGATIVE: the largest draw lands at the top of that range, padded not shortened",
      tb.boot_tag(lambda: 1.0 - 2 ** -24), "0fffff")  # 1-2**-24 is the biggest a draw can be
check("NEGATIVE: a zero draw is padded, not shortened", tb.boot_tag(lambda: 0.0), "000000")
check("this run carries one tag, six hex chars", (len(tb.BOOT), all(c in "0123456789abcdef" for c in tb.BOOT)),
      (6, True))
reset_state(cap=500)
tb.SEEN_IDS[:] = []
hear("chat/tabith/msg/dust", "dust", "restarted one", "dust-1-aaaaaa")
hear("chat/tabith/msg/dust", "dust", "restarted two", "dust-1-bbbbbb")
check("D-1 a RE-MINTED id from a restarted sender is displayed, not swallowed",
      len(room_lines("restarted")), 2)
reset_state(cap=500)
tb.SEEN_IDS[:] = []
hear("chat/tabith/msg/dust", "dust", "one message twice", "dust-9-cccccc")
hear("chat/tabith/msg/dust", "dust", "one message twice", "dust-9-cccccc")
check("NEGATIVE: the same id twice is still one line", len(room_lines("one message twice")), 1)
check("D-1 and the duplicate drop is SAID on screen, not silent",
      any("duplicate dropped" in visible(e) and "dust-9-cccccc" in visible(e) for e in tb.ENTRIES), True)

src_oc = inspect.getsource(tb.on_connect)
check("the client subscribes the flat room AND the leaf wildcard (dual read)",
      ("client.subscribe(TOPIC)" in src_oc, "client.subscribe(MSG_WILD)" in src_oc), (True, True))
check("NEGATIVE: the leaf subscription is guarded, so a stale empty filter is never subscribed",
      "if MSG_WILD:" in src_oc, True)

src_ts = inspect.getsource(tb.text_send)
check("a send goes where write_plan says, and echoes THAT topic on screen",
      ("write_plan(ROOM, SELF, NICK_SOURCE, TLS_PLAN, FLAT_SEND)" in src_ts, "{topic}" in src_ts),
      (True, True))
check("NEGATIVE: text_send no longer publishes to the flat TOPIC global",
      "CLIENT.publish(\n            TOPIC," in src_ts, False)
check("D-1 the client mints its id through msg_id with this run's boot tag",
      "mid = msg_id(SELF, MSG_SEQ, BOOT)" in src_ts, True)
check("NEGATIVE: and the two-part id that collides across sessions is gone",
      'mid = f"{SELF}-{MSG_SEQ}"' in src_ts, False)

tb.CLIENT, tb.ROOM, tb.TOPIC, tb.MSG_WILD = SAVED[0], SAVED[1], SAVED[2], SAVED[3]
tb.PRESENCE, tb.CTL, tb.SELF = SAVED[4], SAVED[5], SAVED[6]
tb.SEEN_IDS[:] = SAVED[7]

# THE NICK IS AN OPERATOR CHOICE (item 4)
check("(iv) --nick is taken verbatim, from --nick", tb.resolve_nick(cli="flash1"), ("flash1", "--nick", ""))
check("(iv) MQTT_NICK is an operator input too", tb.resolve_nick(env={"MQTT_NICK": "dust"}), ("dust", "MQTT_NICK", ""))
check("an explicit --nick outranks MQTT_NICK", tb.resolve_nick(cli="a", env={"MQTT_NICK": "b"}), ("a", "--nick", ""))
check("MQTT_NICK outranks $USER", tb.resolve_nick(env={"MQTT_NICK": "b", "USER": "a"}), ("b", "MQTT_NICK", ""))
check("$USER is a DISPLAY fallback, recorded as inferred", tb.resolve_nick(env={"USER": "dusty"})[1], "$USER")
alt_raw, alt_src, alt_why = tb.resolve_nick(cli="Dusty Smith")
check("(iv) a nick clean() would alter is REFUSED", alt_why != "", True)
check("(iv) and the value comes back UNCHANGED — never rewritten onto the wire", alt_raw, "Dusty Smith")
says("the refusal uses the extension's own case name", alt_why, "no topic-leaf-safe form")
says("and names both doors to fix", alt_why, "--nick")
says("and", alt_why, "MQTT_NICK")
check("(iv) NEGATIVE: a 20-character nick is accepted", tb.resolve_nick(cli="n" * 20)[2], "")
check("(iv) a 21-character nick is refused (clean() truncates at 20)", tb.resolve_nick(cli="n" * 21)[2] != "", True)
check("(iv) an all-punctuation nick is refused", tb.resolve_nick(cli="!!!")[2] != "", True)
check("NEGATIVE CONTROL: clean() would have borrowed the name \"user\"", tb.clean("!!!"), "user")

# D-2 (leg 1135): THE GATE FIRES ON A CHOICE, NOT ON AN ACCOUNT NAME. An inferred value is a display
# name; only a nick the operator named can be refused for a shape it cannot hold on the wire.
check("D-2 an inferred dotted account name is NOT refused", tb.resolve_nick(env={"USER": "dusty.smith"}),
      ("dusty.smith", "$USER", ""))
check("D-2 an inferred spaced display name is NOT refused either",
      tb.resolve_nick(env={"USER": "Dusty Smith"}), ("Dusty Smith", "$USER", ""))
check("D-2 and the client still puts a leaf-safe DISPLAY form on the wire",
      tb.clean(tb.resolve_nick(env={"USER": "dusty.smith"})[0]), "dustysmith")
check("NEGATIVE: the SAME name chosen with --nick IS refused", tb.resolve_nick(cli="dusty.smith")[2] != "", True)
check("NEGATIVE: and by MQTT_NICK too", tb.resolve_nick(env={"MQTT_NICK": "dusty.smith"})[2] != "", True)
check("NEGATIVE: and the refused value still comes back unchanged", tb.resolve_nick(cli="dusty.smith")[0],
      "dusty.smith")

# WHERE A LINE ACTUALLY GOES, and what is said when it cannot go further (items 2 and B)
PAIR = {"tls": True, "kwargs": {"certfile": "/x/cert.pem", "keyfile": "/x/key.pem"}}
HALF = {"tls": True, "kwargs": {"certfile": "/x/cert.pem", "keyfile": None}}
NO_PAIR = {"tls": True, "kwargs": {"ca_certs": "/x/ca.pem", "certfile": None, "keyfile": None}}
PLAIN_PLAN = {"tls": False, "kwargs": {}}
check("(v) a full pair + a chosen nick writes the sender leaf",
      tb.write_plan("tabith", "dust", "MQTT_NICK", PAIR), ("chat/tabith/msg/dust", ""))
check("(v) NEGATIVE: half a pair is not an identity", tb.has_client_identity(HALF), False)
check("(v) NEGATIVE: a TLS plan with a CA and no certificate is not an identity",
      tb.has_client_identity(NO_PAIR), False)
check("(v) NEGATIVE: a plaintext plan is not an identity", tb.has_client_identity(PLAIN_PLAN), False)
flat_t, flat_why = tb.write_plan("tabith", "dust", "MQTT_NICK", None)
check("(v) with no certificate the write is the flat topic", flat_t, "chat/tabith")
says("(v) and the absence is named by the certificate variable", flat_why, "MQTT_TLS_CERTFILE")
says("(v) and by the key variable", flat_why, "MQTT_TLS_KEYFILE")
says("(v) and by the leaf it could not reach", flat_why, "chat/tabith/msg/dust")
check("(v) and it says an ACL entry is part of what is missing", "ACL" in flat_why, True)
check("(v) and it does NOT pretend to mint or guess one", "will not invent" in flat_why, True)
inf_t, inf_why = tb.write_plan("tabith", "dust", "$USER", PAIR)
check("(v) NEGATIVE: a pair with an inferred nick still writes flat, and says why", inf_t, "chat/tabith")
says("the inferred-nick line names the source", inf_why, "$USER")
says("and names the doors", inf_why, "--nick")
check("D-2 NEGATIVE: an inferred name is still no claim on a leaf, however it was sanitised",
      tb.write_plan("tabith", "dustysmith", "$USER", PAIR)[0], "chat/tabith")
says("D-2 and the write says so, naming the inferred source",
     tb.write_plan("tabith", "dustysmith", "$USER", PAIR)[1], "$USER")
sent_t, sent_why = tb.write_plan("tabith", "dust", "MQTT_NICK", PAIR, True)
check("--flat-send keeps the flat write available on purpose", sent_t, "chat/tabith")
says("NEGATIVE: and it is a stated choice, not the no-certificate case", sent_why, "--flat-send")

join_entry = next((e for e in tb.HELP if e.startswith("/join")), "")
check("the help list holds one entry per promise (a missing comma glues two and drops one)",
      len(tb.HELP), 15)
says("(docs) the /join entry names the leaf it writes", join_entry, "msg/<nick>")
says("(docs) and the sender-leaf wildcard it reads", join_entry, "chat/<room>/msg/+")
check("(docs) NEGATIVE: nothing was glued away — /names is still its own entry",
      any(e.startswith("/names") for e in tb.HELP), True)

# --- IS THIS SEAT READ-ONLY? (leg 1146: a refused write must become a sentence) ---------
# The client used to print "the broker vouches for this name" at join, before it had written anything.
# A QoS 0 publish an ACL throws away is silent BY PROTOCOL — rc 0, no error, nothing delivered — so a
# seat with no block spent its whole session read-only and never saw a word (reports/232: two
# `Denied PUBLISH` on chat/tabith/msg/dust at 17:48:52 and 17:49:05). The witness is the only answer
# the protocol gives, so it is what this client relies on, and `unknown` is said as `unknown`.

SENT = "chat/tabith/msg/dust"
UL = tb.write_state_line("unknown", "tabith", "dust", SENT)
UN = tb.write_state_line("unconfirmed", "tabith", "dust", SENT)
GR = tb.write_state_line("granted", "tabith", "dust", SENT)
check("three states, three different sentences — absent is not broken and neither is ok",
      len({UL, UN, GR}), 3)
check("the state at rest is unproved, and it says so", "NOT YET PROVED" in UL, True)
says("and names what would answer it", UL, "first line you send")
never("NEGATIVE: 'unknown' never reads as a pass", UL, "confirmed")
never("NEGATIVE: and never as a refusal the operator cannot verify", UL, "READ-ONLY")
says("(neg) the refused-write sentence says READ-ONLY", UN, "READ-ONLY")
says("(neg) and names the ACL entry the operator can act on", UN, "user CN=dust")
says("(neg) and the topic it could not reach", UN, SENT)
says("(neg) and why the client cannot be certain — the protocol is silent", UN, "silent by protocol")
never("NEGATIVE: it is not a soft suggestion somebody skims", UN, "you may wish to")
FLATUN = tb.write_state_line("unconfirmed", "tabith", "dust", "chat/tabith")
says("a flat seat is told where a granted name actually lands", FLATUN, "chat/tabith/msg/+")
check("NEGATIVE: a state this file does not know is said as unproved, not as ok",
      "unproved" in tb.write_state_line("sideways", "tabith", "dust", SENT).lower(), True)

# --- the witness is an exact (topic, id) match, and the window is a number ----------------
P1 = ("dust-1-aaaaaa", SENT, 1000.0)
check("my own line, on my own topic, with my own id: witnessed", tb.witness_seen(P1, SENT, "dust-1-aaaaaa"), True)
check("NEGATIVE: the same id on another topic is somebody else's write",
      tb.witness_seen(P1, "chat/tabith", "dust-1-aaaaaa"), False)
check("NEGATIVE: the same topic with another id is a different message",
      tb.witness_seen(P1, SENT, "dust-2-aaaaaa"), False)
check("NEGATIVE: nothing pending witnesses nothing", tb.witness_seen(None, SENT, "dust-1-aaaaaa"), False)
check("the window this client gives a line is the shipped number", tb.WITNESS_S, 5.0)
check("NEGATIVE: an open window has not expired", tb.pending_expired(P1, 1004.9), False)
check("and it closes at the boundary", tb.pending_expired(P1, 1005.0), True)
check("NEGATIVE: no pending write never expires into a warning", tb.pending_expired(None, 9e9), False)

# --- driven through the real on_message: the witness fires, and a foreign line does not -----
SAVED2 = (tb.CLIENT, tb.ROOM, tb.TOPIC, tb.SELF, tb.WRITE_STATE, tb.PENDING_WRITE, list(tb.SEEN_IDS))
tb.CLIENT, tb.ROOM, tb.TOPIC, tb.SELF = FakeClient(), "tabith", "chat/tabith", "dust"
tb.SEEN_IDS[:] = []
tb.WRITE_STATE, tb.PENDING_WRITE = "unknown", P1
reset_state(cap=500)
hear(SENT, "dust", "my own line back", "dust-1-aaaaaa")
check("the witness flips the state to granted", tb.WRITE_STATE, "granted")
check("and clears the pending write", tb.PENDING_WRITE, None)
check("the confirmation reaches the screen", any("write confirmed" in visible(e) for e in tb.ENTRIES), True)
check("(i) NEGATIVE: a seat whose write landed sees NO READ-ONLY line",
      any("READ-ONLY" in visible(e) for e in tb.ENTRIES), False)
check("and echo prevention still holds — the line is not shown again as an incoming one",
      len(room_lines("my own line back")), 0)
tb.WRITE_STATE, tb.PENDING_WRITE = "unknown", ("dust-3-aaaaaa", SENT, 2000.0)
reset_state(cap=500)
hear("chat/tabith/msg/wren", "wren", "another seat's line", "dust-3-aaaaaa")
check("(iii) NEGATIVE: another seat's line on another leaf witnesses nothing", tb.WRITE_STATE, "unknown")
check("and the pending write is still pending", tb.PENDING_WRITE, ("dust-3-aaaaaa", SENT, 2000.0))

# --- the sentence is said when it is learned, and again on the next line -------------------
tb.PENDING_WRITE = ("dust-4-aaaaaa", SENT, 3000.0)
tb.WRITE_STATE = "unknown"
reset_state(cap=500)
check("NEGATIVE: a window still open says nothing", tb.mark_unconfirmed(now=3004.0), False)
check("and the screen is still clean", len(tb.ENTRIES), 0)
check("the sweep speaks when the window closes", tb.mark_unconfirmed(now=3005.0), True)
check("the state is unconfirmed, not a silent ok", tb.WRITE_STATE, "unconfirmed")
read_only_lines = [visible(e) for e in tb.ENTRIES if "READ-ONLY" in visible(e)]
check("one sentence, naming the nick", (len(read_only_lines), "dust" in read_only_lines[0]), (1, True))
tb.PENDING_WRITE = ("dust-5-aaaaaa", SENT, 4000.0)
check("and it is said AGAIN on the next line that cannot be confirmed", tb.mark_unconfirmed(now=4005.0), True)
check("so a second vanished message cannot stack silently on the first",
      len([1 for e in tb.ENTRIES if "READ-ONLY" in visible(e)]), 2)
tb.CLIENT, tb.ROOM, tb.TOPIC, tb.SELF, tb.WRITE_STATE, tb.PENDING_WRITE, tb.SEEN_IDS[:] = (
    SAVED2[0], SAVED2[1], SAVED2[2], SAVED2[3], SAVED2[4], SAVED2[5], SAVED2[6])

# --- the glue is wired, not decorative ------------------------------------------------------
src_join = inspect.getsource(tb.do_join)
src_ts = inspect.getsource(tb.text_send)
src_lq = inspect.getsource(tb.leave_quiet)
never("the unproved claim is GONE from the join banner", src_join, "the broker vouches for this name")
says("the banner says unproved instead", src_join, "unproved until one of your lines comes back")
check("and the join prints the unknown sentence, not silence", "write_state_line('unknown'" in src_join, True)
says("text_send opens the window", src_ts, "WITNESS_TIMER = threading.Timer(WITNESS_S, report_witness)")
says("and sweeps the previous line before adding another", src_ts, "mark_unconfirmed()")
check("NEGATIVE: it does not read a QoS 0 rc as proof of delivery", "if info.rc" in src_ts, False)
says("leave_quiet resets the state with the room", src_lq, 'WRITE_STATE = "unknown"')
says("and cancels the timer, so a stopped seat cannot print into the next room", src_lq,
     "WITNESS_TIMER.cancel()")
check("the module says READ-ONLY, not a synonym the operator has to learn", "READ-ONLY" in UN, True)

print()
if failed:
    print(f"{failed} check(s) FAILED")
    sys.exit(1)
print("all tabichat scrollback checks green")
