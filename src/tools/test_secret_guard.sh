#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for .githooks/pre-commit — the secret guard.
#   sh src/tools/test_secret_guard.sh        (exit 1 on any failure)
#
# WHY THIS FILE EXISTS. The guard it tests passed every commit on this box for an unknown span
# WITHOUT COMPARING ANYTHING: the decoder it called (`xxd`) is not installed everywhere, and the decode line
# ended `|| exit 0`. No cell anywhere could tell a working guard from a guard that had quietly
# stopped existing — and a security control that fails open is worse than no control, because it
# sells the belief of one. So the rule for this file is: **"cannot run" and "ran and found nothing"
# must never print the same way**, and every refusal is paired with the pass beside it.
#
# NO REAL SECRET IS USED OR PRINTED. Cells work in a throwaway `git init` repo with a SYNTHETIC
# pattern list whose plaintexts are fixture strings defined right here. The three real rows are
# handled only through their hex form, and where a cell must prove the real list decodes it reports
# LENGTHS and `cksum`s — never contents (masker law: structure, not the value).
#
# The hex fixtures are built IN PURE SH (the same mechanism the hook uses), because a test that
# encodes with the tool the hook is forbidden to need would not be testing the thing it claims.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
HOOK="$REPO/.githooks/pre-commit"
failed=0
ran=0
LAST=""   # "<stdout+stderr>|<rc>" from run_commit; RC holds the status

ok()  { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad() { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
say() { printf '\n== %s ==\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }
out_of()   { printf '%s' "${1%|*}"; }     # the message part of LAST
rc_of()    { printf '%s' "${1##*|}"; }    # the status part of LAST

# --------------------------------------------------------------------------- pure-sh hex encode
hex_encode() {
    _s="$1"; _out=""
    while [ -n "$_s" ]; do
        _c=${_s%"${_s#?}"}; _s=${_s#?}
        # printf takes the CHARACTER CODE when the argument is `'c` — a leading apostrophe is how
        # POSIX printf turns a one-char string into its byte value. Passing the bare character
        # instead (`printf '%02x' f`) is what this cell did first, and it produced `00` + rc=1: the
        # fixtures then encoded to the wrong hex, so the guard "correctly" saw nothing. An encoder
        # bug reads as a passing guard, which is the false green this whole leg is about.
        _out="$_out$(printf '%02x' "'$_c")"
    done
    printf '%s' "$_out"
}

TEST_A="lane6-guard-cell-DO-NOT-COMMIT-7z"
TEST_B="second-guard-cell-42"
# a literal full of REGEX METACHARACTERS: if the guard ever runs these as patterns rather than fixed
# strings, this one narrows itself to near-nothing and the guard passes real secrets quietly
TEST_M='meta[.]*secret+?(x|y)'
HEX_A=$(hex_encode "$TEST_A")
HEX_B=$(hex_encode "$TEST_B")
HEX_M=$(hex_encode "$TEST_M")

[ -f "$HOOK" ] || { printf 'FAIL  no hook at %s\n' "$HOOK"; exit 1; }
sh -n "$HOOK" 2>/dev/null && ok "the hook parses under sh" || bad "the hook parses under sh" "syntax error"
printf '\n== hex fixtures built without any external decoder ==\n'
check "fixture A encodes to an even-length hex row" "$(( ${#HEX_A} % 2 ))" "0"
check "fixture A is hex-only characters" "$(printf '%s' "$HEX_A" | tr -d '0-9a-f' | wc -c | tr -d ' ')" "0"
# THE ENCODER IS TESTED BEFORE IT IS TRUSTED: decode the hex back with the shell's own mechanism and
# require the original fixture. A broken encoder makes every later BLOCKED claim be about a string
# that was never the one it names — and it does it by PASSING. (The first version of this file hit
# exactly that: `printf '%02x' f` is an invalid-number error that emits `00`, so the fixtures encoded
# to the wrong bytes and the guard "correctly" saw nothing.)
_rt=$(
    _r="$HEX_A"; _e=""
    while [ -n "$_r" ]; do
        _c1=${_r%"${_r#?}"}; _r=${_r#?}
        _c2=${_r%"${_r#?}"}; _r=${_r#?}
        _e="$_e\\$(printf '%03o' "$((0x$_c1$_c2))")"
    done
    printf "$_e"
)
check "the encoder round-trips: hex -> the original fixture" "$_rt" "$TEST_A"

scratch=$(mktemp -d "${TMPDIR:-/tmp}/secretguard-XXXXXX")
GHOOKDIR=""

mk_list() { printf '%s\n%s\n%s\n' "$HEX_A" "$HEX_B" "$HEX_M" > "$GHOOKDIR/forbidden-strings.hex"; }

setup_repo() {
    R="$scratch/r$1"; mkdir -p "$R/.githooks"
    ( cd "$R" && git init -q . && git config user.name guard-test && git config user.email guard@test.invalid \
      && git config core.hooksPath .githooks )
    cp "$HOOK" "$R/.githooks/pre-commit"
    GHOOKDIR="$R/.githooks"
    ( cd "$R" && printf 'readme\n' > README.md && git add README.md && git commit -q --no-verify -m init )
}

run_commit() { # $1 = file text; sets LAST="<out>|<rc>"
    ( cd "$scratch/current" && printf '%s\n' "$1" > leak.txt && git add leak.txt \
      && { git commit -m attempt 2>&1; printf '@@RC=%s@@' "$?"; } ) > /tmp/sg-out.$$ 2>&1
    raw=$(cat /tmp/sg-out.$$); rm -f /tmp/sg-out.$$
    rc=$(printf '%s' "$raw" | sed -n 's/.*@@RC=\([0-9]*\)@@.*/\1/p')
    msg=$(printf '%s' "$raw" | sed 's/@@RC=[0-9]*@@//')
    LAST="$msg|$rc"
}

say "POSITIVE half: a planted forbidden literal in a staged ADDED line is BLOCKED"
setup_repo 1; mk_list; cd "$scratch/r1"; ln -sfn "$scratch/r1" "$scratch/current"
run_commit "config line: $TEST_A = true"
check "the commit is refused (rc=1)" "$(rc_of "$LAST")" "1"
contains "$(out_of "$LAST")" "forbidden-strings.hex" "the refusal names the pattern list"
contains "$(out_of "$LAST")" "leak.txt" "the refusal NAMES THE STAGED FILE (the spec asks for it)"
contains "$(out_of "$LAST")" "patterns checked: 3" "it gives the pattern class and count"
contains "$(out_of "$LAST")" "nothing was committed" "it says nothing landed"
lacks "$(out_of "$LAST")" "$TEST_A" "the refusal does NOT echo the secret"

say "NEGATIVE half A: a clean staged diff PASSES, and says it ran"
run_commit "nothing sensitive here, just prose"
check "the commit lands (rc=0)" "$(rc_of "$LAST")" "0"
contains "$(out_of "$LAST")" "secret guard ran clean" "it reports a real comparison, not a silence"

say "NEGATIVE half B: DELETING a secret stays committable (the header's own rule)"
( cd "$scratch/current" && printf 'old line: %s\n' "$TEST_A" > leak.txt && git add leak.txt \
  && git commit -q --no-verify -m plant )
run_commit "cleaned up"
check "removing a forbidden literal commits (rc=0)" "$(rc_of "$LAST")" "0"
lacks "$(out_of "$LAST")" "BLOCKED" "and it did not match on the removed line"

say "THE CASE THAT BIT US: no external decoder on PATH at all — the guard must still BLOCK"
# a PATH holding ONLY git and the coreutils the hook genuinely calls, with the decoder family
# deliberately absent. The hook must not care, because it calls none of them.
CLEAN="$scratch/mini-bin"; mkdir -p "$CLEAN"
for t in sh git grep sed tr mktemp dirname cat; do
    p=$(command -v "$t" 2>/dev/null) || continue
    ln -sf "$p" "$CLEAN/$t" 2>/dev/null
done
for gone in xxd od awk mawk gawk perl python python3 base64 hexdump; do
    if [ -e "$CLEAN/$gone" ]; then bad "the stripped PATH must not contain $gone" "it is there"; fi
done
ok "the stripped PATH has no decoder family (nothing linked for xxd/od/awk/perl/python/base64)"
( cd "$scratch/current" && printf '%s\n' "leak: $TEST_A" > leak.txt && git add leak.txt )
out=$( cd "$scratch/current" && PATH="$CLEAN" sh .githooks/pre-commit 2>&1 ); rc=$?
check "with no decoder installed the guard still refuses (rc=1)" "$rc" "1"
contains "$out" "BLOCKED" "and it says so in words"
lacks "$out" "ran clean" "it did not silently pass"
# and the same decoder-less PATH with a CLEAN diff must PASS: a guard that always blocks is a wall,
# not a control, and it would have "passed" this leg's negative halves for the wrong reason.
( cd "$scratch/current" && printf '%s\n' "harmless text" > leak.txt && git add leak.txt )
out2=$( cd "$scratch/current" && PATH="$CLEAN" sh .githooks/pre-commit 2>&1 ); rc2=$?
check "a clean diff under a decoder-less PATH passes (rc=0)" "$rc2" "0"
contains "$out2" "pattern(s)" "and it counted what it compared"

say "EMPTY / MISSING / JUNK pattern list is a REFUSAL, never a pass"
# these are the fail-opens the rewrite closed; each is asserted as behaviour, not as a comment
setup_repo 2; GHOOKDIR="$scratch/r2/.githooks"; cd "$scratch/r2"; ln -sfn "$scratch/r2" "$scratch/current"
: > .githooks/forbidden-strings.hex
printf 'x\n' > leak.txt; git add leak.txt
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "an empty list refuses (rc=1)" "$rc" "1"
contains "$out" "0 usable rows" "it names the empty list as the cause"
rm -f .githooks/forbidden-strings.hex
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "a MISSING list refuses (rc=1)" "$rc" "1"
contains "$out" "forbidden-strings.hex" "and says which file is gone"
printf 'zz\n' > .githooks/forbidden-strings.hex
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "a non-hex pair refuses (rc=1)" "$rc" "1"
contains "$out" "non-hex pair" "it names the offending pair"
printf 'abc\n' > .githooks/forbidden-strings.hex
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "an ODD-length row refuses (rc=1) — a truncated literal must not become a shorter pattern" "$rc" "1"
contains "$out" "odd number of hex" "and it says so"

say "THE DECODE IS RIGHT, and patterns are FIXED strings"
setup_repo 3; mk_list; cd "$scratch/r3"; ln -sfn "$scratch/r3" "$scratch/current"
run_commit "value is $TEST_A here"
check "decoded fixture A matches what was staged (rc=1)" "$(rc_of "$LAST")" "1"
run_commit "literal text: $TEST_M"
check "a pattern containing [ ] ( ) | ? + * is matched as FIXED TEXT (rc=1)" "$(rc_of "$LAST")" "1"
run_commit "near miss: meta[.]*secret+?(x|z)"
check "the near miss that is NOT the literal passes (rc=0)" "$(rc_of "$LAST")" "0"
run_commit "sub${TEST_B}string"
check "a match embedded in surrounding text is still caught (rc=1)" "$(rc_of "$LAST")" "1"

say "FORMAT-STRING SAFETY: a literal containing % or a space cannot change what printf emits"
# The decode builds printf's FORMAT out of octal escapes, so a literal that itself contains a `%`
# arrives as \045 and is never a conversion specifier. If it ever were, `printf %s` would substitute
# an argument and the pattern would silently become the wrong string — a guard that matches nothing
# while looking intact. Assert with a fixture whose text IS that hazard.
setup_repo 5; cd "$scratch/r5"; ln -sfn "$scratch/r5" "$scratch/current"
printf '%s\n' "$(hex_encode 'pct%s and space 42')" > .githooks/forbidden-strings.hex
GHOOKDIR="$scratch/r5/.githooks"
run_commit "value: pct%s and space 42"
check "a fixture containing %s and a space is still matched (rc=1)" "$(rc_of "$LAST")" "1"
run_commit "value: pct and space 42"
check "with the %s removed it is a different string, so it passes (rc=0)" "$(rc_of "$LAST")" "0"
run_commit "value: pctS and space 42"
check "and the near miss where %s became S passes (rc=0)" "$(rc_of "$LAST")" "0"

say "MECHANISM PROOF, READ OFF THE CODE LINES — not off the file's own narrative"
# The first draft of this cell grepped the WHOLE FILE and failed, because the header explains what
# the hook no longer calls. Prose about a tool is not a dependency on it — the same rule
# src/tools/test_ctx_handle.ts states for `ctx`. So: strip whole-line comments, then look.
code=$(grep -vE '^[[:space:]]*(#|\*)' "$HOOK")
ext=$(printf '%s\n' "$code" | grep -cE '\b(xxd|od|awk|mawk|gawk|perl|python|python3|base64|xargs)\b' || true)
check "no decoder command appears on any CODE line of the hook" "$ext" "0"
escapes=$(printf '%s\n' "$code" | grep -c '|| exit 0' || true)
check "no fail-open '|| exit 0' remains on any code line" "$escapes" "0"
passes=$(printf '%s\n' "$code" | grep -c 'exit 0' || true)
check "both remaining 'exit 0' paths are AFTER a real comparison (2 of them)" "$passes" "2"
fixed=$(printf '%s\n' "$code" | grep -c -- '-F -f' || true)
check "the comparison uses fixed strings from a file" "$fixed" "1"
argv=$(printf '%s\n' "$code" | grep -c '\$args' || true)
check "the old 'secrets in a command line' arg-splice is gone (no \$args)" "$argv" "0"

say "THE REAL PATTERN LIST still decodes: lengths and checksums, contents never printed"
cd "$REPO"
rows=$(grep -cvE '^[[:space:]]*(#|$)' .githooks/forbidden-strings.hex)
check "the real list has the 3 rows this leg was told about" "$rows" "3"
# decode each row with the hook's own mechanism, report only its length + cksum
sums=""
while IFS= read -r h; do
    case "$h" in ''|'#'*) continue ;; esac
    esc=""; _r="$h"
    while [ -n "$_r" ]; do
        c1=${_r%"${_r#?}"}; _r=${_r#?}
        c2=${_r%"${_r#?}"}; _r=${_r#?}
        esc="$esc\\$(printf '%03o' "$((0x$c1$c2))")"
    done
    lit=$(printf "$esc")
    sums="$sums $(printf '%s' "$lit" | wc -c | tr -d ' ')/$(printf '%s' "$lit" | cksum | cut -d' ' -f1)"
done < .githooks/forbidden-strings.hex
n=$(printf '%s\n' $sums | wc -w)
check "all three real rows decoded to non-empty values" "$n" "3"
printf 'note: real literals identified as length/cksum only:%s\n' "$sums"

say "REGRESSION PROOF: the pre-fix logic, with its decoder missing, passes the SAME staged leak"
setup_repo 4; mk_list; cd "$scratch/r4"; ln -sfn "$scratch/r4" "$scratch/current"
printf '%s\n' "password=$TEST_A" > leak.txt; git add leak.txt
# The pre-fix hook, read OUT OF HISTORY rather than paraphrased — so the comparison is against what
# actually shipped. The ref is the BRANCH BASE, and it must not be `HEAD`: the first run after this
# leg's own commit landed, `HEAD:.githooks/pre-commit` returned the NEW hook, the cell then blocked
# as the old hook "should not", and the regression proof inverted silently. A cell that reads a ref
# which moves under it is not a regression test, and the fix is to pin the ref and assert the two
# blobs are actually different.
BASE=$(cd "$REPO" && git rev-parse "${TABICHAT_GUARD_BASE:-8803a5c}" 2>/dev/null)
old=""
[ -n "$BASE" ] && old=$(cd "$REPO" && git show "$BASE:.githooks/pre-commit" 2>/dev/null)
if [ -n "$old" ]; then
    printf '%s\n' "$old" > .githooks/old-pre-commit; chmod +x .githooks/old-pre-commit 2>/dev/null
    # the assertion that makes the pin meaningful: the historical blob MUST differ from the file
    # under test, or this cell is comparing the hook against itself
    if cmp -s .githooks/old-pre-commit "$REPO/.githooks/pre-commit"; then
        bad "the pre-fix blob differs from the current hook" "they are byte-identical: the ref read is wrong"
    else
        ok "the pre-fix blob differs from the current hook (the pin is real)"
    fi
    out=$(PATH="$CLEAN" sh .githooks/old-pre-commit 2>&1); rc=$?
    check "the OLD hook exits 0 on a real leak when its decoder is absent (this WAS the bug)" "$rc" "0"
    lacks "$out" "BLOCKED" "the old hook said nothing about blocking"
else
    bad "the pre-fix hook is retrievable from HEAD" "git show HEAD:.githooks/pre-commit returned nothing"
fi
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "the NEW hook exits 1 on the same staged leak" "$rc" "1"

say "core.hooksPath DISPLACEMENT: the guard says where it is before it compares anything"
# `git config core.hooksPath <path>` replaces the whole hook set git consults, silently. Four states,
# and the honest one is third: a displaced guard is not a refusing guard, it is an ABSENT one, which is
# why the check in src/tools/check_guard_armed.sh (the arm check) exists beside this hook.
setup_repo 6; mk_list; cd "$scratch/r6"; ln -sfn "$scratch/r6" "$scratch/current"
run_commit "plain prose, documented posture"
check "the documented config line still commits (rc=0)" "$(rc_of "$LAST")" "0"
lacks "$(out_of "$LAST")" "core.hooksPath is" "and the guard raises no displacement complaint in its own directory"
contains "$(out_of "$LAST")" "secret guard ran clean" "the comparison still happened"

CHAIN="$scratch/chaindir"; mkdir -p "$CHAIN"
printf '#!/bin/sh\nexec sh "%s/.githooks/pre-commit" "$@"\n' "$scratch/r6" > "$CHAIN/pre-commit"
chmod +x "$CHAIN/pre-commit"; git config --local core.hooksPath "$CHAIN"
run_commit "leak via a chained wrapper: $TEST_A"
check "a chained hook set still BLOCKS the leak (rc=1)" "$(rc_of "$LAST")" "1"
contains "$(out_of "$LAST")" "chains this guard" "it reports the chain instead of pretending it is the whole guard"
contains "$(out_of "$LAST")" "BLOCKED" "and it still refused"

UNCHAIN="$scratch/unchaindir"; mkdir -p "$UNCHAIN"
printf '#!/bin/sh\n# a hook set that does not reach this guard\nexit 0\n' > "$UNCHAIN/pre-commit"
chmod +x "$UNCHAIN/pre-commit"; git config --local core.hooksPath "$UNCHAIN"
run_commit "displaced guard does not see: $TEST_A"
check "PAIRED NEGATIVE — with a foreign hook set git never runs the guard, so the leak lands (rc=0)" "$(rc_of "$LAST")" "0"
lacks "$(out_of "$LAST")" "pre-commit" "and the guard printed nothing at all: absence, not a pass"
git config --local core.hooksPath "$UNCHAIN"
printf 'staged for the direct run\n' > direct.txt; git add direct.txt
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "the same state, run directly, REFUSES rather than reporting a pass it did not earn (rc=1)" "$rc" "1"
contains "$out" "which is not the .githooks path" "it names the value it found"
# the arm command this cell pinned was the bare `git config --local core.hooksPath .githooks`,
# which is the instruction iid 15 exists to replace, and the substring still matches inside the caveat
# that warns AGAINST it — so a pin on that token would pass whether or not the fix survived the merge.
# Pinned instead on the two lines that are now true, plus the absence of the one that is not.
contains "$out" "to arm this clone WITHOUT displacing the set it shadows:  sh src/tools/enable_hook_chain.sh" "it prints the enabler as the command that arms it"
contains "$out" "is right ONLY where no global or system hooksPath is set" "and it keeps the iid 15 caveat beside the bare line"
lacks "$out" "to run the guard on every commit here:  git config --local core.hooksPath .githooks" "and the bare line is no longer offered as the way to arm this clone"
contains "$out" "Do NOT use --no-verify" "and it blocks the escape that would hide the state"

MENTION="$scratch/mentiondir"; mkdir -p "$MENTION"
printf '#!/bin/sh\n# comment only: see .githooks/pre-commit\nexit 0\n' > "$MENTION/pre-commit"
chmod +x "$MENTION/pre-commit"; git config --local core.hooksPath "$MENTION"
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "a prior hook that only MENTIONS the guard in a comment is not a chain (rc=1)" "$rc" "1"
contains "$out" "which is not the .githooks path" "it refuses rather than trusting prose"

say "THE SENTENCE, PINNED — what the guard may and may not claim about a set it cannot see"
# Every check here owes a paired negative; a SENTENCE needs the same treatment, because the failure
# here was not an exit code, it was a claim. An audit found the guard asserting that a foreign set runs
# "in place of this guard" — false in the one state that prints it, since the guard is running RIGHT THERE
# to say so — and the reason it survived review is that the harness pinned the token `DISPLACED`, which the
# false sentence also contains. A pin on a word that survives the fix is not a pin. So: the honest phrase is
# required where the guard is reached but cannot see a chain, and the false phrase is forbidden in EVERY
# state this file can produce, checked by name and not by vibes.
no_false_claim() {   # no_false_claim <label> <text> — the banned sentence, wherever it appears
    case "$2" in
        *"in place of this guard"*) bad "no false 'in place of this guard' claim ($1)" "the phrase is present";;
        *) ok "no false 'in place of this guard' claim ($1)";;
    esac
}
git config --local core.hooksPath "$UNCHAIN"
printf 'staged for the wording check\n' > wording.txt; git add wording.txt
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "the reached-but-not-chained state still refuses (rc=1)" "$rc" "1"
contains "$out" "does not invoke this guard" "and it says the HONEST thing: the consulted set does not invoke it"
contains "$out" "invisible to a one-hop check" "and it names the limit of its own sight, which is the whole point of the sentence"
no_false_claim "reached, not chained" "$out"
no_false_claim "mention-only set" "$out"
contains "$out" "consulted hooks:" "it still lists what git runs there"

say "THE TWO-STAGE CHAIN, BUILT FOR REAL — hooksetB -> hooksetA -> guard"
# Every earlier chain face in this file reaches the guard in ONE hop, and the physical one reaches it through
# a path built at run time so a grep cannot see it either way. Neither shape proves what a reviewer needed
# proven: that a guard which is genuinely two hops away still RUNS, and that the guard's own report about it
# is true. So both sets here are plain scripts with visible `exec` lines — B calls A, A calls the repo's
# guard, nothing concatenated — and the two claims are measured separately: the guard's SELF-REPORT (a
# one-hop look at B) and the guard's ACTUAL BEHAVIOUR (a real commit through B and A).
HBA="$scratch/hooksetA"; HBB="$scratch/hooksetB"; mkdir -p "$HBA" "$HBB"
printf '#!/bin/sh\nexec sh "%s/.githooks/pre-commit" "$@"\n' "$scratch/current" > "$HBA/pre-commit"
printf '#!/bin/sh\nexec sh "%s/pre-commit" "$@"\n' "$HBA" > "$HBB/pre-commit"
chmod +x "$HBA/pre-commit" "$HBB/pre-commit"
git config --local core.hooksPath "$HBB"
# (1) what the guard says about itself when it is reached but the chain is longer than one hop
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "PAIRED — a real two-stage chain is still REFUSED by the guard's own one-hop check (rc=1)" "$rc" "1"
contains "$out" "does not invoke this guard" "it reports the set it looked at, truthfully"
contains "$out" "this guard is running now, so something did reach it" "and it says the thing that makes the refusal honest"
no_false_claim "two-stage chain, direct run" "$out"
lacks "$out" "not configured" "it never claims the value is missing — the value is right there"
# (2) what actually happens on a real commit: the guard runs two hops down, and it bites
printf 'clean prose through a two-stage chain\n' > twostage.txt; git add twostage.txt
TS0=$( git log --oneline | wc -l | tr -d ' ' )
out=$( git commit -m "two-stage, clean" 2>&1 ); rc=$?
check "a REAL commit two hops down the chain is refused by the guard's own verdict (rc=1)" "$rc" "1"
contains "$out" "BLOCKED" "it refuses rather than passing what it cannot verify"
contains "$out" "this guard is running now" "and it says plainly that it DID run to get this verdict, which is the fact the old sentence hid"
no_false_claim "two-stage, real commit" "$out"
check "and the refused commit landed nothing" "$( git log --oneline | wc -l | tr -d ' ' )" "$TS0"
out=$(TABICHAT_GUARD_PROCEED=1 git commit -m "two-stage, told to proceed" 2>&1); rc=$?
check "with the flag the two-stage chain commits (rc=0)" "$rc" "0"
contains "$out" "secret guard ran clean" "and the comparison really executed at the end of the chain — the proof the concatenated fixture could not give"
contains "$out" "PROCEEDING" "and the waiver is on the record"
no_false_claim "two-stage, proceeded" "$out"
# (3) the load-bearing half: under the same two-stage chain, a planted literal is STILL refused, so the
# flag that lets the clean line through has not quietly disarmed the check two hops away.
printf 'planted through the chain: %s\n' "$TEST_A" > twostage.txt; git add twostage.txt
out=$(TABICHAT_GUARD_PROCEED=1 git commit -m "must never land" 2>&1); rc=$?
check "PAIRED NEGATIVE — the flag does not pass a secret at the end of a two-stage chain (rc=1)" "$rc" "1"
contains "$out" "BLOCKED" "the secret refusal fired two hops down, where nobody could see it from the config"
no_false_claim "two-stage, leak under the flag" "$out"
git reset -q --hard >/dev/null 2>&1; rm -f twostage.txt wording.txt direct.txt nodev.txt

say "THE DISPLACEMENT ESCAPE (iid 16 req 1): name it, refuse, and print the way through"
# The shipped answer refused UNCONDITIONALLY, so an informed user had one route left: re-point
# core.hooksPath by hand, or --no-verify, which skips the very check reporting the state. Req 1 asked
# for three things and two of them shipped: print what is about to be displaced, refuse UNLESS TOLD TO
# PROCEED, and print the exact command that proceeds deliberately. Every face below is the guard
# invoked directly (a real commit under a foreign hooksPath never reaches it at all — that is the
# absence case asserted above), so what is measured is the guard's own rc and its own words.
ESC="$scratch/escdir"; mkdir -p "$ESC"
printf '#!/bin/sh\nexit 0\n' > "$ESC/pre-commit"
printf '#!/bin/sh\nexit 0\n' > "$ESC/commit-msg"        # a second hook in the displaced set, to be NAMED
printf '#!/bin/sh\nexit 0\n' > "$ESC/noisy.sample"      # not executable: a sample is not a hook
chmod +x "$ESC/pre-commit" "$ESC/commit-msg"
git config --local core.hooksPath "$ESC"
# a prior hook at the LEGACY path too — one hooksPath value hides that set as well, and nothing in the
# old refusal said so.
LEG=""
[ -d "$PWD/.git/hooks" ] && LEG="$PWD/.git/hooks/pre-commit"
if [ -n "$LEG" ]; then
    printf '#!/bin/sh\nexit 0\n' > "$LEG" && chmod +x "$LEG"
    check "the legacy hook fixture is in place (the instrument can fire)" "$([ -x "$LEG" ] && echo yes)" "yes"
fi
BEFORE_CFG=$(git config --get core.hooksPath)
printf 'clean staged prose, displaced state\n' > esc.txt; git add esc.txt
ESC_HASH_BEFORE=$( git log --oneline | wc -l | tr -d ' ' )
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "PAIRED — a displaced set with nothing told to proceed: REFUSED (rc=1)" "$rc" "1"
first=$(printf '%s\n' "$out" | head -1)
case "$first" in
    "pre-commit: BLOCKED —"*) ok "the FIRST line says BLOCKED when the answer is a refusal";;
    *) bad "the FIRST line says BLOCKED when the answer is a refusal" "got '$first'";;
esac
lacks "${out#*$first}" "PROCEEDING" "and a refusal never also claims it proceeded"
contains "$out" "core.hooksPath is \"$ESC\"" "it prints the incumbent VALUE, not just a warning"
contains "$out" "DISPLACED" "it says plainly that something is being displaced"
conline=$(printf '%s\n' "$out" | sed -n 's/^pre-commit:   consulted hooks://p')
check "it NAMES the executable hooks git consults there instead, on the consulted-hooks line" "$conline" " commit-msg pre-commit"
lacks "$conline" "noisy" "and it does not count a non-executable sample as a displaced hook"
contains "$out" "TABICHAT_GUARD_PROCEED=1 git commit" "it prints the exact command that proceeds deliberately"
check "the refusal wrote no config" "$(git config --get core.hooksPath)" "$BEFORE_CFG"
check "the refusal landed no commit" "$( git log --oneline | wc -l | tr -d ' ' )" "$ESC_HASH_BEFORE"
if [ -n "$LEG" ]; then
    contains "$out" "also hidden behind it" "and it names the legacy hook the same value silences"
fi

# (b) told to proceed: the commit is the guard's own write, and the secret comparison still ran.
printf 'clean staged prose, proceeding\n' > esc.txt; git add esc.txt
out=$(TABICHAT_GUARD_PROCEED=1 sh .githooks/pre-commit 2>&1); rc=$?
check "with the explicit proceed flag the guard STOPS REFUSING THE STATE (rc=0)" "$rc" "0"
first=$(printf '%s\n' "$out" | head -1)
case "$first" in
    "pre-commit: PROCEEDING —"*) ok "and the FIRST line says PROCEEDING when it did";;
    *) bad "the FIRST line says PROCEEDING when it did" "got '$first'";;
esac
lacks "$first" "BLOCKED" "PAIRED — it never reports BLOCKED and then commits anyway (the contradiction the physical run caught)"
contains "$out" "PROCEEDING" "it says out loud that this refusal was waived, not missed"
contains "$out" "secret guard ran clean" "and the comparison still happened under the flag"
check "proceeding wrote no config either" "$(git config --get core.hooksPath)" "$BEFORE_CFG"

# (c) THE HALF THAT MATTERS: the flag is an escape from the displacement refusal, NOT from the secret
# check. A planted literal must still be refused with the flag set, or the escape would be a bypass.
printf 'config line: %s = true\n' "$TEST_A" > esc.txt; git add esc.txt
out=$(TABICHAT_GUARD_PROCEED=1 sh .githooks/pre-commit 2>&1); rc=$?
check "PAIRED NEGATIVE — TABICHAT_GUARD_PROCEED=1 does NOT pass a real secret (rc=1)" "$rc" "1"
contains "$out" "BLOCKED" "the secret refusal still fires with the flag set"
contains "$out" "forbidden-strings.hex" "and it names the pattern list, same as without the flag"
check "the flagged leak landed no commit" "$( git log --oneline | wc -l | tr -d ' ' )" "$ESC_HASH_BEFORE"

# (d) THE PHYSICAL FACE, which no direct invocation can reach: git itself consults the displaced set,
# and that set reaches this guard through a path built at runtime, so the chain is real to git and
# unrecognisable from a code line. This is the state the escape exists for, and the only cells here
# that measure a REAL `git commit` rather than the guard's own rc. Run first on this leg: refusal
# landed nothing, the prefix landed exactly one commit, a leak under the prefix landed nothing, and
# core.hooksPath was unchanged after all three.
printf '#!/bin/sh\nd="%s/.githooks"\nexec sh "$d/pre-com""mit" "$@"\n' "$scratch/current" > "$ESC/pre-commit"
chmod +x "$ESC/pre-commit"
try_commit() { # try_commit <env-prefix-or-empty> <msg> -> LAST="<out>|<rc>"
    local pre=$1 msg=$2
    ( cd "$scratch/current" && { env $pre git commit -m "$msg" 2>&1; printf '@@RC=%s@@' "$?"; } ) > /tmp/sg-phys.$$ 2>&1
    raw=$(cat /tmp/sg-phys.$$); rm -f /tmp/sg-phys.$$
    local r=$(printf '%s' "$raw" | sed -n 's/.*@@RC=\([0-9]*\)@@.*/\1/p')
    LAST="$(printf '%s' "$raw" | sed 's/@@RC=[0-9]*@@//')|$r"
}
N0=$( cd "$scratch/current" && git log --oneline | wc -l | tr -d ' ' )
# start from a KNOWN index: the face above left a planted literal staged, and a commit that refuses
# because of THAT would read as the displacement escape failing to work.
git reset -q
printf 'physical prose, refused\n' > phys.txt; git add phys.txt
try_commit "" "refused by displacement"
check "PHYSICAL — a real commit under a displaced set is refused (rc=1)" "$(rc_of "$LAST")" "1"
contains "$(out_of "$LAST")" "BLOCKED — core.hooksPath is" "and git showed the refusal, not a silent pass"
check "PHYSICAL — the refused commit landed nothing" "$( cd "$scratch/current" && git log --oneline | wc -l | tr -d ' ' )" "$N0"
try_commit "TABICHAT_GUARD_PROCEED=1" "proceeded after reading"
check "PHYSICAL — the same real commit, told to proceed, lands (rc=0)" "$(rc_of "$LAST")" "0"
check "PHYSICAL — and it landed exactly one commit" "$( cd "$scratch/current" && git log --oneline | wc -l | tr -d ' ' )" "$((N0 + 1))"
printf 'physical prose with a planted literal: %s\n' "$TEST_A" > phys.txt; git add phys.txt
try_commit "TABICHAT_GUARD_PROCEED=1" "must never land"
check "PHYSICAL PAIRED NEGATIVE — the prefix does not pass a real secret (rc=1)" "$(rc_of "$LAST")" "1"
contains "$(out_of "$LAST")" "a staged ADDED line matches" "the secret refusal is what stopped it"
check "PHYSICAL — and the flagged leak added no commit" "$( cd "$scratch/current" && git log --oneline | wc -l | tr -d ' ' )" "$((N0 + 1))"
check "no face wrote the venue's configuration" "$(git config --get core.hooksPath)" "$ESC"
git reset -q HEAD phys.txt 2>/dev/null; rm -f phys.txt

# (e) the refusal is the guard and not a typo: the identical call on a venue with NOTHING to displace.
rm -f "$LEG"; git config --local core.hooksPath .githooks
printf 'clean staged prose, own directory\n' > esc.txt; git add esc.txt
out=$(sh .githooks/pre-commit 2>&1); rc=$?
check "POSITIVE CONTROL — same call, nothing to displace: it runs (rc=0)" "$rc" "0"
lacks "$out" "DISPLACED" "and it invents no displacement when there is none"
lacks "$out" "PROCEEDING" "and it claims no waiver it was never given"
git clean -fdq esc.txt 2>/dev/null || true

git config --local --unset core.hooksPath
printf 'no configured value\n' > nodev.txt; git add nodev.txt
out=$(GIT_CONFIG_GLOBAL=/dev/null sh .githooks/pre-commit 2>&1); rc=$?
check "a clone with no core.hooksPath value runs the guard as asked (rc=0)" "$rc" "0"
contains "$out" "secret guard ran clean" "and it does not invent a displacement message"
git config --local core.hooksPath .githooks

say "THE ARM CHECK answers the fourth state — a guard that is simply not on the consulted path"
# src/tools/check_guard_armed.sh is asked because a hook cannot report its own absence: in a
# displaced clone nothing runs, so nothing inside the hook can say so. Each face below is the SAME
# tool on a DIFFERENT clone state, and both rc values are required — a check that has only ever
# printed ARMED is not evidence that it can see an unarmed clone.
ARM="$REPO/src/tools/check_guard_armed.sh"
[ -f "$ARM" ] || { bad "the arm check exists" "no file at $ARM"; }
setup_repo 7; mk_list; cd "$scratch/r7"; ln -sfn "$scratch/r7" "$scratch/current"
out=$(sh "$ARM" 2>&1); rc=$?
check "an armed clone answers ARMED (rc=0)" "$rc" "0"
contains "$out" "ARMED — git consults this clone" "and names the path git would consult"

ARMCH="$scratch/armchain"; mkdir -p "$ARMCH"
printf '#!/bin/sh\nexec sh "%s/.githooks/pre-commit" "$@"\n' "$scratch/r7" > "$ARMCH/pre-commit"
chmod +x "$ARMCH/pre-commit"; git config --local core.hooksPath "$ARMCH"
out=$(sh "$ARM" 2>&1); rc=$?
check "a chained hook set answers ARMED too (rc=0)" "$rc" "0"
contains "$out" "ARMED (chained)" "and it says which of the two armings it found"

git config --local --unset core.hooksPath
mkdir -p "$scratch/r7/.git/hooks"
printf '#!/bin/sh\nexit 0\n' > "$scratch/r7/.git/hooks/pre-commit"; chmod +x "$scratch/r7/.git/hooks/pre-commit"
out=$(GIT_CONFIG_GLOBAL=/dev/null sh "$ARM" 2>&1); rc=$?
check "PAIRED NEGATIVE — a consulted hook that does not invoke the guard answers NOT ARMED (rc=1)" "$rc" "1"
contains "$out" "NOT ARMED" "and it is a refusal, not a quiet line"
contains "$out" "git config --local core.hooksPath .githooks" "and it prints the command that fixes it"

rm -f "$scratch/r7/.git/hooks/pre-commit"
out=$(GIT_CONFIG_GLOBAL=/dev/null sh "$ARM" 2>&1); rc=$?
check "PAIRED NEGATIVE — a clone with NO consulted hook answers NOT ARMED (rc=1)" "$rc" "1"
contains "$out" "does not exist" "and it names the missing path as the reason"

out=$(cd "$scratch" && GIT_CONFIG_GLOBAL=/dev/null sh "$ARM" 2>&1); rc=$?
check "PAIRED NEGATIVE — outside a work tree it refuses rather than guessing (rc=1)" "$rc" "1"
contains "$out" "not inside a git work tree" "and it says that is the reason"
git config --local core.hooksPath .githooks

say "LEGACY-PATH CHAIN: the documented enable must not DISPLACE the user's own hook (iid 16 req 2/4)"
# `git config core.hooksPath .githooks` equals the guard's own directory, so the
# hooksPath-comparison block above is skipped ENTIRELY — and git then stops consulting
# $(git-dir)/hooks/pre-commit for the same reason: hooksPath replaces the whole consulted set. A clone
# that already had a prior hook (project check, husky, personal guard) loses it silently and the arm
# check still answered ARMED. This block is the follow-forward: the guard must CHAIN the prior hook
# after its own checks and propagate its exit status, and the arm check must say which of the two
# armed-with-prior-hook states it is in. All faces run in the fixture clone; nothing here touches a
# real venue's hooksPath.
setup_repo 8; mk_list; cd "$scratch/r8"; ln -sfn "$scratch/r8" "$scratch/current"
PRIOR8="$scratch/r8/.git/hooks/pre-commit"
printf '#!/bin/sh\nprintf "LEGACY-FIRED\\n" >&2\nexit 0\n' > "$PRIOR8"; chmod +x "$PRIOR8"
BEFORE8=$( cd "$scratch/r8" && git log --oneline | wc -l | tr -d ' ' )
run_commit "prior hook present, staged text clean"
check "the guard passes AND the prior hook fires (rc=0)" "$(rc_of "$LAST")" "0"
contains "$(out_of "$LAST")" "secret guard ran clean" "the guard itself ran first"
contains "$(out_of "$LAST")" "LEGACY-FIRED" "the prior hook is chained, not displaced"
# paired negative below reuses the same clone minus the planted file.
rm -f "$PRIOR8"
run_commit "no prior hook at all"
check "PAIRED NEGATIVE — the same clone without a prior hook still commits (rc=0)" "$(rc_of "$LAST")" "0"
contains "$(out_of "$LAST")" "secret guard ran clean" "and the guard did not invent a chain"
lacks "$(out_of "$LAST")" "LEGACY-FIRED" "nothing fired that was not there"
# the REFUSING prior hook: this is the face the review measured as rc 0 / marker 0 at b5648722.
printf '#!/bin/sh\nprintf "LEGACY-REFUSED\\n" >&2\nexit 1\n' > "$PRIOR8"; chmod +x "$PRIOR8"
BEFORE_REFUSAL=$( cd "$scratch/r8" && git log --oneline | wc -l | tr -d ' ' )
run_commit "prior hook present and refusing"
check "a refusing prior hook refuses the commit (rc=1) — its exit status propagates" "$(rc_of "$LAST")" "1"
contains "$(out_of "$LAST")" "LEGACY-REFUSED" "it fired"
AFTER_REFUSAL=$( cd "$scratch/r8" && git log --oneline | wc -l | tr -d ' ' )
check "the refused commit did not land (history unchanged)" "$AFTER_REFUSAL" "$BEFORE_REFUSAL"

say "ARM CHECK: a second state for armed-but-a-prior-hook-exists"
# the arm check's only read was `git rev-parse --git-path hooks/pre-commit`, which ANSWERS FOR THE
# CONFIGURED PATH — so in the documented state it could never see the displaced legacy hook and said
# ARMED about the wrong thing. It must keep saying ARMED (the guard IS consulted) and must also say
# whether a prior hook exists and whether the guard chains it.
PRIOR8X="$scratch/r8/.git/hooks/pre-commit"
out=$(sh "$ARM" 2>&1); rc=$?
check "the documented state still answers ARMED (rc=0) — the fix must not narrow the arm check" "$rc" "0"
contains "$out" "ARMED" "and stays a one-line answer"
case "$out" in
    *"prior hook"*) ok "it names the prior hook that exists at the legacy path in this very clone";;
    *) bad "it names the prior hook that exists at the legacy path" "no prior-hook clause while an executable .git/hooks/pre-commit exists right now";;
esac
rm -f "$PRIOR8X"
out=$(sh "$ARM" 2>&1); rc=$?
check "PAIRED NEGATIVE — same clone with no prior hook still answers ARMED (rc=0)" "$rc" "0"
case "$out" in
    *"prior hook"*) bad "it stays silent about a prior hook that is gone" "prior-hook clause printed with no such file";;
    *) ok "no prior-hook clause when nothing exists at the legacy path";;
esac
# The refusal face of the new clause: prior hook present + a guard that does NOT chain it (read out
# of HISTORY at the branch base, never paraphrased, and pinned like the REGRESSION PROOF above).
setup_repo 9; mk_list; cd "$scratch/r9"; ln -sfn "$scratch/r9" "$scratch/current"
printf '#!/bin/sh\nexit 1\n' > "$scratch/r9/.git/hooks/pre-commit"; chmod +x "$scratch/r9/.git/hooks/pre-commit"
OLD782=$(cd "$REPO" && git rev-parse "${TABICHAT_LEGACY_BASE:-b5648722}" 2>/dev/null)
oldhook=""
[ -n "$OLD782" ] && oldhook=$(cd "$REPO" && git show "$OLD782:.githooks/pre-commit" 2>/dev/null)
if [ -n "$oldhook" ] && ! printf '%s\n' "$oldhook" | grep -qs 'run_prior_hook'; then
    printf '%s\n' "$oldhook" > .githooks/pre-commit; chmod +x .githooks/pre-commit
    out=$(sh "$ARM" 2>&1); rc=$?
    check "a prior hook behind a NON-CHAINING guard answers NOT ARMED (rc=1) — the b5648722 face named" "$rc" "1"
    contains "$out" "does not chain the prior hook" "and it names what is displaced"
    contains "$out" ".git/hooks/pre-commit" "and it names the shadowed legacy path"
else
    bad "the non-chaining base hook is retrievable from history" "pin empty or the pinned hook already chains: TABICHAT_LEGACY_BASE is wrong"
fi
rm -rf "$scratch/r9"

say "THE RECURSION CLOSURE IS LOAD-BEARING: the env marker, asserted"
# Without TABICHAT_PRIOR_HOOK_CHAINED, a prior hook that chains the guard recurses: measured at
# a prior leg's pen — 721 chain announcements in 20 s before the run was cut off. A closure that lives
# only in a comment is a hole with a description on it, so this cell runs EXACTLY that shape: a
# prior hook whose body re-invokes the guard, under a bounded timeout. Correct behaviour is one
# announce and a landed commit; removed marker logic means the timeout fires and the announce
# count runs away — one check, both directions falsify it.
setup_repo 10; mk_list; cd "$scratch/r10"; ln -sfn "$scratch/r10" "$scratch/current"
printf '#!/bin/sh\nexec sh "%s/.githooks/pre-commit" "$@"\n' "$scratch/r10" > "$scratch/r10/.git/hooks/pre-commit"
chmod +x "$scratch/r10/.git/hooks/pre-commit"
r10out=$( cd "$scratch/r10" && printf 'chained twice\n' > two.txt && git add two.txt \
    && { timeout 15 git commit -m "prior hook chains the guard itself" 2>&1; printf '@@RC=%s@@' "$?"; } )
r10rc=$(printf '%s' "$r10out" | sed -n 's/.*@@RC=\([0-9]*\)@@.*/\1/p')
r10n=$(printf '%s\n' "$r10out" | grep -c 'chaining the prior hook')
check "self-chaining prior: commit lands once, exactly one chain announce (rc|announces)" "$r10rc|$r10n" "0|1"

say "THE GATE IS CONSUMED — an array nothing reads is not a requirement"
# deploy-tabichat.sh runs GATES through bun, and bun 1.4.3 cannot run a shell file at all: measured at
# this leg's gate run, `bun tools/check_guard_armed.sh` fails with "Unexpected ')'" while `sh` on the
# same file returns 0. So the arm check lives in SHGATES, which has its own executor. Both halves are
# asserted here — the name in the array, and the array being read — because either one alone can go
# missing while the file still looks registered.
DEP="$REPO/src/tools/deploy-tabichat.sh"
inarray=$(grep -c 'SHGATES=(check_guard_armed.sh)' "$DEP" || true)
check "the arm check is named in the shell-gate array" "$inarray" "1"
# Each name is asserted separately as well: an array that loses one member while keeping the line's exact
# text is the failure this cell family exists to catch, and a single whole-line pin cannot see it.
# Membership is read out of the array's own contents, and from BOTH forms it can be written in: the
# literal and a later `+=`. A whole-line pin on the literal cannot see a member dropped from an appended
# line, which is exactly how a registered-but-never-run check hides.
shgate_members() {
    # `SHGATES=(` and `SHGATES+=(` are two different shapes and BOTH register a gate: a reader written
    # for the first one silently reports an appended member as absent, which is how a registered check
    # can be missing from the census and still be running.
    grep -E '^[[:space:]]*SHGATES\+?=' "$DEP" | sed 's/^[^=]*=+*//' | tr -d '()' | tr ' \t' '\n\n' | grep . || true
}
member_count=$(shgate_members | grep -c .)
# Eight members, and the count is read, not remembered: the arm check, the hook-chain enabler, the two
# attribution checks, this loop's own truth table, the subject guard's armed check, the subject guard's
# behaviour test, and — from the leg that brought dev onto the version it declares — the release-record
# check. The secret guard's own truth table is NOT a member: it counts this array, and test_gate_words.sh
# rewrites the array in the scratch clone it deploys, so registering the counter would make it assert a
# number about a tree that is not the shipped one (measured: 2 history-pinned cells plus the census red
# inside that clone, and the real deploy stopping at position 5 with 14 of 40 gate-word cells red). The
# number below is what `shgate_members | grep -c .` prints in THIS tree at THIS face — 8 at 54e1e98, read
# in the same turn as this edit, after the registration and before this line was edited — not a value
# carried over from any branch or any dispatch page. Merge order decides it: a gate that lands after this
# one makes it nine, and the next face re-derives it here.
# Re-derived on this face: 12, read by the same command in the same turn this line was written. The
# twelfth is `check_cite_faces.sh`, registered by the iid-27 leg and NEVER added to the two lists below
# — so the individual-membership loop and the bun-run fold both printed a green answer about a member
# they had never looked at, which is the exact failure this file says it exists to catch. Both lists now
# name it, and the count is what the instrument prints here, not a value carried over from a branch.
# Re-derived on this face: 13, read by the same command in the same turn this line was written (the run
# printed `got '13', want '12'` before the number below moved, which is the instrument answering, not a
# guess confirmed). The thirteenth is `test_mint_pki.sh`, the PKI minter's truth table, registered by the
# same leg IN BOTH LISTS BELOW — the membership loop and the bun-run fold — because a member named in the
# array and not in a list is a check those lists report green about a file they never looked at.
check "the shell-gate array holds thirteen members across both forms" "$member_count" "13"
for gate in check_guard_armed.sh test_hook_chain.sh check_attributions.sh test_attribution_pins.sh test_gate_words.sh check_subject_armed.sh test_subject_guard.sh check_release_record.sh test_gate_coverage.sh test_deploy_pi_nm.sh test_paho_skip.sh check_cite_faces.sh test_mint_pki.sh; do
    one=$(shgate_members | grep -c "^${gate}$")
    check "  and $gate is individually present" "$one" "1"
done
# none of the thirteen is in the bun-run GATES array — the alternation below names all of them, so a shell gate
# cannot be folded into the array whose interpreter cannot run one. Every member belongs in that
# alternation: a name left out is a fold that prints a green zero instead of refusing.
inbun=$(grep -Ec '^[[:space:]]*GATES=.*(check_guard_armed|check_attributions|test_attribution_pins|test_hook_chain|test_gate_words|check_subject_armed|test_subject_guard|check_release_record|test_gate_coverage|test_deploy_pi_nm|test_paho_skip|check_cite_faces|test_mint_pki)' "$DEP" || true)
check "none of the thirteen is in the bun-run GATES array, which could not run a shell file" "$inbun" "0"

say "CLEANUP: no scratch, and no stray file in the real repo's worktree or git dir"
cd "$REPO"
stray=$(find .git -maxdepth 1 -name '.forbidden-strings.*' 2>/dev/null | wc -l | tr -d ' ')
check "the hook left no scratch pattern file in the git dir" "$stray" "0"
wt=$(git status --porcelain | grep -c 'forbidden' || true)
check "nothing pattern-shaped ever appeared in the worktree status" "$wt" "0"
rm -rf "$scratch"

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells' "$failed" "$ran" || printf 'all %d secret-guard cells pass' "$ran")"
[ "$failed" -gt 0 ] && exit 1
exit 0
