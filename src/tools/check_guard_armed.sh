#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Is the secret guard on the path git will consult in THIS clone? One line, and non-zero when not.
#
# WHY THIS EXISTS. `git config core.hooksPath <path>` replaces the entire hook set git consults and
# says nothing while doing it, so the documented way to enable the guard is also a way to displace it
# — or to never enable it at all. A hook cannot report its own absence: in a displaced clone the guard
# is simply not run, so only something outside the hook can say so. This is that thing, and it
# answers BEFORE a commit exists rather than while one is being refused.
#
# It asks git where the consulted hook lives (`git rev-parse --git-path hooks/pre-commit`, which
# honours core.hooksPath at every level) instead of comparing against a remembered directory, and it
# accepts two armings: this clone's own .githooks/pre-commit, or a hook set that invokes it. Since
# leg 782 it answers about the WHOLE consulted set in the first arming: when an executable prior hook
# sits at the legacy $(git-dir)/hooks/pre-commit — displaced by that same hooksPath value — it names
# the prior path, and refuses if the guard in this clone does not chain it.
set -u

top=$(git rev-parse --show-toplevel 2>/dev/null) || {
    printf 'guard-armed: NOT ARMED — not inside a git work tree, so there is no clone to check.\n' >&2
    exit 1
}
guard="$top/.githooks/pre-commit"
[ -f "$guard" ] || {
    printf 'guard-armed: NOT ARMED — this work tree has no .githooks/pre-commit (%s).\n' "$guard" >&2
    exit 1
}

consulted=$(git rev-parse --git-path hooks/pre-commit 2>/dev/null) || {
    printf 'guard-armed: NOT ARMED — git would not name the hook path to consult.\n' >&2
    exit 1
}
# git prints that path RELATIVE TO THE CURRENT DIRECTORY, and a deploy runs gates from src/, so an
# unqualified value is joined to $PWD — never to the top, which would look at a path that does not
# exist and call a healthy clone unarmed.
case "$consulted" in
    /*) ;;
    *)  consulted="$PWD/$consulted" ;;
esac

# real paths on both sides, so a symlink or another spelling cannot quietly read as a match
real() { CDPATH= cd -- "$(dirname -- "$1")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename -- "$1")"; }
guard_real=$(real "$guard")
cons_real=$(real "$consulted")
[ -n "$cons_real" ] || {
    printf 'guard-armed: NOT ARMED — the consulted hook path (%s) sits in a directory that cannot be read.\n' "$consulted" >&2
    exit 1
}

if [ ! -f "$cons_real" ]; then
    printf 'guard-armed: NOT ARMED — git consults %s, which does not exist. Arm it:\n' "$cons_real" >&2
    printf 'guard-armed:   sh src/tools/enable_hook_chain.sh        (chains any host hook set instead of replacing it)\n' >&2
    printf 'guard-armed:   git config --local core.hooksPath .githooks   (correct ONLY where no global or system core.hooksPath is set — iid 15)\n' >&2
    exit 1
fi
if [ "$cons_real" = "$guard_real" ]; then
    # Second armed state (iid 16 req 2/4, leg 782): the documented enable also hides whatever lived
    # at the legacy $(git-dir)/hooks/pre-commit, because hooksPath replaces the consulted set. Answer
    # about the WHOLE set, not only the guard: name a prior hook that exists, and refuse when the
    # guard in this clone does not chain it (the b5648722 face — ARMED there was an answer about the
    # wrong thing while a user's own hook was being displaced under it).
    gitdir=$(git rev-parse --git-dir 2>/dev/null)
    prior=""
    [ -n "$gitdir" ] && prior=$( cd "$gitdir" 2>/dev/null && printf '%s/hooks/pre-commit' "$(pwd -P)" ) || true
    if [ -n "$prior" ] && [ -x "$prior" ]; then
        # code lines only, the same convention the hook and harness use: prose is not a dependency
        if grep -v '^[[:space:]]*#' "$guard_real" 2>/dev/null | grep -qsF '/hooks/pre-commit'; then
            printf 'guard-armed: ARMED — git consults this clone at %s; a prior hook exists at %s and the guard chains it and propagates its status.\n' "$cons_real" "$prior"
            exit 0
        fi
        printf 'guard-armed: NOT ARMED — git consults the guard at %s, but that guard does not chain the prior hook at %s: core.hooksPath displaced it and it never runs. Update the guard, or remove the prior hook if it is no longer wanted.\n' "$cons_real" "$prior" >&2
        exit 1
    fi
    printf 'guard-armed: ARMED — git consults this clone at %s\n' "$cons_real"
    exit 0
fi
# a deliberate chain: the consulted hook must invoke the guard on a CODE line, not merely mention it
if grep -v '^[[:space:]]*#' "$cons_real" 2>/dev/null | grep -qs '\.githooks/pre-commit'; then
    printf 'guard-armed: ARMED (chained) — git consults %s, which invokes %s\n' "$cons_real" "$guard_real"
    exit 0
fi
printf 'guard-armed: NOT ARMED — git consults %s, which does not invoke %s. The guard will not run on an ordinary commit in this clone.\n' "$cons_real" "$guard_real" >&2
printf 'guard-armed:   to arm it without displacing that hook set:   sh src/tools/enable_hook_chain.sh\n' >&2
printf 'guard-armed:   to arm it the plain way (only if no global or system core.hooksPath exists):   git config --local core.hooksPath .githooks\n' >&2
printf 'guard-armed:   to keep both: make that hook set invoke .githooks/pre-commit and return its exit status.\n' >&2
printf 'guard-armed:   a host guard is a HOOK SET, not one file: core.hooksPath replaces every name at once, so pointing it here stops a global commit-msg, pre-push, or prepare-commit-msg too — iid 15.\n' >&2
exit 1
