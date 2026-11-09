#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""tabichat — the human's room CLI, WITH SCROLLBACK.

ONE ROOM CLIENT, AND IT IS THIS FILE. There used to be a second one, `chat_cli.py`. It was retired:
a release cannot ship a room client that does not work, and nothing was left behind — every piece of
functionality that client had and this one lacked moved here, which supersedes the earlier plan of
keeping the two side by side. The one thing that client did that this one did not — a clear
that blanks the screen and keeps the message history — is here now, as `/clear screen`.

WHAT THIS ONE DOES, and why the retired one could not:

  `chat_cli.py` painted exactly one screenful (`HISTORY[-(rows-1):]`) after a full-screen `\x1b[H`
  repaint, so nothing older than the frame is ever on screen — and the terminal's own scrollwheel
  stays empty because the app redraws in place. Its MAX_HISTORY = 500 counted WRAPPED ROWS, so at
  ~38 rows per long post the real memory was about thirteen messages.

  Here the buffer counts MESSAGES (TABICHAT_HISTORY, default 5000, `/history <n>` to change it in
  session), entries are stored UNWRAPPED and wrapped at paint time so a resize re-wraps them
  correctly, and a scroll offset moves the window instead of the buffer.

KEYS (raw mode; only a full-screen app can offer this, and only a separate client should)
    PageUp / PageDown   half a screen back / forward
    Ctrl-B / Ctrl-F     a full screen back / forward
    Ctrl-A              jump to live
    Home / End          oldest / newest
    typing or sending    always returns you to live first — you never answer a line you cannot see

COMMANDS
    /connect [host[:port]]  connect to the broker (no argument = the broker you configured:
                           the site config "mqttUrl", or $MQTT_URL, or $MQTT_HOST/$MQTT_PORT)
    /join <room>            join a room: READS chat/<room> and chat/<room>/msg/+; WRITES
                           chat/<room>/msg/<nick> when a client certificate pair is configured
    /names                  the beats this client heard: * online, ? quiet or unrankable, - gone
    /up [rows]  /down [rows]   scroll the window (default: a screen)
    /top                    oldest line in the buffer
    /live | /back           newest, and clears the unread counter
    /depth                  how far the buffer reaches right now
    /grep <text>            search the WHOLE buffer (not just the screen), newest match first
    /show <row>             jump the window to a row number that /grep printed
    /history [n]            show or set the buffer cap (messages, not rows)
    /md                     toggle the markdown-lite pass (ON by default)
    /clear                  blank the screen AND drop the buffer (keeps the room)
    /clear screen           blank the screen and KEEP the buffer — PgUp brings it back
    /help                   this list
    /quit                   leave (presence offline) and exit

THE TWO TOPIC SHAPES — what this client reads, and which one it writes
    READS BOTH: the flat room topic `chat/<room>` and every per-nick sender leaf
    `chat/<room>/msg/+`. MQTT one-level matching means the two filters never BOTH hear one publish (a
    leaf line does not arrive on the flat subscription), but a line that does reach this client twice
    — a re-delivery across a reconnect, or a sender that writes both shapes — is printed ONCE, keyed on
    the message id, the same way the pi extension collapses them (`roommsg.ts:noteRoomId`).
    WRITES the leaf `chat/<room>/msg/<nick>` when the transport carries a client certificate pair
    (`MQTT_TLS_CERTFILE` + `MQTT_TLS_KEYFILE`) AND the nick was chosen by the operator (`--nick` or
    `MQTT_NICK`). Both halves are required: the ACL grants that leaf to the certificate whose subject
    names the nick, so a leaf write without the pair is refused by the broker SILENTLY (rc 0, nothing
    delivered) and a leaf write under an inferred name aims at a leaf nobody granted. Without them the
    client writes the flat topic and says so on screen, and every line it read from a flat topic is
    shown marked `unverified` — that name is text the sender typed, not an identity the broker vouched
    for. `--flat-send` keeps the flat write available on purpose: a room whose ACL has not migrated
    needs it, and it is then a choice the operator made rather than a fallback that happened to them.
    PROVES IT BY WITNESS, NEVER BY CLAIM: a QoS 0 publish the broker throws away is not an error — the
    call succeeds, `wait_for_publish` returns, the exit code is 0 and nothing appears anywhere. So this
    client treats every line it sends as UNPROVED until the broker hands that same id back to it on
    `chat/<room>/msg/+`, which is the one answer the protocol does give. A write that does not come back
    within `WITNESS_S` seconds prints `READ-ONLY` with the ACL entry to look for, and says it again on
    the next line that cannot be confirmed. A transport that cannot answer the question at all is
    reported as `unknown` — never as a pass, never as a refusal.

MARKDOWN-LITE, and the deliberate limit (whether markdown is worth it at all is a real question): the room
stays BYTE-FOR-BYTE PLAIN TEXT on the wire — no markup is ever sent, and the agent-side cap rule
("plain text only in the room") is untouched. Rendering happens only in this human client, and
only three shapes: a fenced ``` block is shown without reflowing it, `code` is tinted, **bold**
and _em_ keep their markers on purpose. Full markdown (headings, lists, tables, reflowed
paragraphs) was rejected: a renderer that re-lays-out text in a fixed one-row-per-entry frame
produces a screen nobody can read, and anything stricter invites the room to carry markup the
lanes were told not to write.

Usage:
    cd "$(git rev-parse --show-toplevel)/src"   # run it from this repo's own src dir
    .venv/bin/python src/tabichat_cli.py [room]        # room optional
"""

import argparse
import collections
import fcntl
import getpass
import json
import os
import random
import re
import shutil
import signal
import sys
import termios
import threading
import time
import tty
import warnings
from datetime import datetime

import paho.mqtt.client as mqtt

from addressing import mentions_self as _mentions_self, receives  # noqa: F401 (mentions_self re-exported below)
from paste import enter_is_paste, fold_message
from presence import peer_record_wins, peer_state as record_state, peer_age, PEERS_INSTRUMENT
from broker import BrokerError, resolve_broker, resolve_broker_url
# transport: TLS + client certificates, decided by the pure module next to this one. It is a
# separate file because the pi extension enforces the SAME refusal rules in tlsopts.ts, and two
# inline copies of "never fall back to plaintext" drift until only one of the clients obeys it.
from tlsenv import (
    TLS_ENV,
    TransportBlocked,
    TransportRefusal,
    apply_to_client,
    build_ssl_context,
    transport_kwargs,
)

warnings.filterwarnings("ignore", "Callback API version 1 is deprecated")

# BROKER LOCATION — RESOLVED, NEVER DEFAULTED (site-agnostic by design: "no default, must be
# set" + "the mqtt url can be set in a config, not hardcoded"). Order and refusal text: broker.py,
# beside this file. `--host`/`--port` and `/connect <host:port>` are the OPERATOR typing an address
# for this run, which is what replaces the default that used to sit on those lines.
#
# The TRANSPORT is built from the SAME resolution — never from a second read of MQTT_URL, which on a
# box whose site file configures the broker would be a different layer answering for the same socket
# (the drift a shipped default creates). A refusal here is recorded and printed at start, loud and
# non-zero, and it never degrades to a plaintext session in silence.
BROKER_ERROR = ""
TLS_PLAN = None
TLS_PLAN_SOURCE = ""
try:
    _url, _source = resolve_broker_url()
    BROKER_HOST, BROKER_PORT, BROKER_SOURCE = resolve_broker()
    TLS_PLAN = transport_kwargs(_url)
    TLS_PLAN_SOURCE = _source
except (BrokerError, TransportRefusal, TransportBlocked) as _exc:
    BROKER_HOST, BROKER_PORT, BROKER_SOURCE = None, None, "none"
    BROKER_ERROR = str(_exc)


def plan_transport(host, port, base=None):
    """The transport for `host:port`, or None plus a refusal TEXT.

    `base` is the plan the configured broker produced. When `/connect` retargets to the SAME host
    the config names, the pinned CA and client pair still apply, because the operator pointed at
    that host and configured credentials for it. When it retargets to a DIFFERENT host over TLS,
    reusing the configured pair would be a guess about a broker nothing has verified, so the honest
    answer is a refusal naming the door (MQTT_TLS_CAFILE) rather than a silent plaintext session or
    a certificate served to a host that never asked for it.
    """
    if base is not None and base["host"] == host:
        return base, ""
    if not base or not base["tls"]:
        # plaintext everywhere it was never configured: today's behaviour, unchanged
        return None, ""
    return None, (
        f"/connect {host} is not the configured broker ({base['host']}), and the TLS material "
        f"(MQTT_TLS_CAFILE / MQTT_TLS_CERTFILE / MQTT_TLS_KEYFILE) is configured for "
        f"{base['host']}. Refusing to carry a pinned CA and a client certificate to a different "
        "host. Point MQTT_TLS_CAFILE at the CA that signed the new broker's leaf, or run without "
        "the TLS variables."
    )

# THE BUFFER COUNTS MESSAGES, NOT WRAPPED ROWS. That distinction is the whole point: a 2,500
# -character room post is ONE message here and ~38 rows on screen. 5,000 messages at a typical
# ~1.2 rows each is ~6,000 wrapped rows, which wraps once per entry and renders from a cached
# matrix, so a repaint does not re-wrap 5,000 strings ten times a second.
HISTORY_CAP_DEFAULT = 5000
HISTORY_ENV = "TABICHAT_HISTORY"


def cap_from_env(raw, default=HISTORY_CAP_DEFAULT):
    """The cap from $TABICHAT_HISTORY. A junk or non-positive value keeps the default — a typo in
    an env var must not silently leave a human with a two-line memory."""
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


# --- colours -----------------------------------------------------------------
AMBER = "\033[33m"
MENTION = "\033[1;93m"
BLUE = "\033[38;5;75m"
RESET = "\033[0m"
DIM = "\033[2m"
SELF_HIGHLIGHT = "\033[1;35m"
CYAN = "\033[36m"
BOLD = "\033[1m"
ANSI_RE = re.compile(r"(\033\[[0-9;]*m)")

# A full-screen client repaints in place, so the terminal's own scrollback never fills up — and a
# stale copy of an old frame left in it is noise. BOTH clears therefore erase the scrollback too
# (xterm's ED=3), the behaviour the earlier `chat_cli` WIP test asked for. It is written by the
# renderer on the clear itself, not only at teardown: HELP promises the erase, so the wire must
# show it (measured at dev 1b69e32: CLEAR_SEQ was only emitted when the renderer loop ended).
CLEAR_SEQ = "\x1b[3J"

# How the two clears differ, and this is the whole difference from chat_cli.py's /clear:
#   /clear         drops ENTRIES/MATRIX — the screen AND the messages are gone.
#   /clear screen  moves the paint start (VIEW) past what is in the buffer now. Nothing is
#                  deleted: the screen is blank, new lines fill it from the top, and PgUp / /top /
#                  /show reset the mark because reaching back is the reader asking for it back.
CLEAR = threading.Event()        # /clear handshake
CLEAR_KEEP = threading.Event()   # /clear screen handshake

HELP = [
    "/connect [host[:port]]  connect to the broker",
    "/join <room>            read chat/<room> + chat/<room>/msg/+; write the msg/<nick> leaf",
    "/names                  the beats this client heard: * online, ? quiet or unrankable, - gone",
    "/up [rows] /down [rows] scroll the window (default: a screen)",
    "/top   /live | /back    oldest, newest (clears the unread count)",
    "/depth                  how far the buffer reaches",
    "/grep <text>            search the whole buffer; /show <row> jumps there",
    "/history [n]            show or set the buffer cap (messages)",
    "/md                     toggle markdown-lite (on)",
    "/clear                  blank the screen and drop the buffer (keeps the room)",
    "/clear screen           blank the screen, KEEP the buffer (PgUp brings it back)",
    "/help                   this list",
    "/quit                   leave (presence offline) and exit",
    "PageUp/PgDn half-screen, Ctrl-B/Ctrl-F screen, Ctrl-A live",
    "anything else           sent to the room as a chat message",
]


def clean(nick):
    return re.sub(r"[^a-zA-Z0-9_\-]", "", nick or "")[:20] or "user"


# --- THE PER-NICK SENDER LEAF ------------------------------------------------
# Shape (B), broker-first authorship. The rules live here as PURE functions (no paho, no filesystem,
# no socket) for the same reason `tlsenv.py` is a separate module: the pi extension holds the same
# decisions in `roommsg.ts` (`topicLeaf`, `msgTopic`, `msgWild`, `nickFromMsgTopic`, `authorVerdict`,
# `noteRoomId`) and two inline copies of "whose name is this" drift until only one client obeys it.
# These are mirrors of that shape, not an import of it — python and TS stay separate by design.
NICK_ENV = "MQTT_NICK"
NICK_EXPLICIT = ("--nick", NICK_ENV)
SEEN_IDS_MAX = 200            # roommsg.ts:SEEN_IDS_MAX — one ledger, same size on both clients
UNVERIFIED = " unverified"    # roommsg.ts:renderLine — the SAME word leg 1120 ships, no second vocabulary


def topic_leaf(nick):
    """The topic-level form of a nick: what survives is the leaf, and the payload nick is not it."""
    return re.sub(r"[^a-zA-Z0-9_-]", "", (nick or "").strip())


def msg_topic(room, nick):
    """`chat/<room>/msg/<leaf>`, or "" — the empty-leaf case refuses instead of aiming at a
    trailing-separator topic nobody reads (roommsg.ts:msgTopic)."""
    leaf = topic_leaf(nick)
    return f"chat/{room}/msg/{leaf}" if (room and leaf) else ""


def msg_wild(room):
    """The read half of the same shape: every sender leaf in this room (roommsg.ts:msgWild)."""
    return f"chat/{room}/msg/+" if room else ""


def nick_from_msg_topic(topic, room):
    """The nick the TOPIC asserts, or "" when it is not a sender leaf. One level only."""
    pre = f"chat/{room}/msg/"
    if not room or not topic.startswith(pre):
        return ""
    leaf = topic[len(pre):]
    return "" if (not leaf or "/" in leaf) else leaf


def author_verdict(topic, room, payload_nick):
    """(ok, author, verified, why) for one inbound room line — roommsg.ts:authorVerdict.

    A line on a sender leaf carries its author in the TOPIC, because that leaf is the only topic the
    broker's ACL let the authenticated certificate write. The payload `nick` is a string the sender
    typed. When the two disagree the topic is right and the line is DROPPED AND SAID, never re-labelled
    quietly: a client that accepts a rewritten author is one ack away from trusting a forgery.
    A flat-topic line is deliverable but `verified` is False — that is the limit leg 1120 marks.
    """
    leaf = nick_from_msg_topic(topic, room)
    typed = (payload_nick or "").strip()
    if not leaf:
        return True, typed, False, ""
    if not typed:
        return True, leaf, True, f"no nick in the payload; author taken from the topic {topic}"
    if typed == leaf:
        return True, leaf, True, ""
    return False, leaf, True, f'topic {topic} asserts "{leaf}" but the payload names "{typed}"'


def note_room_id(seen, mid, cap=SEEN_IDS_MAX):
    """(dup, seen) — the id ledger that makes dual-read print one line (roommsg.ts:noteRoomId).
    An absent id dedupes nothing: it is not a key, and swallowing a line for want of one is worse
    than showing it twice."""
    key = (mid or "").strip()
    if not key:
        return False, seen
    if key in seen:
        return True, seen
    nxt = list(seen) + [key]
    return False, nxt[len(nxt) - cap:] if len(nxt) > cap else nxt


def has_client_identity(plan):
    """True only when the transport carries a client certificate PAIR — the thing a leaf write is keyed on."""
    if not plan or not plan.get("tls"):
        return False
    kw = plan.get("kwargs") or {}
    return bool(kw.get("certfile")) and bool(kw.get("keyfile"))


def write_plan(room, nick, source, plan, flat=False):
    """(topic, says) — where the NEXT line actually goes, and the one clear line naming what is missing.

    The per-nick leaf is the only room topic whose author the broker vouches for, and reaching it takes
    a client certificate pair AND a nick the operator chose. Anything else writes the flat topic — and
    says so, because a silent wrong-topic write is the failure this shape creates: the publish succeeds,
    the socket stays open, the broker returns nothing.
    """
    flat_topic = f"chat/{room}"
    if flat:
        return flat_topic, (
            "--flat-send is on, so this line went on the flat "
            f"{flat_topic}: the broker vouches for the topic, not for the name in it."
        )
    if not has_client_identity(plan):
        return flat_topic, (
            f'no client certificate for "{nick}": {TLS_ENV["certfile"]} and {TLS_ENV["keyfile"]} are not '
            f"both set, so this line went on the flat {flat_topic}. Writing {msg_topic(room, nick)} needs "
            f"a client certificate minted for this nick AND an ACL entry granting that leaf to it — "
            "minting is the operator's act against the live CA, and this client will not invent either."
        )
    if source not in NICK_EXPLICIT:
        return flat_topic, (
            f'the nick "{nick}" was inferred from {source}, not chosen with --nick or {NICK_ENV}, so no '
            f"per-nick leaf is claimed for it and this line went on the flat {flat_topic}. A leaf write "
            "aims at the name a certificate was minted for, so name it yourself."
        )
    leaf = msg_topic(room, nick)
    if not leaf:
        return flat_topic, (
            f'nick "{nick}" has no topic-leaf-safe form; posted to the flat room topic instead, so the '
            "per-sender ACL does NOT apply to this line."
        )
    return leaf, ""


def boot_tag(rand=random.random):
    """Six hex chars, the shipped builder's width (`roommsg.ts:bootTag`), from an injectable draw so the
    mapping is testable without a random number."""
    return f"{int(rand() * 0x100000):06x}"


def msg_id(nick, seq, boot):
    """`<nick>-<seq>-<boot>` — the shipped id shape, `roommsg.ts:msgId`, and the boot tag is not decoration.

    `MSG_SEQ` restarts at 0 every session, so `<nick>-<seq>` alone hands the SAME id to two different
    messages in two sessions of one seat — and this client's own id ledger keys on exactly that string,
    so a restarted sender's first line would be swallowed as a duplicate of a line already on screen.
    The extension carries the tag for the same reason: its receipt board is filed by id.
    """
    return f"{nick}-{seq}-{boot}"


WITNESS_S = 5.0        # how long a self-written line is given to come back from the broker


def witness_seen(pending, topic, mid):
    """True when the line coming back IS the line we just sent. Exact (topic, id) only: a different
    topic is somebody else's write, and a different id is a different message."""
    return bool(pending) and pending[0] == mid and pending[1] == topic


def pending_expired(pending, now, limit=WITNESS_S):
    """Has the witness window run out? `now` is passed in, so the boundary is testable without sleeping."""
    return bool(pending) and (now - pending[2]) >= limit


def write_state_line(state, room, nick, topic):
    """What the operator is told, per state. Three states, three different sentences — an ungranted
    write and an unanswerable transport are NOT the same fact, and `unknown` must never read as `ok`.

    Returns "" only for the state that needs no warning: a write the broker handed back.
    """
    leaf = topic and topic != f"chat/{room}"
    if state == "granted":
        return (
            f"write confirmed: your own line came back on {topic} — this broker is accepting writes "
            "from this seat, so the name on it is one the certificate carried"
        )
    if state == "unconfirmed":
        return (
            f"READ-ONLY: your line went out on {topic} and never came back, and nothing you type now "
            f"reaches the room. A refused write is silent by protocol (rc 0, no error), so this is the "
            f"only signal you will get. What to check: an ACL entry for this nick on this broker — "
            f"`user CN={nick}` granting `topic readwrite {topic}`"
            + ("" if leaf else f" (this seat is writing the flat room topic, not its leaf: {msg_wild(room)} is where a granted name lands)")
            + "."
        )
    if state == "unknown":
        return (
            f"write path NOT YET PROVED: nothing has been sent on {topic} since this join, so whether "
            "this broker accepts this seat's writes is unknown — the first line you send is what answers "
            "it, and if it does not come back this seat will say so here, in words you can act on"
        )
    # A state this file does not know is not a pass and not a refusal either: it is said as itself.
    return f"write path UNKNOWN: this client cannot classify state {state!r} — treat it as unproved"


def resolve_nick(cli=None, env=None):
    """(nick, source, refusal). An operator-chosen roster nick first; a refusal, never a rewrite.

    `clean()` STRIPS characters and truncates at 20, so a nick it alters cannot be the leaf the ACL
    grants: `"Dusty Smith"` sanitises to `"DustySmith"` and a publish aimed at the truncated leaf is
    refused by the broker with rc 0 and no error. So an altered nick that the OPERATOR CHOSE (`--nick`,
    `MQTT_NICK`) is refused with a named reason instead of being quietly rewritten — the same notice the
    extension gives for that case. An INFERRED value ($USER, chat_nick, irc_nick, getpass) is not a claim
    on a leaf and stays what it has always been here: a display name, sanitised for the wire by `clean()`,
    with `write_plan` writing flat because its source is not explicit. Dotted and spaced account names are
    ordinary, and refusing start-up for one tells a person to choose an identity they never chose.
    """
    env = os.environ if env is None else env
    if cli:
        raw, source = str(cli), "--nick"
    elif (env.get(NICK_ENV) or "").strip():
        raw, source = env[NICK_ENV], NICK_ENV
    elif (env.get("USER") or "").strip():
        raw, source = env["USER"], "$USER"
    elif (env.get("chat_nick") or env.get("irc_nick") or "").strip():
        raw, source = (env.get("chat_nick") or env.get("irc_nick")), "chat_nick/irc_nick"
    else:
        raw, source = getpass.getuser(), "getpass"
    raw = raw.strip()
    if not raw:
        return raw, source, (
            "no nick to post as — refusing to join under a borrowed name. Choose the roster nick: "
            f"--nick <nick> or {NICK_ENV}=<nick>."
        )
    # THE LEAF-SHAPE GATE FIRES ON A CHOICE. The refusal below binds only a nick somebody named, because
    # that is the only nick a leaf is ever claimed under; an inferred one is refused its leaf by
    # `write_plan`, which is the same fact stated where the write actually happens.
    if source in NICK_EXPLICIT and clean(raw) != raw:
        return raw, source, (
            f'nick "{raw}" has no topic-leaf-safe form: it is not what this client would put on the '
            f"wire (`clean()` alters it to {clean(raw)!r}), and an altered nick aims the publish at a "
            f"leaf the ACL will not grant. Choose the nick the certificate was minted for: "
            f"--nick <nick> or {NICK_ENV}=<nick>."
        )
    return raw, source, ""


SELF_RAW, NICK_SOURCE, NICK_REFUSAL = resolve_nick()
SELF = clean(SELF_RAW)

# --- state -------------------------------------------------------------------
ENTRIES: list[str] = []          # UNWRAPPED messages, oldest first — the buffer
MATRIX: list[list[str]] = []     # per-entry wrapped rows, rebuilt on width change
_WIDTH = 0
_HEIGHT = 0
_SCROLL = 0                      # rows of headroom; 0 = live at the bottom
_UNREAD = 0                      # rows that arrived while the window was parked
VIEW = 0                         # first ENTRIES/MATRIX row the window paints (/clear screen)
HISTORY_CAP = cap_from_env(os.environ.get(HISTORY_ENV), HISTORY_CAP_DEFAULT)
MD = True                        # markdown-lite pass, /md toggles
CLEAR = threading.Event()        # /clear handshake (screen AND buffer)

_HIST = threading.Lock()
LINE = bytearray()
_LINE_L = threading.Lock()
CLIENT = None
CONN_LOCK = threading.Lock()
SEQ = 1
HOST, PORT = BROKER_HOST, BROKER_PORT
TOPIC = ""
MSG_WILD = ""                # chat/<room>/msg/+ — the read half of shape (B)
FLAT_SEND = False            # --flat-send: the operator chose the flat write
SEEN_IDS: list[str] = []     # the id ledger that makes dual-read print one line
PRESENCE = ""
PRESENCE_W = ""
PRESENCE_SELF = ""
CTL = ""
ROOM = None
ONLINE: dict[str, tuple[str, float]] = {}
ACKS: list[tuple[float, str, str, str]] = []
MSG_SEQ = 0
HB_S = 30.0
BOOT = boot_tag()             # this run's tag in every id it mints (see msg_id)
WRITE_STATE = "unknown"       # unknown | granted | unconfirmed — proved by witness, never asserted
PENDING_WRITE = None          # (id, topic, sent_at) of the last write not yet witnessed
WITNESS_TIMER = None          # the threading.Timer that says READ-ONLY when the window closes
LAST_BYTE = None
_RENDERER_RUNNING = True


class QuitSignal(BaseException):
    pass


def now():
    return datetime.now().strftime("%H:%M:%S")


def ts():
    return f"{AMBER}{now()}{RESET}"


# --- pure window math (importable, tested in tools/test_tabichat_cli.py) ------

def visible_rows(matrix, cap=100000):
    """Total scrollable rows. A sane ceiling, because a human scrolling 5M rows is a bug report."""
    return min(cap, sum(len(r) for r in matrix))


def scroll_window(total, avail, scroll):
    """The rows [start, end) to paint, given `scroll` rows of headroom below the window.

    Three properties a scrollback screen must have, all enforced here and each tested with its
    negative half: the window is ALWAYS `avail` rows tall whenever there is content (no shrink,
    which would flash the frame); it can never paint past the bottom (`scroll <= total - avail`,
    so a short buffer shows from row 0); and it can never go negative (clamped at the oldest).
    """
    if total <= 0:
        return (0, 0)
    a = max(avail, 1)
    hi = total - max(0, min(scroll, max(0, total - a)))
    lo = max(0, hi - a)
    return (lo, min(hi, total))


def status_row(scroll, unread, total, avail):
    """The footer a scrolled reader needs: how deep, and how to get out. '' when live."""
    if scroll <= 0:
        return ""
    back = max(0, scroll - avail)
    parts = [f"\u25b2 {back} row(s) back"]
    if unread:
        parts.append(f"{unread} new")
    parts.append("PgDn/Ctrl-F forward, /live newest")
    return f"{BOLD}{DIM}\u2504 " + " \u00b7 ".join(parts) + RESET


# --- markdown-lite (display only; the wire stays plain text) ------------------
CODE_SPAN_RE = re.compile(r"`([^`\n]{1,400})`")
BOLD_RE = re.compile(r"(?<!\*)\*\*([^*\n]{1,300})\*\*(?!\*)")
EM_RE = re.compile(r"(?<![A-Za-z0-9_])_([^_\n]{1,200})_(?![A-Za-z0-9_])")


def md_inline(text):
    """Tint `code` and **bold**. The markers STAY VISIBLE on purpose: a room line is evidence,
    and a renderer that eats the characters the sender typed cannot be quoted back to them."""
    text = CODE_SPAN_RE.sub(lambda m: f"{DIM}`{RESET}{CYAN}{m.group(1)}{DIM}`{RESET}", text)
    text = BOLD_RE.sub(lambda m: f"{DIM}**{RESET}{BOLD}{m.group(1)}{DIM}**{RESET}", text)
    return text


def md_block(entry):
    """A fenced ``` block: render each of its lines verbatim, no reflow, dim marker on the fence.

    Returns the list of display strings, or None when the entry is not fenced (the caller then
    uses the single-entry line as-is). Reflowing a code block would break the one thing a code
    block is for.
    """
    if "```" not in entry:
        return None
    lines = entry.split("\n")
    out = []
    inside = False
    for ln in lines:
        if ln.strip().startswith("```"):
            inside = not inside
            out.append(f"{DIM}{ln}{RESET}")
            continue
        out.append(f"{DIM}  {ln}{RESET}" if inside else ln)
    return out


# --- buffer ------------------------------------------------------------------

def _cap_locked():
    """Trim the buffer to HISTORY_CAP MESSAGES. Caller holds _HIST."""
    global ENTRIES, MATRIX, _SCROLL, _UNREAD, VIEW
    over = len(ENTRIES) - HISTORY_CAP
    if over <= 0:
        return
    del ENTRIES[:over]
    del MATRIX[:over]
    # The trim deletes from the FRONT, so every index — including the /clear screen mark — shifts
    # down by `over`. Without this the mark would silently hide `over` live messages off the bottom.
    VIEW = max(0, VIEW - over)


def note(line):
    """Append one entry. It stays UNWRAPPED here; the renderer wraps it at paint time."""
    with _HIST:
        ENTRIES.append(line)
        MATRIX.append([])          # empty means "wrap me at the next paint"
        _cap_locked()
        # Rows arriving while the reader is parked in the past must NOT yank them forward — that
        # is what a scrollback is for. Count them instead; the footer offers the way out.
        if _SCROLL > 0:
            _bump_unread_locked()


def _bump_unread_locked():
    global _UNREAD
    _UNREAD += 1
    if _UNREAD > 999:
        _UNREAD = 999


def set_scroll(delta_rows):
    """Move the window. Returns (scroll, total) as clamped — the UI reads the truth, not the ask."""
    global _SCROLL, _UNREAD, VIEW
    with _HIST:
        VIEW = 0        # reaching back into the buffer ends a /clear screen; that is what was asked
        total = visible_rows(MATRIX)
        avail = max(_HEIGHT - 2, 1)
        _SCROLL = max(0, min(_SCROLL + delta_rows, max(0, total - avail)))
        if _SCROLL == 0:
            _UNREAD = 0
        return _SCROLL, total


def go_live():
    global _SCROLL, _UNREAD
    with _HIST:
        _SCROLL = 0
        _UNREAD = 0


def go_top():
    global _SCROLL, VIEW
    with _HIST:
        VIEW = 0        # /top means "the oldest line in the buffer", mark included
        _SCROLL = max(0, visible_rows(MATRIX) - max(_HEIGHT - 2, 1))
        return _SCROLL


def depth():
    with _HIST:
        return len(ENTRIES), visible_rows(MATRIX), _SCROLL, _UNREAD


def buffer_rows():
    """The current painted rows of the whole buffer, for /grep and /show. Wrapped lazily."""
    global MATRIX, _WIDTH
    with _HIST:
        width = max(shutil.get_terminal_size((80, 24)).columns - 1, 20)
        if width != _WIDTH:
            _WIDTH = width
        rows = []
        index_of = []
        for i, entry in enumerate(ENTRIES):
            disp = _render_entry(entry, width)
            wr = _wrap_display_rows(disp, width)
            if MATRIX[i] != wr:
                MATRIX[i] = wr
            for _ in wr:
                index_of.append(i)
            rows.extend(wr)
        return rows, index_of


def grep_rows(needle):
    """Search the WHOLE buffer, newest first, on VISIBLE text (ANSI stripped), case-insensitive.
    Returns [(row_index, snippet)] — the row is what /show jumps to."""
    if not needle:
        return []
    rows, index_of = buffer_rows()
    hits = []
    low = needle.lower()
    for i in range(len(rows) - 1, -1, -1):
        if low in strip_ansi(rows[i]).lower():
            hits.append((i, strip_ansi(rows[i]).strip()[:110]))
            if len(hits) >= 25:
                break
    return hits, len(rows), index_of


def jump_to_row(row):
    """Put the printed row at the TOP of the window. Clamped both ends, so a stale /grep row
    number cannot park the window past the newest line."""
    global _SCROLL, _UNREAD, VIEW
    rows, _ = buffer_rows()
    total = len(rows)
    if total == 0:
        return False
    with _HIST:
        VIEW = 0        # a /show jump names a row in the WHOLE buffer, so the buffer is revealed
        _SCROLL = max(0, min(total - 1 - max(0, min(row, total - 1)), total - 1))
        if _SCROLL == 0:
            _UNREAD = 0
    return True


def strip_ansi(text):
    return ANSI_RE.sub("", text)


# --- wrapping (visible-width aware, colour-safe) ------------------------------

def _render_entry(entry, width):
    """One buffer entry -> display string (markdown-lite applied, mentions highlighted)."""
    if MD:
        block = md_block(entry)
        if block is not None:
            return "\n".join(block)
        return md_inline(entry)
    return entry


def _wrap_display_rows(text, width):
    """Split one display string into rows of ONE terminal line each, colours re-opened.

    Spaces are reproduced, never invented (the rule chat_cli learned the hard way: a colour code
    is not a word, and the first version of this loop gave every room line a phantom space after
    its timestamp). Rows are at most `width` VISIBLE characters.
    """
    rows = []
    cur = ""
    cur_vis = 0
    codes = ""
    pending = 0

    def flush():
        nonlocal cur, cur_vis, pending
        if cur != "":
            rows.append(cur + (RESET if codes else ""))
        cur, cur_vis, pending = "", 0, 0

    def put_word(word):
        nonlocal cur, cur_vis, pending
        wlen = len(word)
        # A word that no longer fits ends the row. Any spaces it was carrying
        # break with the row rather than opening the next one with whitespace.
        if cur_vis and cur_vis + pending + wlen > width:
            flush()
            cur, cur_vis = codes, 0
        if pending and cur_vis:
            cur += " " * pending
            cur_vis += pending
        pending = 0
        # A word WIDER than the terminal is broken, never passed whole. Left whole it makes one
        # row longer than the screen: the terminal wraps it for us, the frame has already counted
        # that line, and everything below shifts by one — which is precisely how a fixed-frame
        # client turns into a wall of duplicated lines. tools/test_wrap_rows.py demands this too — it
        # is committed (at `406814f`) and it is a deploy gate, so a long URL or path cannot
        # cost you the bottom of your screen. The colour that was open stays open on every piece.
        while len(word) > width - cur_vis:
            take = max(1, width - cur_vis)
            cur += word[:take]
            cur_vis += take
            word = word[take:]
            wlen = len(word)
            flush()
            if not word:
                return
            cur, cur_vis = codes, 0
        cur += word
        cur_vis += wlen

    for seg in text.split("\n"):
        if seg.strip() == "":
            flush()
            rows.append("")
            continue
        for tok in ANSI_RE.split(seg):
            if not tok:
                continue
            if ANSI_RE.fullmatch(tok):
                codes = "" if tok == RESET else tok
                cur += tok
                continue
            if tok == "":
                continue
            for piece in re.split(r"( +)", tok):
                if piece == "":
                    continue
                if piece.isspace():
                    pending += len(piece)
                    continue
                put_word(piece)
        flush()
    return rows or [""]


# --- display ------------------------------------------------------------------

def render_frame(total, avail, size, matrix, scroll, unread=0, line=""):
    """Compose one frame. Kept separate from the loop so a test can assert the window it paints.

    `line` is the text being typed RIGHT NOW. It belongs in the frame: the first version of this
    function wrote the prompt and forgot the line buffer, so every keystroke vanished from the
    screen — a client that repaints 10 times a second, reads every key, and shows none of them.
    A person typing into it caught that; no unit check would have, which is why the pty probe now
    types and asserts the echo.
    """
    lo, hi = scroll_window(total, avail, scroll)
    flat = [r for rows in matrix for r in rows]
    tail = flat[lo:hi]
    short = avail - len(tail)
    status = status_row(scroll, unread, total, avail)
    body = []
    if status:
        # the footer costs a row, so the window is one shorter — computed, never promised
        body.append(status)
    body.extend([""] * short)
    body.extend(tail)
    return "\x1b[H\x1b[J" + "\r\n".join(body) + f"\r\n{BLUE}>{RESET} {line}"


def apply_clear():
    """Take the /clear handshake: blank AND drop. Split out of the renderer loop so the truth
    table in tools/test_wrap_rows.py can exercise the real path without starting a paint thread.
    The renderer is the only caller in the shipped client."""
    global _SCROLL, _UNREAD, VIEW
    with _HIST:
        ENTRIES.clear()
        MATRIX.clear()
        _SCROLL = 0
        _UNREAD = 0
        VIEW = 0
    sys.stdout.write(CLEAR_SEQ)
    sys.stdout.flush()


def apply_clear_keep():
    """Take the /clear screen handshake: blank the view, delete nothing. The mark moves past every
    entry that is already here, so the screen is empty and the buffer still holds all of it."""
    global _SCROLL, _UNREAD, VIEW
    with _HIST:
        VIEW = len(ENTRIES)
        _SCROLL = 0
        _UNREAD = 0
    sys.stdout.write(CLEAR_SEQ)
    sys.stdout.flush()


def renderer():
    # _SCROLL and _UNREAD are written here (the clamp below), so they must be named global at the top
    # of the function. The first version of this loop declared them inside the /clear branch, and
    # when that branch moved into apply_clear() the declaration left with it: Python then treated
    # _SCROLL as a local for the WHOLE function and the frame died with UnboundLocalError. The unit
    # truth table cannot see this — it never runs renderer() — the pty probe caught it on the first
    # frame, which is exactly why the physical probe exists.
    global _WIDTH, _HEIGHT, _RENDERER_RUNNING, _SCROLL, _UNREAD
    while _RENDERER_RUNNING:
        size = shutil.get_terminal_size((80, 24))
        width = max(size.columns - 1, 20)
        avail = max(size.lines - 2, 1)
        if CLEAR.is_set():
            CLEAR.clear()
            apply_clear()
        if CLEAR_KEEP.is_set():
            CLEAR_KEEP.clear()
            apply_clear_keep()
        changed = False
        with _HIST:
            if width != _WIDTH or size.lines != _HEIGHT:
                _WIDTH, _HEIGHT = width, size.lines
                for i in range(len(MATRIX)):
                    MATRIX[i] = []
                changed = True
            if any(len(r) == 0 for r in MATRIX):
                changed = True
            if changed:
                for i, entry in enumerate(ENTRIES):
                    if not MATRIX[i]:
                        MATRIX[i] = _wrap_display_rows(_render_entry(entry, width), width)
                total = sum(len(r) for r in MATRIX)
                _SCROLL = max(0, min(_SCROLL, max(0, total - avail)))
            matrix = [list(r) for r in MATRIX[VIEW:]]
        total = sum(len(r) for r in matrix)
        with _LINE_L:
            typing = bytes(LINE).decode("utf-8", "replace")
        out = render_frame(total, avail, size, matrix, _SCROLL, _UNREAD, typing)
        sys.stdout.write(out)
        sys.stdout.flush()
        time.sleep(0.1)
    sys.stdout.write("\x1b[H\x1b[J" + CLEAR_SEQ)
    sys.stdout.flush()


# --- presence / ack / broker (the parts chat_cli already got right) ------------

def peer_state_for(nick):
    return record_state(ONLINE.get(nick), time.time())


def beat(client=None):
    c = client or CLIENT
    if not (c and PRESENCE_SELF):
        return
    try:
        c.publish(
            PRESENCE_SELF,
            json.dumps({"nick": SELF, "status": "online", "ts": time.time()}),
            retain=True,
        )
    except Exception:
        pass


def heartbeat(client):
    while CLIENT is client and _RENDERER_RUNNING:
        time.sleep(HB_S)
        if CLIENT is not client:
            return
        beat(client)


def start_heartbeat(client):
    threading.Thread(target=heartbeat, args=(client,), daemon=True).start()


def ack_id(target_msg_id, sender):
    # THE PARAMETER IS A VALUE, NOT THE BUILDER. It used to be named `msg_id`, which shadowed the
    # module-level `msg_id()` id builder (`:359`) for this whole body: legal while the body only reads the
    # string, and a silent trap the moment anything here wants to reshape an id — it would be calling a str.
    c = CLIENT
    if not (c and CTL and target_msg_id):
        return
    try:
        c.publish(
            CTL,
            json.dumps({"kind": "ack", "id": target_msg_id, "to": sender, "by": SELF, "ts": time.time()}),
        )
    except Exception:
        pass


def mentions_self(text):
    """LEGACY PATH — kept as the name this file has always exposed, now a thin delegate to
    `addressing.mentions_self` so the scan exists in exactly one place. Delivery decisions go
    through `receives()` (field-first), not through this."""
    return _mentions_self(text, SELF)


def highlight_mentions(text):
    def replacer(match):
        name = match.group(1)
        if SELF and name.lower() == SELF.lower():
            return f"{SELF_HIGHLIGHT}@{name}{RESET}"
        return f"{MENTION}@{name}{RESET}"

    return MENTION_RE.sub(replacer, text)


MENTION_RE = re.compile(r"@([A-Za-z0-9_.\-]+)")


def active(c):
    return CLIENT is c


def on_connect(client, userdata, flags, rc):
    global ROOM
    if not active(client):
        return
    if rc != 0:
        note(f"{ts()} [!] broker refused us (rc={rc}) — try /connect again")
        return
    if TOPIC:
        client.subscribe(TOPIC)
        # DUAL READ, shape (B): the per-sender leaves are heard ALONGSIDE the flat room topic, and a
        # line that arrives on both is collapsed by the id ledger, so this cannot print twice. It is
        # unconditional: a client that reads only the flat topic is deaf from the moment the writer
        # migrates, and the writer has already migrated in the lanes.
        if MSG_WILD:
            client.subscribe(MSG_WILD)
        client.subscribe(CTL)
        client.subscribe(PRESENCE_W)
        if PRESENCE:
            client.subscribe(PRESENCE)
        beat(client)
        start_heartbeat(client)
        ROOM = TOPIC.split("/", 1)[1]
        n, r, _, _ = depth()
        note(
            f"{ts()} in room {TOPIC} as {BLUE}{SELF}{RESET} — buffer {n} msgs / {r} rows "
            "(PgUp scrolls, /help)"
        )
    else:
        note(f"{ts()} connected to {HOST}:{PORT} — /join <room>")


def on_message(client, userdata, msg):
    global SEEN_IDS
    if not active(client):
        return
    try:
        data = json.loads(msg.payload.decode("utf-8", "replace"))
    except Exception:
        return
    if data.get("kind") == "ack":
        ACKS.append(
            (
                float(data.get("ts") or time.time()),
                str(data.get("id", "?")),
                str(data.get("by", "?")),
                str(data.get("to", "?")),
            )
        )
        del ACKS[:-50]
        return
    if PRESENCE and (msg.topic == PRESENCE or msg.topic.startswith(f"{PRESENCE}/")):
        nick = data.get("nick", "")
        status = data.get("status", "")
        if not nick or nick == SELF:
            return
        seen = ONLINE.get(nick)
        was = peer_state_for(nick)
        raw_ts = data.get("ts")
        at = float(raw_ts) if isinstance(raw_ts, (int, float)) else 0.0
        incoming = ("offline" if status == "offline" else "online", at)
        if not peer_record_wins(seen, incoming):
            return
        ONLINE[nick] = incoming
        if status == "online" and was != "online":
            note(f"{ts()} — {BLUE}{nick}{RESET} joined")
        elif status == "offline" and was == "online":
            note(f"{ts()} — {BLUE}{nick}{RESET} left")
        return
    on_leaf = bool(ROOM) and bool(nick_from_msg_topic(msg.topic, ROOM))
    if msg.topic == TOPIC or on_leaf:
        # BROKER-FIRST AUTHORSHIP: on a sender leaf the TOPIC names the author, because that leaf is
        # the only topic the ACL lets the authenticated certificate write. A disagreement between the
        # topic and the typed payload nick is dropped AND SAID, never re-labelled. A flat-topic line
        # is shown marked `unverified` — the same word leg 1120 renders, so a human reader is not told
        # that a typed name is a proven identity.
        ok, author, verified, why = author_verdict(msg.topic, ROOM, data.get("nick", ""))
        if not ok:
            note(f"{ts()} [!] line dropped, authorship conflict: {why}. Nothing was delivered.")
            return
        if why:
            note(f"{ts()} [!] authorship note: {why}")
        sender = author or "unknown"
        if sender == SELF:
            # THE WITNESS. The broker delivering a line back to the seat that wrote it is the ONLY
            # answer MQTT 3.1.1 gives about an ACL refusal, so this is where a write stops being a
            # claim. It has to be read before echo-prevention drops the line as "mine".
            global WRITE_STATE, PENDING_WRITE, WITNESS_TIMER
            if witness_seen(PENDING_WRITE, msg.topic, data.get("id", "")):
                if WITNESS_TIMER:
                    WITNESS_TIMER.cancel()
                    WITNESS_TIMER = None
                PENDING_WRITE = None
                if WRITE_STATE != "granted":
                    note(f"{ts()} [ok] {write_state_line('granted', ROOM, SELF, msg.topic)}")
                WRITE_STATE = "granted"
            return
        # ONE MESSAGE, ONE LINE: a line can still reach this client on BOTH shapes — a re-delivery
        # across a reconnect, or a sender that writes the flat topic and the leaf — and the flat
        # subscription is not going away while half the room still posts to it. The repeat is collapsed
        # here, before the buffer and before any ack, so a duplicate can be neither read nor answered
        # twice.
        dup, SEEN_IDS = note_room_id(SEEN_IDS, data.get("id", ""))
        if dup:
            # SAID, not swallowed. A line that vanishes off the wire with no word on screen is the exact
            # failure class this leg exists to close, and a reader cannot tell "already shown" from "lost".
            note(f"{ts()} [!] duplicate dropped: id {data.get('id')!r} from {sender} was already read "
                 "here — nothing new was printed")
            return
        ONLINE[sender] = ("online", time.time())
        message = data.get("message", "")
        # FIELD-FIRST, TEXT-FALLBACK (see addressing.py): a payload carrying a
        # recipient field is addressed by that field alone, so an @nick quoted in the prose no longer
        # makes this terminal shout or ack a line that was never meant for it. A fieldless line (a
        # human's bare type, any sender that predates the field) keeps the whole-body scan.
        # The ack now reads the MESSAGE, not the raw payload: the payload also carries the sender's
        # nick, so a line SENT BY this nick's namesake used to be scannable as a mention of it.
        for_me = receives(data.get("to"), message, SELF)
        if for_me and data.get("id"):
            ack_id(data.get("id"), sender)
        if for_me:
            # the human deserves the same nudge the lanes get: a line addressed to you is not
            # background reading, and while scrolled back it would otherwise be silent
            message = f"{BOLD}{MENTION}[for you]{RESET} {message}"
        note(
            f"{ts()} {BLUE}{sender}{RESET}{'' if verified else UNVERIFIED}: "
            f"{highlight_mentions(message)}"
        )


def on_disconnect(client, userdata, rc):
    global ROOM
    if not active(client) or rc == 0:
        return
    ROOM = None
    note(f"{ts()} [!] lost the broker (rc={rc}) — /connect, then /join <room>")


def make_client(seq, plan=None):
    c = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION1,
        client_id=f"{SELF}-tbcli-{os.getpid()}-{seq}",
    )
    # TLS is applied to the CLIENT, before any connect, and a paho that cannot carry the plan raises
    # rather than falling through to plaintext. `note()` is used for the per-connect warnings in the
    # two call sites, because this function has no terminal access of its own.
    if plan is not None and plan["tls"]:
        try:
            apply_to_client(c, plan)
        except (TransportBlocked, TransportRefusal) as e:
            note(f"{ts()} [!] transport refused: {e}")
            raise
        for _w in plan["warnings"]:
            note(f"{ts()} [!] {_w}")
    c.on_connect = on_connect
    c.on_message = on_message
    c.on_disconnect = on_disconnect
    return c


def leave_quiet():
    global CLIENT, ROOM, TOPIC, MSG_WILD, PRESENCE, PRESENCE_W, PRESENCE_SELF, CTL
    global WRITE_STATE, PENDING_WRITE, WITNESS_TIMER
    WRITE_STATE = "unknown"
    PENDING_WRITE = None
    if WITNESS_TIMER:
        WITNESS_TIMER.cancel()
        WITNESS_TIMER = None
    c = CLIENT
    in_room = bool(ROOM and TOPIC and PRESENCE_SELF)
    self_topic = PRESENCE_SELF
    CLIENT = None
    ROOM = None
    TOPIC = ""
    MSG_WILD = ""
    PRESENCE = ""
    PRESENCE_W = ""
    PRESENCE_SELF = ""
    CTL = ""
    if c is None:
        return
    if in_room:
        try:
            c.publish(
                self_topic,
                json.dumps({"nick": SELF, "status": "offline", "ts": time.time()}),
                retain=True,
            ).wait_for_publish(timeout=2)
        except Exception:
            pass
    try:
        c.loop_stop(timeout=1)
        c.disconnect()
    except Exception:
        pass


def do_connect(host, port):
    global CLIENT, HOST, PORT, SEQ, TLS_PLAN
    if host is None:
        # never a guess — say which doors were looked at
        note(f"{ts()} [!] {BROKER_ERROR or 'no broker configured'}")
        return
    # A retarget that would carry the configured broker's pinned CA and client pair to some other
    # host is refused here, in the room, rather than attempted on the socket.
    plan, why = plan_transport(host, int(port), TLS_PLAN)
    if why:
        note(f"{ts()} [!] {why}")
        return
    with CONN_LOCK:
        leave_quiet()
        HOST, PORT = host, int(port)
        note(f"{ts()} connecting to {HOST}:{PORT} ...")
        c = make_client(SEQ, plan if plan is not None else TLS_PLAN)
        SEQ += 1
        CLIENT = c
        try:
            c.connect(HOST, PORT, keepalive=30)
            c.loop_start()
        except Exception as e:
            note(f"{ts()} [!] connect to {HOST}:{PORT} failed: {e}")
            leave_quiet()


def do_join(room_name):
    global TOPIC, MSG_WILD, PRESENCE, PRESENCE_W, PRESENCE_SELF, CTL, ONLINE, SEQ, CLIENT
    if HOST is None:
        note(f"{ts()} [!] {BROKER_ERROR or 'no broker configured'}")
        return
    with CONN_LOCK:
        room = clean(room_name)
        if not room:
            note(f"{ts()} usage: /join <room>")
            return
        leave_quiet()
        ONLINE = {}
        TOPIC = f"chat/{room}"
        PRESENCE = f"{TOPIC}/presence"
        PRESENCE_W = f"{PRESENCE}/#"
        PRESENCE_SELF = f"{PRESENCE}/{SELF}"
        CTL = f"{TOPIC}/_ctl"
        MSG_WILD = msg_wild(room)
        wtopic, wsays = write_plan(room, SELF, NICK_SOURCE, TLS_PLAN, FLAT_SEND)
        note(f"{ts()} joining {TOPIC} — reading {TOPIC} and {MSG_WILD}")
        # THE WRITE PATH IS NOT ASSERTED HERE. The banner this replaces claimed the broker stood
        # behind the name before this seat had written anything, and that claim is exactly what hid a
        # seat whose ACL block is missing. The witness on the first real line is what earns the words.
        # (A cell in tools/test_tabichat_cli.py pins that the old wording is gone from this function.)
        note(f"{ts()} writing {wtopic} — unproved until one of your lines comes back")
        if wsays:
            note(f"{ts()} [!] {wsays}")
        else:
            note(f"{ts()} [?] {write_state_line('unknown', room, SELF, wtopic)}")
        c = make_client(SEQ, TLS_PLAN)
        SEQ += 1
        c.will_set(
            PRESENCE_SELF,
            json.dumps({"nick": SELF, "status": "offline", "ts": time.time()}),
            retain=True,
        )
        CLIENT = c
        try:
            c.connect(HOST, PORT, keepalive=30)
            c.loop_start()
        except Exception as e:
            note(f"{ts()} [!] join {TOPIC} failed: {e}")
            leave_quiet()
            return
        deadline = time.time() + 3
        while not (ROOM == room) and time.time() < deadline and active(c):
            time.sleep(0.05)
        if ROOM != room:
            note(f"{ts()} [!] join {TOPIC} timed out — try /join {room} again")


# --- commands -----------------------------------------------------------------

def mark_unconfirmed(now=None):
    """Say it when it is learned: a write whose witness window has closed without an answer.

    Called twice on purpose — by the timer at the moment the window closes, and again from the NEXT send,
    so a second silent line is not possible. One sentence, built in `write_state_line`, never two vocabularies.
    """
    global WRITE_STATE
    at = time.time() if now is None else now
    if not pending_expired(PENDING_WRITE, at):
        return False
    WRITE_STATE = "unconfirmed"
    note(f"{ts()} [!] {write_state_line(WRITE_STATE, ROOM, SELF, PENDING_WRITE[1])}")
    return True


def report_witness():
    """The timer trampoline. It answers the window, not the room: a pending write that is gone is a no-op."""
    global WITNESS_TIMER
    WITNESS_TIMER = None
    mark_unconfirmed()


def text_send(text):
    global MSG_SEQ, PENDING_WRITE, WITNESS_TIMER
    if CLIENT is None or not ROOM:
        note(f"{ts()} [!] not in a room — /connect then /join <room>")
        return
    text = fold_message(text)
    if not text:
        note(f"{ts()} [!] nothing to send — a blank line stays here")
        return
    MSG_SEQ += 1
    # THREE PARTS, THE SHIPPED SHAPE (msg_id / roommsg.ts:msgId): MSG_SEQ restarts at 0 every run, so a
    # two-part id hands the same string to two different messages across two sessions — and this client's
    # own duplicate ledger keys on it.
    mid = msg_id(SELF, MSG_SEQ, BOOT)
    # THE TOPIC IS CHOSEN, NOT ASSUMED: the leaf is the write the broker can vouch for, and the flat
    # topic stays available (--flat-send, or no certificate yet). Either way the echo names the topic
    # the line ACTUALLY went on — a wrong-topic write is otherwise silent, rc 0, nothing delivered.
    topic, _ = write_plan(ROOM, SELF, NICK_SOURCE, TLS_PLAN, FLAT_SEND)
    # A previous line may have gone unanswered. Say that BEFORE adding another, so a second vanished
    # message cannot stack silently on the first.
    mark_unconfirmed()
    try:
        info = CLIENT.publish(
            topic,
            json.dumps({"nick": SELF, "message": text, "id": mid, "ts": time.time()}),
        )
        info.wait_for_publish(timeout=3)
    except Exception as e:
        note(f"{ts()} [!] send failed: {e}")
        return
    # THE WINDOW OPENS. rc 0 and a returned wait_for_publish prove the SOCKET took the bytes, not that
    # the broker kept them; only the line coming back on our own subscription settles that.
    PENDING_WRITE = (mid, topic, time.time())
    if WITNESS_TIMER:
        WITNESS_TIMER.cancel()
    WITNESS_TIMER = threading.Timer(WITNESS_S, report_witness)
    WITNESS_TIMER.daemon = True
    WITNESS_TIMER.start()
    note(f"{ts()} {BLUE}{SELF}{RESET}: {text} {DIM}\u2192 {topic}{RESET}")


def cmd_depth():
    n, rows, scroll, unread = depth()
    note(
        f"{ts()} buffer: {n} message(s) / {rows} row(s), cap {HISTORY_CAP} "
        f"({HISTORY_ENV}, /history <n>), window {'live' if scroll == 0 else f'{scroll} deep'}, "
        f"unread-while-scrolled {unread}, md={'on' if MD else 'off'}"
    )


def cmd_grep(arg):
    got = grep_rows(arg)
    if isinstance(got, list):        # empty needle
        note(f"{ts()} usage: /grep <text>")
        return
    hits, total, _ = got
    if not hits:
        note(f"{ts()} /grep {arg!r}: no match in {total} row(s) — that text never arrived here")
        return
    note(f"{ts()} /grep {arg!r}: {len(hits)} newest match(es) of {total} row(s) — /show <row> jumps")
    for row, snippet in hits:
        note(f"    {DIM}{row:>5}{RESET}  {highlight_mentions(snippet)}")


def submit(line):
    global HISTORY_CAP, MD
    if not line.startswith("/"):
        go_live()          # you never answer a line you cannot see
        text_send(line)
        return None
    cmd, _, arg = line[1:].partition(" ")
    cmd = cmd.strip().lower()
    arg = arg.strip()
    if cmd == "connect":
        host, port = HOST, PORT
        if arg:
            if re.fullmatch(r"\d+", arg):
                port = int(arg)
            elif re.fullmatch(r"[^:]+:\d+", arg):
                host, port = arg.rsplit(":", 1)
                port = int(port)
            else:
                host = arg
        do_connect(host, port)
    elif cmd == "join":
        do_join(arg)
    elif cmd == "names":
        cmd_names()
    elif cmd == "clear":
        # submit() partitions on the first space, so the two-word form arrives as cmd="clear"
        # arg="screen". A bare /clear stays the destructive one; /clear screen is the non-destructive
        # one chat_cli.py's "erase the chat lines on screen (keeps the room)" promise moved here.
        if arg in ("screen", "view"):
            CLEAR_KEEP.set()
        else:
            CLEAR.set()
    elif cmd in ("up", "pageup"):
        rows = int(arg) if arg.isdigit() else max(_HEIGHT - 2, 1)
        scroll, total = set_scroll(rows)
        note(f"{ts()} ▲ window at row {max(0, total - scroll - 1)} of {total}")
    elif cmd in ("down", "pagedown"):
        rows = int(arg) if arg.isdigit() else max(_HEIGHT - 2, 1)
        scroll, total = set_scroll(-rows)
        note(f"{ts()} {'live' if scroll == 0 else f'▼ {scroll} deep'} of {total}")
    elif cmd == "top":
        scroll = go_top()
        note(f"{ts()} at the oldest line in the buffer ({scroll} deep)")
    elif cmd in ("live", "back", "end", "bottom"):
        go_live()
        note(f"{ts()} live")
    elif cmd == "depth":
        cmd_depth()
    elif cmd == "history":
        if not arg:
            cmd_depth()
        elif arg.isdigit() and int(arg) > 0:
            HISTORY_CAP = int(arg)
            with _HIST:
                _cap_locked()
            note(f"{ts()} buffer cap = {HISTORY_CAP} message(s) (older ones past it are gone)")
        else:
            note(f"{ts()} usage: /history <positive integer>")
    elif cmd == "md":
        MD = not MD
        with _HIST:
            for i in range(len(MATRIX)):
                MATRIX[i] = []      # force a re-wrap through the new pass
        note(f"{ts()} markdown-lite {'on' if MD else 'off'}")
    elif cmd == "grep":
        cmd_grep(arg)
    elif cmd == "show":
        if not arg.isdigit():
            note(f"{ts()} usage: /show <row>   (row numbers come from /grep)")
        elif not jump_to_row(int(arg)):
            note(f"{ts()} [!] no rows in the buffer")
    elif cmd == "fill":
        # A deterministic way to put known text in the buffer, for testing the scrollback (and for
        # answering "how far back can I actually see?" without waiting a day for the room to fill).
        # It publishes NOTHING: these lines exist only on this screen.
        count = int(arg) if arg.isdigit() else 300
        count = max(1, min(count, 5000))
        for i in range(count):
            note(f"{ts()} {BLUE}fill{RESET}: scrollback test line {i + 1} of {count}")
        note(f"{ts()} filled {count} line(s) — PgUp to read them, /depth for the real numbers")
    elif cmd in ("help", "?"):
        for entry in HELP:
            note(entry)
    elif cmd in ("quit", "exit", "end-session"):
        return "quit"
    else:
        note(f"{ts()} [!] unknown command /{cmd} — /help")
    return None


def cmd_names():
    if not ROOM:
        note(f"{ts()} [!] not in a room yet — /join <room>")
        return
    rows = []
    for nick in sorted(ONLINE, key=lambda n: (peer_state_for(n) != "online", n)):
        st = peer_state_for(nick)
        # the age column says HOW it was arrived at: a stamp ahead of this clock prints its skew, not a
        # clamped "0s" that reads as "just now" to whoever is staffing lanes off this screen
        age = peer_age(ONLINE.get(nick), time.time())
        mark = "*" if st == "online" else "?" if st == "stale" else "-"
        rows.append(f"{mark} {BLUE}{nick}{RESET} {st} {age}")
    note(
        f"{ts()} {len(rows) + 1} in {TOPIC}: {BLUE}{SELF}{RESET} online, "
        + (", ".join(rows) if rows else "no other peer reported")
    )
    # This is a board of BEATS. The empty case used to read as an empty room, and a
    # coordinator acted on it, so the surface now says what it measured every time it answers.
    note(f"{ts()}   {PEERS_INSTRUMENT}")
    if not rows:
        note(
            f"{ts()}   no other beat heard HERE since this client joined {TOPIC} — that is a fact about "
            f"this subscription, not a statement that the room is empty"
        )
    if ACKS:
        note(
            f"{ts()}   {len(ACKS)} receipt(s) on {CTL}; newest: "
            f"{ACKS[-1][2]} received {ACKS[-1][1]}"
        )
    elif CTL:
        note(f"{ts()}   no delivery receipts yet on {CTL}")


def quit_clean():
    leave_quiet()
    note(f"{ts()} offline — bye, {BLUE}{SELF}{RESET}")
    time.sleep(0.15)


# --- input (raw mode) ---------------------------------------------------------

def touch():
    global LAST_BYTE
    LAST_BYTE = time.monotonic()


def esc_args(fd):
    """Read the tail of an escape sequence, return the final byte and any intervening bytes."""
    args = bytearray()
    final = None
    for _ in range(16):
        try:
            c = os.read(fd, 1)
        except (BlockingIOError, OSError):
            break
        if not c:
            break
        b = c[0]
        if 0x40 <= b <= 0x7E:
            final = b
            break
        args.append(b)
    return final, args


def read_esc(fd):
    """A sequence began. Decide what it was, and act. Returns 'quit'/'send'/None like pump_key."""
    global _SCROLL
    try:
        first = os.read(fd, 1)
    except (BlockingIOError, OSError):
        return None
    if not first:
        return None
    b = first[0]
    if b == ord("["):
        final, args = esc_args(fd)
        if final is None:
            return None
        if final == ord("~"):                       # xterm function keys: 1~/7~ Home, 5~ PgUp, 6~ PgDn, 4~/8~ End
            num = args.decode("ascii", "replace").rstrip(";")
            if num == "5":
                set_scroll(max(_HEIGHT - 2, 1) // 2)
            elif num == "6":
                set_scroll(-max(_HEIGHT - 2, 1) // 2)
            elif num in ("1", "7"):
                go_top()
            elif num in ("4", "8"):
                go_live()
            return None
        if final in (ord("A"), ord("B")):           # arrow keys: one row at a time
            set_scroll(1 if final == ord("A") else -1)
            return None
        if final == ord("H"):                        # CSI H — Home in normal cursor mode
            go_top()
            return None
        if final == ord("F"):                        # CSI F — End in normal cursor mode
            go_live()
            return None
        return None
    if b == ord("O"):                               # SS3: application-cursor keys, and F1-F4
        _2, args = esc_args(fd)
        if _2 == ord("D"):                          # Home in application-cursor mode
            go_top()
        elif _2 == ord("C"):                        # End in application-cursor mode
            go_live()
        # OP..OS (F1..F4) and anything unrecognised stay inert, exactly like a lone Escape
        return None
    if b in (ord("B"), ord("F")):                   # Ctrl-B / Ctrl-F
        step = max(_HEIGHT - 2, 1)
        set_scroll(step if b == ord("B") else -step)
        return None
    if b == ord("A"):                               # Ctrl-A
        go_live()
    # Anything else (a lone Escape, an Alt chord) is deliberately inert: Escape must never look
    # like a keypress that could be mistaken for a quit or a send.
    return None


def pump_key(fd):
    b = os.read(fd, 1)
    if not b:
        return "eof"
    c = b[0]
    if c == 0x1B:
        return read_esc(fd)
    if c == 0x03:
        return "quit"
    if c in (0x01, 0x02, 0x06):                     # Ctrl-A live, Ctrl-B back, Ctrl-F forward
        step = max(_HEIGHT - 2, 1)
        if c == 0x01:
            go_live()
        else:
            set_scroll(step if c == 0x02 else -step)
        return None
    if c == 0x04:
        return "quit" if not LINE else None
    with _LINE_L:
        if c in (0x0D, 0x0A):
            if enter_is_paste(LAST_BYTE, fd, time.monotonic()):
                LINE.append(0x20)
                touch()
                return None
            return "send"
        if c in (0x7F, 0x08):
            if LINE:
                del LINE[-1]
            touch()
            return None
        if c == 0x15:
            LINE.clear()
            touch()
            return None
    if c >= 0x20:
        go_live()                                   # typing pins you to the present
        with _LINE_L:
            LINE.append(c)
        touch()
    return None


def grab_line():
    with _LINE_L:
        s = bytes(LINE).decode("utf-8", "replace")
        LINE.clear()
    return s


def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="tabichat_cli.py",
        description="tabichat — the room CLI with scrollback",
    )
    p.add_argument("room", nargs="?", default=None, help="room to join on start")
    p.add_argument("--host", default=None,
                   help="broker host for THIS run — overrides the site config and $MQTT_URL; "
                        "without it and with nothing configured, the client refuses")
    p.add_argument("--port", type=int, default=None, help="broker port (default $MQTT_PORT or 1883)")
    p.add_argument("--nick", default=None,
                   help="the roster nick to post as — the name on the sender leaf "
                        f"chat/<room>/msg/<nick>. Order: --nick, then ${NICK_ENV}, then $USER. "
                        "A nick this client cannot put on the wire is refused, never rewritten.")
    p.add_argument("--flat-send", dest="flat_send", action="store_true",
                   help="post to the flat chat/<room> topic even when a client certificate is "
                        "configured; a line written there is marked unverified, because the broker "
                        "vouches for the topic and not for the name in it")
    p.add_argument("--history", type=int, default=None, help=f"buffer cap in messages (default {HISTORY_CAP_DEFAULT}, env {HISTORY_ENV})")
    p.add_argument("--no-md", action="store_true", help="render room text verbatim, no markdown-lite")
    return p.parse_args(argv)


def main(argv=None):
    global _WIDTH, _HEIGHT, _RENDERER_RUNNING, HISTORY_CAP, MD, SELF, SELF_RAW, NICK_SOURCE
    global NICK_REFUSAL, FLAT_SEND, HOST, PORT, BROKER_ERROR, TLS_PLAN
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        print("tabichat_cli needs a real terminal (TTY)", file=sys.stderr)
        return 1
    # THE NICK IS AN OPERATOR CHOICE, AND A BROKEN ONE IS A REFUSAL. `clean()` strips characters and
    # truncates at 20, so an altered nick would aim the leaf write at a topic the ACL never granted —
    # refused here, in words, before the TUI is touched, and never quietly rewritten.
    SELF_RAW, NICK_SOURCE, NICK_REFUSAL = resolve_nick(cli=args.nick)
    if NICK_REFUSAL:
        print(f"tabichat_cli: refusing to start — {NICK_REFUSAL}", file=sys.stderr)
        return 1
    SELF = clean(SELF_RAW)
    FLAT_SEND = bool(args.flat_send)
    # "must be set" — never guessed: --host for this run, or the site file, or the env. Nothing
    # configured is a REFUSAL with an exit code, printed before the TUI is touched — a client that
    # starts silent and then cannot connect is the mystery refusal a customer would read
    # as a broken product.
    if args.host or args.port:
        try:
            HOST, PORT, _ = resolve_broker(cli_host=args.host, cli_port=args.port)
            BROKER_ERROR = ""
        except BrokerError as exc:
            print(f"tabichat_cli: {exc}", file=sys.stderr)
            return 1
        # The transport follows the address the operator TYPED for this run, or it refuses. A
        # --host that is not the configured broker does not inherit its pinned CA or its client
        # certificate, and it does not silently drop to plaintext either.
        plan, why = plan_transport(HOST, PORT, TLS_PLAN)
        if why:
            print(f"tabichat_cli: {why}", file=sys.stderr)
            return 1
        if plan is not None:
            TLS_PLAN = plan
    elif BROKER_ERROR:
        print(f"tabichat_cli: {BROKER_ERROR}", file=sys.stderr)
        return 1
    # A configured TLS broker is proven at start, before the TUI is touched: an unreadable CA path
    # or a key that will not pair with its certificate is a refusal here, in words, not a failed
    # socket later that reads like a network fault. (transport_kwargs already refused to build a
    # plan at all if the TLS variables were missing or half-set — BROKER_ERROR carries that text.)
    if TLS_PLAN is not None and TLS_PLAN["tls"]:
        try:
            build_ssl_context(TLS_PLAN)
        except (TransportBlocked, TransportRefusal) as exc:
            print(f"tabichat_cli: refusing to start — {exc}", file=sys.stderr)
            return 1
    if args.history:
        HISTORY_CAP = cap_from_env(args.history, HISTORY_CAP_DEFAULT)
    if args.no_md:
        MD = False

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)

    size = shutil.get_terminal_size((80, 24))
    _WIDTH = max(size.columns - 1, 20)
    _HEIGHT = size.lines

    if args.room:
        do_join(args.room)

    tty.setraw(fd)

    def _sig(signum, frame):
        raise QuitSignal()

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGHUP, _sig)

    threading.Thread(target=renderer, daemon=True).start()

    for entry in [
        f"you are {BLUE}{SELF}{RESET} (nick from {NICK_SOURCE}) — tabichat (scrollback client)",
        f"buffer: {HISTORY_CAP} messages ({HISTORY_ENV}, /history <n>) — PgUp scrolls",
        "",
    ] + HELP:
        note(entry)
    time.sleep(0.15)

    try:
        while True:
            action = pump_key(fd)
            if action in ("quit", "eof"):
                quit_clean()
                break
            if action == "send":
                line = grab_line().strip()
                if line and submit(line) == "quit":
                    quit_clean()
                    break
    except QuitSignal:
        quit_clean()
    finally:
        _RENDERER_RUNNING = False
        time.sleep(0.15)
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write("\r\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
