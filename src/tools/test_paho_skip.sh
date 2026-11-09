#!/usr/bin/env bash
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for the paho-mqtt exemption in src/tools/deploy-tabichat.sh — item F4.
#   bash src/tools/test_paho_skip.sh        (exit 1 on any failure)
#   sh   src/tools/test_paho_skip.sh        — the same, and this is how the deploy runs it: the shell-gate
#     loop consults `sh`, which is dash here. Both faces are required to agree; ported at a prior leg for that
#     reason, and it is now a registered member of SHGATES.
#
# WHAT WAS WRONG. The deploy probes for paho (`python3 -c "import paho.mqtt.client"`) and, on a host without
# it, skipped ONE GATE BY NAME: `[ "$t" = "test_wrap_rows.py" ]`. But PYGATES is written in two places and the
# second is an append — `PYGATES+=(… test_tabichat_cli.py)` — and `test_tabichat_cli.py` joined that array in
# this same release. It imports the client, so on a paho-less host it died exactly the way the exempted file
# did. Measured at 4f97ada6 by running every member both ways: without paho, test_wrap_rows.py rc 1 and
# test_tabichat_cli.py rc 1, the other five rc 0; with paho, all seven rc 0. So the count was two and the
# exemption said one, and a healthy-looking gate set refused with an unrelated-looking traceback.
#
# WHY THE CURE IS A SET AND NOT A SECOND NAME. Nobody had to touch the `if` when the append grew, so nothing
# could warn. Adding the second filename to the `if` leaves that same silent-drift shape for whoever adds a
# third. The exemption is now membership in a declared array, PYGATES_NO_PAHO, and the drift cells below DERIVE
# that set by running every member and require the declared list to equal it — so adding a gate that needs paho,
# or dropping one, fails a cell instead of widening a hole.
#
# WHY THE SET IS DERIVED BY RUNNING AND NEVER READ STATICALLY. Both files do `sys.path.insert(0, "../src")` at
# RUN time (test_wrap_rows.py:49, test_tabichat_cli.py:33) and only then import a first-party module that
# imports paho (src/tabichat_cli.py:83). A name-based AST closure over the gate file alone answers "no" for
# both — a confidently wrong answer, which is worse than no answer because it looks like a measurement. A static
# read of a dynamic path insert is not evidence, so there is no static read here.
#
# MEMBERSHIP MEANS "DIES WITHOUT IT", NOT "MENTIONS IT". test_tlsenv.py imports paho through the same client
# and returns rc 0 without it, so it runs on a paho-less host and is NOT exempt. The derived rule is the pair of
# observations the deploy actually acts on: non-zero on a paho-less interpreter AND zero on a host that has one.
#
# WHY EVERY BEHAVIOUR CELL RUNS THE REAL SCRIPT. Same rule as test_gate_words.sh: a copied driver drifts from
# the original and hides a regression. Each cell runs `deploy-tabichat.sh` against a scratch tree of THIS face
# with EXT=fs-gate. Two arrays are emptied in that tree — the bun GATES and the shell SHGATES — because they
# would otherwise run a full deploy's whole suite inside a test (and the armed-guard check refuses outside a git
# work tree). Nothing else is touched: the python loop under test, the probe above it, and the skip branch are
# the shipped code, and the static cells below prove the shipped arrays are not empty before any strip is used.
#
# WHY THIS FILE IS REGISTERED IN SHGATES NOW, and what a prior leg's ruling does NOT extend to. a prior leg left it
# out on two readings: that it counts the gate arrays while its own planted faces rewrite them (a prior leg's reason
# for test_secret_guard.sh), and that the shell loop consults `sh` while this file carried bash-only process
# substitutions. The second was real and is now fixed — the two `<(...)` sites are a temp-file set comparison,
# and the 34 cells agree under `sh` and `bash`. The first does not apply as written: this file counts the arrays
# of the SHIPPED tree, statically, and rewrites only a scratch clone it built for itself, in which it strips
# GATES and SHGATES so the nested deploy cannot re-run this very file. A member that reads the shipped array and
# mutates only its own copy asserts one number about one tree. test_secret_guard.sh is different in kind — its
# planted faces rewrite the registration in a clone that the deploy then runs through the FULL shell stage, so
# registering it would have the loop consult an array the census had already changed. That stays excluded, and
# test_gate_coverage.sh prints the reason every run.
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

SCR=$(mktemp -d "${TMPDIR:-/tmp}/paho-skip-XXXXXX") || { printf 'no scratch dir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_SCR:-}" ] || rm -rf "$SCR"; }
trap cleanup EXIT INT TERM
BUN="${BUN:-$(command -v bun || true)}"
GOOD_NAME="Tabith LLC"; GOOD_MAIL="info@tabith.com"

# The absent face is a STUB on PYTHONPATH, not a host change: the stub package is found before site-packages
# and raises, so `import paho.mqtt.client` fails whether or not this box has paho installed.
mkdir -p "$SCR/nopaho/paho"
printf 'raise ImportError("paho is stubbed absent for this cell")\n' > "$SCR/nopaho/paho/__init__.py"

members_of() {  # $1 = script path, $2 = array name -> one member per line, read from BOTH assignment shapes
  grep -E "^[[:space:]]*$2\+?=\(" "$1" | sed 's/^[^=]*=+*//' | tr -d '()' | tr ' \t' '\n\n' | grep . || true
}

# grep_absent <lines to test> <the allowed lines> -> prints the members of the first list that are absent
# from the second. A temp file rather than a process substitution, because the shell-gate loop runs
# `sh tools/<name>` and /bin/sh on this box is dash: `grep -vxF -f <(printf …)` is bash-only and dash stops
# the whole file at parse time (measured at a prior leg: `sh src/tools/test_paho_skip.sh` -> rc 2,
# `Syntax error: "(" unexpected`). Same predicate, same output, one fewer interpreter dependency — the
# exemption is a SET, and the set check has to run in the shell that the deploy actually uses.
grep_absent() {
  local pat
  pat=$(mktemp "${TMPDIR:-/tmp}/paho-skip-set-XXXXXX") || return 1
  printf '%s\n' "$2" > "$pat"
  printf '%s\n' "$1" | grep -vxF -f "$pat" || true
  rm -f "$pat"
}
GATE_MEMBERS=$(members_of "$REPO/$DEP_REL" PYGATES | sort -u)
DECLARED=$(members_of "$REPO/$DEP_REL" PYGATES_NO_PAHO | sort -u)

say "THE ARRAYS ARE THERE, AND THE OLD SINGLE-NAME EXEMPTION IS GONE"
check "PYGATES holds seven members across both assignment shapes" "$(printf '%s\n' "$GATE_MEMBERS" | grep -c .)" "7"
check "and PYGATES_NO_PAHO is declared as its own array (1 line)" \
      "$(grep -cE '^[[:space:]]*PYGATES_NO_PAHO=\(' "$REPO/$DEP_REL")" "1"
check "the declared exemption holds two names" "$(printf '%s\n' "$DECLARED" | grep -c .)" "2"
old=$(grep -cF '[ "$t" = "test_wrap_rows.py" ]' "$REPO/$DEP_REL" || true)
check "the exemption no longer tests one filename (0 sites)" "$old" "0"
hard=$(grep -c 'tools/test_wrap_rows.py did NOT RUN' "$REPO/$DEP_REL" || true)
check "and the skip line is not hard-wired to one gate either — it names the loop variable (0 sites)" "$hard" "0"
says=$(grep -c 'tools/\$t did NOT RUN' "$REPO/$DEP_REL" || true)
# Re-derived at this face: 2, not 1. The second is NOT a paho line — it is the openssl family
# (`SHGATES_NO_OPENSSL`), declared the same way and saying its own cause, and its faces live in
# src/tools/test_gate_words.sh CASE 7, not here. This cell counts a SHAPE in the deployer — a skip that
# names the gate from the loop variable — so when the shape legitimately gains an instance the number
# moves with it, and the paired cells above and below are what stop the move from hiding a hard-wired
# name or an orphaned declaration.
check "every capability skip names the gate it skipped, from the loop variable (2: paho family + openssl family)" "$says" "2"
mint_hard=$(grep -c 'tools/test_mint_pki.sh did NOT RUN' "$REPO/$DEP_REL" || true)
check "PAIRED — and neither family hard-wires a gate name into its skip (0 sites)" "$mint_hard" "0"
orphan=$(grep_absent "$DECLARED" "$GATE_MEMBERS")
check "every exempted name is a member of PYGATES — a stale exemption names nothing (0 orphans)" \
      "$(printf '%s' "$orphan" | grep -c . )" "0"
check "the bun GATES array is not empty in the shipped tree (>=1)" \
      "$([ "$(members_of "$REPO/$DEP_REL" GATES | grep -c .)" -gt 0 ] && echo yes || echo no)" "yes"
check "the shell SHGATES array is not empty in the shipped tree (>=1)" \
      "$([ "$(members_of "$REPO/$DEP_REL" SHGATES | grep -c .)" -gt 0 ] && echo yes || echo no)" "yes"

# --------------------------------------------------------------------- scratch trees of this face
build_tree() { # $1 = path
  local dest="$1"; rm -rf "$dest"; mkdir -p "$dest"
  git -C "$REPO" archive --format=tar HEAD | tar -x -C "$dest" || return 1
  local f
  for f in $(git -C "$REPO" diff --name-only HEAD) $(git -C "$REPO" ls-files --others --exclude-standard); do
    [ -f "$REPO/$f" ] && cp "$REPO/$f" "$dest/$f"
  done
}
strip_other_gates() { # $1 = script path — empty the two arrays this file is not about
  python3 - "$1" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
for arr in ("GATES", "SHGATES"):
    a = '  for t in "${%s[@]}"; do' % arr
    assert a in s, a
    s = s.replace(a, '  %s=()   # emptied by test_paho_skip.sh\n' % arr + a, 1)
open(p, "w").write(s)
PY
}
after_last_pygates_reg() { # $1 = script path, $2 = names -> insert `PYGATES+=(names)` inside the array
  local ln; ln=$(grep -n '^[[:space:]]*PYGATES+=(' "$1" | tail -1 | cut -d: -f1)
  [ -n "$ln" ] || return 1
  { head -n "$ln" "$1"; printf '  PYGATES+=(%s)\n' "$2"; tail -n "+$((ln + 1))" "$1"; } > "$1.tmp" && mv "$1.tmp" "$1"
}

fire_deploy() { # $1 = tree, $2 = target dir, $3 = extra python gate names (space separated), "" for none
  local tree="$1" tgt="$2" extra="${3:-}" f="$1/$DEP_REL"
  strip_other_gates "$f" || { printf 'FAIL  could not strip the other gate arrays\n' >&2; return 1; }
  if [ -n "$extra" ]; then
    local n
    for n in $extra; do
      after_last_pygates_reg "$f" "$n" || { printf 'FAIL  no PYGATES+= line to plant after\n' >&2; return 1; }
      printf '#!/usr/bin/env python3\nimport paho.mqtt.client\nprint("PLANT-OK")\n' > "$tree/src/tools/$n"
    done
  fi
  RC=$( cd "$tree/src" && env HOME="$HOME" BUN="${BUN:-bun}" EXT=fs-gate TARGET="$tgt" \
        PYTHONPATH="$SCR/nopaho" bash tools/deploy-tabichat.sh > "$SCR/out.txt" 2>&1; printf '%s' "$?" )
  OUT=$(cat "$SCR/out.txt")
}

say "CELL 1 — THE DEPLOY ON A PAHO-LESS HOST: both paho gates are skipped, each by name, and it finishes"
build_tree "$SCR/fix" || { printf 'FAIL  could not build the scratch tree\n' >&2; exit 1; }
fire_deploy "$SCR/fix" "$SCR/fix/tgt" || exit 1
check "paho-less host: the deploy completes (rc=0)" "$RC" "0"
check "exactly two gates were skipped" "$(printf '%s\n' "$OUT" | grep -c 'did NOT RUN')" "2"
contains "$OUT" "WARNING: python3 has no paho-mqtt — tools/test_wrap_rows.py did NOT RUN" "the name it always skipped"
contains "$OUT" "WARNING: python3 has no paho-mqtt — tools/test_tabichat_cli.py did NOT RUN" "and the name the old single-filename test never reached"
contains "$OUT" "gate: python3 tools/test_broker.py" "the other members still ran"
contains "$OUT" "gate: python3 tools/test_tlsenv.py" "including the one that imports paho and survives without it"
contains "$OUT" "deployed set complete and identical" "a skip is not a refusal, and the deploy says so at the end"
check "no gate was skipped that is not exempt" "$(printf '%s\n' "$OUT" | grep 'did NOT RUN' | grep -vc -e test_wrap_rows.py -e test_tabichat_cli.py)" "0"

say "CELL 2 — PAIRED NEGATIVE, ONE BLOCK REVERTED: the pre-fix exemption dies on the second name"
build_tree "$SCR/pre" || exit 1
python3 - "$SCR/pre/$DEP_REL" <<'PY' || exit 1
import sys
p = sys.argv[1]; s = open(p).read()
new = '''      nopaho=0
      for k in "${PYGATES_NO_PAHO[@]}"; do [ "$k" = "$t" ] && nopaho=1; done
      if [ "$nopaho" = 1 ] && [ "${PY_HAVE_PAHO:-1}" = 0 ]; then
        say "WARNING: python3 has no paho-mqtt — tools/$t did NOT RUN"'''
old = '''      if [ "$t" = "test_wrap_rows.py" ] && [ "${PY_HAVE_PAHO:-1}" = 0 ]; then
        say "WARNING: python3 has no paho-mqtt — tools/test_wrap_rows.py did NOT RUN"'''
assert new in s, "the membership block is not where this cell expects it"
open(p, "w").write(s.replace(new, old, 1))
PY
fire_deploy "$SCR/pre" "$SCR/pre/tgt" || exit 1
check "pre-fix exemption: the deploy refuses (rc=1)" "$RC" "1"
contains "$OUT" "REFUSED: test_tabichat_cli.py is not green" "the second name died exactly as the first one did"
check "and only one gate was skipped before it died" "$(printf '%s\n' "$OUT" | grep -c 'did NOT RUN')" "1"
lacks "$OUT" "tools/test_tabichat_cli.py did NOT RUN" "it was never offered a skip"
lacks "$OUT" "deployed set complete" "the run stopped at the gate stage"

say "CELL 3 — PAIRED NEGATIVE, THE SKIP MUST NOT SWALLOW A REAL FAILURE"
# A gate that fails for its own reasons has to refuse WITH ITS CODE AND ITS WORDS even on a paho-less host.
# The plant is not in PYGATES_NO_PAHO, so membership — not a pattern-match on its output — is the only thing
# that can exempt it, and it must not be.
build_tree "$SCR/fail" || exit 1
strip_other_gates "$SCR/fail/$DEP_REL" || exit 1
after_last_pygates_reg "$SCR/fail/$DEP_REL" "gate_realfail.py" || exit 1
printf '#!/usr/bin/env python3\nimport sys\nprint("PAHO-SKIP-PLANT: an assertion, not an availability problem", file=sys.stderr)\nsys.exit(1)\n' > "$SCR/fail/src/tools/gate_realfail.py"
RC=$( cd "$SCR/fail/src" && env HOME="$HOME" BUN="${BUN:-bun}" EXT=fs-gate TARGET="$SCR/fail/tgt" \
      PYTHONPATH="$SCR/nopaho" bash tools/deploy-tabichat.sh > "$SCR/out.txt" 2>&1; printf '%s' "$?" )
OUT=$(cat "$SCR/out.txt")
check "a gate that fails for real still refuses (rc=1)" "$RC" "1"
contains "$OUT" "PAHO-SKIP-PLANT" "its own words come out, not a paraphrase"
contains "$OUT" "REFUSED: gate_realfail.py is not green" "and the refusal names the gate that failed"
check "the skip branch never fired for the plant itself (0 skip lines naming it)" "$(printf '%s\n' "$OUT" | grep -c 'gate_realfail.py did NOT RUN' || true)" "0"

say "CELL 4 — THE TRIPWIRE: the declared set is derived by RUNNING, and must equal what was declared"
# Each member is run twice: once on this host's python3, once on a paho-less interpreter. The exemption set is
# exactly the members that die WITHOUT paho and pass WITH it — the pair the deploy acts on.
if python3 -c "import paho.mqtt.client" >/dev/null 2>&1; then HAVE_PAHO=1; else HAVE_PAHO=0; fi
derive_set() { # $1 = tree src dir, $2 = member list (newline) -> derived member names, one per line
  local srcdir="$1" list="$2" n rc_no rc_yes d
  for n in $list; do
    [ -f "$srcdir/tools/$n" ] || continue
    ( cd "$srcdir" && PYTHONPATH="$SCR/nopaho" python3 "tools/$n" >/dev/null 2>&1 ); rc_no=$?
    if [ "$HAVE_PAHO" = 1 ]; then
      ( cd "$srcdir" && python3 "tools/$n" >/dev/null 2>&1 ); rc_yes=$?
    else rc_yes=0; fi
    [ "$rc_no" != 0 ] && [ "$rc_yes" = 0 ] && printf '%s\n' "$n"
  done
}
derived=$(cd "$REPO/src" && derive_set "$REPO/src" "$GATE_MEMBERS" | sort -u)
if [ "$HAVE_PAHO" = 0 ]; then
  printf 'note  NOT RUN as a comparison — this host has no paho-mqtt, so the "passes with paho" half of the pair cannot be observed here. The behaviour cells above are what this box measured.\n' >&2
else
  check "derived set equals the declared set" "$(printf '%s\n' "$derived")" "$(printf '%s\n' "$DECLARED")"
  check "and the derivation is not empty — it found the two names by running them" "$(printf '%s\n' "$derived" | grep -c .)" "2"
  tls_in=$(printf '%s\n' "$derived" | grep -c '^test_tlsenv.py$' || true)
  check "test_tlsenv.py imports paho but survives without it, so it is NOT exempt (0)" "$tls_in" "0"
fi

say "CELL 5 — THE TRIPWIRE HAS TEETH: a planted paho gate that the declared list does not name is refused"
build_tree "$SCR/plant" || exit 1
after_last_pygates_reg "$SCR/plant/$DEP_REL" "gate_needs_paho.py" || exit 1
printf '#!/usr/bin/env python3\nimport paho.mqtt.client\nprint("PLANT-OK")\n' > "$SCR/plant/src/tools/gate_needs_paho.py"
planted_members=$(members_of "$SCR/plant/$DEP_REL" PYGATES | sort -u)
planted_derived=$(cd "$SCR/plant/src" && derive_set "$SCR/plant/src" "$planted_members" | sort -u)
plant_declared=$(members_of "$SCR/plant/$DEP_REL" PYGATES_NO_PAHO | sort -u)
check "the planted gate really does die without paho, so the derivation counts it too" \
      "$(printf '%s\n' "$planted_derived" | grep -c .)" "$([ "$HAVE_PAHO" = 1 ] && echo 3 || echo 2)"
check "and the declared list does not name it, so the tripwire must refuse (mismatch)" \
      "$([ "$planted_derived" = "$plant_declared" ] && echo equal || echo differs)" "differs"
contains "$(printf '%s\n' "$planted_derived")" "gate_needs_paho.py" "the name it would have to be told about"

say "CELL 6 — THE OTHER DIRECTION: dropping a gate from PYGATES while leaving it exempted is refused too"
build_tree "$SCR/drop" || exit 1
python3 - "$SCR/drop/$DEP_REL" <<'PY' || exit 1
import sys
p = sys.argv[1]; s = open(p).read()
old = "  PYGATES+=(test_tlsenv.py test_addressing.py test_paste.py test_presence.py test_tabichat_cli.py)"
assert old in s, "the append line is not where this cell expects it"
open(p, "w").write(s.replace(old, "  PYGATES+=(test_tlsenv.py test_addressing.py test_paste.py test_presence.py)", 1))
PY
drop_members=$(members_of "$SCR/drop/$DEP_REL" PYGATES | sort -u)
check "the dropped name is no longer a member (0)" "$(printf '%s\n' "$drop_members" | grep -c '^test_tabichat_cli.py$')" "0"
drop_orphan=$(grep_absent "$DECLARED" "$drop_members")
check "but it is still declared exempt, so the orphan test refuses it (1 orphan)" "$(printf '%s' "$drop_orphan" | grep -c .)" "1"

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells' "$failed" "$ran" || printf 'all %d paho-skip cells pass' "$ran")"
[ "$failed" -gt 0 ] && exit 1
exit 0
