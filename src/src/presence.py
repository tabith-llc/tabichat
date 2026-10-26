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
    """online, stale (quiet too long, or nothing to go on) or offline."""
    if not seen:
        return "offline"
    status, at = seen
    if status == "offline":
        return "offline"
    if at <= 0:
        return "stale"
    return "stale" if (now_epoch - at) > stale_s else "online"
