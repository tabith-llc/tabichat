#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for src/tools/enable_hook_chain.sh — the enabler that answers tabichat iid 15.
#   sh src/tools/test_hook_chain.sh        (exit 1 on any failure)
#
# WHY THIS FILE EXISTS, and the one requirement it is written against. iid 15 AC2 is not "the tool
# prints something helpful": it is that a clone which FOLLOWED the shipped enable instruction still
# has the host identity guard running — one refused commit with a wrong identity, rc != 0 — and still
# has this repo's secret guard refusing a planted forbidden string. Both halves, same clone, same
# instruction, no hand-editing in between. A cell that only proves a directory was written proves
# nothing about coverage; the only proof is a real `git commit`, refused twice for two different
# reasons and accepted once.
#
# HOW THE HOST IS SIMULATED, and why nothing here can touch the box. Every git call, the enabler, and
# the arm check all run with GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM pointed at files inside this
# harness's scratch directory, and with cwd INSIDE the fixture clone. The real ~/.gitconfig — which on
# a configured host holds a core.hooksPath of its own — is never read and never written, and no hook path
# of any real venue is re-aimed by anything below. That second point is not style: the first draft of
# this file ran the enabler from the harness's own cwd, so every face answered for the venue the
# harness happened to sit in. The `en` helper below is the correction, and it is the reason the cells
# can be trusted.
#
# The "incumbent global guard" is a fixture this file writes. It enforces the same rule the deployed
# guard gives the real one — author AND committer must be Tabith LLC <info@tabith.com> — and prints HOST-RAN /
# HOST-REFUSED so a cell can tell that guard's decision from any other non-zero status.
#
# NO REAL SECRET IS USED. Each fixture clone gets a one-row pattern list whose plaintext is the
# synthetic literal in CELL below; the repo's own rows are never copied.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENABLER="$REPO/src/tools/enable_hook_chain.sh"
ARMCHK="$REPO/src/tools/check_guard_armed.sh"
GUARD_SRC="$REPO/.githooks/pre-commit"
DEPLOY="$REPO/src/tools/deploy-tabichat.sh"
CELL="chain-cell-DO-NOT-COMMIT-7q"
HEX_CELL="636861696e2d63656c6c2d444f2d4e4f542d434f4d4d49542d3771"
GOOD_NAME="Tabith LLC"; GOOD_MAIL="info@tabith.com"

failed=0; ran=0
ok()    { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad()   { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
say()   { printf '\n== %s ==\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }

SCR=$(mktemp -d "${TMPDIR:-/tmp}/hookchain-XXXXXX") || { printf 'no scratch dir\n' >&2; exit 1; }
cleanup() { [ -n "${KEEP_SCR:-}" ] || rm -rf "$SCR"; }
trap cleanup EXIT INT TERM

cfgenv() { # cfgenv <clone> — the two config files this clone's world consists of
    printf 'GIT_CONFIG_GLOBAL=%s GIT_CONFIG_SYSTEM=%s' "$SCR/$(basename "$1")-global" "$SCR/$(basename "$1")-system"
}
gc() { # gc <clone> <git args...> — every call inside this harness's config world
    d=$1; shift
    GIT_CONFIG_GLOBAL="$SCR/$(basename "$d")-global" GIT_CONFIG_SYSTEM="$SCR/$(basename "$d")-system" \
        git -C "$d" "$@" 2>&1
}
en() { # en <clone> [args...] — the shipped enabler, run from INSIDE the clone, as the header tells a
    # user to run it. cwd matters: the tool resolves the work tree from where it is invoked, so running
    # it from anywhere else tests some other venue, not this fixture.
    d=$1; shift
    ( cd "$d" && GIT_CONFIG_GLOBAL="$SCR/$(basename "$d")-global" GIT_CONFIG_SYSTEM="$SCR/$(basename "$d")-system" \
        sh "$ENABLER" "$@" 2>&1 )
}
arm() { # arm <clone> — the shipped arm check, same discipline
    d=$1
    ( cd "$d" && GIT_CONFIG_GLOBAL="$SCR/$(basename "$d")-global" GIT_CONFIG_SYSTEM="$SCR/$(basename "$d")-system" \
        sh "$ARMCHK" 2>&1 )
}
count() { gc "$1" rev-list --count HEAD | tr -d ' \n'; }

# ---- the fixture host guard, in a directory of its own, as the deployed guard installs the real one --
GH="$SCR/githooks"
write_host_guard() { # rebuilt by one face on purpose (the refusal cell removes it)
    mkdir -p "$GH"
    cat > "$GH/pre-commit" <<'FIX'
#!/bin/sh
# fixture of a host-wide identity guard: refuses unless author AND committer are the fleet identity.
a=$(git var GIT_AUTHOR_IDENT 2>/dev/null) || { printf 'HOST-REFUSED author-unresolvable\n' >&2; exit 1; }
c=$(git var GIT_COMMITTER_IDENT 2>/dev/null) || { printf 'HOST-REFUSED committer-unresolvable\n' >&2; exit 1; }
for v in "$a" "$c"; do
    case "$v" in
        "Tabith LLC <info@tabith.com>"*) ;;
        *) printf 'HOST-REFUSED %s\n' "$v" >&2; exit 1 ;;
    esac
done
printf 'HOST-RAN\n' >&2
exit 0
FIX
    printf '#!/bin/sh\nprintf "HOST-COMMITMSG-RAN\\n" >&2\nexit 0\n' > "$GH/commit-msg"
    chmod 755 "$GH/pre-commit" "$GH/commit-msg"
}
write_host_guard

# $1 = tag; $2 = "global" (a host guard directory is installed) or "plain" (nothing is)
mkclone() {
    d="$SCR/$1"; mkdir -p "$d/.githooks"
    if [ "$2" = global ]; then printf '[core]\n\thooksPath = %s\n' "$GH" > "$SCR/$1-global"
    else : > "$SCR/$1-global"; fi
    : > "$SCR/$1-system"
    gc "$d" init -q .
    gc "$d" config user.name "$GOOD_NAME"
    gc "$d" config user.email "$GOOD_MAIL"
    cp "$GUARD_SRC" "$d/.githooks/pre-commit"
    printf '%s\n' "$HEX_CELL" > "$d/.githooks/forbidden-strings.hex"
    printf 'readme\n' > "$d/README.md"; gc "$d" add README.md >/dev/null
    gc "$d" commit -q --no-verify -m init >/dev/null
    printf '%s' "$d"
}
stage() { printf '%s\n' "$2" > "$1/work.txt"; gc "$1" add work.txt >/dev/null; }
wrongid() { gc "$1" config user.name "someone-else"; gc "$1" config user.email "seat@invalid"; }
goodid()  { gc "$1" config user.name "$GOOD_NAME";  gc "$1" config user.email "$GOOD_MAIL"; }

[ -f "$ENABLER" ] || { bad "the enabler exists" "no file at $ENABLER"; printf '\n%d cells, %d failures\n' "$ran" "$failed"; exit 1; }
sh -n "$ENABLER" 2>/dev/null && ok "the enabler parses under sh" || bad "the enabler parses under sh" "syntax error"

say "AC2 — an incumbent global guard: following the shipped step leaves BOTH guards running"
G=$(mkclone g1 global); N0=$(count "$G"); wrongid "$G"; stage "$G" "clean prose for the chain"
out=$(en "$G"); rc=$?
check "the enabler answers rc=0" "$rc" "0"
contains "$out" "ARMED BY FORWARDING" "it says it forwarded, not replaced"
contains "$out" "global" "and it names the scope it found the incumbent in"
hp=$(gc "$G" config --get core.hooksPath)
case "$hp" in
    "$G/.git/"*) ok "the local value points at a chain directory inside THIS clone: $hp";;
    *) bad "the chain directory is inside this clone" "got '$hp'";;
esac
[ "$hp" != "$GH" ] && ok "and it is not the incumbent directory — nothing was written into someone else's tree" || bad "the chain directory is not the incumbent" "same path"
[ -x "$hp/pre-commit" ] && ok "a wrapper exists for pre-commit" || bad "a wrapper exists for pre-commit" "missing or not executable"
[ -x "$hp/commit-msg" ] && ok "a wrapper exists for the incumbent's OTHER name too — one hooksPath replaces every name" || bad "the incumbent's commit-msg is forwarded, not dropped" "no wrapper"

# (1) the host guard still refuses a wrong identity, after the enable step
out=$(gc "$G" commit -m "wrong identity after the enable step"); rc=$?
check "PAIRED NEGATIVE — a wrong-identity commit is STILL refused after enabling (rc!=0)" "$([ "$rc" -ne 0 ] && echo refused)" "refused"
contains "$out" "HOST-REFUSED" "and it was the HOST guard that refused it, not ours"
check "the refused commit landed nothing" "$(count "$G")" "$N0"

# (2) right identity, planted secret: this repo's guard still refuses
goodid "$G"; stage "$G" "config line: $CELL = true"
out=$(gc "$G" commit -m "planted literal"); rc=$?
check "PAIRED NEGATIVE — the secret guard still refuses a planted forbidden string (rc=1)" "$rc" "1"
contains "$out" "forbidden-strings.hex" "naming the pattern list, so it is this repo's guard speaking"
contains "$out" "HOST-RAN" "the host guard ran first in that same commit"
check "the flagged leak landed nothing" "$(count "$G")" "$N0"

# (3) both guards happy → the commit lands, exactly one
stage "$G" "clean prose at last"
out=$(gc "$G" commit -m "both guards passed"); rc=$?
check "POSITIVE — with both guards satisfied the commit lands (rc=0)" "$rc" "0"
contains "$out" "HOST-RAN" "the host hook ran"
contains "$out" "secret guard ran clean" "and so did this repo's"
check "exactly one new commit" "$(count "$G")" "$((N0 + 1))"

# (4) an incumbent refusal on commit-msg propagates: the chain is not pre-commit-only cover
printf '#!/bin/sh\nprintf "HOST-COMMITMSG-REFUSED\\n" >&2\nexit 1\n' > "$GH/commit-msg"; chmod 755 "$GH/commit-msg"
NB=$(count "$G"); stage "$G" "clean prose, commit-msg refuses"
out=$(gc "$G" commit -m "must not land"); rc=$?
check "PAIRED — a host refusal on commit-msg stops the commit through the chain (rc!=0)" "$([ "$rc" -ne 0 ] && echo refused)" "refused"
contains "$out" "HOST-COMMITMSG-REFUSED" "the incumbent's own voice, not a paraphrase"
check "and it landed nothing" "$(count "$G")" "$NB"
write_host_guard

say "THE OTHER HALF OF iid 15 — the plain host: the fix must not break the case that had no trap"
P=$(mkclone p1 plain); goodid "$P"
out=$(en "$P"); rc=$?
check "rc=0 on a host with nothing installed" "$rc" "0"
contains "$out" "no host hook set was in place" "it says WHY the plain value is right here"
check "the local value is the documented .githooks" "$(gc "$P" config --get core.hooksPath)" ".githooks"
[ -e "$P/.git/tabichat-hooks" ] && bad "no chain directory was built for nothing" "it exists" || ok "and no chain directory was invented either"
stage "$P" "clean prose, plain host"
out=$(gc "$P" commit -m "plain host commit"); rc=$?
check "the guard runs and the commit lands (rc=0)" "$rc" "0"
contains "$out" "secret guard ran clean" "a real comparison, stated out loud"
stage "$P" "a planted $CELL line"
out=$(gc "$P" commit -m "leak on the plain host"); rc=$?
check "PAIRED NEGATIVE — the secret guard still refuses on the plain host (rc=1)" "$rc" "1"

say "CONTROL — the bare line the header used to ship really did disable the host guard"
B=$(mkclone b1 global); NB=$(count "$B"); wrongid "$B"
gc "$B" config --local core.hooksPath .githooks        # the OLD shipped instruction, applied as written
stage "$B" "clean prose, shadowed host"
out=$(gc "$B" commit -m "wrong identity under the bare line"); rc=$?
check "the instrument can fire: under the bare line a wrong-identity commit LANDS (rc=0)" "$rc" "0"
hostlines=$(printf '%s' "$out" | grep -c 'HOST-' || true)
check "and the host guard printed nothing at all — absence, not a pass" "$hostlines" "0"
check "so the identity it wrote was the venue's own, not the fleet's" "$(printf '%s' "$(gc "$B" log -1 --format='%an <%ae>')" | grep -c 'someone-else')" "1"
out=$(en "$B"); rc=$?
check "the enabler repairs a clone already left in that state (rc=0)" "$rc" "0"
NC=$(count "$B")
out=$(gc "$B" commit -m "wrong identity, now forwarded"); rc=$?
check "PAIRED — the selfsame commit that slipped through is refused after the run (rc!=0)" "$([ "$rc" -ne 0 ] && echo refused)" "refused"
check "and it landed nothing" "$(count "$B")" "$NC"

say "IDEMPOTENCE, --check, and the arm check agreeing with the chain"
out=$(en "$G"); rc=$?
check "re-running changes nothing (rc=0)" "$rc" "0"
contains "$out" "ALREADY ARMED" "and it says so instead of writing a second chain"
C=$(mkclone c1 global)
out=$(en "$C" --check); rc=$?
check "--check refuses to write (rc=1), so a seat can ask before changing a clone" "$rc" "1"
check "--check left the LOCAL value unset, so the host's own value still answers" "$(gc "$C" config --local --get core.hooksPath)" ""
check "and it did not re-aim anything either" "$(gc "$C" config --get core.hooksPath)" "$GH"
[ -e "$C/.git/tabichat-hooks" ] && bad "--check wrote no chain directory" "the directory exists" || ok "--check wrote no chain directory"

say "--check ON A HOST WITH NO INCUMBENT SET — it names NOT ARMED and what the host consults, never ALREADY ARMED"
# The face a customer gets. This tool's own rule is that it must not require state from one site, and it is
# also not allowed to describe a set as armed when a consulted name is missing from it: one core.hooksPath
# value replaces EVERY name at once (iid 15), so "ALREADY ARMED" on a host that has no commit-msg anywhere
# is the same half-sentence in the other direction. --check answers, and writes nothing.
P2=$(mkclone p2 plain)
out=$(en "$P2" --check); rc=$?
check "--check on a plain host is NOT ARMED, rc=1 (nothing is armed here, and it no longer reports an arming)" "$rc" "1"
contains "$out" "NOT ARMED" "and it says which face it is on, in words"
contains "$out" "what this clone consults" "and it names the paths git would consult, asked out of git"
lacks "$out" "ALREADY ARMED" "and it never claims an arming this clone does not have"
[ -e "$P2/.git/tabichat-hooks" ] && bad "--check wrote nothing on a plain host" "the directory exists" || ok "and --check wrote nothing at all"
check "and the LOCAL value is still unset after --check" "$(gc "$P2" config --local --get core.hooksPath)" ""
A2=$(mkclone a2 plain); gc "$A2" config --local core.hooksPath .githooks
out=$(en "$A2" --check); rc=$?
check "--check on a clone aimed at .githooks is NOT ARMED as a set, rc=1 — pre-commit there, commit-msg not" "$rc" "1"
contains "$out" "NOT ARMED" "and the set is not called armed while one consulted name is absent"
contains "$out" "commit-msg absent" "and it names the missing name rather than the whole hook system"
lacks "$out" "ALREADY ARMED" "PAIRED — the blanket claim is gone from this face"
F2=$(mkclone f2 global)
out=$(en "$F2" --check); rc=$?
check "PAIRED — with an incumbent set in place, --check still refuses to write (rc=1)" "$rc" "1"
contains "$out" "CHECK" "and it keeps the incumbent's own words: what it would forward to"
out=$(en "$C"); rc=$?
check "and the same call without --check arms it (rc=0)" "$rc" "0"
out=$(arm "$C"); armc=$?
check "the shipped arm check calls a forwarded clone ARMED (rc=0)" "$armc" "0"
contains "$out" "ARMED" "in one line, as its own contract says"

say "THE REFUSALS — a guard that cannot be forwarded is not guessed at"
D=$(mkclone d1 plain); goodid "$D"; gc "$D" config --local core.hooksPath "$SCR/no-such-dir"
out=$(en "$D"); rc=$?
check "PAIRED NEGATIVE — a local value that resolves nowhere is a REFUSAL, not an overwrite (rc=1)" "$rc" "1"
check "and the unreadable value is left exactly as it was" "$(gc "$D" config --local --get core.hooksPath)" "$SCR/no-such-dir"
E=$(mkclone e1 plain); rm -f "$E/.githooks/pre-commit"
out=$(en "$E"); rc=$?
check "PAIRED NEGATIVE — a clone with no tracked guard to enable is a REFUSAL (rc=1)" "$rc" "1"
F=$(mkclone f1 global); rm -rf "$GH"
out=$(en "$F"); rc=$?
check "PAIRED NEGATIVE — an incumbent whose directory is gone is a REFUSAL, not a silent replace (rc=1)" "$rc" "1"
contains "$out" "REFUSED" "and it says which"
write_host_guard
out=$(en "$F"); rc=$?
check "and the same call succeeds once the directory is back (rc=0)" "$rc" "0"
EMPTY="$SCR/emptyhooks"; mkdir -p "$EMPTY"
H=$(mkclone h1 plain); printf '[core]\n\thooksPath = %s\n' "$EMPTY" > "$SCR/h1-global"
out=$(en "$H"); rc=$?
check "an incumbent set that holds NO executable hook arms the plain value instead (rc=0)" "$rc" "0"
contains "$out" "holds NO executable hook" "and it SAYS the host set was empty rather than chaining nothing"
contains "$out" "nothing host-side is in place to displace" "naming that no chain was needed"
check "so the local value is the plain documented one" "$(gc "$H" config --get core.hooksPath)" ".githooks"
[ -e "$H/.git/tabichat-hooks" ] && bad "and no empty chain directory was created" "it exists" || ok "and no empty chain directory was created"
out=$( cd "$SCR" && GIT_CONFIG_GLOBAL="$SCR/h1-global" GIT_CONFIG_SYSTEM="$SCR/h1-system" sh "$ENABLER" 2>&1 ); rc=$?
check "PAIRED NEGATIVE — outside a work tree it refuses rather than guessing (rc=1)" "$rc" "1"

say "THE GATE IS CONSUMED — a check no deploy runs is decoration (iid 16 req 3's rule)"
inarray=$(grep -c 'SHGATES+=(test_hook_chain.sh)' "$DEPLOY" || true)
check "this harness is named in the shell-gate array" "$inarray" "1"
pinned=$(grep -c 'SHGATES=(check_guard_armed.sh)' "$DEPLOY" || true)
check "and it joined by APPENDING, so the arm check's own pin still reads true" "$pinned" "1"
consumed=$(grep -c '"\${SHGATES\[@\]}"' "$DEPLOY" || true)
check "and that array has an executor in the deploy script" "$consumed" "1"
inbun=$(grep -Ec '^[[:space:]]*GATES=.*test_hook_chain' "$DEPLOY" || true)
check "it is NOT in the bun-run GATES array, which could not run a shell file" "$inbun" "0"

say "NO STRAY STATE — the harness leaves nothing behind in the real venue"
cd "$REPO"
stray=$(find .git -maxdepth 1 -name 'tabichat-hooks' 2>/dev/null | wc -l | tr -d ' ')
check "no chain directory in the real venue's git dir" "$stray" "0"
vt=$(gc "$REPO" status --porcelain | grep -c 'hooksPath\|tabichat-hooks' || true)
check "and nothing hooksPath-shaped in its status" "$vt" "0"

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells' "$failed" "$ran" || printf 'all %d hook-chain cells pass' "$ran")"
[ "$failed" -gt 0 ] && exit 1
exit 0
