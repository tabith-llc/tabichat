#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Drive tabichat_cli.py in a real pty and measure what it PAINTS.

    cd src && .venv/bin/python tools/pty_tabichat_probe.py     (exit 1 on any failure)

WHY THIS EXISTS NEXT TO test_tabichat_cli.py: the unit truth table proves the window maths and the
key decoding. Nothing but a real terminal proves the thing the owner actually asked for — "I need
to scroll up and see missed messages, and the buffer must be MUCH BIGGER". So this probe starts the
client in a pty, fills the buffer with known text, presses PageUp, and reads back what landed on
the screen.

NO ROOM, NO BROKER, NO PRESENCE WRITE: the client is started with no room argument, so it never
connects and publishes nothing. `/fill` is the local-only command that puts known lines in the
buffer for exactly this purpose. Everything measured here is terminal bytes.

The assertions are the paired kind: after PageUp the screen must NOT read as the live tail, and
after /live it must. A client that paints the same frame either way fails here rather than in the
owner's terminal.
"""
import fcntl
import os
import pty
import re
import signal
import struct
import sys
import termios
import time

# Derived from this file's own location, never pinned to one operator's box: the old literal was
# /media/dust/dust-ext1/projects/tabichat/src, a FROZEN montana path that does not exist on idaho, so
# the probe reported 16 failures here while measuring nothing at all — a client that cannot start is
# not a red client. REPO is the `src` directory two levels up, which is where the client is run from.
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PY = os.path.join(REPO, ".venv", "bin", "python")
if not os.path.exists(PY):
    PY = sys.executable   # the probe drives the client, it does not own an environment
ANSI_RE = re.compile(r"\033\[[0-9;?]*[a-zA-Z]")
FRAME = "\x1b[H\x1b[J"
TERM_ROWS, TERM_COLS = 24, 100

fail = []


def check(name, cond, detail=""):
    print(("ok    " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        fail.append(name)


def setsize(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)


def drain(seconds=0.6):
    out = b""
    end = time.time() + seconds
    while time.time() < end:
        try:
            import select
            r, _, _ = select.select([fd], [], [], 0.05)
        except Exception:
            break
        if fd in r:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
    return out.decode("utf-8", "replace")


def visible(s):
    return ANSI_RE.sub("", s)


def last_frame(raw):
    parts = [f for f in raw.split(FRAME) if f.strip()]
    return visible(parts[-1]) if parts else ""


def frames(raw):
    return [visible(f) for f in raw.split(FRAME) if f.strip()]


def rows_of(frame_text):
    return [ln for ln in frame_text.split("\r\n")]


pid, fd = pty.fork()
if pid == 0:
    for var in ("COLUMNS", "LINES", "MQTT_HOST"):
        os.environ.pop(var, None)
    os.environ["USER"] = "probegap"        # never connects, so no presence record is written
    os.environ["TERM"] = "xterm-256color"
    os.environ["TABICHAT_HISTORY"] = "5000"
    os.chdir(REPO)
    os.execv(PY, [PY, "src/tabichat_cli.py"])

setsize(TERM_ROWS, TERM_COLS)
boot = drain(1.0)
check("client starts and paints", FRAME in boot, "no frame after 1s")
check("boot banner names the buffer", "buffer:" in boot or "buffer" in last_frame(boot))
check("boot banner advertises the scroll keys", "PgUp" in last_frame(boot), last_frame(boot)[:120])

# --- fill the buffer far past one screen, then read what the screen shows -------
os.write(fd, b"/fill 400\r")
drain(2.5)
live = drain(1.0)
lf = last_frame(live)
check("live frame shows the NEWEST fill line", "fill: scrollback test line 400" in lf, lf[-160:])
check("live frame does NOT reach line 3", "test line 3\b" not in lf and "test line 3 \n" not in lf)
check("a frame stays within the terminal's rows", len(rows_of(lf)) <= TERM_ROWS, str(len(rows_of(lf))))

# --- PageUp: the whole point ----------------------------------------------------
os.write(fd, b"\x1b[5~")
deep = drain(1.0)
df = last_frame(deep)
check("PageUp painted a DIFFERENT frame than live", df != lf)
check("PageUp shows the footer with a depth", "row(s) back" in df, df[:160])
check("PageUp frame is still within the terminal's rows", len(rows_of(df)) <= TERM_ROWS, str(len(rows_of(df))))

# go deep enough that the OLDEST text becomes visible — the one thing chat_cli could not do
for _ in range(30):
    os.write(fd, b"\x1b[5~")
drain(1.5)
top = last_frame(drain(1.0))
check("after 31 PageUps the screen is NOT the live tail", "line 400" not in top)
import re as _re
_nums = [int(n) for n in _re.findall(r"test line (\d+) of", top)]
check(
    "deep scroll reaches the OLD part of the buffer, not the tail",
    bool(_nums) and max(_nums) < 100,
    f"visible line numbers: {_nums[:6]}",
)
check(
    "and it keeps painting whole rows of that old text",
    len(rows_of(top)) >= 2,
    str(len(rows_of(top))),
)
check("footer still offers the way out", "/live newest" in top)

# --- /live returns you ----------------------------------------------------------
os.write(fd, b"/live\r")
drain(1.2)
back = last_frame(drain(1.0))
check("/live returns the newest line", "test line 400" in back, back[-200:])
check("/live clears the depth footer", "row(s) back" not in back)

# --- /depth reports the buffer in messages, not rows -----------------------------
os.write(fd, b"/depth\r")
drain(1.2)
dep = last_frame(drain(1.0))
check("/depth reports messages", "message(s)" in dep, dep[-220:])
check("/depth reports the 5000 cap", "cap 5000" in dep, dep[-220:])

# --- /grep reaches past the screen ------------------------------------------------
os.write(fd, b"/grep test line 7\r")
drain(1.2)
gr = last_frame(drain(1.0))
check("/grep finds text that is NOT on screen", "match" in gr or "matches" in gr, gr[-240:])

# --- a long word cannot overflow the frame ---------------------------------------
os.write(fd, ("/fill 3\r").encode())
drain(0.8)
os.write(fd, ("a" * 400 + "\r").encode())   # not in a room, so this only echoes as a note
drain(1.2)
wide = frames(drain(1.0))
over = [r for f in wide for r in rows_of(f) if len(r) > TERM_COLS]
check("no painted row is wider than the terminal", not over, str([len(r) for r in over[:3]]))

# --- a resize re-wraps instead of shifting the screen ----------------------------
setsize(30, 60)
drain(1.0)
narrow = last_frame(drain(1.0))
check("narrower terminal still fits", len(rows_of(narrow)) <= 30, str(len(rows_of(narrow))))
nover = [r for f in frames(narrow) for r in rows_of(f) if len(r) > 60]
check("no row overruns the narrower width", not nover, str([len(r) for r in nover[:3]]))

# --- THE ECHO: typing must appear on screen --------------------------------------
# The owner ran this client and reported "it is not accepting my keypresses. no text being
# generated by my typing in the input area". The cause was a frame that wrote the prompt and
# dropped the line buffer. So: type, and assert the screen shows it.
os.write(fd, b"echo me please")
drain(1.0)
typed = last_frame(drain(1.0))
check("typed text appears on the prompt line", "echo me please" in typed, typed[-120:])
os.write(fd, b"\x15")          # Ctrl-U clears the input line
drain(1.0)
cleared = last_frame(drain(1.0))
check("Ctrl-U clears what was typed", "echo me please" not in cleared, cleared[-120:])

# --- keys must not leak into the input line --------------------------------------
# Start from a KNOWN-EMPTY input line, then press ONLY scroll keys. The earlier case typed real
# text and left it in the buffer, which made this assertion measure the previous test instead of
# the keys under test.
os.write(fd, b"\x15")
drain(0.6)
for _ in range(4):
    os.write(fd, b"\x1b[5~")
    os.write(fd, b"\x1b[6~")
    os.write(fd, b"\x1b[A")
    os.write(fd, b"\x1b[B")
    os.write(fd, b"\x1b[H")
    os.write(fd, b"\x1b[F")
    os.write(fd, b"\x1b\x1b")   # a stray Escape must leave nothing behind either
drain(0.8)
kb = last_frame(drain(1.0))
prompt_tail = kb.rstrip().split("\r\n")[-1]
check(
    "scroll keys left the input line EMPTY (no leaked bytes from the escape tails)",
    prompt_tail.strip() == ">",
    repr(prompt_tail[-60:]),
)

# --- BOTH shapes of /clear, on the WIRE (cells this probe did not have) -------
# These two came with `tools/pty_chat_cli_probe.py`, which retired with its subject (leg 506). A
# unit check can prove a function returns the right bytes; only a pty can prove the erase sequence
# actually reaches the terminal and that nothing is PAINTED where the operator asked for a blank
# screen — which is how /clear was specified: "a blank screen IS the acknowledgement".
os.write(fd, b"/clear\r")
cleared = drain(1.0)
check("/clear puts the scrollback erase (CSI 3J) on the wire", "\x1b[3J" in cleared)
check(
    "/clear paints no receipt line (the blank screen IS the acknowledgement)",
    "cleared" not in "".join(rows_of(last_frame(cleared))).lower(),
    "".join(rows_of(last_frame(cleared)))[:120],
)
# The non-destructive shape, and the reason the destructive one is allowed to stay destructive: the
# buffer must survive /clear screen, which only /depth can say out loud on a real screen.
os.write(fd, b"/fill 40\r")
drain(1.0)
os.write(fd, b"/clear screen\r")
blanked = drain(1.0)
check("/clear screen erases the scrollback too", "\x1b[3J" in blanked)
os.write(fd, b"/depth\r")
kept = last_frame(drain(1.0))
check(
    "/clear screen keeps the buffer (/depth still counts the fill lines)",
    "40 message(s)" in kept or "41 message(s)" in kept,
    kept[-200:],
)

os.kill(pid, signal.SIGTERM)
drain(0.5)
try:
    os.close(fd)
except OSError:
    pass

print()
if fail:
    print(f"{len(fail)} probe check(s) FAILED: {', '.join(fail)}")
    sys.exit(1)
print("tabichat pty probe: the screen really does scroll")
