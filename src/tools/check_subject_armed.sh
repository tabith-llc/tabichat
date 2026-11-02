#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Is the subject-nickname guard on the commit-msg path git will consult in THIS clone?
# One line, and non-zero when not — the same shape as check_guard_armed.sh, asked of the other hook.
#
# WHY THIS EXISTS. The rule that a commit subject carries no nickname is years old and NO hook
# enforced it: nicked subjects reached this repo's own dev tip, because a rule with no instrument is a
# wish. The instrument is a helper on the deployed hook sets (box-global and the tabichat chain set);
# a hook cannot report its own absence, and `core.hooksPath` replaces the consulted set while saying
# nothing, so only something OUTSIDE the hook can say whether the guard is on the path. This is that
# thing, and it answers BEFORE a commit is refused rather than after one landed unchecked.
#
# It asks git where the consulted commit-msg lives (`git rev-parse --git-path hooks/commit-msg`, which
# honours core.hooksPath at every level) instead of comparing against a remembered directory, and it
# requires the guard on a CODE line of what git would run — prose is not a dependency, the same
# convention as the armed check for the secret guard.
set -u

consulted=$(git rev-parse --git-path hooks/commit-msg 2>/dev/null) || {
    printf 'subject-armed: NOT ARMED — git would not name the commit-msg path to consult.\n' >&2
    exit 1
}
case "$consulted" in
    /*) ;;
    *)  consulted="$PWD/$consulted" ;;
esac

[ -n "$consulted" ] || {
    printf 'subject-armed: NOT ARMED — git named an unreadable commit-msg path.\n' >&2
    exit 1
}
if [ ! -f "$consulted" ]; then
    printf 'subject-armed: NOT ARMED — git consults %s, which does not exist, so no subject check runs here.\n' "$consulted" >&2
    printf 'subject-armed:   arm it on this box:   git config --global core.hooksPath /tabith/githooks\n' >&2
    printf 'subject-armed:   or per venue:         git config --local  core.hooksPath /tabith/githooks-tabichat\n' >&2
    exit 1
fi
if ! grep -v '^[[:space:]]*#' "$consulted" 2>/dev/null | grep -qs 'subject-guard\.sh'; then
    printf 'subject-armed: NOT ARMED — git consults %s, which does not invoke the subject guard on a code line. A nickname in a subject would land unchecked.\n' "$consulted" >&2
    printf 'subject-armed:   make that commit-msg call the deployed helper (githooks/subject-guard.sh) and propagate its exit status.\n' >&2
    exit 1
fi
printf 'subject-armed: ARMED — git consults %s, which invokes the subject guard.\n' "$consulted"
exit 0
