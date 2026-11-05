# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""Room addressing for the human clients: the recipient FIELD, the legacy body scan, and the seam.

Mirrored from ``extensions/tabichat/mention.ts`` — same field-first rule, same names, same
whole-token discipline — so a lane and a human cannot read one room line as addressed differently.
Pure by design (no paho, no broker), which is the only way the human side of this rule is checkable:
``python3 tools/test_addressing.py`` runs on a box where MQTT is absent.

THE RULE (broadcast means the recipient FIELD says "@all", never the body text: a message is sent to
all only when it is addressed to "@all", and a message body that includes "@all" is not broadcast):

  1. FIELD-FIRST. A room payload carrying a ``to`` field is delivered by that field alone. A token
     quoted in the prose — the all-lanes token included — decides nothing while a field is set.
     That was the reported defect on the lane side, and the human client had it identically: a line
     addressed to ``lead-agent`` that QUOTED ``@worker1`` made worker1's terminal shout "[for you]" and
     publish a receipt for a dispatch that was never for it.
  2. TEXT-FALLBACK. A payload with no field is still decided by scanning the body for this nick.
     A human typing a bare line has no tool that sets a field, so suppressing the scan would
     silently stop the human path — that is the documented limitation, not an oversight.

ONE DELIBERATE DIFFERENCE FROM THE LANE EXTENSION, stated rather than hidden: for a LANE, a field
naming the room means "inject", because a broadcast is a dispatch. For a human client there is no
injection — every room line prints — so the field only drives the "[for you]" nudge and the
receipt, and a broadcast field does NOT make the human's nick ack every room-wide notice. That is
today's behavior exactly (the clients never matched a body ``@all`` either), and changing it would
put receipts from the human's own nick on the board for traffic he never answered. If a broadcast
should nudge the human, that is a one-line change here and a separate decision.

Why tokens and not substrings: the original check was ``"@all" in text``, so "@allen" and "@allow"
woke the whole room and "@worker10" woke "@worker1". A NAME character is what a room nick can hold —
letters, digits, "_" and "-" — so "@lead-agent" is one token and "@lead" does not match inside it.
"." is deliberately NOT a name character: both clients strip "." from nicks, and leaving it out
keeps a sentence-final "@all." a valid mention.
"""

import re

# The recipient-field value that means "every lane in the room". Lanes inject on it; see the
# difference for a human client in the note above.
ALL_LANES = "all"

# Characters a room nick may hold. One string, so the two guards below cannot drift apart.
NAME_CHARS = "a-z0-9_-"

_NOT_NAME = re.compile(f"[^{NAME_CHARS}]+")


def address_tokens(to):
    """A recipient field split into whole lower-case name tokens.

    A field is a short list of nicks, not prose, so splitting on anything that is not a NAME
    character IS the whole-token rule: "lead-agent" -> ["lead-agent"], "@all" -> ["all"],
    "worker1, worker2" -> ["worker1", "worker2"], and "worker10" is one token that is not "worker1".
    """
    if not isinstance(to, str):
        return []
    return [t for t in _NOT_NAME.split(to.lower()) if t]


def recipient_field(to):
    """Normalize what the sender passed into the value that goes on the wire, "" when nobody was named.

    A leading "@" is dropped, so ``@all`` and ``all`` are one address. A field holding no name token
    at all ("", "   ", "@", "!!!") is treated as NO field: an address that names nobody must not
    silence the line by deciding alone, because that is how a dispatch is lost with no trace.
    """
    if not isinstance(to, str):
        return ""
    cleaned = to.strip().lstrip("@").strip()
    return cleaned if address_tokens(cleaned) else ""


def addressed_to(to, nick):
    """True when the recipient FIELD names `nick`. Never reads the body.

    A room-wide field names every LANE; here it does not name the human (see the module note), so
    this asks for this nick alone. `broadcast_field` is the other half, kept separate so the
    difference is a named thing and not an accident of one boolean.
    """
    return (nick or "").lower() in address_tokens(to)


def broadcast_field(to):
    """True when the recipient FIELD declares a room-wide broadcast."""
    return ALL_LANES in address_tokens(to)


def mentions_self(text, nick):
    """LEGACY PATH — the whole-body scan for this nick, kept for fieldless senders only.

    Whole-token: a name character before or after the token means it is a different token, or an
    e-mail address, not a mention. This is the scan the clients have always run, and it makes no
    room-wide case at all — a body "@all" never addressed a human, and still does not.
    """
    if not text or not nick:
        return False
    pat = f"(?<![{NAME_CHARS}])@{re.escape(nick.lower())}(?![{NAME_CHARS}])"
    return bool(re.search(pat, text.lower()))


def receives(to, text, nick):
    """THE ONE DECISION a human client acts on: field when there is one, body only when there is not.

    It drives BOTH the "[for you]" nudge and the receipt, so one dispatch can only ever produce a
    nudge from the seat it addresses — the quoted-prose shout is the defect this replaces.
    """
    field = recipient_field(to)
    if field:
        return addressed_to(field, nick)
    return mentions_self(text, nick)
