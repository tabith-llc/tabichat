# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Presence-record precedence (P5), mirrored from extensions/tabichat/roommsg.ts.

The broker hands a NEW subscriber the retained presence records it holds. Those
include records left by older senders on the shared chat/<room>/presence topic,
which carry no timestamp at all. If such an unscored record is allowed to
overwrite a fresh, stamped per-nick record, a live peer is marked gone in the
same second it is announced — which is how "/names shows only me" came to look
like "/names shows only me, and everyone else just left".

So: an unstamped record never outranks a stamped one, and among stamped records
the newer one wins. An unstamped record on its own reads as "no idea about
liveness", which is reported as stale rather than as present.
"""

# How long a peer may stay quiet and still count as present.
STALE_S = 90.0


def peer_record_wins(prev, incoming):
    """True when `incoming` (status, ts) may replace `prev` (status, ts) or None.

    ts <= 0 means "no stamp".
    """
    if prev is None:
        return True
    _, prev_ts = prev
    _, inc_ts = incoming
    if inc_ts <= 0:
        return prev_ts <= 0
    return inc_ts >= prev_ts


def peer_state(seen, now_epoch, stale_s=STALE_S):
    """online, stale (quiet too long, or nothing to go on) or offline.

    The stamp is the PEER'S clock and the age is taken against OURS, so a record stamped more than
    one whole allowance ahead of us cannot be timed at all — it is a clock we cannot trust, not a
    beat we can rank. It used to read online here (and on the roommsg.ts face) for as long as the
    skew kept the age negative, which is how a seat whose process was gone stayed live on a liveness
    board. It reads `stale` now: heard something, cannot rank it (R-2717 item 3).
    """
    if not seen:
        return "offline"
    status, at = seen
    if status == "offline":
        return "offline"
    if at <= 0:
        return "stale"
    age = now_epoch - at
    if age < -stale_s:
        return "stale"
    return "stale" if age > stale_s else "online"


# The line a peers surface must carry, word-for-word with the roommsg.ts face: what was measured, and
# what the reading therefore cannot say. A board of beats is not a process check.
PEERS_INSTRUMENT = (
    "measured: the last presence beat THIS seat heard per nick on this room's presence topic, "
    "ranked against THIS seat's clock; a beat is not a process check, so `stale` here never means gone"
)


def peer_age(seen, now_epoch):
    """How one row was arrived at. Never an age invented from a stamp that cannot be ranked."""
    if not seen:
        return "no record"
    _status, at = seen
    if at <= 0:
        return "no stamp"
    age = now_epoch - at
    if age < 0:
        return f"ahead {int(-age)}s"
    return f"{int(age)}s"
