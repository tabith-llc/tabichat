#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Enable this repo's secret guard WITHOUT displacing a hook set the host already consults.
#
# WHY THIS EXISTS (tabichat iid 15). The tracked header used to tell every reader to run
#
#     git config core.hooksPath .githooks
#
# and `core.hooksPath` is SINGLE-VALUED: one local value replaces the global and system ones for
# EVERY hook name. On a host whose global points at a guard directory — the fleet keeps its
# commit-identity check there — following the shipped line silently stopped every hook that
# directory provided. No error, no changed exit code, commits kept landing: nine clones on one box
# were in exactly that state and only a deliberate census found them. So the defect was never the
# guard's behaviour, it was the INSTRUCTION. An instruction is a shipped artifact, so it gets a
# shipped instrument: this file is what the header tells you to run now.
#
# WHAT IT DOES, in one sentence: it never replaces a hook set, it FORWARDS to it. Where an incumbent
# `core.hooksPath` exists at global or system scope and holds a runnable hook, this writes a
# per-clone chain directory INSIDE $(git-dir) — one small wrapper per hook name, each running the
# incumbent's hook first and this repo's tracked hook after, and the first refusal wins — then points
# LOCAL `core.hooksPath` at that generated directory. That is the shape this fleet already runs —
# identity check, then exec the repo's own guard, then return its status — generated per clone
# instead of per host. It stays site-agnostic: nothing here names a
# directory, it reads the one git already consults out of the config and forwards to it.
#
# WHAT IT NEVER DOES.
#   - It never writes into the incumbent directory. That is someone else's tree — host-owned, and in
#     the fleet's case a guard with its own rules. The wrappers live in THIS clone's git dir.
#   - It never lowers coverage. Every hook name in the union of (incumbent set, this repo's .githooks)
#     gets a wrapper, so a name that would otherwise vanish is forwarded rather than dropped. A review
#     found the first draft of this file forwarding pre-commit only, which is the same defect wearing
#     a smaller hat: a host `commit-msg` check behind a chain that names one hook is still disabled.
#   - It never re-aims a hooksPath that already reaches this guard. If the consulted hook invokes
#     .githooks/pre-commit on a CODE line — prose is not a dependency, the convention the guard and
#     the arm check both use — it says so and writes nothing at all.
#   - It never edits a global or system config, and never guesses a value: only `--local`, and a value
#     that resolves nowhere is a refusal, not something to overwrite quietly.
#   - It never arms a guard that cannot run: no work tree, no tracked .githooks/pre-commit, an
#     incumbent directory holding nothing executable, or a read-back that disagrees are all refusals.
#
# Exit: 0 armed or already armed, 1 refused (with the reason on stderr), 2 bad usage.
set -u

CHAIN_SUBDIR="tabichat-hooks"
# Every name git can consult, so a chain that forwards one name never silently drops another.
HOOKNAMES="applypatch-msg pre-merge-commit pre-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push fsmonitor-watchman post-rewrite sendemail-validate"

die()   { printf 'hook-chain: REFUSED — %s\n' "$1" >&2; exit 1; }
say()   { printf 'hook-chain: %s\n' "$1" >&2; }
usage() { printf 'usage: sh src/tools/enable_hook_chain.sh [--check]\n' >&2; exit 2; }

check_only=0
for a in "$@"; do
    case "$a" in
        --check) check_only=1 ;;
        *) usage ;;
    esac
done

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git work tree, so there is no clone to arm."
gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || die "git would not name this clone's git directory."
guard="$top/.githooks"
[ -f "$guard/pre-commit" ] || die "this work tree has no .githooks/pre-commit to enable ($guard/pre-commit)."
[ -x "$guard/pre-commit" ] || die ".githooks/pre-commit is not executable, so git would never run it — chmod it (or fix the checkout) rather than arming a hook that cannot fire."

# --- the incumbent, read from the CONFIG at every scope, never remembered from a document --------
# Scope is the whole question here: a LOCAL value is ours to write, a GLOBAL or SYSTEM one belongs to
# whatever guard the host installed, and a local value beats both for every hook name at once.
local_hp=$(git config --local --get core.hooksPath 2>/dev/null || true)
global_hp=$(git config --global --get core.hooksPath 2>/dev/null || true)
system_hp=$(git config --system --get core.hooksPath 2>/dev/null || true)

resolve_dir() { # <value> -> absolute directory, or empty when it does not resolve
    case "$1" in
        '') return 0 ;;
    esac
    case "$1" in
        /*) printf '%s' "$1" ;;
        *)  ( cd "$top/$1" 2>/dev/null && pwd -P ) || true ;;
    esac
}

# Does the hook set in <dir> reach this repo's guard on a code line?
chains_guard() {
    [ -n "$1" ] && [ -f "$1/pre-commit" ] || return 1
    grep -v '^[[:space:]]*#' "$1/pre-commit" 2>/dev/null | grep -qs '\.githooks/pre-commit'
}

# Does <dir> hold any runnable hook at all? An incumbent naming an empty directory displaces nothing,
# and arming a chain over it would be ceremony.
holds_hook() {
    [ -d "$1" ] || return 1
    for h in "$1"/*; do
        [ -f "$h" ] && [ -x "$h" ] || continue
        return 0
    done
    return 1
}

# ---- state 1: this clone is armed, and whatever is consulted reaches the guard -----------------
if [ -n "$local_hp" ]; then
    ldir=$(resolve_dir "$local_hp")
    if [ "$local_hp" = ".githooks" ] || chains_guard "$ldir"; then
        say "ALREADY ARMED — core.hooksPath is \"$local_hp\" (local) and that hook set invokes this repo's guard."
        say "  nothing was written. Read it back any time with:  sh src/tools/check_guard_armed.sh"
        exit 0
    fi
fi

# ---- state 2: an incumbent at global or system scope (iid 15's trap) ---------------------------
incumbent=""; incumbent_scope=""
if [ -n "$global_hp" ]; then incumbent="$global_hp"; incumbent_scope="global"
elif [ -n "$system_hp" ]; then incumbent="$system_hp"; incumbent_scope="system"
fi

if [ -n "$incumbent" ]; then
    inc_dir=$(resolve_dir "$incumbent")
    if chains_guard "$inc_dir"; then
        say "ALREADY ARMED — the $incumbent_scope set at $inc_dir invokes this repo's guard. Nothing was written."
        say "  read it back any time with:  sh src/tools/check_guard_armed.sh"
        exit 0
    fi
    if [ -z "$inc_dir" ] || [ ! -d "$inc_dir" ]; then
        die "the $incumbent_scope core.hooksPath is \"$incumbent\", which does not resolve to a directory, so there is nothing to forward to. That value is broken on its own terms; it will not be overwritten from here."
    fi
    if ! holds_hook "$inc_dir"; then
        say "the $incumbent_scope value \"$incumbent\" resolves to $inc_dir, which holds NO executable hook — so nothing host-side is in place to displace here, and no chain is needed."
        incumbent=""; incumbent_scope=""
    fi
fi

# ---- state 3: nothing host-side to displace → the documented plain value -----------------------
# This is the branch the iid 15 fix must NOT break: on a clean host the one-liner was always correct,
# and saying so beats making everyone build a chain over nothing.
if [ -z "$incumbent" ]; then
    if [ -n "$local_hp" ] && [ "$local_hp" != ".githooks" ]; then
        die "this clone already carries a LOCAL core.hooksPath \"$local_hp\" that does not invoke this guard, and it resolves to nothing runnable. It will not be overwritten from here: point it at .githooks, or make that hook set invoke .githooks/pre-commit and return its exit status."
    fi
    if [ "$check_only" = 1 ]; then
        say "CHECK — nothing host-side is in place to displace, so this clone would take the plain local value."
        say "CHECK — that is:  git config --local core.hooksPath .githooks"
        exit 0
    fi
    git config --local core.hooksPath .githooks || die "cannot write the local core.hooksPath."
    back=$(git config --get core.hooksPath 2>/dev/null || true)
    [ "$back" = ".githooks" ] || die "core.hooksPath reads back \"$back\", not .githooks."
    say "ARMED — no host hook set was in place to displace, so the local value is the plain one."
    printf 'hook-chain:   git config --local core.hooksPath  ->  %s\n' "$back" >&2
    printf 'hook-chain:   proof it took:  sh src/tools/check_guard_armed.sh\n' >&2
    printf 'hook-chain:   if a host guard is installed later, run this file again — it will chain it instead of leaving it shadowed.\n' >&2
    exit 0
fi

# ---- state 4: there IS a host hook set; forward to it instead of replacing it ------------------
inc_dir=$(resolve_dir "$incumbent")
chain="$gitdir/$CHAIN_SUBDIR"
[ "$chain" != "$inc_dir" ] || die "the generated chain directory would be the incumbent itself — refusing rather than forwarding to itself."
if [ "$check_only" = 1 ]; then
    say "CHECK — a $incumbent_scope core.hooksPath is \"$incumbent\" ($inc_dir), and it does not invoke this repo's guard."
    say "CHECK — following the old bare line here would DISPLACE every hook in $inc_dir, silently."
    say "CHECK — this tool would write per-clone forwarders into $chain and point LOCAL core.hooksPath at them. Run without --check to do it."
    exit 1
fi
mkdir -p "$chain" || die "cannot create the chain directory $chain."
chmod 700 "$chain" 2>/dev/null
names=""; inc_names=""
for n in $HOOKNAMES; do
    have_inc=0; have_repo=0
    [ -f "$inc_dir/$n" ] && [ -x "$inc_dir/$n" ] && { have_inc=1; inc_names="$inc_names $n"; }
    [ -f "$guard/$n" ] && [ -x "$guard/$n" ] && have_repo=1
    [ "$have_inc" = 1 ] || [ "$have_repo" = 1 ] || continue
    names="$names $n"
    w="$chain/$n"
    # The wrapper: the incumbent's hook runs FIRST (a host guard must never be blamed for a refusal
    # it did not make, and it is the check that was there before us), then this repo's tracked hook,
    # and the first refusal wins. Paths are resolved at run time from the work tree, so the chain
    # directory travels with the clone and a moved checkout cannot stale-point at an old path.
    {
        printf '#!/bin/sh\n'
        printf '# generated by enable_hook_chain.sh — forwards the %s-scope core.hooksPath set, then this repo guard.\n' "$incumbent_scope"
        printf '# Do not edit by hand; re-run src/tools/enable_hook_chain.sh. It exists so that enabling one guard never removes the other.\n'
        printf 'rc=0\n'
        if [ "$have_inc" = 1 ]; then
            printf 'p=%s\n' "$(printf '%s' "$inc_dir/$n" | sed "s/'/'\\\\''/g")"
            printf '%s\n' '[ -x "$p" ] || { printf "hook-chain: the forwarded hook is gone (%s) — refusing rather than committing unchecked.\\n" "$p" >&2; exit 1; }'
            printf '%s\n' '"$p" "$@" || rc=$?'
        fi
        if [ "$have_repo" = 1 ]; then
            printf 'top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf "hook-chain: no work tree at hook time — refusing.\\n" >&2; exit 1; }\n'
            printf 'g=%s\n' "\$top/.githooks/$n"
            printf '%s\n' '[ -x "$g" ] || { printf "hook-chain: this repo guard is missing (%s) — refusing rather than committing unchecked.\\n" "$g" >&2; exit 1; }'
            printf '%s\n' '"$g" "$@" || rc=$?'
        fi
        printf 'exit $rc\n'
    } > "$w" || die "cannot write the chain wrapper $w."
    chmod 755 "$w" || die "cannot make $w executable; git would ignore it, and a guard git never runs is a guard that passed."
done
[ -n "$inc_names" ] || die "the $incumbent_scope set at $inc_dir holds no executable hook this tool could forward — arming a chain over it would displace nothing and check nothing."
[ -n "$names" ] || die "neither $inc_dir nor this repo's .githooks holds a runnable hook — refusing rather than arming something that checks nothing."
git config --local core.hooksPath "$chain" || die "cannot write the local core.hooksPath."
back=$(git config --get core.hooksPath 2>/dev/null || true)
[ "$back" = "$chain" ] || die "core.hooksPath reads back \"$back\", not the chain directory — nothing is assumed from here."
say "ARMED BY FORWARDING — the $incumbent_scope set \"$incumbent\" ($inc_dir) still runs, and this repo's guard runs after it."
printf 'hook-chain:   wrappers written:%s\n' "$names" >&2
printf 'hook-chain:   forwarded from the host:%s\n' "${inc_names:- (none)}" >&2
printf 'hook-chain:   chain directory:  %s (inside this clone, never in the incumbent tree)\n' "$chain" >&2
printf 'hook-chain:   local value now:  git config --local core.hooksPath  ->  %s\n' "$back" >&2
printf 'hook-chain:   proof it took:    sh src/tools/check_guard_armed.sh\n' >&2
printf 'hook-chain:   the host set keeps its own voice: a refusal by it refuses the commit, and so does one by this repo.\n' >&2
exit 0
