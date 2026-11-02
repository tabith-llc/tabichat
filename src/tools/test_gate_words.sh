#!/usr/bin/env bash
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for the shell-gate loop in src/tools/deploy-tabichat.sh — what that loop is allowed to SAY.
#   bash src/tools/test_gate_words.sh        (exit 1 on any failure)
#
# WHY THIS FILE EXISTS. The loop used to send each gate's ordinary output to /dev/null and then print one
# fixed sentence claiming the guard it named "is not on the path git consults". Measured at the leg that
# wrote this: in a clone where the file was sitting right there, the check itself had refused, and the
# sentence about a hook path was simply false — and the words that named the real reason had been thrown
# away. A deploy gate that lies about WHY it stopped is worse than no gate, because the reader goes to fix
# the wrong thing. So the two faces the loop can actually observe (no file; ran and left non-zero) are the
# only two faces it may describe, and this harness plants each face and reads what came back.
#
# WHY EVERY CASE RUNS THE REAL SCRIPT. Extracting the loop into a test driver would test the driver, and a
# driver that is copied drifts from the original in exactly the way that hides a regression. Each case
# therefore runs `deploy-tabichat.sh` in a scratch clone of THIS TREE, with `EXT=fs-gate` so the run is
# short (one bun gate, the build, the destination load-check) while the shell-gate stage — the code under
# test — is the same code the tabichat deploy runs. TARGET is inside the scratch, so nothing this harness
# writes can reach a live extension directory.
#
# THE ABSENCE FACE IS ORDERED AGAINST A REAL TRAP: `sh` on a missing file exits non-zero too (127), so a
# loop that runs first and looks for the file afterwards reports "it ran and exited 127" about a check that
# never ran. Case 4 is that trap, and it asserts BOTH halves: the absence sentence fires, and the
# ran-and-exited sentence does not.
#
# THE FIXTURES ARE PLANTED, NOT COMMITTED. They are written into a scratch clone at run time and never
# enter this repository, so the repo holds no gate that fails on purpose.
set -uo pipefail

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
DEP_REL="src/tools/deploy-tabichat.sh"
[ -f "$REPO/$DEP_REL" ] || { printf 'FAIL  no deploy script at %s/%s\n' "$REPO" "$DEP_REL"; exit 1; }

failed=0; ran=0
ok()    { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad()   { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
say()   { printf '\n== %s ==\n' "$1"; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }
lineno()   { printf '%s\n' "$1" | grep -n -F "$2" | head -1 | cut -d: -f1; }

# ------------------------------------------------------------------ the hook SET the clone is aimed at
# A host guard is a HOOK SET, not one file: `core.hooksPath` replaces every consulted name at once and
# says nothing while doing it, so an aim carrying a pre-commit but no commit-msg arms one guard and
# silently stops the other — the class check_guard_armed.sh names ("pointing it here stops a global
# commit-msg, pre-push, or prepare-commit-msg too", iid 15). These ask git where each consulted hook
# lives, exactly the way the arm checks do, instead of comparing against a remembered directory.
consulted_path() { # $1 = repo path, $2 = hook name -> the path git would consult, absolute
  local p; p=$(git -C "$1" rev-parse --git-path "hooks/$2" 2>/dev/null) || return 1
  case "$p" in /*) ;; *) p="$1/$p" ;; esac   # git prints a relative hooksPath against the -C directory
  printf '%s' "$p"
}
consulted_face() { # $1 = repo path, $2 = hook name -> exists | absent | unreadable
  local p; p=$(consulted_path "$1" "$2") || { printf 'unreadable'; return; }
  if [ -f "$p" ]; then printf 'exists'; else printf 'absent'; fi
}
consulted_dir()  { local p; p=$(consulted_path "$1" "$2") || return 1; printf '%s' "$(dirname -- "$p")"; }
armed_set() {    # the set the ENCLOSING repo consults, when it is a set: both names present, same dir
  local pc cm d
  pc=$(consulted_path "$REPO" pre-commit) || return 1
  cm=$(consulted_path "$REPO" commit-msg) || return 1
  [ -f "$pc" ] && [ -f "$cm" ] || return 1
  d=$(dirname -- "$cm"); [ "$d" = "$(dirname -- "$pc")" ] || return 1
  printf '%s' "$d"
}

SCR=$(mktemp -d "${TMPDIR:-/tmp}/gate-words-XXXXXX") || { printf 'no scratch dir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_SCR:-}" ] || rm -rf "$SCR"; }
trap cleanup EXIT INT TERM
GOOD_NAME="Tabith LLC"; GOOD_MAIL="info@tabith.com"

# ---------------------------------------------------------------- the scratch clone of THIS tree
# Archived from HEAD plus the working-tree state of every tracked file, and staged INSIDE the clone so
# the archive and its overlay can never see each other (a self-overwrite truncates the file it copies).
# The overlay is what a leg that has not committed yet needs; after a commit both halves agree.
build_clone() { # $1 = path; $2 = extra += registration text, if any; $3 = file names to plant
  local dest="$1" reg="$2"; shift 2
  rm -rf "$dest"; mkdir -p "$dest"
  git -C "$REPO" archive --format=tar HEAD | tar -x -C "$dest"
  local f
  for f in $(git -C "$REPO" diff --name-only HEAD) $(git -C "$REPO" ls-files --others --exclude-standard); do
    [ -f "$REPO/$f" ] && cp "$REPO/$f" "$dest/$f"
  done
  # RE-ENTRANCE IS CLOSED HERE, and this is the one line in this file that is not about a message.
  # This harness is itself a registered shell gate, so a clone that kept the registration would run this
  # file again from inside the deploy it is running — and again, each level rebuilding a clone that
  # registers it: measured at the first scratch run, an unbounded tree of nested deploys. The registration
  # is therefore stripped from the CLONE's copy only: the loop under test still runs with every OTHER
  # registered gate, on the shipped code path, and the cell at the end of this file proves the
  # registration is present in the tree before it is stripped, so the strip cannot silently become a no-op.
  grep -v -e 'SHGATES+=(test_gate_words.sh)' -e '# leg 851: the truth table' "$dest/$DEP_REL" > "$dest/$DEP_REL.tmp"
  mv "$dest/$DEP_REL.tmp" "$dest/$DEP_REL"
  if [ -n "$reg" ]; then
    # insert the plant AFTER the last existing += registration, so it lands inside the array the loop
    # reads — appending at end-of-file would sit below the `for` and be dead text that tests nothing
    local ln; ln=$(grep -n 'SHGATES+=(' "$dest/$DEP_REL" | tail -1 | cut -d: -f1)
    [ -n "$ln" ] || { printf 'FAIL  no SHGATES+= registration line to plant after\n' >&2; return 1; }
    { head -n "$ln" "$dest/$DEP_REL"; printf '  SHGATES+=(%s)\n' "$reg"; tail -n "+$((ln + 1))" "$dest/$DEP_REL"; } \
      > "$dest/$DEP_REL.tmp" && mv "$dest/$DEP_REL.tmp" "$dest/$DEP_REL"
  fi
  for f in "$@"; do
    case "$f" in
      # A name planted WITHOUT a file is the missing-file case, and the loop order puts the absence test
      # before the run — so `sh` is never reached and no 127 can leak into the sentence under test.
      gate_missing.sh) continue;;
      gate_loud.sh)   plant_loud   "$dest/src/tools/$f" 3; chmod +x "$dest/src/tools/$f"; continue;;
      gate_quiet.sh)  plant_quiet  "$dest/src/tools/$f" 5; chmod +x "$dest/src/tools/$f"; continue;;
    esac
    printf '#!/bin/sh
# a planted fixture for src/tools/test_gate_words.sh — not shipped
printf "GATEWORD-SECOND: the second refusal, never to be seen\\n" >&2
exit 9\n' > "$dest/src/tools/$f"
    chmod +x "$dest/src/tools/$f"
  done
  git -C "$dest" init -q -b lane-under-test . >/dev/null
  git -C "$dest" config user.name "$GOOD_NAME"; git -C "$dest" config user.email "$GOOD_MAIL"
  # Aim the clone at the hook SET the enclosing repo actually consults — a set carrying BOTH the secret
  # guard's pre-commit and the subject guard's commit-msg — because that is the armed state a real clone
  # has on a box that runs a host guard. The aim here used to be `.githooks` alone, which carries
  # pre-commit and NOT commit-msg: it armed one guard and displaced the other in the same silent line.
  # That stayed invisible while every registered gate asked about pre-commit only, and went red the
  # moment a registered gate asked about commit-msg — the deploy under test then stopped at that check
  # before any plant ran. Where the host carries no such set, `.githooks` is the honest aim, and it is
  # the same value the enclosing repo would consult; AIM_TAKEN records which one this run chose so the
  # cells below and the report can say what was modelled instead of assuming it.
  local aim; aim=$(armed_set) || aim=""
  [ -n "$aim" ] || aim=".githooks"
  AIM_TAKEN="$aim"
  git -C "$dest" config core.hooksPath "$aim"
  git -C "$dest" add -A >/dev/null
  git -C "$dest" commit -q -m "base: the tree under test" >/dev/null
  git -C "$dest" branch dev HEAD   # check_attributions.sh resolves its base from a published line
}
# The commit-msg arm check, run against the clone in whichever state the caller put it. It is C's
# (iid 13, the check whose rc 1 made 13 of these cells red), so a tree that does not carry it yet gets a
# printed NOT-RUN line and no cells — never a pass worn by the half that did not run.
subject_arm_cells() { # $1 = armed | displaced
  local want="$1" out rc
  if [ ! -f "$SCR/clone/src/tools/check_subject_armed.sh" ]; then
    printf 'note  this face of the tree carries no check_subject_armed.sh: the arm-check half of the %s pair is NOT RUN here — the consulted-path cells are what this face asserts\n' "$want" >&2
    return 0
  fi
  out=$( cd "$SCR/clone/src" && sh tools/check_subject_armed.sh 2>&1 ); rc=$?
  if [ "$want" = armed ]; then
    check "and the commit-msg arm check calls this clone armed (rc)" "$rc" "0"
    contains "$out" "subject-armed: ARMED" "and it names the set it consulted"
  else
    check "the arm check refuses the displaced clone (rc)" "$rc" "1"
    contains "$out" "NOT ARMED" "and the displaced state is said out loud, so a missing commit-msg can never read as armed"
  fi
}
plant_loud()  { printf '#!/bin/sh\n# a planted fixture for src/tools/test_gate_words.sh — not shipped\nprintf "GATEWORD-LOUD: the check speaks, the wrapper does not\\n" >&2\nexit %s\n' "$2" > "$1"; }
plant_quiet() { printf '#!/bin/sh\n# a planted fixture for src/tools/test_gate_words.sh — not shipped\nexit %s\n' "$2" > "$1"; }
run_deploy()  { ( cd "$SCR/clone/src" && env -u MQTT_LEAD_NICK EXT=fs-gate TARGET="$SCR/clone/target" \
                    bash tools/deploy-tabichat.sh > "$SCR/out.txt" 2>&1 ); printf '%s' "$?"; }
OUT=""; RC=0
fire() { RC=$(run_deploy); OUT=$(cat "$SCR/out.txt"); }

say "THE CLONE IS A REAL ONE — the three shipped shell gates pass in it BEFORE any plant is registered"
build_clone "$SCR/clone" "" || { printf 'FAIL  could not build the scratch clone\n' >&2; exit 1; }
printf 'note  the fixture clone is aimed at core.hooksPath=%s — the set the enclosing repo consults, asked out of git, not remembered\n' "$AIM_TAKEN" >&2
for t in check_guard_armed.sh check_attributions.sh test_attribution_pins.sh; do
  ( cd "$SCR/clone/src" && sh "tools/$t" >/dev/null 2>&1 ); check "the clone's own $t is green (rc=0)" "$?" "0"
done

say "THE AIM IS A SET — every consulted hook name exists where the clone is pointed (iid 15)"
# The half that the old aim was blind to: one value replaces the whole consulted set, so a set that
# carries pre-commit and not commit-msg reads as armed to the guard check and displaced to every other.
check "the clone's consulted commit-msg is a real file, not displaced by the aim" "$(consulted_face "$SCR/clone" commit-msg)" "exists"
sdir=$(consulted_dir "$SCR/clone" pre-commit); cdir=$(consulted_dir "$SCR/clone" commit-msg)
check "and both consulted names resolve into the SAME set, which is the one value hooksPath replaces" "$([ -n "$sdir" ] && [ "$sdir" = "$cdir" ] && echo same || echo differ)" "same"
subject_arm_cells armed

say "PAIRED — the same clone aimed at a set MISSING commit-msg must still be refused, never read as armed"
# Root AGENTS.md sec.2 asked of every gate: the case it rejects gets a cell. This re-aim is legal only
# because $SCR/clone is a throwaway fixture the harness makes and destroys; no real venue is touched.
git -C "$SCR/clone" config core.hooksPath .githooks
check "the displaced aim consults a commit-msg that does not exist" "$(consulted_face "$SCR/clone" commit-msg)" "absent"
subject_arm_cells displaced
git -C "$SCR/clone" config core.hooksPath "$AIM_TAKEN"
check "and the clone is put back on the armed set before any plant case runs" "$(consulted_face "$SCR/clone" commit-msg)" "exists"

say "CASE 1 — a passing gate set completes the deploy and never says REFUSED"
fire
check "the deploy exits 0" "$RC" "0"
lacks "$OUT" "REFUSED" "and a pass is not a refusal wearing different words"
contains "$OUT" "deployed set complete" "and it still says the thing a green deploy is for"

say "CASE 2 — the file is PRESENT and the check refuses loudly: its code, its words, not a borrowed cause"
build_clone "$SCR/clone" "gate_loud.sh" gate_loud.sh
fire
check "the deploy stops (rc=1)" "$RC" "1"
contains "$OUT" "gate_loud.sh is not green: it ran and exited 3." "and the exit code the check returned is the code printed"
contains "$OUT" "GATEWORD-LOUD: the check speaks, the wrapper does not" "and the check's own words survived the run"
lacks "$OUT" "is not on the path git consults" "and the wrapper claims no cause it never observed"
lacks "$OUT" "exited 127" "and a file that exists is never called missing"

say "CASE 2b — the code carried is the CHECK's, not a hardcoded 1 (the same shape at rc 7)"
plant_loud "$SCR/clone/src/tools/gate_loud.sh" 7
fire
contains "$OUT" "it ran and exited 7." "rc 7 is printed as 7 — the number tracks the gate, not the wrapper"
check "and the deploy still stops (rc=1)" "$RC" "1"

say "CASE 3 — a check that refuses with NO output at all gets the nothing line, never a bare promise"
build_clone "$SCR/clone" "gate_quiet.sh" gate_quiet.sh
fire
check "the deploy stops (rc=1)" "$RC" "1"
contains "$OUT" "(the check printed nothing)" "and the absence of words is said out loud, so 'its words are above' is never a lie"
contains "$OUT" "gate_quiet.sh is not green: it ran and exited 5." "and the code is still the check's own"

say "CASE 3b — PAIRED: a check that DID print must never be given the nothing line"
# The paired negative root AGENTS.md sec.2 asks of every filter: the nothing-line is only true when the
# output is empty. A loop that printed it unconditionally would bury the reason it exists to show, in the
# loudest case there is — and the sentence a reader acts on would be the wrong one.
build_clone "$SCR/clone" "gate_loud.sh" gate_loud.sh
fire
lacks "$OUT" "(the check printed nothing)" "a loud refusal never carries the empty-output sentence"
contains "$OUT" "GATEWORD-LOUD" "and its own words are what stands above the line"

say "CASE 4 — a registered name with NO file: absence is named, and no run is claimed"
build_clone "$SCR/clone" "gate_missing.sh"
fire
check "the deploy stops (rc=1)" "$RC" "1"
contains "$OUT" "gate_missing.sh is not green: the file src/tools/gate_missing.sh is not in this clone, so the check never ran." "the absence message fires on the missing file"
lacks "$OUT" "it ran and exited" "and the loop never claims a run it did not perform — sh on a missing file exits 127, so running first would have said exactly that"
lacks "$OUT" "is not on the path git consults" "and it does not reach for the hook path either"

say "CASE 4b — PAIRED: the absence message must NOT fire when the file is there"
build_clone "$SCR/clone" "gate_loud.sh" gate_loud.sh
fire
lacks "$OUT" "is not in this clone, so the check never ran" "a present file is never reported absent"

say "CASE 5 — the check's own words come BEFORE the REFUSED line"
build_clone "$SCR/clone" "gate_loud.sh" gate_loud.sh
fire
w=$(lineno "$OUT" "GATEWORD-LOUD"); r=$(lineno "$OUT" "REFUSED")
check "both lines are present, in that order" "$([ -n "$w" ] && [ -n "$r" ] && [ "$w" -lt "$r" ] && echo yes || echo no)" "yes"

say "CASE 6 — the FIRST refusal stops the deploy: two gates registered, only one is ever run"
build_clone "$SCR/clone" "gate_loud.sh gate_second.sh" gate_loud.sh gate_second.sh
fire
check "the deploy stops (rc=1)" "$RC" "1"
contains "$OUT" "GATEWORD-LOUD" "the first planted gate ran and was heard"
lacks "$OUT" "GATEWORD-SECOND" "the second never ran — a gate that reports all four cases instead of stopping at the first is a worse bug than the sentence it fixes"
check "exactly one REFUSED line was printed" "$(printf '%s\n' "$OUT" | grep -c REFUSED)" "1"

say "THE LOOP IS STILL CONSUMED, AND THE OLD DISCARD IS GONE (static face of the same rule)"
# A behaviour cell proves the shape today; this pair proves nobody can quietly re-introduce the swallow.
dep=$(cat "$REPO/$DEP_REL")
disc=$(printf '%s\n' "$dep" | grep -Ec 'sh "tools/\$t" >/dev/null' || true)
check "the shell-gate loop no longer sends a check's output to /dev/null (0 sites)" "$disc" "0"
claim=$(printf '%s\n' "$dep" | grep -Fc 'is not on the path git consults' || true)
check "and the false cause sentence is not in the script at all (0 sites)" "$claim" "0"
selfreg=$(printf '%s\n' "$dep" | sed -n 's/^[[:space:]]*SHGATES+=(\(.*\))/\1/p' | tr ' \t' '\n\n' | grep -c '^test_gate_words\.sh$')
check "this harness is registered in the shell-gate array, by the += form only (1)" "$selfreg" "1"
folded=$(printf '%s\n' "$dep" | grep -c 'SHGATES=(.*test_gate_words' || true)
check "and it is NOT folded into the pinned literal, which test_secret_guard.sh reads by exact text (0)" "$folded" "0"

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells' "$failed" "$ran" || printf 'all %d gate-word cells pass' "$ran")"
[ "$failed" -gt 0 ] && exit 1
exit 0
