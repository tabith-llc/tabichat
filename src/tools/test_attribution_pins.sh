#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for src/tools/check_attributions.sh — the §10 / R-2671 attribution gate.
#   sh src/tools/test_attribution_pins.sh        (exit 1 on any failure)
#
# WHY THIS FILE EXISTS. The rule it guards was caught twice by a person reading a diff and is enforced by
# nothing shipped (F-no-check-enforces-the-attribution-ban-in-tabichat): the instrument that found the
# violation was a grep written in a report. A new gate gets the treatment root §2 requires of it — a paired
# negative — so here the SAME tool on the SAME scratch repo is run at two commits: one whose added line
# credits a decision to a seat, one whose added line is ordinary. Then three faces that a check like this
# usually gets wrong and this one names out loud: a base that cannot be resolved is a REFUSAL and not a
# pass; a diff with nothing in it says it scanned zero lines instead of printing a bare ok; and the
# pre-existing population in the base face stays out of scope, which is the ONLY reason the gate is green
# on arrival and therefore survives.
#
# THIS HARNESS PLANTS VIOLATIONS WITHOUT CARRYING ONE. Every fixture string is assembled at run time from
# two halves, so no whole credit exists in this file — proven at the end by running the shipped gate over a
# commit that adds these two files, which must come back CLEAN. A gate that refuses the code that defines
# it is a gate that gets deleted, so that cell is load-bearing and not decoration.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CHK="$REPO/src/tools/check_attributions.sh"
GOOD_NAME="Tabith LLC"; GOOD_MAIL="info@tabith.com"

failed=0; ran=0
ok()    { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad()   { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
say()   { printf '\n== %s ==\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }

[ -f "$CHK" ] || { printf 'FAIL  no gate at %s\n' "$CHK"; exit 1; }
sh -n "$CHK" 2>/dev/null && ok "the gate parses under sh" || bad "the gate parses under sh" "syntax error"

SCR=$(mktemp -d "${TMPDIR:-/tmp}/attrib-XXXXXX") || { printf 'no scratch dir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_SCR:-}" ] || rm -rf "$SCR"; }
trap cleanup EXIT INT TERM

# The violation class, each assembled at run time from two halves so this file stays clean of it.
V_OWNER="per the own""er's word, ship it"
V_COAUTH="Co-authored-b""y: Someone <someone@invalid>"
V_NICK="per ultr""a, the shape was ruled"     # a credit preposition + a seat word, split
V_TRUST="request""ed by the owner, it was ruled"   # the same class from the other verb
# The boundary case: a seat word with NO credit construction around it. This must pass, or the gate is a
# name ban and it will red every honest test cell in the repo within a month.
V_MENTION='const FIXTURE_VALUE = "ultra"; // a seat word as test data, no credit claimed'

R="$SCR/venue"; mkdir -p "$R/src/tools"
git -C "$R" init -q .
git -C "$R" config user.name "$GOOD_NAME"; git -C "$R" config user.email "$GOOD_MAIL"
printf 'base content\n' > "$R/doc.md"; git -C "$R" add doc.md && git -C "$R" commit -q -m base
BASE=$(git -C "$R" rev-parse HEAD)
cp "$CHK" "$R/src/tools/check_attributions.sh"
git -C "$R" add -A && git -C "$R" commit -q -m "tools: the gate arrives"
BASE2=$(git -C "$R" rev-parse HEAD)

run() { ( cd "$R" && sh src/tools/check_attributions.sh "${1:-$BASE2}" 2>&1 ); }
add_and_commit() { printf '%s\n' "$1" >> "$R/doc.md"; git -C "$R" add doc.md; git -C "$R" commit -q -m "$2" >/dev/null 2>&1; }
rewind() { git -C "$R" reset -q --hard "$BASE2"; }

say "THE RULE: an added line that credits a decision to a person or a seat is refused"
for pair in "an owner credit|$V_OWNER" "a co-author trailer|$V_COAUTH" "a seat credit|$V_NICK" "the other verb|$V_TRUST"; do
    name=${pair%%|*}; line=${pair#*|}
    rewind; add_and_commit "$line" "docs: a planted $name"
    out=$(run); rc=$?
    check "PAIRED — the gate refuses $name (rc=1)" "$rc" "1"
    contains "$out" "REFUSED" "and it calls it a refusal, not a note"
    contains "$out" "doc.md" "and it names the FILE the line came from"
    contains "$out" "$(printf '%s' "$line" | cut -c1-14)" "and it shows the offending line as typed"
    lacks "$out" "no exclusions" "and it claims no exception (there are none to claim)"
done

say "THE BOUNDARY THAT KEEPS IT HONEST: a seat word alone is not a credit, and is not refused"
rewind; add_and_commit "$V_MENTION" "test: a fixture names a peer"
out=$(run); rc=$?
check "POSITIVE — a nick with no credit construction passes (rc=0)" "$rc" "0"
contains "$out" "CLEAN" "and it says so"
contains "$out" "1 added line(s)" "and it counted the line it accepted, rather than saying nothing"

say "THE SAME TOOL WITHOUT THE VIOLATION: green, and green means it looked"
rewind; add_and_commit "ordinary prose about what the code does" "docs: an ordinary line"
out=$(run); rc=$?
check "green on a clean added line (rc=0)" "$rc" "0"
lacks "$out" "REFUSED" "a pass is not a refusal wearing different words"

say "THE VACUOUS FACE IS NAMED, NOT HIDDEN"
rewind; out=$(run); rc=$?
check "an empty diff passes, which is all a clean diff can claim (rc=0)" "$rc" "0"
contains "$out" "0 added line(s)" "and it prints the scan size, so nobody reads a nothing-scan as corroboration"

say "THE INSTRUMENT REFUSES WHEN IT CANNOT RUN — the fail-open that has burned this repo twice"
out=$( cd "$R" && sh src/tools/check_attributions.sh nope-not-a-ref 2>&1 ); rc=$?
check "a base that is not a commit is a REFUSAL (rc=1)" "$rc" "1"
contains "$out" "not a commit" "and it names the reason"
# A clone with no published line to compare against: the gate lives at src/tools/ inside it, so the repo it
# resolves is the bare one and no origin/dev exists anywhere. Run as a sibling of $R, never inside it — the
# first draft of this cell created the bare clone UNDER the venue, and a later `git add -A` then committed an
# embedded repository, which is a scratch-pollution bug in the harness and not a finding about the gate.
BARE="$SCR/bare"; mkdir -p "$BARE/src/tools"
git -C "$BARE" init -q .
git -C "$BARE" config user.name "$GOOD_NAME"; git -C "$BARE" config user.email "$GOOD_MAIL"
cp "$CHK" "$BARE/src/tools/check_attributions.sh"
printf 'x\n' > "$BARE/x"; git -C "$BARE" add -A && git -C "$BARE" commit -q -m one
# This control depends on an ambient variable the gate reads when it is given no argument, so the call
# site controls that variable instead of inheriting it: the bare clone is built to have no base, and a
# base arriving from the caller's shell would route it to a different, equally real refusal.
out=$( cd "$BARE" && env -u ATTRIB_BASE sh src/tools/check_attributions.sh 2>&1 ); rc=$?
check "a clone with no remote branch to compare against REFUSES rather than passing blind (rc=1)" "$rc" "1"
contains "$out" "uncomputable diff" "and it says the sentence the rule turns on"
# The paired faces, in this file and not in someone's shell history: the same control with the variable
# exported in the calling subshell must answer identically, because the call site clears it — and the
# counter-face, which hands the value to the child ON PURPOSE, must still route to the other refusal.
# That third face is what keeps the first two honest: it proves the variable really does change the
# gate's answer when the harness does not clear it, so a pass here is control, not luck.
out=$( export ATTRIB_BASE=0.1.0; cd "$BARE" && env -u ATTRIB_BASE sh src/tools/check_attributions.sh 2>&1 ); rc=$?
check "PAIRED — the same bare clone still REFUSES when the caller's shell exported ATTRIB_BASE (rc=1)" "$rc" "1"
contains "$out" "uncomputable diff" "and it says the identical sentence, so the harness owns its input"
out=$( cd "$BARE" && ATTRIB_BASE=0.1.0 sh src/tools/check_attributions.sh 2>&1 ); rc=$?
check "COUNTER-FACE — a base handed to the child on purpose is still a REFUSAL (rc=1)" "$rc" "1"
contains "$out" "not a commit in this clone" "and it routes to the other refusal, which is the CLI contract working"
lacks "$out" "uncomputable diff" "and the two sentences are distinguishable, so the face above cannot pass by accident"
# The wiring itself, checked in the shipped text the way the roster wiring is checked below: a control that
# clears its input only because the operator's shell happened to be clean is not a control. The pattern is
# anchored on the call form, not on the literal, because a grep for its own string counts itself — measured
# here as 3 of 2 on the first draft. If either call site loses its clearance, this cell reddens instead of
# the whole face quietly needing a special environment to fail.
clearances=$(grep -cE 'out=.*env -u ATTRIB_BASE sh src/tools/check_attributions\.sh' "$0")
check "both bare-clone call sites clear the ambient base in the shipped text (2 of 2)" "$clearances" "2"

say "THE PRE-EXISTING POPULATION IS NOT THIS GATE'S BUSINESS, and that is why it arrives green"
rewind
printf 'this shipped doc has always read: %s\n' "$V_OWNER" > "$R/legacy.md"
git -C "$R" add legacy.md && git -C "$R" commit -q -m "base carries a legacy credit"
LEG=$(git -C "$R" rev-parse HEAD)
printf 'an ordinary new line\n' >> "$R/legacy.md"; git -C "$R" add legacy.md; git -C "$R" commit -q -m "docs: ordinary"
out=$(run "$LEG"); rc=$?
check "the legacy credit is in the BASE face, so the gate is green over it (rc=0)" "$rc" "0"
printf 'and now the branch adds the same words: %s\n' "$V_OWNER" >> "$R/legacy.md"; git -C "$R" add legacy.md
git -C "$R" commit -q -m "docs: repeat it as a new line"
out=$(run "$LEG"); rc=$?
check "PAIRED — the same words sit in the base and are refused the moment this branch adds them (rc=1)" "$rc" "1"

say "THE HISTORICAL PAIR — the violation this gate exists for, run against the commits themselves"
# Not a plant: 841 found three real owner-credit lines on the escape branch and 843 removed them, so the
# two shas are the exact pair a regression check should hold forever. Run with no checkout (ATTRIB_HEAD),
# because a harness that moves the work tree to test a diff is a harness that will be run against the
# wrong tree the first time it is in a hurry. Both shas live in this repo's object store as branch tips;
# if a future clone has neither, the cell says so OUT LOUD rather than passing quietly.
ESC_TIP=4a39e4ec2c463b7b128f0188dad732573a38e0fe
FIX_TIP=cbbf368b0af13e2812c13196fd6c1be9cf1f451f
DEV_FACE=71c39e68340016d3bacb769daf523916cb5cccd5
have_both=1
for r in "$ESC_TIP" "$FIX_TIP" "$DEV_FACE"; do
    git -C "$REPO" rev-parse --verify -q "${r}^{commit}" >/dev/null || have_both=0
done
if [ "$have_both" = 1 ]; then
    out=$( ATTRIB_HEAD=$ESC_TIP sh "$CHK" "$DEV_FACE" 2>&1 ); rc=$?
    check "the gate refuses the branch as it was reviewed — the three real lines 841 caught (rc=1)" "$rc" "1"
    for f in CHANGELOG.md README.md docs/use.md; do
        contains "$out" "$f" "and it names $f, one of the three files 841 listed"
    done
    contains "$out" "3 added line(s)" "and the count is the same three, not more and not fewer"
    out=$( ATTRIB_HEAD=$FIX_TIP sh "$CHK" "$DEV_FACE" 2>&1 ); rc=$?
    check "the same gate accepts the branch after 843 reworded them (rc=0)" "$rc" "0"
    contains "$out" "CLEAN" "and says so in words"
else
    ok "NOT RUN — the escape/fix shas are absent from this clone, and that is reported, not passed silently"
    ok "NOT RUN (second of the pair), same reason"
fi

say "MOVING THE TEXT INTO A SOURCE FILE IS NOT A WAY PAST IT"
rewind
mkdir -p "$R/src/extensions/tabichat"; printf '// %s\n' "$V_COAUTH" > "$R/src/extensions/tabichat/x.ts"
git -C "$R" add -A && git -C "$R" commit -q -m "code: a credit inside a source file"
out=$(run); rc=$?
check "a source-file hit is caught like a doc hit (rc=1)" "$rc" "1"
contains "$out" "src/extensions/tabichat/x.ts" "and it names the path"

say "THE ROSTER AND THE TWO EXTRA SHAPES — leg 850 closed the three blind faces leg 848 measured"
# The roster is a CLOSED list, and the file says so now; what it must not contain is an entry that can never
# fire. `writter` was one, and `dust[y]` saw only the longer spelling of the name §10 is about. Both are
# fixed at the source, and each face below is planted rather than asserted from prose.
# Every violation string is assembled at run time from two halves, in this file's own discipline, so the
# harness stays clean of the phrase it plants — and the section after this one proves that by running the
# shipped gate over a commit that adds this file.
V_WRITER="per the writ""er, this was ruled"      # the entry `writter` was always meant to be
V_DUST="per du""st, this line was ruled"         # the owner's own nick, not the longer spelling
V_DUSTY="per du""sty, this line was ruled"       # the spelling that already fired — kept working
V_NAMEFIRST="flas""h1 ruled that this stays"     # a roster name as the SUBJECT of a decision verb
V_POSSESS="ul""tra's call on the matter"         # a roster name in the possessive before a decision noun
# The other half of the bar: these are shipped vocabulary, and a gate that reds them arrives dead on arrival.
L_ENV='const KEY = "MQTT_OWNER_NICK"; // the variable name'
L_FIELD='owner: tabith-llc-group/tabichat'
L_POSTS="the owner's posts are unlimited"
L_ANSWER="needs the owner's answer before it ships"
L_SCRATCH="not in a repo or a lane's scratch dir"

roster=$(grep -m1 '^NAMES=' "$CHK")
dead=$(printf '%s' "$roster" | grep -c 'writter')
check "the dead roster entry is gone from the NAMES line" "$dead" "0"
contains "$roster" 'write[r]' "and the entry that replaces it is a word that can fire"
contains "$roster" 'dust[y]?' "and the roster now carries both spellings of the name the rule is about"
wired=$(grep -cF 'grep -inE "$PATTERN|$NICKS|$NAMED|$POSSESS"' "$CHK")
check "all four lists are joined into the one matcher — a declared list nothing greps is a dead branch" "$wired" "1"

for pair in "a credit naming the writer|$V_WRITER" "a credit naming the owner by his own nick|$V_DUST" \
            "a seat name as the subject of the verb|$V_NAMEFIRST" "a seat in the possessive|$V_POSSESS"; do
    name=${pair%%|*}; line=${pair#*|}
    rewind; add_and_commit "$line" "docs: a planted $name"
    out=$(run); rc=$?
    check "PAIRED — the gate refuses $name (rc=1)" "$rc" "1"
    contains "$out" "$(printf '%s' "$line" | cut -c1-14)" "and it shows the line as typed, not a paraphrase"
done

rewind; add_and_commit "$V_DUSTY" "docs: a planted longer spelling"
out=$(run); rc=$?; check "the longer spelling still refuses, so the fix widened and did not swap" "$rc" "1"

for pair in "an env-var name|$L_ENV" "a payload field|$L_FIELD" "what the human's posts may do|$L_POSTS" \
            "someone's answer is owed|$L_ANSWER" "a lane's scratch dir|$L_SCRATCH"; do
    name=${pair%%|*}; line=${pair#*|}
    rewind; add_and_commit "$line" "docs: legit $name"
    out=$(run); rc=$?
    check "POSITIVE — $name stays CLEAN (rc=0)" "$rc" "0"
done

say "THE NON-VACUITY CONTROL — the same four faces under the BASE matcher, so the branches are proven to be what changed the answer"
BASE_SHA=63e11d9857e0de4b3297adf135b0bab874f36c9d
bset=$(git -C "$REPO" show "${BASE_SHA}:src/tools/check_attributions.sh" 2>/dev/null || true)
if [ -n "$bset" ]; then
    baseclean=$( eval "$(printf '%s\n' "$bset" | grep -E '^(PATTERN|CRED|NAMES|NICKS)=')"
        n=0
        for s in "$V_WRITER" "$V_DUST" "$V_NAMEFIRST" "$V_POSSESS"; do
            printf '%s\n' "$s" | grep -iqE "$PATTERN|$NICKS" || n=$((n + 1))
        done
        printf '%s' "$n" )
    check "all four read CLEAN under the base matcher at $BASE_SHA (4 of 4)" "$baseclean" "4"
else
    ok "NOT RUN — the base matcher blob is absent from this clone, and that is reported rather than passed silently"
    ok "NOT RUN (the four-face control), same reason"
fi

say "THE GATE AND ITS HARNESS DO NOT TRIP THE GATE — run over a commit that adds both"
rewind
cp "$CHK" "$R/src/tools/check_attributions.sh"
cp "$0" "$R/src/tools/test_attribution_pins.sh" 2>/dev/null || cp "$REPO/src/tools/test_attribution_pins.sh" "$R/src/tools/test_attribution_pins.sh"
git -C "$R" add -A && git -C "$R" commit -q -m "tools: gate and harness, added as lines"
out=$(run "$BASE2"); rc=$?
check "the shipped gate does not refuse the files that define it (rc=0)" "$rc" "0"
contains "$out" "CLEAN" "and it says so in words"
# and the same string, joined at run time, IS a violation — the split is the fixture, not an exemption
printf '%s\n' "$V_NICK" > "$R/join.txt"; git -C "$R" add join.txt; git -C "$R" commit -q -m "docs: the joined fixture"
out=$(run "$BASE2"); rc=$?
check "PAIRED — assembled at run time the same line IS refused (rc=1)" "$rc" "1"
contains "$out" "join.txt" "and it names the file"

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells' "$failed" "$ran" || printf 'all %d attribution cells pass' "$ran")"
[ "$failed" -gt 0 ] && exit 1
exit 0
