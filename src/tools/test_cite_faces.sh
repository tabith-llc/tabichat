#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for src/tools/check_cite_faces.sh — what it may read as a pointer, and what it must still refuse.
#   sh src/tools/test_cite_faces.sh        (exit 1 on any failure)
#
# WHY THIS EXISTS. The instrument had no harness of its own: `check_cite_faces.sh` is a member of the
# deploy loop's shell-gate array, and the only check that looked at it was the one that counts the array.
# So the extractor could read the inside of an English word as a commit cite — `succeeded` yielding
# `cceeded`, `deadbeat` yielding `deadbea`, `prefabbed` yielding `efabbed` — ask git for it, resolve
# nowhere, and exit 1. Every one of those is prose. The check runs in the deploy loop, so a sentence could
# redden a customer's deploy, and nothing in the suite would have said so: the corpus happened to hold no
# such word, and a corpus that happens to be quiet is not an instrument that is right.
#
# BOTH HALVES, because this is a gate-instrument change. The false cites must go green AND the real ones
# must still refuse. A rule that buys the first by making the second unjudgeable is the forbidden
# weakening, so the refusals here are RUN, not described: in a scratch clone that can actually judge.
#
# WHY A SCRATCH CLONE AND NOT THIS REPO. The tool reports instead of refusing where no verdict is possible
# (no commits, no tags and no fetched faces, shallow) — see its header. A harness that ran against a tree
# in one of those states would print `unjudged` and every refusal cell here would pass on absence, which is
# silence wearing a completion line. So this file builds one throwaway clone with a commit, a tag and a
# fetched-shape remote ref, and every cell runs the real script against it with CITE_REPO. Nothing here
# touches a live venue, and the scratch is deleted on exit.
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CHK="$ROOT/src/tools/check_cite_faces.sh"

failed=0
ran=0

ok()  { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad() { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/cite-faces.XXXXXX") || { printf 'cite-faces: no tmpdir\n' >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT INT TERM

SCR="$TMP/face"
mkdir -p "$SCR"
git init -q "$SCR" || { printf 'cite-faces: cannot build the scratch face\n' >&2; exit 1; }
git -C "$SCR" config user.name "Tabith LLC"
git -C "$SCR" config user.email "info@tabith.com"
printf 'seed\n' > "$SCR/f"; git -C "$SCR" add -A
git -C "$SCR" commit -qm "docs: seed the scratch face the cite harness reads against" || { printf 'cite-faces: seed commit failed\n' >&2; exit 1; }
git -C "$SCR" tag 9.9.9
git -C "$SCR" update-ref refs/remotes/scratch/main HEAD   # a "fetched face", so the tool may judge
REAL=$(git -C "$SCR" rev-parse --short=8 HEAD)           # a cite that resolves here, by construction

# run the real instrument over planted text; sets OUT and RC
judge() { # judge <text>
    OUT=$(printf '%s\n' "$1" | CITE_REPO="$SCR" sh "$CHK" - 2>&1); RC=$?
}

printf '\n== the false cites: prose that used to be read as a pointer ==\n'
# Measured against the system word list, these are the words whose maximal hex run is 7+ characters while
# the word itself is not a token of hex. Each one is prose in a sentence, and each one used to exit 1.
for w in "the run succeeded and the gate printed all checks" \
         "a deadbeat prefabbed the biofeedback page" \
         "decaffeinated intake exsucceeded the predeeded form" \
         "the exceeded acceed and seceded counts stayed put" ; do
    judge "$w"
    case "$OUT" in *'cite(s) read'*) bad "prose is never a cite: $w" "it was judged: $OUT";;
                   *) check "prose is never a cite: $w (rc=0)" "$RC" "0";; esac
done
# The pure-digit rule the tool already states, kept honest: a seven-digit number is a count, not a pointer.
judge "the run printed 1234567 cells in 1780000 ms"
check "a pure-digit run is still a count and not a cite (rc=0)" "$RC" "0"

printf '\n== the true cites: what must STILL refuse, or the green was bought ==\n'
judge "the note cites deadbeefcafe as the face it landed on"
check "a fabricated BARE sha still refuses (rc=1)" "$RC" "1"
contains "$OUT" "deadbeefcafe" "and it names the token"
contains "$OUT" "NOWHERE" "and says it resolves nowhere"
judge "the note cites 0xdeadbeef as the face"
check "a fabricated 0x-PREFIXED sha still refuses (rc=1)" "$RC" "1"
contains "$OUT" "deadbeef " "and the run it names is the one behind the prefix"
judge "the note cites sha-abcdef01 as the face"
check "a fabricated sha-PREFIXED cite still refuses (rc=1)" "$RC" "1"
contains "$OUT" "abcdef01" "and names the run, not the prefix"
judge "commit $REAL and also \`$REAL\` and ($REAL) and path/$REAL still open"
check "a REAL cite is read in every delimiter shape (rc=0)" "$RC" "0"
contains "$OUT" "cite(s) read" "and the cites were counted, not skipped"
printf '\n== the limit the rule does NOT cross, said out loud ==\n'
# A whole word that happens to be all hex IS a maximal alphanumeric token, so it stays a candidate: the
# dictionary carries `defaced`, `effaced` and `acceded`. Skipping them would mean dropping real shas whose
# first seven characters hold no digit, which is the narrowing this leg refuses. So the limit is asserted
# as a refusal — if it ever stops refusing, this cell says the rule changed under the header that names it.
judge "the panel was defaced before the run"
check "THE NAMED LIMIT: a wholly-hex English token is still judged (rc=1)" "$RC" "1"
contains "$OUT" "defaced" "and it is named rather than swallowed"

printf '\n== the glued-hex limit leg 1180 names instead of hiding ==\n'
# The shape the maximal-token rule cannot see: letters fused to a hex run with no boundary between them. Base
# `42e3b7a` refused these; the 1165 rule reads nothing, so they pass. That trade is stated in the check's header
# and pinned here, so a later widening must rename a cell and edit that header in the open rather than quietly
# turn a silence into a refusal.
judge "The run xxdeadbeefcafe1234 failed at the cut."
check "LIMIT (glued, long): a fused 18-char token is not read (rc=0)" "$RC" "0"
lacks "$OUT" "cite(s) read" "and it is not judged, so no count line prints"
judge "The run sha1deadbeefcafe failed at the cut."
check "LIMIT (glued, short): the same shape at 14 chars is not read (rc=0)" "$RC" "0"
lacks "$OUT" "cite(s) read" "and the smaller fused form is not read either"
# Symmetry, the half that keeps the limit honest: when the fused run OPENS a real face it is unread too, and
# unread is a pass. A limit that hides only misses is not a limit, it is a bug wearing a name.
judge "the note cites xx$REAL as the face"
check "LIMIT (glued, resolving): a fused token around a REAL sha is not read either (rc=0)" "$RC" "0"
# The same value in a cite shape IS read, and it opens: the coverage the limit leaves on the other side.
judge "the note cites $REAL as the face"
check "and that same value written as a pointer is still read (rc=0)" "$RC" "0"
contains "$OUT" "cite(s) read" "so the limit is about the boundary, not about the value"
# The regression this leg must not cause, asserted rather than hoped: the class 1165 closed stays closed.
judge "the run succeeded and the gate printed all checks"
check "LIMIT guard: prose that contains a wholly-hex substring is still not a cite (rc=0)" "$RC" "0"

printf '\n== the states that report instead of refusing (unchanged by this leg) ==\n'
EMPTY="$TMP/no-commits"; mkdir -p "$EMPTY"; git init -q "$EMPTY"
OUT=$(printf 'cceeded\n' | CITE_REPO="$EMPTY" sh "$CHK" - 2>&1); RC=$?
check "a tree with no commits reports rather than refusing (rc=0)" "$RC" "0"
contains "$OUT" "unjudged" "and it says the cite was not judged"
contains "$OUT" "no commits" "and names the state that stops it judging"
NOREPO="$TMP/not-a-repo"; mkdir -p "$NOREPO"
OUT=$(printf 'anything\n' | CITE_REPO="$NOREPO" sh "$CHK" - 2>&1); RC=$?
check "a directory that is not a repository still exits 2 (usage face)" "$RC" "2"

printf '\ncite-faces: %d cells, %d failures\n' "$ran" "$failed"
[ "$failed" -eq 0 ] || exit 1
exit 0
