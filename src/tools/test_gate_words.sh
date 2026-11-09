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
#
# EVERY CELL SELF-PROVISIONS ITS CLONE, and that is what makes this a product check rather than a crew
# ritual. The hook set the scratch clone is aimed at is BUILT here, inside this run's scratch directory:
# one wrapper per consulted name, forwarding to the clone's own tracked guard, and a commit-msg that calls
# the subject helper. It used to ask the ENCLOSING repo where the host keeps its hooks and aim the fixture
# at that answer, so on a host with no crew hook set the clone got `.githooks` alone, which carries
# pre-commit and not commit-msg, and every cell downstream went red for a reason about the machine rather
# than about the code. A deploy gate must not require state that exists on only one site.
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

# The set the fixture clone is aimed at, WRITTEN BY THIS HARNESS in its own scratch directory. Nothing
# here reads the host's config: the same armed state is modelled on the crew box and on a customer box,
# from the same bytes, so a cell that passes here passes for the reason the code says it does.
# It is a MODEL of an armed set, not an enforcement test — the subject guard's behaviour truth table is
# src/tools/test_subject_guard.sh, and it self-provisions the same way.
write_fixture_set() { # -> the directory, which the caller points core.hooksPath at
  local d="$SCR/fixture-hookset"
  mkdir -p "$d" || return 1
  printf '#!/bin/sh\n# planted by src/tools/test_gate_words.sh — forwards to the tracked guard of whatever clone is consulted\ntop=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1\nexec "$top/.githooks/pre-commit" "$@"\n' > "$d/pre-commit"
  printf '#!/bin/sh\n# planted by src/tools/test_gate_words.sh — an armed commit-msg: it calls the subject helper and returns its status\ng=$(dirname -- "$0")/subject-guard.sh\n[ -f "$g" ] && { sh "$g" "$@" || exit $?; }\nexit 0\n' > "$d/commit-msg"
  chmod 755 "$d/pre-commit" "$d/commit-msg" || return 1
  printf '%s' "$d"
}

SCR=$(mktemp -d "${TMPDIR:-/tmp}/gate-words-XXXXXX") || { printf 'no scratch dir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_SCR:-}" ] || rm -rf "$SCR"; }
trap cleanup EXIT INT TERM
GOOD_NAME="Tabith LLC"; GOOD_MAIL="info@tabith.com"
# The config world every arm cell runs in. The check under test asks the CONFIG whether the host carries a
# hook set, so a cell that inherited this box's global value would answer about the machine it happened to
# run on — an empty file we own, plus an empty HOME, so each cell supplies its own input.
: > "$SCR/no-global"; mkdir -p "$SCR/home"
# A host set that carries pre-commit and lost commit-msg, and a global config file that names it. This is
# how an INCUMBENT is modelled: a value above the clone. A local core.hooksPath is not an incumbent — it
# is the arming this repo tells a customer to run — so the refusal face has to be built from the global.
mkdir -p "$SCR/set-broken"
printf '#!/bin/sh\nexit 0\n' > "$SCR/set-broken/pre-commit"; chmod 755 "$SCR/set-broken/pre-commit"
printf '[core]\n\thooksPath = %s\n' "$SCR/set-broken" > "$SCR/g-broken"

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
  grep -v -e 'SHGATES+=(test_gate_words.sh)' -e '# the truth table for THIS loop' "$dest/$DEP_REL" > "$dest/$DEP_REL.tmp"
  mv "$dest/$DEP_REL.tmp" "$dest/$DEP_REL"
  # A clone that removes a harness's registration must not keep that harness's file. The directory census
  # (test_gate_coverage.sh) reads the tree it is run in, and a check file with no registration in that tree is
  # an uncovered check by its rule — so the strip above is only half of the act, and this is the other half.
  rm -f "$dest/src/tools/test_gate_words.sh"
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
  # Aim the clone at the hook SET this harness just wrote — a set carrying BOTH the secret guard's
  # pre-commit forwarder and a commit-msg that calls the subject helper. This used to read the ENCLOSING
  # repo's consulted path and aim the fixture there, which made the clone's armed state a fact about
  # whichever host ran the gate: on a crew box it inherited a real set, on a customer box it fell back to
  # `.githooks` (pre-commit, no commit-msg) and every cell below that asks about commit-msg went red for
  # the host, not the code. AIM_TAKEN records which set this run wrote, so the note line can say it.
  local aim; aim=$(write_fixture_set) || { printf 'FAIL  could not write the fixture hook set\n' >&2; return 1; }
  AIM_TAKEN="$aim"
  git -C "$dest" config core.hooksPath "$aim"
  git -C "$dest" add -A >/dev/null
  git -C "$dest" commit -q -m "base: the tree under test" >/dev/null
  git -C "$dest" branch dev HEAD   # check_attributions.sh resolves its base from a published line
}
# The commit-msg arm check, run against a throwaway clone this harness aims, in the config world above.
# It is C's (iid 13, the check whose rc 1 made 13 of these cells red), so a tree that does not carry it yet
# gets a printed NOT-RUN line and no cells — never a pass worn by the half that did not run. Four faces,
# each paired: armed, an incumbent above the clone that lost commit-msg (a refusal), nothing installed at
# all (NOT APPLICABLE), and a clone aimed at its own pre-commit-only .githooks (also NOT APPLICABLE, which
# is the documented customer arming and must never read as tampering).
arm_cells() { # arm_cells <armed|broken|scrubbed|plainhooked> [global-file]
  local want="$1" gfile="${2:-$SCR/no-global}" out rc
  if [ ! -f "$SCR/clone/src/tools/check_subject_armed.sh" ]; then
    printf 'note  this face of the tree carries no check_subject_armed.sh: the arm-check half of the %s pair is NOT RUN here — the consulted-path cells are what this face asserts\n' "$want" >&2
    return 0
  fi
  # The clone's own LOCAL value is what git consults, so a face that models something ABOVE the clone has
  # to set the local aside first; aim_clone restores it.
  case "$want" in
    armed)     git -C "$SCR/clone" config --local core.hooksPath "$AIM_TAKEN" ;;
    broken)    git -C "$SCR/clone" config --local --unset core.hooksPath ;;
    scrubbed)  git -C "$SCR/clone" config --local --unset core.hooksPath ;;
    plainhooked) git -C "$SCR/clone" config --local core.hooksPath .githooks ;;
  esac
  out=$( cd "$SCR/clone/src" && env GIT_CONFIG_GLOBAL="$gfile" HOME="$SCR/home" sh tools/check_subject_armed.sh 2>&1 ); rc=$?
  git -C "$SCR/clone" config --local core.hooksPath "$AIM_TAKEN"
  case "$want" in
    armed)
      check "and the commit-msg arm check calls this clone armed (rc)" "$rc" "0"
      contains "$out" "subject-armed: ARMED" "and it names the set it consulted"
      lacks "$out" "NOT APPLICABLE" "an armed clone is never described as a face the check does not apply to"
      ;;
    broken)
      check "the arm check refuses a clone whose HOST carries a set that lost commit-msg (rc)" "$rc" "1"
      contains "$out" "NOT ARMED" "and the displaced state is said out loud, so a missing commit-msg can never read as armed"
      lacks "$out" "NOT APPLICABLE" "PAIRED — a host that DOES carry a hook set never gets the non-fatal face: this is the doormat negative"
      ;;
    scrubbed)
      check "the arm check exits 0 where nothing is installed above the clone (rc)" "$rc" "0"
      contains "$out" "NOT APPLICABLE" "and it names the face it is on, in words"
      contains "$out" "which does not exist" "and it names the consulted path it asked about"
      lacks "$out" "NOT ARMED" "a host that never had a guard is not reported as one that lost it"
      ;;
    plainhooked)
      check "the documented customer arming — a clone aimed at its own .githooks — is NOT APPLICABLE (rc)" "$rc" "0"
      lacks "$out" "NOT ARMED" "and it is never called tampering: that set ships pre-commit only, everywhere"
      ;;
  esac
}
plant_loud()  { printf '#!/bin/sh\n# a planted fixture for src/tools/test_gate_words.sh — not shipped\nprintf "GATEWORD-LOUD: the check speaks, the wrapper does not\\n" >&2\nexit %s\n' "$2" > "$1"; }
plant_quiet() { printf '#!/bin/sh\n# a planted fixture for src/tools/test_gate_words.sh — not shipped\nexit %s\n' "$2" > "$1"; }
run_deploy()  { ( cd "$SCR/clone/src" && env -u MQTT_LEAD_NICK EXT=fs-gate TARGET="$SCR/clone/target" \
                    bash tools/deploy-tabichat.sh > "$SCR/out.txt" 2>&1 ); printf '%s' "$?"; }
# The CASE 7 family runs the same deploy in its OWN clones, so it needs the same call with the clone
# named — the env is identical except for the one variable a skip is decided on.
run_deploy_in() { # $1 = clone dir
  ( cd "$1/src" && env -u MQTT_LEAD_NICK EXT=fs-gate TARGET="$1/target" \
      bash tools/deploy-tabichat.sh > "$SCR/out.txt" 2>&1 ); printf '%s' "$?";
}
run_nossl() { # $1 = clone dir, $2 = a PATH dir with no openssl in it
  ( cd "$1/src" && env -u MQTT_LEAD_NICK PATH="$2" EXT=fs-gate TARGET="$1/target" \
      bash tools/deploy-tabichat.sh > "$SCR/out.txt" 2>&1 ); printf '%s' "$?";
}
# A PATH that has no `openssl` in it, built from symlinks and nothing else: no host change, no removal,
# no mount namespace. The names outside the system directories are linked too — the deploy reaches `bun`
# through an absolute default, but nested runs look several of these up by NAME, and a missing one is an
# instrument fault wearing a product face (measured at this leg's first run: `command -v bun` came back
# empty under a /usr-only PATH, and the refusal that followed was about node, not about openssl).
build_noopenssl_bin() {
  local d="$SCR/nossl-bin" src extra p
  rm -rf "$d"; mkdir -p "$d" || return 1
  for src in /usr/bin /bin /usr/local/bin /usr/sbin /sbin; do
    [ -d "$src" ] || continue
    ln -sf "$src"/* "$d"/ 2>/dev/null || true
  done
  for extra in bun node npm uv pi; do
    p=$(command -v "$extra" 2>/dev/null) && ln -sf "$p" "$d/$extra"
  done
  rm -f "$d/openssl"
  printf '%s' "$d"
}
# Trim THIS CLONE's arrays for the CASE 7 faces: the shell-gate array down to two names — the declared
# no-openssl gate and one ordinary gate — and the other gate arrays emptied, the way
# src/tools/test_paho_skip.sh empties the arrays it is not about. Why the emptying, stated as measured:
# the stage order in the deployer is GATES -> SHGATES -> PYGATES (`src/tools/deploy-tabichat.sh:236`,
# `:394`, `:426`), so on a PATH with no `openssl` the shell stage IS reached, and first — its
# `WARNING: … did NOT RUN` line prints — and the run then stops later at
# `src/tools/test_tlsenv.py:214`, which names the same binary (`FileNotFoundError`, rc 1). PYGATES is
# emptied here so that unrelated stop does not decide THIS cell's exit code; it is not because the shell
# stage is unreachable, and that gate's own capability question is a separate leg
# (`F-deploy-stage-required-openssl-since-the-shipped-tag`). The emptiness guard at the array site needs
# at least one shell member, which is why one ordinary gate stays in rather than the array going empty.
trim_shgates_ssl() { # $1 = a clone's deploy-tabichat.sh
  python3 - "$1" <<'PY' || return 1
import sys
p = sys.argv[1]; s = open(p).read()
for arr in ("GATES", "PYGATES", "PHYSICAL"):
    a = '  for t in "${%s[@]}"; do' % arr
    if a in s:
        s = s.replace(a, '  %s=()   # emptied by test_gate_words.sh CASE 7\n%s' % (arr, a), 1)
i = s.index('  SHGATES=(check_guard_armed.sh)')
j = s.index('  [ "${#SHGATES[@]}" -gt 0 ]')
new = ('  SHGATES=(test_mint_pki.sh check_release_record.sh)   # trimmed by test_gate_words.sh\n'
       '  SHGATES_NO_OPENSSL=(test_mint_pki.sh)\n')
open(p, 'w').write(s[:i] + new + s[j:])
PY
}
OUT=""; RC=0
fire() { RC=$(run_deploy); OUT=$(cat "$SCR/out.txt"); }

say "THE CLONE IS A REAL ONE — the three shipped shell gates pass in it BEFORE any plant is registered"
build_clone "$SCR/clone" "" || { printf 'FAIL  could not build the scratch clone\n' >&2; exit 1; }
printf 'note  the fixture clone is aimed at core.hooksPath=%s — a set THIS harness wrote in its own scratch dir, so the armed state is modelled, not inherited from the host\n' "$AIM_TAKEN" >&2
for t in check_guard_armed.sh check_attributions.sh test_attribution_pins.sh; do
  ( cd "$SCR/clone/src" && sh "tools/$t" >/dev/null 2>&1 ); check "the clone's own $t is green (rc=0)" "$?" "0"
done

say "THE AIM IS A SET — every consulted hook name exists where the clone is pointed (iid 15)"
# The half that the old aim was blind to: one value replaces the whole consulted set, so a set that
# carries pre-commit and not commit-msg reads as armed to the guard check and displaced to every other.
check "the clone's consulted commit-msg is a real file, not displaced by the aim" "$(consulted_face "$SCR/clone" commit-msg)" "exists"
sdir=$(consulted_dir "$SCR/clone" pre-commit); cdir=$(consulted_dir "$SCR/clone" commit-msg)
check "and both consulted names resolve into the SAME set, which is the one value hooksPath replaces" "$([ -n "$sdir" ] && [ "$sdir" = "$cdir" ] && echo same || echo differ)" "same"
arm_cells armed

say "PAIRED — a clone whose HOST carries a set that lost commit-msg must still be refused, never read as armed"
# Root AGENTS.md sec.2 asked of every gate: the case it rejects gets a cell. These re-aims are legal only
# because $SCR/clone is a throwaway fixture the harness makes and destroys; no real venue is touched, and
# arm_cells puts the clone's own aim back before it returns.
git -C "$SCR/clone" config --local core.hooksPath "$SCR/set-broken"
check "a set carrying pre-commit and no commit-msg consults an absent commit-msg" "$(consulted_face "$SCR/clone" commit-msg)" "absent"
git -C "$SCR/clone" config --local --unset core.hooksPath
arm_cells broken "$SCR/g-broken"
check "and the clone's own aim is back on the armed set after the cell" "$(consulted_face "$SCR/clone" commit-msg)" "exists"

say "THE NON-FATAL FACES — nothing installed above the clone, and the arming this repo documents"
# Two customer states, one answer each side of the line the rule draws. Nothing installed anywhere is
# NOT APPLICABLE; a clone aimed at its own pre-commit-only .githooks — which is exactly what this repo's
# header tells a customer to run — is NOT APPLICABLE too, because that set has never carried a commit-msg
# on any host, so there is no guard there that could have been lost.
mkdir -p "$SCR/emptyhooks"
arm_cells scrubbed
arm_cells plainhooked
git -C "$SCR/clone" config --local core.hooksPath "$AIM_TAKEN"
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

say "CASE 7 — a gate declared as needing openssl, on a box that has none: named skip, rc 0, nothing swallowed"
# WHY THIS CASE LIVES HERE: it is about what the shell-gate loop is allowed to SAY. A gate that skips
# itself with rc 0 prints to a capture the success path never shows, so the skip has to be said by the
# loop, in the loop's own words, from the declared set — the shape PYGATES_NO_PAHO already uses. Three
# faces, each paired: absent capability (skip and complete), capability present (no skip line at all),
# and present-but-broken (the declared set is NOT a doormat: it still stops the deploy).
# The clone's array is trimmed to two gates for these runs, the shipped tree untouched, so the cells
# measure the loop's decision and not every registered gate's runtime — the same scoping
# src/tools/test_paho_skip.sh uses for its deploy faces.
dep7=$(cat "$REPO/$DEP_REL")
check "SHGATES_NO_OPENSSL is declared as its own array (1 line)" "$(printf '%s\n' "$dep7" | grep -cE '^[[:space:]]*SHGATES_NO_OPENSSL=\(')" "1"
check "and the skip sentence names the loop variable, not one hardcoded gate (0 literal sites)" "$(printf '%s\n' "$dep7" | grep -c 'tools/test_mint_pki.sh did NOT RUN')" "0"
ssl_orphans=$(printf '%s\n' "$dep7" | sed -n 's/^[[:space:]]*SHGATES_NO_OPENSSL=(\(.*\))/\1/p' | tr -d '()' | tr ' \t' '\n\n' | grep . || true)
sh_mem=$(printf '%s\n' "$dep7" | grep -E '^[[:space:]]*SHGATES\+?=\(' | sed 's/^[^=]*=+*//' | tr -d '()' | tr ' \t' '\n\n' | grep . || true)
bad_orphan=0
for n in $ssl_orphans; do printf '%s\n' "$sh_mem" | grep -qxF "$n" || bad_orphan=$((bad_orphan + 1)); done
check "every declared name is also a registered gate — a stale declaration would name nothing (0)" "$bad_orphan" "0"

BINN=$(build_noopenssl_bin) || { printf 'FAIL  could not build a PATH without openssl\n' >&2; exit 1; }
# The link list is written down because two of these cells passed vacuously at this leg's first run: the
# trimmed dir inherited a `openssl` symlink from /usr/local/bin and a shadowed `python3`, so the "no
# openssl" claim was FALSE and a rc came back 1 for a reason outside this loop. A cell that cannot fail
# is not a cell: the dir is printed, the lookup is asserted empty, and the names the deploy needs are
# asserted present, one per lookup (dash's `command -v` prints only the first of several arguments).
printf 'note  the trimmed bin dir holds %s links; `ls` names them here so a stray openssl entry cannot hide:\n' "$(ls "$BINN" | grep -c .)" >&2
printf '%s\n' "$(ls "$BINN" | grep -E '^(openssl|python3|bun|bash|sh)$' | tr '\n' ' ')" >&2
check "CONTROL — this environment finds openssl" "$(command -v openssl >/dev/null 2>&1 && echo found || echo absent)" "found"
check "and the trimmed PATH does not" "$(env -i PATH="$BINN" sh -c 'command -v openssl >/dev/null 2>&1 && echo found || echo absent')" "absent"
# One lookup per name: POSIX `command -v` takes a single argument, and dash prints only the first hit,
# so a four-name call returns 1 whether or not the others resolve (measured at this leg's first run).
found_n=0
for b in bash sh python3 git; do
  env -i PATH="$BINN" sh -c "command -v $b >/dev/null 2>&1" && found_n=$((found_n + 1))
done
check "while the trimmed PATH still resolves the four names the deploy needs (4)" "$found_n" "4"

build_clone "$SCR/clone_ssl" "" || { printf 'FAIL  clone\n' >&2; exit 1; }
trim_shgates_ssl "$SCR/clone_ssl/$DEP_REL" || { printf 'FAIL  could not trim the clone array\n' >&2; exit 1; }
RC=$(run_nossl "$SCR/clone_ssl" "$BINN"); OUT=$(cat "$SCR/out.txt")
check "openssl-less host: the deploy completes (rc=0)" "$RC" "0"
contains "$OUT" "WARNING: openssl is absent on this box — tools/test_mint_pki.sh did NOT RUN" "the skip names the gate it skipped"
contains "$OUT" "gate: sh tools/check_release_record.sh" "the other registered gate still ran"
contains "$OUT" "deployed set complete and identical" "and the run ends with its completion line"
check "exactly one gate was skipped" "$(printf '%s\n' "$OUT" | grep -c 'did NOT RUN')" "1"
check "and it is the declared one, never an undeclared gate" "$(printf '%s\n' "$OUT" | grep 'did NOT RUN' | grep -vc test_mint_pki)" "0"

say "CASE 7b — PAIRED: with openssl present, no skip line appears and the gate ran"
build_clone "$SCR/clone_with" "" || exit 1
trim_shgates_ssl "$SCR/clone_with/$DEP_REL" || exit 1
RC=$(run_deploy_in "$SCR/clone_with"); OUT=$(cat "$SCR/out.txt")
check "the deploy completes (rc=0)" "$RC" "0"
check "no skip line was printed anywhere (0)" "$(printf '%s\n' "$OUT" | grep -c 'did NOT RUN')" "0"
contains "$OUT" "gate: sh tools/test_mint_pki.sh" "the gate was run, not skipped"
contains "$OUT" "deployed set complete and identical" "and the deploy finished"

say "CASE 7c — PAIRED: the declared set is not a doormat — openssl present and the gate broken still stops"
build_clone "$SCR/clone_broke" "" || exit 1
trim_shgates_ssl "$SCR/clone_broke/$DEP_REL" || exit 1
python3 - "$SCR/clone_broke/src/tools/test_mint_pki.sh" <<'PY' || { printf 'FAIL  could not plant\n' >&2; exit 1; }
import sys
p = sys.argv[1]; lines = open(p).read().split('\n')
for i, l in enumerate(lines):
    if l.startswith('[ "$failed" -gt 0 ] && exit 1'):
        lines.insert(i, 'bad "PLANTED gate-word probe: this gate must still refuse" "planted for CASE 7c"')
        break
else:
    raise SystemExit('anchor not found')
open(p, 'w').write('\n'.join(lines))
PY
RC=$(run_deploy_in "$SCR/clone_broke"); OUT=$(cat "$SCR/out.txt")
check "the deploy STOPS (rc=1)" "$RC" "1"
contains "$OUT" "test_mint_pki.sh is not green: it ran and exited 1." "with the gate's own code, not a borrowed cause"
contains "$OUT" "PLANTED gate-word probe" "and the check's own words survived"
check "and no skip line was printed for a box that HAS openssl (0)" "$(printf '%s\n' "$OUT" | grep -c 'did NOT RUN')" "0"

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
