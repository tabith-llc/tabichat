#!/usr/bin/env bash
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for the DESTINATION LOAD-CHECK in src/tools/deploy-tabichat.sh — leg 953, iid 13's class.
#   bash src/tools/test_deploy_pi_nm.sh        (exit 1 on any failure)
#
# WHY THIS FILE MOVED, AND WHAT IT DID NOT LOSE. It was written at leg 905 against the pi install-tree
# derivation, whose cure was one `if`-wrapped assignment. Leg 947 DELETED that derivation — the guess it
# made about which `@earendil-works/pi-ai` the host resolves is what made the check refuse a healthy
# deployment — and leg 949 made the replacement hermetic. The pins here went on pointing at the deleted
# line, so the file went red on its own: not a product defect, and not the file's purpose either.
#
# THE PURPOSE OUTLIVED THE LINE. The previous header put it in one sentence, and it is still the rule this
# file enforces: "a missing derivation must never become a skipped check." That class now sits in three
# places in the shipped script: the load-check must RUN (an empty FILES or LOADCHECK array is a refusal,
# not a green); it must run BEFORE the files move (a refusal that publishes is half a deploy, which is the
# leg-579 outcome measured at 21b34e1); and its answer must be about THE TREE, not about the host that ran
# it (which is what the hermeticity scan is for). Every pin below points at one of those three.
#
# PIN LAW FOR THIS FILE, learned from its own red face: pin a STABLE FRAGMENT, never a whole line. A
# comment rewrap in the shipped script must not redden a guard — that is precisely how this file broke —
# and a guard that reddens on formatting is a guard someone will delete. So: short fragments, an explicit
# expected count on each, and every revert anchored, so a vanished fragment FAILS and names itself instead
# of quietly comparing against nothing.
#
# WHY EVERY CASE RUNS THE REAL SCRIPT WITH --no-gates. `--no-gates` skips the gate loops and STILL runs
# the load-check — the script says so itself ("gates skipped" must never mean "destination skipped") — and
# that is the region under test here. Running the real deploy rather than a copied driver is the rule
# test_gate_words.sh states: a driver drifts from the original and hides a regression. Skipping the gate
# loops is also what keeps this file safe to register later: the inner run never reaches the shell-gate
# array, so it cannot call itself back.
#
# THE PAIRED NEGATIVES REVERT ONE MECHANISM EACH, NOT ONE FILE. Each revert substitutes one anchored line
# and the ONLY difference between the surviving run and the failing run is that line. If a reverted run
# ever comes back rc 0 where the shipped mechanism refuses, this file has stopped measuring the defect it
# was written for and says so in its own words.
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

# ------------------------------------------------------------------ the pins, by fragment and count
countfrag() { # $1 = fragment ; prints how many lines of the shipped script contain it
  DEP_TEXT=$(cat "$REPO/$DEP_REL")
  printf '%s\n' "$DEP_TEXT" | grep -cF -- "$1" || true
}
pin() { # $1 = expected count, $2 = what it proves, $3 = the fragment (never a whole line)
  local want="$1" what="$2" frag="$3" got
  got=$(countfrag "$frag")
  check "$what" "$got" "$want"
}

SCR=$(mktemp -d "${TMPDIR:-/tmp}/deploy-pi-nm-XXXXXX") || { printf 'no scratch dir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_SCR:-}" ] || rm -rf "$SCR"; }
trap cleanup EXIT INT TERM
BUN="${BUN:-$(command -v bun || true)}"
ARM="${ARM:-tabichat}"          # which EXT arm the next fire() deploys; the tabichat arm is the one that carries the three externals

# ------------------------------------------------------------------ the scratch tree of THIS face
# Archived from HEAD plus this worktree's tracked changes and untracked files, exactly as
# test_gate_words.sh does, so the cell measures the bytes under review whether or not they are committed
# yet. It is NOT a git repo and does not need to be: the deploy calls git nowhere outside its gate loops,
# and every run here is --no-gates. `git archive` needs a .git, so this harness must be run from a real
# clone — measured at leg 953: run from an archive extraction it refuses here, and refusing is correct.
build_tree() { # $1 = path
  local dest="$1" f
  rm -rf "$dest"; mkdir -p "$dest"
  git -C "$REPO" archive --format=tar HEAD | tar -x -C "$dest" || return 1
  for f in $(git -C "$REPO" diff --name-only HEAD) $(git -C "$REPO" ls-files --others --exclude-standard); do
    [ -f "$REPO/$f" ] && cp "$REPO/$f" "$dest/$f"
  done
  # The loop's tail status is a fact about the last untracked file, not about the tree, so the tree is
  # judged by the one thing every cell needs: the deploy script must be present in it.
  [ -f "$dest/$DEP_REL" ]
}

must_build() { # every cell that needs a tree refuses out loud if it cannot have one — an empty directory is not a skipped check
  build_tree "$1" || { printf 'FAIL  could not build the scratch tree at %s — this harness runs `git archive`, which needs a real clone; refusing here rather than firing the deploy against an empty directory\n' "$1" >&2; exit 1; }
}

revert() { # $1 = tree, $2 = anchored fragment, $3 = the whole line to put in its place, $4 = what this revert is
  local f="$1/$DEP_REL"
  if ! grep -qF -- "$2" "$f"; then
    bad "revert $4" "the anchored fragment is not in the shipped script: '$2' — the mechanism moved again and this revert must be re-pointed, not skipped"
    return 1
  fi
  awk -v old="$2" -v new="$3" 'index($0, old){print new; next} {print}' "$f" > "$f.tmp" || return 1
  mv "$f.tmp" "$f" || return 1
  if ! grep -qF -- "$3" "$f"; then
    bad "revert $4" "the substitution did not land"
    return 1
  fi
  ok "revert $4 applied (one line, anchored on '$2')"
}

plant() { # $1 = tree, $2 = relative module path inside the arm, $3 = the text to append
  local p="$1/src/extensions/$ARM/$2"
  [ -f "$p" ] || { bad "plant into $2" "the file is not in the scratch tree"; return 1; }
  printf '%s\n' "$3" >> "$p"
}

fire() { # $1 = tree, $2 = HOME, $3 = target dir, [$4] = BUN_INSTALL_CACHE_DIR ; sets RC and OUT
  local cachedir="${4:-}"
  [ -n "$BUN" ] || { printf 'FAIL  no bun on this host — the deploy cannot load-check, so nothing here is measurable\n' >&2; RC="nobun"; OUT=""; return; }
  if [ -n "$cachedir" ]; then
    RC=$( cd "$1/src" && env HOME="$2" BUN="$BUN" EXT="$ARM" BUN_INSTALL_CACHE_DIR="$cachedir" TARGET="$3" \
          bash tools/deploy-tabichat.sh --no-gates > "$SCR/out.txt" 2>&1; printf '%s' "$?" )
  else
    RC=$( cd "$1/src" && env HOME="$2" BUN="$BUN" EXT="$ARM" TARGET="$3" \
          bash tools/deploy-tabichat.sh --no-gates > "$SCR/out.txt" 2>&1; printf '%s' "$?" )
  fi
  OUT=$(cat "$SCR/out.txt")
}
# A fresh target so a cell can tell "moved" from "same": the deploy skips a byte-identical destination file.
fresh_target() { mkdir -p "$1"; }
nmoved() { printf '%s\n' "$1" | grep -c '^  moved :' || true; }
nload()  { printf '%s\n' "$1" | grep -c '^  load ok' || true; }
nherm()  { printf '%s\n' "$1" | grep -c 'probe hermetic:' || true; }

# ================================================================ CELL 1 — THE MECHANISM UNDER TEST IS IN THE TREE
say "CELL 1 — THE SHIPPED MECHANISM IS PRESENT, BY FRAGMENT AND COUNT (a moved guard fails here, not later)"
pin 1 'load_check_tree exists as a function the deploy calls'                 'load_check_tree() {'
pin 1 'the probe scans for package specifiers'                                'probe_bare_specifiers() {'
pin 1 'the pi-ai stub is written into the probe'                              "cat > \"\$loadcheck_probe/pi-ai.ts\" <<'STUB_AI'"
pin 1 'the pi-coding-agent stub is written into the probe'                    "cat > \"\$loadcheck_probe/pi-ca.ts\" <<'STUB_CA'"
pin 1 'the mqtt stub is written into the probe'                               "cat > \"\$loadcheck_probe/mqtt.ts\" <<'STUB_MQ'"
pin 3 'all three package specifiers are rewritten by the same anchored, quote-paired expression' 's#(from|import)([[:space:]]*)(\(?)'
pin 1 'the rewrite is written out beside every member'                        '> "$loadcheck_probe/$m.rewritten"'
pin 1 'the rewritten member replaces the copy, so the probe imports what it rewrote' 'mv -f "$loadcheck_probe/$m.rewritten" "$loadcheck_probe/$m"'
pin 2 'the rewrite walks FILES — one loop copies the set, one rewrites it — not the LOADCHECK entries alone' 'for m in "${FILES[@]}"; do'
pin 1 'the scan is CALLED before anything is imported'                        'bare=$(probe_bare_specifiers "$loadcheck_probe" || true)'
pin 1 'the scan prints the green line this file requires'                     'probe hermetic:'
pin 1 'the scan has its own refusal, in words'                                'the load-check probe is not hermetic'
pin 1 'what the scan accepts: relative or node: and nothing else'             './*|../*|node:*'
pin 1 'an empty FILES array is a refusal'                                     '[ "${#FILES[@]}" -gt 0 ] || die'
pin 1 'an empty LOADCHECK array is a refusal'                                 '[ "${#LOADCHECK[@]}" -gt 0 ] || die'
pin 1 'the import target is the rewritten member, not a side file'            'TABICHAT_LOAD_TARGET="$loadcheck_probe/$m"'
pin 1 'the staged tree is load-checked'                                       'load_check_tree "$stage"'
pin 1 'the published destination is load-checked too'                         'load_check_tree "$TARGET"'
pin 1 'a staged refusal says it came before anything was published'           'the staged tree, checked before anything was published'

# The two guards 947 added are a property of ORDER, and an order is a position, not a string.
stage_line=$(grep -nF -- 'load_check_tree "$stage"' "$REPO/$DEP_REL" | head -1 | cut -d: -f1)
move_line=$(grep -nF -- 'mv -f "$stage/$f" "$TARGET/$f"' "$REPO/$DEP_REL" | head -1 | cut -d: -f1)
dest_line=$(grep -nF -- 'load_check_tree "$TARGET"' "$REPO/$DEP_REL" | head -1 | cut -d: -f1)
if [ -n "$stage_line" ] && [ -n "$move_line" ] && [ -n "$dest_line" ] \
   && [ "$stage_line" -lt "$move_line" ] && [ "$dest_line" -gt "$move_line" ]; then
  ok "the staged load-check sits above the move loop and the destination check below it (staged :$stage_line < moved :$move_line < destination :$dest_line)"
else
  bad "the load-check ordering" "cannot place the staged call before the move loop: staged='${stage_line:-none}' moved='${move_line:-none}' destination='${dest_line:-none}'"
fi
# …and the retired shape, kept here as the record of why the old design failed, asserted GONE. If the
# install-tree guess comes back, this file reddens and tells the next reader to re-point it — that is the
# same lesson the deleted line taught, now held in the direction that can still fire.
pin 0 'the deleted install-tree derivation is absent from the shipped script' 'if PI_NM="$(ls -d "$HOME/.pi/agent/install/releases/'
pin 0 'and so is the context line it printed'                                 'load-check context:'

# ================================================================ CELL 2 — THE RECORD: the idiom that half-finished a deploy
say "CELL 2 — THE RECORD, STILL MEASURED: a bare failing assignment under set -e dies WITHOUT A WORD"
# Both halves are asserted together because rc alone cannot tell a silence from a success: rc 2 with output
# is a different bug from rc 2 with no output, and the one that shipped printed nothing at all. Kept on
# purpose after 947 deleted its subject: this is the artifact that records why the old shape failed.
mkdir -p "$SCR/home-empty"
NOUT=$(HOME="$SCR/home-empty" bash -c 'set -euo pipefail
PI_NM="$(ls -d "$HOME/.pi/agent/install/releases/"*/node_modules 2>/dev/null | sort -V | tail -1)"
printf "REACHED-AFTER-ASSIGNMENT\n"' 2>&1); NRC=$?
check "pre-fix derivation: it dies (rc=2)" "$NRC" "2"
check "pre-fix derivation: and it dies WITHOUT A WORD (0 bytes captured)" "$(printf '%s' "$NOUT" | wc -c | tr -d ' ')" "0"
lacks "$NOUT" "REACHED-AFTER-ASSIGNMENT" "the line after the assignment is unreachable on the pre-fix shape"
POUT=$(HOME="$SCR/home-empty" bash -c 'set -euo pipefail
if PI_NM="$(ls -d "$HOME/.pi/agent/install/releases/"*/node_modules 2>/dev/null | sort -V | tail -1)"; then :; else PI_NM=""; fi
[ -n "$PI_NM" ] && printf "ctx: NODE_PATH=%s\n" "$PI_NM" || printf "ctx: no pi install tree found — default resolution, check unchanged\n"
printf "REACHED-AFTER-ASSIGNMENT\n"' 2>&1); PRC=$?
check "the old cure, isolated: it survives (rc=0)" "$PRC" "0"
contains "$POUT" "REACHED-AFTER-ASSIGNMENT" "and the line after the assignment is reachable again"
contains "$POUT" "no pi install tree found" "and the else-branch sentence, which was unreachable, prints"

# ================================================================ CELL 3 — A GOOD TREE IS NOT A HOST QUESTION
say "CELL 3 — THE WHOLE DEPLOY OF A GOOD TREE, ON THREE HOSTS: the same rc, the same words, no resolution guessed"
# 947's premise was that the check must not depend on which pi tree the host happens to resolve. 949 made
# that structural: nothing outside ./ ../ node: survives the scan, so the probe has nothing left to ask the
# host. The live equivalent of the old no-install-tree cell is therefore "does the host change the answer?"
# — asked here from three directions: this box, a synthetic HOME with no ~/.bun and no pi install tree, and
# a brand-new empty BUN_INSTALL_CACHE_DIR so nothing can be read from a cache and nothing is already in one.
must_build "$SCR/ok"
fresh_target "$SCR/ok/t1"; fire "$SCR/ok" "$HOME" "$SCR/ok/t1"
check "this box: the deploy completes (rc=0)" "$RC" "0"
check "this box: the probe was found hermetic twice (2)" "$(nherm "$OUT")" "2"
check "this box: both load faces ran (2)" "$(nload "$OUT")" "2"
contains "$OUT" "deployed set complete and identical" "and the completion line is reached"
lacks "$OUT" "load-check context" "and it no longer announces a resolution context it did not consult"
fresh_target "$SCR/ok/t2"; fire "$SCR/ok" "$SCR/home-empty" "$SCR/ok/t2"
check "no-home host: the deploy completes (rc=0)" "$RC" "0"
check "no-home host: same two hermetic lines (2)" "$(nherm "$OUT")" "2"
check "no-home host: same two load lines (2)" "$(nload "$OUT")" "2"
CACHE_EMPTY="$SCR/cache-empty"; mkdir -p "$CACHE_EMPTY"
fresh_target "$SCR/ok/t3"; fire "$SCR/ok" "$SCR/home-empty" "$SCR/ok/t3" "$CACHE_EMPTY"
check "empty-bun-cache host: the deploy completes (rc=0)" "$RC" "0"
check "empty-bun-cache host: same two hermetic lines (2)" "$(nherm "$OUT")" "2"
check "empty-bun-cache host: same two load lines (2)" "$(nload "$OUT")" "2"
[ "$(printf '%s\n' "$OUT" | grep -c '^  moved :')" = "13" ] \
  && ok "a fresh destination moves all 13 tabichat members (=13)" \
  || bad "fresh-destination move count" "got '$(nmoved "$OUT")', want '13'"

# ================================================================ CELL 4 — A SPECIFIER ONLY THE HOST COULD ANSWER MUST REFUSE
say "CELL 4 — THE HERMETICITY SCAN IS THE DEFENDER: an unstubbed package specifier refuses by name, and nothing moves"
# The plant is a package the probe has no stub for, reached from a SIBLING file rather than the entry — the
# exact shape leg 948 measured, where the rewrite touched only the LOADCHECK entries and this machine
# answered for the tree. It must now stop the deploy before the move, naming the file and the specifier.
HOST_SPEC="@earendil-works/pi-agent-core"
# Is this host even able to answer it? Asked by READING THE CACHE DIRECTORY, not by importing the package:
# an import would execute third-party code and, on a box that fetches on demand, would reach the network.
# The answer only chooses which of the three honest branches below the un-scanned face can take.
HOST_CACHED=$(ls -d "${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}/@earendil-works/pi-agent-core@"* 2>/dev/null | head -1)
if [ -n "$HOST_CACHED" ]; then
  ok "this host bun cache holds $HOST_SPEC, so an un-scanned run can be answered by the host rather than by the tree"
else
  printf 'note  this host cache does not hold %s — the un-scanned face below reports which way the host answers, and the cell does not depend on it\n' "$HOST_SPEC" >&2
fi
must_build "$SCR/loose"
plant "$SCR/loose" roommsg.ts "import * as __PAC from \"$HOST_SPEC\";"
plant "$SCR/loose" roommsg.ts 'export const __loose_use = __PAC;'
fresh_target "$SCR/loose/tgt"; fire "$SCR/loose" "$HOME" "$SCR/loose/tgt"
check "unstubbed specifier: the deploy refuses (rc=1)" "$RC" "1"
contains "$OUT" "no stub for: roommsg.ts $HOST_SPEC" "it names the file and the specifier, so the next reader knows what to stub"
contains "$OUT" "the load-check probe is not hermetic" "and refuses in the scan's own voice"
check "unstubbed specifier: NOTHING MOVED (0 moved lines)" "$(nmoved "$OUT")" "0"
contains "$OUT" "the staged tree, checked before anything was published" "the refusal says it came before the publish"
lacks "$OUT" "load ok" "no green line is printed about a graph this box answered"
lacks "$OUT" "deployed set complete" "and the completion line is never reached"
# The pair: the same tree and the same plant with the scan's one call substituted away. Whether bun then
# answers is a fact about this host, so BOTH outcomes are read out loud rather than asserted.
must_build "$SCR/loose-noscan" && revert "$SCR/loose-noscan" 'bare=$(probe_bare_specifiers "$loadcheck_probe" || true)' '  bare=""' "the scan's call"
plant "$SCR/loose-noscan" roommsg.ts "import * as __PAC from \"$HOST_SPEC\";"
plant "$SCR/loose-noscan" roommsg.ts 'export const __loose_use = __PAC;'
fresh_target "$SCR/loose-noscan/tgt"; fire "$SCR/loose-noscan" "$HOME" "$SCR/loose-noscan/tgt"
lacks "$OUT" "no stub for:" "with the scan removed the refusal that names the specifier is gone"
lacks "$OUT" "the load-check probe is not hermetic" "and so is its refusal sentence"
contains "$OUT" "probe hermetic:" "and the GREEN LINE STILL PRINTS anyway — which is the point of this pair: the sentence is not the guard, the scan above it is, so a deploy that lost the call would report hermetic about a graph it never checked"
reached=$(printf '%s' "$OUT" | grep -c "load ok\|pi-agent-core" || true)
if [ "$reached" -gt 0 ]; then ok "and the run reaches the import step, where only the host can answer (rc $RC)"; else bad "scan-removed face" "the run never reached the import step and printed nothing about it either (rc $RC) — read $SCR/loose-noscan"; fi
# Which way the host answered is a fact about this box, not a requirement, so it is read out rather than
# asserted: a green line here is the silent pass the scan closes, an error naming the specifier is the host
# failing to answer, and either one is a graph the ship set never contained.
if [ "$RC" = "0" ]; then
  printf 'note  THIS host answered it (rc 0, %s load line(s)) — the check reported green about a module graph that mixes the tree with ~/.bun/install/cache. That is the outcome the scan exists to close.\n' "$(nload "$OUT")" >&2
elif printf '%s' "$OUT" | grep -q 'Cannot find package'; then
  printf 'note  this host could not answer %s either (bun: Cannot find package), so the un-scanned tree dies at import instead of passing — the scan turns that into a named instruction before anything moves\n' "$HOST_SPEC" >&2
else
  printf 'note  the host answered sideways — bun said: %s — which is still a graph the ship set does not contain\n' "$(printf '%s\n' "$OUT" | grep -m1 -i 'error' | tr -d '\n')" >&2
fi

# ================================================================ CELL 5 — THE STUB TRIO IS LOAD-BEARING
say "CELL 5 — PAIRED NEGATIVE, ONE LINE: with the pi-ai stub not written, the good tree is refused and nothing moves"
# The stubs are what replaced the guessed resolution context, so the pair that shows they are doing the work
# is to leave the rewrite pointing at pi-ai.ts and stop the file being written. Anchored on the heredoc
# opener and substituted with `:`, which consumes the heredoc body and writes nothing — one line again.
must_build "$SCR/nostub" && revert "$SCR/nostub" "cat > \"\$loadcheck_probe/pi-ai.ts\" <<'STUB_AI'" ": > /dev/null <<'STUB_AI'" "the pi-ai stub write"
fresh_target "$SCR/nostub/tgt"; fire "$SCR/nostub" "$HOME" "$SCR/nostub/tgt"
check "stub not written: the deploy refuses (rc=1)" "$RC" "1"
contains "$OUT" "pi-ai.ts" "and it names the module it could not find"
contains "$OUT" "REFUSED: index.ts does not LOAD" "in the load-check's own voice"
check "stub not written: NOTHING MOVED (0 moved lines)" "$(nmoved "$OUT")" "0"
lacks "$OUT" "deployed set complete" "and the completion line is not reached"

# ================================================================ CELL 6 — THE EMPTY SHIP SET REFUSES
say "CELL 6 — AN EMPTY ARRAY IS NOT AN EMPTY RUN: FILES and LOADCHECK each refuse, and the guard is what refuses"
# Measured at 510e4ab: LOADCHECK=() gave rc 0, 37 gate lines, 13 files moved and ZERO load lines — a check
# that never happened, reporting success. That is the same class as the unreachable cure in CELL 2: a
# remedy sitting on a path that cannot execute. Both arrays now refuse, so this cell asserts the refusal
# and then removes it, to show which line is doing the work.
must_build "$SCR/noload" && revert "$SCR/noload" '    LOADCHECK=(index.ts)' '    LOADCHECK=()' "the LOADCHECK array (both arms)"
fresh_target "$SCR/noload/tgt"; fire "$SCR/noload" "$HOME" "$SCR/noload/tgt"
check "empty LOADCHECK: the deploy refuses (rc=1)" "$RC" "1"
contains "$OUT" "LOADCHECK is empty" "and says which array is short"
check "empty LOADCHECK: NOTHING MOVED (0 moved lines)" "$(nmoved "$OUT")" "0"
must_build "$SCR/noload2" && revert "$SCR/noload2" '    LOADCHECK=(index.ts)' '    LOADCHECK=()' "the LOADCHECK array (both arms)" \
  && revert "$SCR/noload2" '[ "${#LOADCHECK[@]}" -gt 0 ] || die' '  :' "the guard that reads it"
fresh_target "$SCR/noload2/tgt"; fire "$SCR/noload2" "$HOME" "$SCR/noload2/tgt"
check "empty LOADCHECK with its guard removed: the silent green comes back (rc=0)" "$RC" "0"
check "and it prints no load line at all (0)" "$(nload "$OUT")" "0"
contains "$OUT" "deployed set complete and identical" "which is exactly how a check that never ran reads"
must_build "$SCR/nofiles" && revert "$SCR/nofiles" '    FILES=(mention.ts' '    FILES=()' "the tabichat FILES array"
fresh_target "$SCR/nofiles/tgt"; fire "$SCR/nofiles" "$HOME" "$SCR/nofiles/tgt"
check "empty FILES: the deploy refuses (rc=1)" "$RC" "1"
contains "$OUT" "FILES is empty" "and names it"

# ================================================================ CELL 7 — THE SHORT TREE STILL REFUSES, BEFORE THE PUBLISH
say "CELL 7 — IID 12'S OWN SHAPE: an import of a module the ship set does not carry refuses, and moves nothing"
# The plant must be USED, not merely imported: the loader erases a dead specifier, so an unused import of an
# unshipped file is not something a lane can die from (that limit is stated in the shipped comment beside
# the scan, and the closure gate — which reads bytes, not the executed graph — is what names it at full
# stage). This file fires --no-gates, so the load-check is the only thing standing here.
must_build "$SCR/short"
plant "$SCR/short" index.ts 'import { OMITTED_MARKER as __O } from "./omitted.ts";'
plant "$SCR/short" index.ts 'const __omitted_used = __O;'
fresh_target "$SCR/short/tgt"; fire "$SCR/short" "$HOME" "$SCR/short/tgt"
check "short tree: the deploy refuses (rc=1)" "$RC" "1"
contains "$OUT" "Cannot find module './omitted.ts'" "and names the module the ship set does not carry"
check "short tree: NOTHING MOVED (0 moved lines)" "$(nmoved "$OUT")" "0"
contains "$OUT" "the staged tree, checked before anything was published" "the refusal says it came from the staged tree"
lacks "$OUT" "deployed set complete" "and the completion line is not reached"
# …and the recorded limit, read out loud rather than asserted as a requirement: an UNUSED dead import.
must_build "$SCR/dead"
plant "$SCR/dead" index.ts 'import { OMITTED_MARKER as __O } from "./omitted.ts";'
fresh_target "$SCR/dead/tgt"; fire "$SCR/dead" "$HOME" "$SCR/dead/tgt"
printf 'note  recorded limit, not a requirement — the same plant with the binding UNUSED returns rc %s here: the loader erases a dead specifier, so the load-check cannot see it, and test_deploy_closure.ts is what names that shape at full stage\n' "$RC" >&2

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells' "$failed" "$ran" || printf 'all %d load-check cells pass' "$ran")"
[ "$failed" -gt 0 ] && exit 1
exit 0
