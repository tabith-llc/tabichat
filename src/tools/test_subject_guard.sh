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
# requires the guard named on a code line there — prose is not a dependency. That question is asked of
# FIXTURES this harness builds, in a config world it supplies, so its answer is about the code and not
# about whichever box ran it. Where a subject helper exists on the face, it is copied into the fixture and
# the cells below drive REAL commits in a throwaway clone so a "refused" is a real rc, not a grep. Where
# this face has no helper to copy, that half prints the reason it did not run and is never counted as a
# pass: it never calls an unarmed box green, and it no longer refuses a deploy for a guard the box was
# never given.
#
# NO real secret and no live venue is touched. Cells run in a throwaway `git init` under $TMPDIR with
# the same identity every commit on this fleet carries.
#
# EVERY CELL SELF-PROVISIONS ITS FIXTURE, and that is what makes this runnable anywhere. It used to ask
# the ENCLOSING repo what git consults and refuse outright when the answer was a path that does not exist,
# which meant a customer host was refused by a check for crew commit hygiene it was never handed. Three
# faces of `src/tools/check_subject_armed.sh` are asserted here instead, each inside a clone this harness
# builds and destroys, in a config world this harness supplies (an empty global file and an empty HOME,
# so no cell can inherit what the box it happens to run on has installed):
#   ARMED          - a set this harness wrote, carrying a commit-msg that calls the helper.
#   NOT ARMED      - a set that carries an executable hook and NO commit-msg: a set that lost one name is
#                    the tamper class, and it must stay a refusal. That is the doormat negative.
#   NOT APPLICABLE - a plain `git init` with nothing installed anywhere, rc 0, naming the path it asked.
# The helper itself is SOURCED from this face if the face has one — adjacent to the consulted hook, or
# tracked at .githooks/subject-guard.sh should the product ever ship it, or at the fixed path a CHAINED
# set names in its own text (see the three candidates below) — and COPIED into the fixture, so the behaviour
# cells below test a real guard in a clone of this harness's making. Where a face has no helper at all, the
# behaviour half prints the reason it did not run and is never worn as a pass: "cannot run" and "ran and
# found nothing" do not print the same way.
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CHK="$ROOT/src/tools/check_subject_armed.sh"

failed=0
ran=0
LAST=""
RC=0

ok()  { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad() { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
say() { printf '\n== %s ==\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }

# ---- where a guard helper lives, for whichever hook set is asked about. THREE CANDIDATES, tried IN ORDER:
# (1) adjacent to the consulted commit-msg, (2) the tracked fallback this repo carries, (3) the fixed
# absolute path the consulted hook names in its OWN text.
#
# The third is what a CHAINED set needs, and this box is shaped that way: githooks-tabichat/commit-msg calls
# githooks/subject-guard.sh in the other directory. Guessing "adjacent to the hook" misses a guard that runs
# on every commit there, so the census reads as a face with no helper — a count of WHERE the file sits, never
# of whether the guard runs. Asking the hook itself answers that without remembering a directory name: only
# code lines are read (a comment is not a dependency), only an absolute path whose last segment is the guard's
# own name, and only one that exists. A path built from a variable ($(dirname ...)/subject-guard.sh) is not a
# fixed path and is not matched — candidate 1 is what answers that shape. Whatever is resolved gets copied,
# made executable, and committed against, so a wrapper gets to point at a subject-guard and at nothing else.
#
# THE FALLBACK IS AN ARGUMENT, not an assumption. The plants below ask about a hook set in a scratch
# directory, and a scratch question must not inherit this repo's tracked set as a candidate it never asked
# for — a control that reads its caller's shape can be turned by that caller into a false answer.
resolve_helper() { # resolve_helper <consulted-commit-msg> [<tracked-fallback>] -> a helper path, or nothing
    local rh_hook=$1
    local rh_fallback=${2:-$ROOT/.githooks/subject-guard.sh}
    local rh="" rh_candidate rh_chained
    if [ -n "$rh_hook" ] && [ -f "$rh_hook" ] \
       && grep -v '^[[:space:]]*#' "$rh_hook" 2>/dev/null | grep -qs 'subject-guard\.sh'; then
        rh_candidate=$(dirname -- "$rh_hook")/subject-guard.sh
        [ -f "$rh_candidate" ] && rh="$rh_candidate"
    fi
    [ -n "$rh" ] || { [ -f "$rh_fallback" ] && rh="$rh_fallback"; }
    if [ -z "$rh" ] && [ -n "$rh_hook" ] && [ -f "$rh_hook" ]; then
        rh_chained=$(grep -v '^[[:space:]]*#' "$rh_hook" 2>/dev/null \
            | grep -oE "/[^\"'\$[:space:]]*/subject-guard\.sh" | head -1)
        [ -n "$rh_chained" ] && [ -f "$rh_chained" ] && rh="$rh_chained"
    fi
    printf '%s\n' "$rh"
}

ambient_consulted=$(git -C "$ROOT" rev-parse --git-path hooks/commit-msg 2>/dev/null || true)
case "${ambient_consulted:-}" in ''|/*) ;; *) ambient_consulted="$ROOT/$ambient_consulted" ;; esac
HELPER=$(resolve_helper "$ambient_consulted")

# ---- the config world every cell after this line runs in, supplied here rather than inherited ----
TMP=$(mktemp -d "${TMPDIR:-/tmp}/subject-guard.XXXXXX") || { printf 'subject-guard: no tmpdir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_TMP:-}" ] || rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
: > "$TMP/no-global"; mkdir -p "$TMP/home"
GIT_CONFIG_GLOBAL="$TMP/no-global"; HOME="$TMP/home"; export GIT_CONFIG_GLOBAL HOME

# ---- the armed set, written by this harness into its own scratch directory ----
SETD="$TMP/hookset"; mkdir -p "$SETD"
mkdir -p "$TMP/set-broken" "$TMP/set-empty" "$TMP/plain-hooks"
cp "$ROOT/.githooks/pre-commit" "$TMP/plain-hooks/pre-commit" 2>/dev/null || printf '#!/bin/sh\nexit 0\n' > "$TMP/plain-hooks/pre-commit"
chmod 755 "$TMP/plain-hooks/pre-commit"
printf '#!/bin/sh\n# planted by src/tools/test_subject_guard.sh — a host set that carries pre-commit and lost commit-msg\nexit 0\n' > "$TMP/set-broken/pre-commit"
chmod 755 "$TMP/set-broken/pre-commit"
printf '#!/bin/sh\ng=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/subject-guard.sh\n[ -x "$g" ] || { printf "subject-guard fixture: helper missing at %s — refusing rather than judging nothing.\\n" "$g" >&2; exit 1; }\n"$g" "$1"\nexit $?\n' > "$SETD/commit-msg"
printf '#!/bin/sh\nexit 0\n' > "$SETD/pre-commit"
chmod 755 "$SETD/commit-msg" "$SETD/pre-commit"
[ -n "$HELPER" ] && { cp "$HELPER" "$SETD/subject-guard.sh" && chmod 755 "$SETD/subject-guard.sh"; }
# The faces below are driven by the GLOBAL config file each fixture clone is run with, except the one that
# models this repo's own documented arming — an incumbent is what sits ABOVE the clone, and a LOCAL value is
# the arming a customer is told to run, so each of those two is aimed the way a real host aims it.
printf '[core]\n\thooksPath = %s\n' "$SETD" > "$TMP/g-armed"
printf '[core]\n\thooksPath = %s\n' "$TMP/set-broken" > "$TMP/g-broken"
printf '[core]\n\thooksPath = %s\n' "$TMP/plain-hooks" > "$TMP/g-plain"

say "THE THREE FACES OF THE ARM CHECK, each in a clone this harness built, in a config world it supplied"
arm_face() { # arm_face <tag> <global-config-file> [local hooksPath]
    f="$TMP/face-$1"; mkdir -p "$f"
    git init -q "$f" || { AOUT="git init failed"; ARC=99; return; }
    [ -n "${3:-}" ] && git -C "$f" config --local core.hooksPath "$3"
    AOUT=$( cd "$f" && GIT_CONFIG_GLOBAL="$2" sh "$CHK" 2>&1 ); ARC=$?
}
arm_face armed "$TMP/g-armed"
check "an armed face — a host set carrying both names — is ARMED (rc=0)" "$ARC" "0"
contains "$AOUT" "subject-armed: ARMED" "and it says which set it consulted"
lacks "$AOUT" "NOT APPLICABLE" "an armed clone never gets the non-fatal face"
arm_face broken "$TMP/g-broken"
check "PAIRED — a host that DOES carry a set above the clone which lost commit-msg is refused (rc=1)" "$ARC" "1"
contains "$AOUT" "NOT ARMED" "and the refusal is said out loud"
lacks "$AOUT" "NOT APPLICABLE" "and the doormat face does not open here: guards exist above this clone, one went missing"
arm_face scrubbed "$TMP/no-global"
check "a plain clone with nothing installed above it is NOT APPLICABLE (rc=0)" "$ARC" "0"
contains "$AOUT" "NOT APPLICABLE" "and it says so in words rather than passing in silence"
contains "$AOUT" "which does not exist" "and it names the consulted path it asked about"
lacks "$AOUT" "NOT ARMED" "a host that never had a guard is not reported as one that lost it"
# The fourth face is the one that would have been blocked by the first draft of this rule: a clone whose
# LOCAL value points at its own pre-commit-only set. That is what this repo's header tells a customer to
# run (iid 15's correct answer on a host with nothing installed), and that set has never carried a
# commit-msg anywhere, so it must read NOT APPLICABLE. A GLOBAL value aimed the same way is the OTHER face
# — the `broken` cell above — because a global set is a host guard with names that can go missing.
mkdir -p "$TMP/plain-hooks" 2>/dev/null
arm_face plainlocal "$TMP/no-global" "$TMP/plain-hooks"
check "a clone whose LOCAL value aims at a pre-commit-only set, with nothing above it, is NOT APPLICABLE (rc=0)" "$ARC" "0"
lacks "$AOUT" "NOT ARMED" "and the documented arming is never described as tampering"
arm_face global-only "$TMP/g-plain"
check "PAIRED — the SAME set aimed by a GLOBAL value is a refusal (rc=1): a host guard lost a name" "$ARC" "1"
contains "$AOUT" "NOT ARMED" "and it says which"

say "HELPER RESOLUTION — a chained set, its missing twin, and a real commit between them"
# Both plants below chain to a helper in ANOTHER directory, so candidate 1 cannot answer either one and what
# these cells measure is candidate 3 alone. The first names a helper that EXISTS; the second names the same
# shape at a path that does NOT. Telling those two apart is the whole job: a resolution that returned the
# second as if it were the first would go on to copy a file that is not there, and a harness that found
# nothing has to say so rather than pass. The fallback is passed as a scratch path that holds no helper,
# so neither plant can be answered by candidate 2 either.
plant_wrapper() { # plant_wrapper <file> <helper-path> — a chained wrapper: fixed path, refuse when missing
    printf '#!/bin/sh\n# plant: a chained set — the helper is named by fixed path in ANOTHER directory\nsg=%s\n[ -x "$sg" ] || { printf "subject-guard: helper missing at %%s — refusing rather than committing unchecked.\\n" "$sg" >&2; exit 1; }\n"$sg" "$1"\nexit $?\n' "$2" > "$1"
    chmod 755 "$1"
}
mkdir -p "$TMP/plant-set" "$TMP/plant-gone" "$TMP/plant-far"
printf '#!/bin/sh\nexit 0\n' > "$TMP/plant-far/subject-guard.sh"
chmod 755 "$TMP/plant-far/subject-guard.sh"
plant_wrapper "$TMP/plant-set/commit-msg" "$TMP/plant-far/subject-guard.sh"
resolved=$(resolve_helper "$TMP/plant-set/commit-msg" "$TMP/plant-gone/subject-guard.sh")
check "a chained set naming a helper that EXISTS resolves the path the hook itself printed" "$resolved" "$TMP/plant-far/subject-guard.sh"
plant_wrapper "$TMP/plant-gone/commit-msg" "$TMP/plant-gone/subject-guard.sh"
resolved=$(resolve_helper "$TMP/plant-gone/commit-msg" "$TMP/plant-gone/subject-guard.sh")
check "PAIRED — the same shape naming a helper that does NOT exist resolves to nothing, which is the branch that prints the skip" "$resolved" ""
# And that missing plant, driven by a REAL commit, so "cannot find" is proven at the hook rather than worn
# as a pass: the refuse-when-missing law is exercised here, not restated.
GONE="$TMP/venue-gone"
git init -q "$GONE" || { printf 'subject-guard: cannot build the missing-helper venue\n' >&2; exit 1; }
git -C "$GONE" config user.name "Tabith LLC"
git -C "$GONE" config user.email "info@tabith.com"
git -C "$GONE" config core.hooksPath "$TMP/plant-gone"
echo seed > "$GONE/f"; git -C "$GONE" add -A
MOUT=$(git -C "$GONE" commit -qm "docs: record the two faces of helper resolution" 2>&1); MRC=$?
case "$MOUT" in
    *"nothing to commit"*) bad "the missing-helper plant" "instrument fault: nothing to commit — the fixture did not change";;
    *) check "a real commit through a chained set whose helper is missing is refused, not accepted (rc=1)" "$MRC" "1";;
esac
contains "$MOUT" "subject-guard: helper missing at" "and the refusal names the path it could not find"

BEHAVIOUR=1
if [ -z "$HELPER" ]; then
    BEHAVIOUR=0
    printf 'subject-guard: NOT APPLICABLE — this face carries no subject helper to copy (the guard sits on the deployed crew hook sets and is not a shipped member), so the behaviour cells below did NOT RUN. They are named, not counted as passes.\n' >&2
    printf 'subject-guard: the arm-check faces above ran on a fixture this harness wrote, and they are what a deploy gate on any host can assert.\n' >&2
fi

REPO="$TMP/venue"
git init -q "$REPO" || { printf 'subject-guard: cannot build the throwaway clone\n' >&2; exit 1; }
git -C "$REPO" config user.name "Tabith LLC"
git -C "$REPO" config user.email "info@tabith.com"
git -C "$REPO" config core.hooksPath "$SETD"
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

# The behaviour half runs only against a helper this harness COPIED into its fixture. When this face has
# no helper to copy, the fixture commit-msg would refuse for the missing helper and every `refused` cell
# below would read as a guard working — a false green of exactly the class this file exists to stop. So the
# half is gated off and named, not run and not counted as a pass.
if [ "$BEHAVIOUR" = 1 ]; then

say "refusals, each beside the pass it is paired with"
# the leading lane-prefix class: "<name><digits>: "
refused "prefix flash9:"            "flash9: fix the leak"
passed  "no prefix, plain subject"  "fix: correct the leak in the relay"
# the leading lane-prefix class on a non-roster name (catches a retired seat too)
refused "prefix s270:"              "s270: notes"
passed  "no colon-prefix rule"      "read the fixture from the second stage"
# roster words in the subject
refused "roster word in the subject"      "flash8 confirmed the guard"
passed  "body-only roster word"     "docs: record the two-door faces" "the reviewer flash8 re-ran the suites"
refused "roster word inside a clause"     "a flash8 reviewed the relay"
refused "nicked branch in a merge"  "Merge branch fix/relay-topic-flash8 into dev"
passed  "clean merge subject"       "Merge branch feature/split-brain-wrappers into dev"

say "a refusal is not a crash: after a refusal the box still commits (positive control)"
passed "clean commit after a refusal" "tests: subject guard ships with its harness"

say "the guard refuses the class and does not decide the prose"
# a subject that only MEANS a seat but names none must pass — the rule is the nickname class, not taste
passed "descriptive, no nickname" "tests: the seat that owns this leg authored it"

else
ok "the behaviour half did NOT RUN on this face — no subject helper to copy, named above, never worn as a pass"
fi

printf '\nsubject-guard: %d cells, %d failures (%s behaviour half)\n' "$ran" "$failed" "$([ "$BEHAVIOUR" = 1 ] && printf 'ran' || printf 'NOT RUN: no helper on this face')"
[ "$failed" -eq 0 ] || exit 1
exit 0
