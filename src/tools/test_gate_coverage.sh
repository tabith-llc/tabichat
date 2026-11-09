#!/usr/bin/env bash
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Directory-coverage census for src/tools/ — tabichat iid 13's coverage cell.
#   bash src/tools/test_gate_coverage.sh        (exit 1 on any refusal)
#   runs under sh/dash too, which matters: the shell-gate loop invokes `sh tools/<name>`, not bash.
#
# WHY THIS FILE EXISTS. Three lanes found the same hole from three sides this session: a check can sit in
# src/tools/, be true, be run by nobody, and stay invisible. `test_deploy_pi_nm.sh` is the proof — it pinned
# a line a prior leg deleted, printed rc 1 with eight failed cells, and the 37-line stage passed beside it,
# because the arrays were counted and nothing enumerated the directory. A census over the arrays alone
# cannot see the file no array names, which is exactly iid 13's complaint.
#
# WHAT IT ASSERTS. Every regular file in src/tools/ whose name begins `test_` or `check_` is named by at
# least one gate array of src/tools/deploy-tabichat.sh — GATES, PYGATES, SHGATES, or PHYSICAL — or appears on
# the EXCLUDED list below, where every entry must also be a real file and must still be absent from every
# array. So the list cannot quietly grow stale in the flattering direction: registering a file that is still
# on the list is a refusal naming it, the same way an uncovered file is.
#
# WHY PHYSICAL COUNTS AS CONSUMED. Its members have an executor — `bash src/tools/deploy-tabichat.sh
# --physical` runs them and refuses non-zero — so they are consumed even though a stage run never reaches
# them. Read without PHYSICAL the same denominator gives 7 uncovered, not 3, and a lane that quotes the wrong
# pair of numbers is arguing about a predicate, not a fact.
#
# WHAT THIS FILE DELIBERATELY DOES NOT DO, in both directions.
#   * It does not assert array LENGTHS. The interlock this leg hit is the reason:
#     `test_secret_guard.sh` pins the shell-gate array's member COUNT in prose ("the shell-gate array holds
#     N members across both forms", N re-derived at every face that registers a gate), and any registration
#     reddens that cell until someone re-derives the number by hand. A census that reads membership never
#     needs re-deriving; a census that repeats a count does, every merge.
#   * It does not run the deploy, and it rewrites nothing — which is what makes it safe to be a member of the
#     array it censuses. `test_secret_guard.sh` is not, and stays on the exclusion list: it rewrites the gate
#     arrays in a scratch clone and then runs the FULL shell stage through that clone, so as a member
#     it would assert one number about a tree holding another. `test_paho_skip.sh` was held out on a
#     reading that did not survive contact with its own code: it strips arrays only inside its own clone and
#     never re-runs itself, so it registered at a prior leg after a one-line dash port. The lesson the two cases
#     share is that an exclusion has to name the mechanism, not the shape it resembles.
#
# POSITIVE CONTROL, EVERY RUN. A coverage cell that cannot fail is decoration, so the last cells prove the
# predicate returns a nonzero orphan count: once on a synthetic listing with an invented name, and once
# against a real scratch tree holding a real unregistered file. Both are computed in a scratch directory and
# neither touches this repository.
set -uo pipefail

REPO=${CENSUS_REPO:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
DEP_REL="src/tools/deploy-tabichat.sh"
TOOLS_REL="src/tools"
[ -f "$REPO/$DEP_REL" ] || { printf 'FAIL  no deploy script at %s/%s — the census cannot run against nothing\n' "$REPO" "$DEP_REL"; exit 1; }
[ -d "$REPO/$TOOLS_REL" ] || { printf 'FAIL  no tools directory at %s/%s — the census cannot run against nothing\n' "$REPO" "$TOOLS_REL"; exit 1; }

failed=0; ran=0
ok()    { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad()   { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
say()   { printf '\n== %s ==\n' "$1"; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }

# The ruled exclusions, as a list with a reason per entry. Adding a name here is a decision a reviewer reads,
# so each entry states the mechanism, not a preference. Space-separated on purpose: the shell-gate loop runs
# this file under dash, which has no arrays.
EXCLUDED="test_secret_guard.sh"
exclusion_reason() {
  case "$1" in
    test_secret_guard.sh) printf '%s\n' 'it COUNTS the gate arrays while test_gate_words.sh rewrites those arrays in the scratch clone it deploys — the ruling recorded at src/tools/deploy-tabichat.sh in the SHGATES block; registering the counter would make a deploy assert one number about a tree it changed on purpose' ;;
    *) printf '%s\n' '(no reason recorded — an exclusion without one is the widening this file refuses)' ;;
  esac
}

members_of() { # $1 = deploy script, $2 = array name ; both the literal and every `+=` form, one member per line
  grep -E "^[[:space:]]*${2}\+?=" "$1" | sed 's/^[^=]*=+*//' | tr -d '()' | tr ' \t' '\n' | grep . || true
}
listing_of() { # every regular test_*/check_* file under $1/src/tools
  for f in "$1/$TOOLS_REL"/test_* "$1/$TOOLS_REL"/check_*; do
    [ -f "$f" ] && basename -- "$f"
  done
}
covered_of() { # the union of the four gate arrays of $1, sorted and unique
  { members_of "$1/$DEP_REL" GATES; members_of "$1/$DEP_REL" PYGATES;
    members_of "$1/$DEP_REL" SHGATES; members_of "$1/$DEP_REL" PHYSICAL; } | sort -u
}
orphans_of() { # $1 = root to census ; prints the names that are on disk, in no array, and not excluded
  root="$1"; orph=""; tmpm="$(mktemp)"
  covered_of "$root" > "$tmpm"
  for n in $(listing_of "$root" | sort -u); do
    grep -qxF "$n" "$tmpm" && continue
    case " $EXCLUDED " in *" $n "*) continue ;; esac
    orph="$orph $n"
  done
  rm -f "$tmpm"
  for n in $orph; do printf '%s\n' "$n"; done
}

say "THE ARRAYS THIS CENSUS READS ARE NON-EMPTY (a stripped array would cover nothing and look like a pass)"
for arr in GATES PYGATES SHGATES PHYSICAL; do
  n=$(members_of "$REPO/$DEP_REL" "$arr" | grep -c .)
  if [ "$n" -gt 0 ]; then ok "  $arr has $n member line(s) in the shipped script"; else bad "$arr is empty in $REPO/$DEP_REL" "an empty array reads as zero orphans and hides every file"; fi
done

say "THE CENSUS — every test_*/check_* file is covered, or excluded with a reason"
den=$(listing_of "$REPO" | sort -u | grep -c .)
orph_count=$(orphans_of "$REPO" | grep -c .)
exc_count=0; for e in $EXCLUDED; do exc_count=$((exc_count + 1)); done
printf 'note  denominator %s file(s) in src/tools/ named test_*/check_*, %s ruled exclusion(s), %s orphan(s)\n' "$den" "$exc_count" "$orph_count" >&2
check "no test_*/check_* file is uncovered and unexcluded" "$orph_count" "0"
orph_names=$(orphans_of "$REPO" | tr '\n' ' ')
[ "$orph_count" = "0" ] || printf '   uncovered: %s\n' "$orph_names" >&2

say "THE EXCLUSION LIST IS TRUE, NOT CONVENIENT"
# Each entry must be a real file that is still absent from every array. An entry whose file no longer exists,
# or which has since been registered, is a stale carve-out — the same shape this leg exists to remove, just
# pointing the other way.
for e in $EXCLUDED; do
  if [ ! -f "$REPO/$TOOLS_REL/$e" ]; then
    bad "exclusion $e" "no such file in src/tools/ — the list names something that is not there"
    continue
  fi
  inarray=$(covered_of "$REPO" | grep -cxF "$e")
  if [ "$inarray" = "0" ]; then
    ok "  $e is a real file and is named by no gate array, so its exclusion is doing work"
  else
    bad "exclusion $e is stale" "it is now a member of a gate array — remove it from EXCLUDED or the list is a lie"
  fi
done
reason=$(exclusion_reason "$EXCLUDED" | tr -d '\n')
case "$reason" in *'(no reason recorded'*) bad "every exclusion carries a reason" "an entry with no reason is a widening" ;; *) ok "  the exclusion carries its reason, and the reason is printed: $(printf '%s' "$reason" | cut -c1-60)…" ;; esac
printf 'note  exclusion %s — %s\n' "$EXCLUDED" "$reason" >&2

say "THE REGISTRATIONS 955 AND 958 LANDED ARE PRESENT BY NAME"
for g in test_deploy_pi_nm.sh test_gate_coverage.sh test_paho_skip.sh; do
  one=$(members_of "$REPO/$DEP_REL" SHGATES | grep -cxF "$g")
  check "  $g is a member of the shell-gate array" "$one" "1"
done
# And the interpreter claim is checked, not remembered: every SHGATES member is run by `sh`, so a member that
# is bash-only would stop every deploy with a parse error (the mirror of the booked fact that a .sh name in
# the bun GATES array reddens every run). The check is that this file parses under sh when sh is not bash.
if ! [ "$(readlink -f /bin/sh 2>/dev/null)" = "$(readlink -f "$(command -v bash)")" ]; then
  sh -n "$REPO/$TOOLS_REL/test_gate_coverage.sh" && ok "  this file parses under sh as the loop runs it" || bad "test_gate_coverage.sh does not parse under sh" "the shell-gate loop runs sh, not bash"
fi

say "POSITIVE CONTROL — THE PREDICATE CAN RETURN NON-ZERO (a coverage cell that cannot fail is decoration)"
SCR=$(mktemp -d "${TMPDIR:-/tmp}/gate-coverage-XXXXXX") || { printf 'FAIL  no scratch dir — the control cannot run, and a skipped control is not a pass\n' >&2; exit 1; }
trap 'rm -rf "$SCR"' EXIT INT TERM
mkdir -p "$SCR/tree/$TOOLS_REL"
cp "$REPO/$DEP_REL" "$SCR/tree/$DEP_REL"
for f in $(listing_of "$REPO"); do printf '' > "$SCR/tree/$TOOLS_REL/$f"; done
printf '' > "$SCR/tree/$TOOLS_REL/test_invented_by_the_control_955.sh"
syn=$(orphans_of "$SCR/tree" | tr '\n' ' ')
check "an invented name on the listing, in no array, is reported as exactly one orphan" "$(printf '%s' "$syn" | grep -c . )" "1"
contains "$syn" "test_invented_by_the_control_955.sh" "and the orphan is named, not counted"

say "THE REAL PLANT — a file that exists and is registered nowhere refuses this harness"
if [ -n "${CENSUS_PLANTING:-}" ]; then
  printf 'note  the plant face is already running one level up; not recursing\n' >&2
else
  mkdir -p "$SCR/plant/$TOOLS_REL"
  cp "$REPO/$DEP_REL" "$SCR/plant/$DEP_REL"
  for f in $(listing_of "$REPO"); do cp "$REPO/$TOOLS_REL/$f" "$SCR/plant/$TOOLS_REL/$f"; done
  printf '#!/usr/bin/env bash\n# a planted fixture for test_gate_coverage.sh — not shipped\nexit 0\n' > "$SCR/plant/$TOOLS_REL/test_zzz_planted_955.sh"
  pout=$(CENSUS_REPO="$SCR/plant" CENSUS_PLANTING=1 sh "$REPO/$TOOLS_REL/test_gate_coverage.sh" 2>&1); prc=$?
  check "the planted file makes the census refuse (rc=1)" "$prc" "1"
  contains "$pout" "test_zzz_planted_955.sh" "and it names the planted file"
  contains "$pout" "uncovered:" "and says which kind of finding it is"
  lacks "$pout" "all " "a refusal never reads as the pass sentence"
fi

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells — %s file(s) in src/tools/ carry no gate array and no ruled exclusion: %s' "$failed" "$ran" "$orph_count" "${orph_names:-none}" || printf 'all %d coverage cells pass — %s test_*/check_* files, %s excluded with a reason, 0 uncovered' "$ran" "$den" "$exc_count")"
[ "$failed" -gt 0 ] && exit 1
exit 0
