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

# ONE FIELD, TWO UNITS, AND THE NUMBER THAT TELLS THEM APART. `ts` on a presence beat is
# milliseconds from the extension (`Date.now()`) and, before this face, epoch-seconds from the CLI
# (`time.time()`) — so an ms beat read against a seconds clock is ~56 years in the future, which every
# consumer here already classifies as "a stamp that cannot be ranked": the CLI printed `stale` forever
# and reprinted `joined` on every beat, and the seconds stamp never outranked an ms record, so a CLI
# user could not show online to a seat and could not clear their own record on exit.
#
# 1e11 seconds is 5138-11-20. No clock in this fleet will print that as epoch-seconds this millennium,
# and today's ms stamps are ~1.8e12, so a value at or above the ceiling cannot be a seconds clock and
# is read as milliseconds. Below it, seconds. The threshold is a UNIT test, not a clock correction, and
# it is stated where it bit for the same reason the guard below is: a number that quietly becomes
# another number is how a liveness board starts lying.
MS_CEILING_S = 1e11


def norm_ts(ts):
    """One unit for every reading of a presence stamp: seconds.

    This is the single shared reading face. Ranking, state and age all come through here, so no call
    site can forget and compare a raw stamp against its own clock — which is how the two units were
    allowed to meet in the first place. Canonical on the wire is MILLISECONDS (see docs/wire-format.md);
    this normalizes what cannot be milliseconds, and leaves everything else exactly as it arrived.
    """
    try:
        v = float(ts)
    except (TypeError, ValueError):
        return 0.0
    if v <= 0:
        return 0.0
    return v / 1000.0 if v >= MS_CEILING_S else v


def _is_ms_stamp(ts):
    """True when a raw stamp arrived in the canonical unit and this face read it down to seconds."""
    try:
        return float(ts) >= MS_CEILING_S
    except (TypeError, ValueError):
        return False


def peer_record_wins(prev, incoming):
    """True when `incoming` (status, ts) may replace `prev` (status, ts) or None.

    ts <= 0 means "no stamp". Both sides go through `norm_ts` first: ranking across units is what made
    a CLI seconds stamp lose forever to an extension ms record, and a last-will that loses is a peer
    who cannot clear their own row.
    """
    if prev is None:
        return True
    _, prev_ts = prev
    _, inc_ts = incoming
    prev_ts, inc_ts = norm_ts(prev_ts), norm_ts(inc_ts)
    if inc_ts <= 0:
        return prev_ts <= 0
    return inc_ts >= prev_ts


def peer_state(seen, now_epoch, stale_s=STALE_S):
    """online, stale (quiet too long, or nothing to go on) or offline.

    The stamp is the PEER'S clock and the age is taken against OURS, so a record stamped more than
    one whole allowance ahead of us cannot be timed at all — it is a clock we cannot trust, not a
    beat we can rank. It used to read online here (and on the roommsg.ts face) for as long as the
    skew kept the age negative, which is how a seat whose process was gone stayed live on a liveness
    board. It reads `stale` now: heard something, cannot rank it.
    """
    if not seen:
        return "offline"
    status, at = seen
    if status == "offline":
        return "offline"
    at = norm_ts(at)
    if at <= 0:
        return "stale"
    age = now_epoch - at
    if age < -stale_s:
        # KEPT, on purpose. A stamp that is still impossible to rank after the unit is normalized is a
        # clock that cannot be trusted, not a beat: eating this branch would stop the operator's spam
        # by making the board claim liveness it did not measure, which is a weakening of the guard the
        # 1146 class exists to hold. `test_presence.py` carries the plant that proves it still fires.
        return "stale"
    return "stale" if age > stale_s else "online"


# The line a peers surface must carry, word-for-word with the roommsg.ts face: what was measured, and
# what the reading therefore cannot say. A board of beats is not a process check.
PEERS_INSTRUMENT = (
    "measured: the last presence beat THIS seat heard per nick on this room's presence topic, "
    "ranked against THIS seat's clock; a beat is not a process check, so `stale` here never means gone"
)


def peer_age(seen, now_epoch):
    """How one row was arrived at. Never an age invented from a stamp that cannot be ranked.

    When a beat arrived in the canonical milliseconds unit, the row SAYS SO: the normalization is a
    reading decision, and a board that silently converted a peer's stamp leaves the next reader unable
    to tell a converted row from a native one.
    """
    if not seen:
        return "no record"
    _status, at = seen
    if norm_ts(at) <= 0:
        return "no stamp"
    from_ms = _is_ms_stamp(at)
    age = now_epoch - norm_ts(at)
    unit = " [ms stamp, read as ms]" if from_ms else ""
    if age < 0:
        return f"ahead {int(-age)}s{unit}"
    return f"{int(age)}s{unit}"
