#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for .githooks/pre-commit — the secret guard.
#   sh src/tools/test_secret_guard.sh        (exit 1 on any failure)
#
# WHY THIS FILE EXISTS. The guard it tests passed every commit on this box for an unknown span
# WITHOUT COMPARING ANYTHING: the decoder it called (`xxd`) is absent on idaho and the decode line
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

TEST_A="flash6-guard-cell-DO-NOT-COMMIT-7z"
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
BASE=$(cd "$REPO" && git rev-parse "${TABICHAT_GUARD_BASE:-1638bad}" 2>/dev/null)
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
