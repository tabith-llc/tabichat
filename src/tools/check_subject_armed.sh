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
#
# THREE ANSWERS, and the third is what makes this a gate rather than a crew ritual. The subject guard is
# crew commit hygiene: the helper it runs sits on the deployed hook sets, which are not part of the shipped
# extension and exist only where the crew installed them. A deploy gate that demands that state refuses a
# CUSTOMER for a thing the customer was never handed, and a host with no hook set has no route that
# satisfies it. So:
#   ARMED          — the consulted commit-msg exists and calls the guard on a code line. rc 0.
#   NOT ARMED      — the guard is off the path on a host that DOES carry a hook set ABOVE this clone (a
#                    global or system value, or a per-venue hook that a value shadowed), so that set lost
#                    its commit-msg. That is the state this check was written to catch and it stays a
#                    refusal.
#   NOT APPLICABLE — the consulted commit-msg does not exist and nothing is installed above the clone, so
#                    there was never a guard here to lose. rc 0, and it names the path it asked. A clone
#                    aimed at its own .githooks is this face: that set ships with pre-commit only, and the
#                    subject guard was never part of it, so refusing there would block a customer for a
#                    guard they were never shipped.
# "cannot run" and "ran and found nothing" still never print the same way: NOT APPLICABLE is a sentence
# about a state that does not apply here, it is printed, and it is not silence.
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
# Does this host carry a hook set ABOVE this clone? The answer decides between the two refusals: a host
# that has guards and lost its commit-msg is the tamper class; a host with no set at all never had one to
# lose. Both scopes are read out of the config and out of the clone's own git directory — nothing here
# remembers a directory name:
#   * a global or system core.hooksPath — the iid 15 trap, one value replacing EVERY name at once;
#   * the legacy $(git-dir)/hooks — a per-venue guard that a hooksPath value silently shadowed.
# A LOCAL core.hooksPath is deliberately NOT treated as an incumbent. Pointing a clone at its own
# .githooks is what this repo's own header tells a customer to run, and that set carries pre-commit and no
# commit-msg: counting it here would refuse the documented arming on every host that ever followed it, and
# would re-create the very block this file was changed to lift.
set_at_level() { # <dir> -> 0 when it holds a runnable hook that is not a git sample
    [ -d "$1" ] || return 1
    for h in "$1"/*; do
        [ -f "$h" ] && [ -x "$h" ] || continue
        case "$h" in *.sample) continue ;; esac
        return 0
    done
    return 1
}
global_hp=$(git config --global --get core.hooksPath 2>/dev/null || true)
system_hp=$(git config --system --get core.hooksPath 2>/dev/null || true)
gitdir=$(git rev-parse --git-dir 2>/dev/null || true)
case "${gitdir:-}" in ''|/*) ;; *) gitdir="$PWD/$gitdir" ;; esac
incumbent=""
[ -n "$global_hp" ] && incumbent="core.hooksPath=\"$global_hp\" (global)"
[ -z "$incumbent" ] && [ -n "$system_hp" ] && incumbent="core.hooksPath=\"$system_hp\" (system)"
# A hook in the clone's own legacy hooks/ counts: that is a guard that exists and was shadowed, which is
# the displacement iid 15 was filed for.
if [ -z "$incumbent" ] && [ -n "${gitdir:-}" ]; then
    set_at_level "$gitdir/hooks" && incumbent="a hook set at $gitdir/hooks, shadowed by whatever git consults now"
fi

if [ ! -f "$consulted" ] && [ -z "$incumbent" ]; then
    printf 'subject-armed: NOT APPLICABLE — this host consults %s, which does not exist; the subject guard is crew commit hygiene and is not applicable to a customer extension deploy.\n' "$consulted"
    printf 'subject-armed:   no core.hooksPath is set at global or system scope and the hooks/ directory of this clone holds no runnable hook, so there was no guard above this clone to lose.\n'
    exit 0
fi
if [ ! -f "$consulted" ]; then
    printf 'subject-armed: NOT ARMED — git consults %s, which does not exist, so no subject check runs here.\n' "$consulted" >&2
    printf 'subject-armed:   this host does carry a hook set (%s), so an absent commit-msg here is a set that lost one name, not a host that never had one.\n' "$incumbent" >&2
    printf 'subject-armed:   arm it in THIS venue:  sh src/tools/enable_hook_chain.sh\n' >&2
    printf 'subject-armed:   That writes a per-clone chain inside the git dir of this clone and forwards to\n' >&2
    printf 'subject-armed:   whatever hook set the host already consults. Do NOT set core.hooksPath by hand:\n' >&2
    printf 'subject-armed:   a global or system value replaces EVERY hook name at once, silently, and writing\n' >&2
    printf 'subject-armed:   a global config is a host change rather than a venue change.\n' >&2
    exit 1
fi
if ! grep -v '^[[:space:]]*#' "$consulted" 2>/dev/null | grep -qs 'subject-guard\.sh'; then
    printf 'subject-armed: NOT ARMED — git consults %s, which does not invoke the subject guard on a code line. A nickname in a subject would land unchecked.\n' "$consulted" >&2
    printf 'subject-armed:   make that commit-msg call the deployed helper (githooks/subject-guard.sh) and propagate its exit status.\n' >&2
    exit 1
fi
printf 'subject-armed: ARMED — git consults %s, which invokes the subject guard.\n' "$consulted"
exit 0
