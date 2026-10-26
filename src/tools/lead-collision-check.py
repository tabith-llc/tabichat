#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""The `lead-agent` collision self-check -- run after any deploy, restart sweep, or rename.

Why this exists: ONE string, `lead-agent`, currently means four unrelated things on this host
(see TERMS.md in the tabith workspace, not in this repo):

  1. the shipped FALLBACK LEAD NICK in the tabichat extension      ctxwarn.ts  -> LEAD_NICK
  2. the XHIGH MODEL TIER id in the tabichat-lead-model extension           index.ts    -> "lead-agent"
  3. the RETIRED launcher alias in ~/.bashrc                        pi-lead-agent
  4. a member of the VIRTUAL-MODEL WHITELIST in ~/.bashrc          _pi_tabith case labels

The available bug is a seat told to "fix the dead lead-agent nick" editing (2) or (4) instead of
(1)/(3): nothing breaks loudly, and the fleet goes silently deaf to context alarms and deaf to the
lead's steers, because the token that gates BOTH is the one that was never touched.

So this script reports all four surfaces on ONE screen -- what each file currently holds, and which
of the four it is. It is REPORT-ONLY by default, because a legitimate tier rename is supposed to
change row 2 without changing row 1; `--strict` fails if the routing surface (1) has drifted from
its documented default, which is the drift that actually costs you a fleet.

    .venv/bin/python tools/lead-collision-check.py [--strict]
"""
import glob
import os
import re
import subprocess
import sys

EXT = os.path.expanduser("~/.pi/agent/extensions")
BASHRC = os.path.expanduser("~/.bashrc")
DOCUMENTED_FALLBACK = "lead-agent"     # site-neutral default: TERMS.md, row 1

# The tabith workspace root, RESOLVED AT RUNTIME. It used to be the hardcoded montana path
# "/media/dust/dust-ext1/tabith", which is absent on idaho — read() then swallowed the OSError,
# seat_holders printed <missing> with NO drift, and --strict still exited 0: a green verdict
# from an instrument inspecting nothing. Candidates are ordered host-neutrally; both live
# faces (idaho /tabith and the montana copy) resolve, and a root that exists but yields no
# readable launcher is LOUD (see seat_holders + the drift in main).
TABITH_CANDIDATES = ("/tabith", "/media/dust/dust-ext1/tabith")


def tabith_root():
    env = os.environ.get("TABITH_ROOT")
    if env:
        # An explicitly set root is a DECLARATION: if it does not exist, that is the answer —
        # silently falling back to a candidate would hide a misconfiguration behind a green face.
        return env if os.path.isdir(env) else None
    for cand in TABITH_CANDIDATES:
        if os.path.isdir(cand):
            return cand
    return None


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def surface_routing_fallback():
    """(1) the value LEAD_NICK falls back to, and what the LIVE env says."""
    txt = read(f"{EXT}/tabichat/ctxwarn.ts")
    m = re.search(r'export const LEAD_NICK = [^\n]*', txt)
    declared = m.group(0).strip() if m else "NOT FOUND (ctxwarn.ts changed shape)"
    live = os.environ.get("MQTT_LEAD_NICK")
    return declared, live


def surface_model_tier():
    txt = read(f"{EXT}/tabichat-lead-model/index.ts")
    ids = re.findall(r'\{\s*id:\s*"([^"]+)"[^\n]*?level:\s*"([^"]+)"', txt)
    return ids or [("NOT FOUND", "?")]


def surface_bashrc():
    txt = read(BASHRC)
    alias = re.findall(r'alias\s+pi-lead-agent=[^\n]*', txt)
    whitelist = re.findall(r'^\s*lead-agent\|[^\n]*', txt, re.MULTILINE)
    leadnick = re.findall(r'^\s*export MQTT_LEAD_NICK=[^\n]*', txt, re.MULTILINE)
    return alias, whitelist, leadnick


LEAD_ROLE_SUFFIX = "/agents/lead"   # the lead seat is resolved by ROLE, never by a hardcoded
                                     # nick — a seat rename must not need an edit here (leg 539).


def seat_holders():
    """Which role dir the LEAD launcher actually boots, and the nick it sets.

    Returns (holders, root): holders is a list of (path, role_dir, nick, model) — the idaho
    face names its file `tabichat-aliases-idaho.sh` and the montana face `tabichat-aliases.sh`,
    and BOTH parse because a holder printed from a stale face is exactly the silent-stale class
    this leg exists to kill. `holders == []` means the launcher surface was NOT inspected —
    main() turns that into a named drift and a non-zero --strict exit, so 'no drift' is
    unreachable while the read failed.

    The seat is matched by ROLE (its `_tabith_seat` first argument ends in `/agents/lead`) and
    NOT by name: the launcher function name is captured, so a renamed lead seat still resolves
    (leg 539 AC). Three launcher shapes parse — the plain `name() { _tabith_seat ... }`, the
    `( export ...; _tabith_seat ... )` subshell-wrapped form the live idaho seat uses, and a
    `VAR=value _tabith_seat ...` prefix form — all kept to the header's own line so a multi-line
    function body can never reach the seat fields.
    """
    root = tabith_root()
    if not root:
        return [], None
    paths = ([f"{root}/tabichat-aliases.sh"] if os.path.isfile(f"{root}/tabichat-aliases.sh") else []) \
        + sorted(glob.glob(f"{root}/tabichat-aliases-*.sh"))
    holders = []
    for p in paths:
        for m in re.finditer(
            r'^(\w+)\(\)\s*\{[^\n]*?_tabith_seat\s+(\S+)\s+(\S+)\s+(\S+)',
            read(p), re.MULTILINE):
            fname, role_dir, nick, model = m.groups()
            if fname == "_tabith_seat":
                continue                      # the helper's own definition is not a seat
            if role_dir.endswith(LEAD_ROLE_SUFFIX):
                holders.append((p, role_dir, nick, model))
    return holders, root


def main():
    strict = "--strict" in sys.argv
    declared, live = surface_routing_fallback()
    tiers = surface_model_tier()
    alias, whitelist, leadnick = surface_bashrc()
    holders, root = seat_holders()

    print("lead-collision-check -- four surfaces, one string. Read TERMS.md first.\n")
    print(f"(1) ROUTING TOKEN  ctxwarn fallback : {declared}")
    print(f"    live env MQTT_LEAD_NICK          : {live if live else '(unset -> uses the fallback above)'}")
    print(f"    ~/.bashrc export                 : {leadnick[0].strip() if leadnick else 'MISSING'}")
    if holders:
        for path, role_dir, nick, model in holders:
            print(f"    the holder's launcher            : nick={nick} model=tabith/{model} dir={role_dir}  [{path}]")
    else:
        print("    the holder's launcher            : NOT INSPECTED (see DRIFT)")
    print(f"(2) MODEL TIER   tabichat-lead-model ids      : {tiers}")
    print(f"(3) LEGACY ALIAS pi-lead-agent (launches the old tier NAME, which still resolves)      : {alias[0].strip() if alias else 'absent (already removed)'}")
    print(f"(4) WHITELIST    _pi_tabith labels    : {len(whitelist)} line(s)")
    for ln in whitelist:
        print(f"      {ln.strip()}")

    drift = []
    if not holders:
        if root is None:
            env_root = os.environ.get("TABITH_ROOT")
            where = (f"TABITH_ROOT={env_root!r} is set but is not a directory" if env_root else
                     "no TABITH root exists (TABITH_ROOT unset, and neither /tabith nor "
                     "/media/dust/dust-ext1/tabith is a directory)")
        else:
            where = f"no readable tabichat-aliases*.sh at {root}"
        drift.append(
            "LEAD launcher unreadable at %s — instrument degraded, the holder surface was NOT "
            "inspected (fix: point TABITH_ROOT at the live workspace or restore the launcher; "
            "'no drift' must be unreachable while this read fails)" % where)
    if f'?? "{DOCUMENTED_FALLBACK}"' not in declared and DOCUMENTED_FALLBACK not in declared:
        drift.append(f"surface (1) no longer falls back to {DOCUMENTED_FALLBACK!r} -- TERMS.md is stale or routing moved")
    if not leadnick:
        drift.append("~/.bashrc sets no MQTT_LEAD_NICK export: a bare `pi --tabichat` launch routes alarms to the fallback")
    # SURFACE (2), post-rename (2026-10-09): the CANONICAL tier is `lead-xhigh` and `lead-agent`
    # survives only as a LEGACY ALIAS. Both must be present: canonical missing = the rename did not
    # land; alias missing = something still launching `tabith/lead-agent` is now bricked.
    ids = [i[0] for i in tiers]
    if "lead-xhigh" not in ids:
        drift.append("canonical tier `lead-xhigh` is ABSENT from tabichat-lead-model -- the rename did not land, or the file changed shape")
    if "lead-agent" in ids and "lead-xhigh" in ids:
        print("     (surface 2: `lead-agent` present AS THE LEGACY ALIAS, `lead-xhigh` canonical -- expected)")
    elif "lead-agent" not in ids:
        drift.append("legacy alias `lead-agent` is gone -- that is the FINAL step of the rename, and it is only safe once no launcher, alias or seat contract still names it (grep ~/.bashrc, tabichat-aliases.sh, agents/*/AGENTS.override.md)")

    print()
    for d in drift:
        print("DRIFT  " + d)
    if not drift:
        print("no drift: the four surfaces match what TERMS.md documents")
    if strict and drift:
        print("\n--strict: exiting 1 on drift")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
