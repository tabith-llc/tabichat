#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for the commit-subject nickname guard. Run: sh src/tools/test_subject_guard.sh
#
# WHY THIS EXISTS. The rule against a nickname in a commit subject is older than this repo, and NO hook
# anywhere enforced it — nicked subjects reached this repo's own dev tip, and the split-brain over
# `core.hooksPath` meant the venues on the box-global hook set ran no commit-msg check at all. The
# instrument is now a helper on the hook sets; a check that cannot tell a working guard from a guard
# that quietly stopped existing is the failure this file exists to prevent, so the rule is the one
# test_secret_guard.sh already lives by: **"cannot run" and "ran and found nothing" never print the
# same way**, and every refusal is paired with the pass beside it.
#
# WHAT IT EXERCISES, and how it finds it. It does NOT compare against a remembered directory. It
# asks git where the consulted commit-msg lives (`git rev-parse --git-path hooks/commit-msg`) and
# requires the guard named on a code line there — prose is not a dependency. If the consulted hook is
# armed, the cells below drive REAL commits in a throwaway clone so a "refused" is a real rc, not a
# grep. If the clone is not armed, the harness says so loudly and exits non-zero: it never calls an
# unarmed box green.
#
# NO real secret and no live venue is touched. Cells run in a throwaway `git init` under $TMPDIR with
# the same identity every commit on this fleet carries.
set -u

failed=0
ran=0
LAST=""
RC=0

ok()  { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad() { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
say() { printf '\n== %s ==\n' "$1"; }

consulted=$(git rev-parse --git-path hooks/commit-msg 2>/dev/null)
case "$consulted" in /*) ;; *) consulted="$PWD/$consulted" ;; esac
if [ ! -f "$consulted" ]; then
    printf 'subject-guard: NOT ARMED — git consults %s, which does not exist. Cannot test what does not run.\n' "$consulted" >&2
    exit 1
fi
if ! grep -v '^[[:space:]]*#' "$consulted" 2>/dev/null | grep -qs 'subject-guard\.sh'; then
    printf 'subject-guard: NOT ARMED — the consulted commit-msg (%s) does not invoke the subject guard. Nothing to test.\n' "$consulted" >&2
    exit 1
fi
printf 'subject-guard: testing the consulted commit-msg at %s\n' "$consulted"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/subject-guard.XXXXXX") || { printf 'subject-guard: no tmpdir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_TMP:-}" ] || rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
REPO="$TMP/venue"
git init -q "$REPO" || { printf 'subject-guard: cannot build the throwaway clone\n' >&2; exit 1; }
git -C "$REPO" config user.name "Tabith LLC"
git -C "$REPO" config user.email "info@tabith.com"
echo base > "$REPO/f"; git -C "$REPO" add -A

try() { # try <subject> [body lines...] -> sets LAST and RC
    local subj=$1; shift
    local body=$*
    # UNIQUE content every cell: an identical rewrite means "nothing to commit", whose rc 1 would
    # masquerade as a hook refusal — the same false-fact family this whole harness exists to stop.
    printf 'cell-%s\n' "$(date +%s%N)" >> "$REPO/f"; git -C "$REPO" add -A
    if [ -n "$body" ]; then
        LAST=$(git -C "$REPO" commit -qm "$subj" -m "$body" 2>&1)
    else
        LAST=$(git -C "$REPO" commit -qm "$subj" 2>&1)
    fi
    RC=$?
}
refused() { # refused <case-name> <subject...>
    local name=$1; shift; try "$@"
    case "$LAST" in *"nothing to commit"*) bad "$name" "instrument fault: nothing to commit — the fixture did not change"; return;; esac
    if [ $RC -ne 0 ]; then ok "$name (refused rc=$RC)"; else bad "$name" "accepted a nickname subject — guard is inert"; fi
}
passed() {
    local name=$1; shift; try "$@"
    case "$LAST" in *"nothing to commit"*) bad "$name" "instrument fault: nothing to commit — the fixture did not change"; return;; esac
    if [ $RC -eq 0 ]; then ok "$name (accepted)"; else bad "$name" "refused a clean subject: $LAST"; fi
}

say "refusals, each beside the pass it is paired with"
# the leading lane-prefix class: "<name><digits>: "
refused "prefix flash9:"            "flash9: fix the leak"
passed  "no prefix, plain subject"  "fix: correct the leak in the relay"
# the leading lane-prefix class on a non-roster name (catches a retired seat too)
refused "prefix s270:"              "s270: notes"
passed  "no colon-prefix rule"      "read the fixture from the second stage"
# roster words in the subject
refused "roster ultra"              "ultra confirmed the guard"
passed  "body-only roster word"     "docs: record the two-door faces" "the reviewer ultra re-ran the suites"
refused "roster wren in a clause"   "a wren reviewed the relay"
refused "nicked branch in a merge"  "Merge branch fix/relay-576-flash2 into dev"
passed  "clean merge subject"       "Merge branch feature/split-brain-wrappers into dev"

say "a refusal is not a crash: after a refusal the box still commits (positive control)"
passed "clean commit after a refusal" "tests: subject guard ships with its harness"

say "the guard refuses the class and does not decide the prose"
# a subject that only MEANS a seat but names none must pass — the rule is the nickname class, not taste
passed "descriptive, no nickname" "tests: the seat that owns this leg authored it"

printf '\nsubject-guard: %d cells, %d failures\n' "$ran" "$failed"
[ "$failed" -eq 0 ] || exit 1
exit 0
