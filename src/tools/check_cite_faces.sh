#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# check_cite_faces.sh — does a face-cite say what it is a cite OF?  (tabichat iid 27)
#
#   sh src/tools/check_cite_faces.sh                       # every tracked Markdown page in this clone
#   sh src/tools/check_cite_faces.sh FILE [FILE ...]       # named files (repo-relative or absolute)
#   git show HEAD | sh src/tools/check_cite_faces.sh -     # a diff, or any text on stdin
#
# Prints one line per cite:  cite | resolves? | which refs contain it | if a tag, the peeled commit.
# Exit: 0 every cite opens here (or the tree cannot be judged at all) · 1 a cite resolves NOWHERE ·
# 2 usage, or not a repository.
#
# WHY IT INFORMS AND ONLY REFUSES ON ONE THING. A pointer that opens but names the wrong line is a
# writing problem, not a build failure: the tag `0.1.0` peels to a commit whose subject is "init" on the
# published faces while a local clone can carry that same name peeling to a cut-face merge, and a commit
# can sit on many `feature/*` refs and on no release line at all. Those print and the run still passes —
# reddening a build on them would let a gate rewrite the meaning of text already history. One case is not
# a judgment: a cite a reader cannot open at all. That exits 1.
#
# WHAT IT JUDGES. Any hex token of 7-40 characters bounded by non-hex text — a bare sha in prose, in a
# table cell, or inside a code span — plus dotted versions with or without a prefix (`0.1.1`,
# `pub-0.1.0`). A run of pure digits is left alone (a count, a date, a timestamp). A version that matches
# no tag here is reported and passes: the packet writes the next heading before the tag exists.
#
# WHAT IT CANNOT SEE FROM A CLONE, said so a zero is earned and not assumed. It reads the objects THIS
# repository holds, so a cite pushed after your last fetch reads as NOWHERE: re-fetch the published
# branches (the same `git fetch <remote> refs/heads/<branch>:refs/remotes/<remote>/<branch>` form the
# clone's own `git remote -v` names) and run this again before calling a cite fabricated. This file
# deliberately names no host: the venue-address scan in `test_broker.ts` reads tracked text, and a
# comment here would be the one thing that check exists to refuse. And it answers about names, never
# about the sentence — the rule is "name the ref you measured at"; whether the sentence is honest stays
# the reader's job.
set -eu

REPO=${CITE_REPO:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    printf 'cite-faces: %s is not a git repository, so there is no face to read cites against.\n' "$REPO" >&2
    exit 2
fi

# ---- the refs this clone can rank a cite against -----------------------------------------------
cut=''; cutpeel=''
t=$(git -C "$REPO" tag -l '[0-9]*' | sort -V | tail -n 1)
if [ -n "$t" ]; then cut=$t; cutpeel=$(git -C "$REPO" rev-parse --verify -q "$t^{commit}" || true); fi
# A control guarantees its own inputs, and this one has a face to read: a pointer is judged by the
# objects and refs THIS repository carries, so three states of repository cannot issue a verdict at all —
# no commits (an `git archive` tree staged with `git init`, which is how src/tools/test_gate_words.sh
# builds the clone it runs the deploy loop against), no tags AND no fetched faces (the same shape: a
# tree that has never met a remote), and a shallow clone, where everything before the boundary is simply
# absent. In any of those, `NOWHERE` would be a true sentence about the instrument and a false one about
# the text, and a check that prints a confident false fact is the thing iid 27 is filed against. So the
# tool reports, names the reason, and passes; it refuses only where it can actually judge.
gitdir=$(git -C "$REPO" rev-parse --absolute-git-dir)
judge=1; reason=''
git -C "$REPO" rev-parse --verify -q HEAD >/dev/null 2>&1 || { judge=0; reason='this tree carries no commits'; }
[ "$judge" = 1 ] || true
if [ "$judge" = 1 ]; then
    ntag=$(git -C "$REPO" tag -l | wc -l)
    nrem=$(git -C "$REPO" for-each-ref --format='x' refs/remotes | wc -l)
    [ "$ntag" -gt 0 ] || [ "$nrem" -gt 0 ] || { judge=0; reason='this tree has no tags and no fetched faces'; }
fi
if [ "$judge" = 1 ] && [ -f "$gitdir/shallow" ]; then
    judge=0; reason='this is a shallow clone; history before the boundary is not here'
fi
devref=$(git -C "$REPO" for-each-ref --format='%(refname:short)' 'refs/remotes/*/dev' | head -n 1)
mainref=$(git -C "$REPO" for-each-ref --format='%(refname:short)' 'refs/remotes/*/main' | head -n 1)

short() { printf %.7s "$1"; }

classify() { # <commit> -> where the claim sits, in the row's own two words
    if [ -n "$cutpeel" ] && git -C "$REPO" merge-base --is-ancestor "$1" "$cutpeel" 2>/dev/null; then
        printf 'shipped (ancestor of tag %s)' "$cut"; return 0
    fi
    if [ -n "$devref" ] && git -C "$REPO" merge-base --is-ancestor "$1" "$devref" 2>/dev/null; then
        printf 'on dev, unreleased'; return 0
    fi
    if [ -n "$mainref" ] && git -C "$REPO" merge-base --is-ancestor "$1" "$mainref" 2>/dev/null; then
        printf 'on the main face only'; return 0
    fi
    n=$(git -C "$REPO" for-each-ref --contains "$1" --format='%(refname:short)' 2>/dev/null | wc -l)
    if [ "$n" -gt 0 ]; then printf 'on no release line (%s ref(s) carry it)' "$n"
    else printf 'on no ref at all (unreferenced object)'; fi
}

reflist() { # <object> -> up to three named refs carrying it, always with the total count
    [ "$1" = 'unpeelable' ] && { printf '-'; return 0; }
    all=$(git -C "$REPO" for-each-ref --contains "$1" --format='%(if)%(symref)%(then)%(else)%(refname:short)%(end)' 2>/dev/null | sed '/^$/d' | sort)
    n=$(printf '%s\n' "$all" | sed '/^$/d' | wc -l)
    [ "$n" -gt 0 ] || { printf 'no ref'; return 0; }
    names=$(printf '%s\n' "$all" | sed '/^$/d' | head -n 3 | paste -sd, -)
    printf '%s (%s ref(s))' "$names" "$n"
}

# ---- the text to read ---------------------------------------------------------------------------
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
if [ $# -eq 0 ]; then
    set -- $(git -C "$REPO" ls-files '*.md')
    [ $# -gt 0 ] || { printf 'cite-faces: no tracked Markdown here; nothing to check.\n'; exit 0; }
fi
if [ "$1" = '-' ] && [ $# -eq 1 ]; then
    cat > "$tmp"
else
    for f in "$@"; do
        [ -f "$f" ] || f="$REPO/$f"
        [ -f "$f" ] && cat "$f" >> "$tmp" || printf 'cite-faces: %s is not a readable file.\n' "$f" >&2
    done
fi

# Pass 1: every hex token bounded by non-hex characters that also carries at least one letter a-f — a
# bare sha in prose, in a table cell, or inside a code span all read the same way. A run of pure digits is
# never judged as a pointer: that is a count, a date, or a millisecond timestamp, and the cost is a sha
# whose first seven characters happen to hold no letter at all, which is named here as the limit.
# Pass 2: dotted version names of three parts, with or without a prefix (`0.1.1`, `pub-0.1.0`,
# `0.1.2-rc1`), anywhere in the text. Two-part numbers (`BUSL-1.1`, `3.12`) are not release names here.
hex=$(tr 'A-F' 'a-f' < "$tmp" | tr -c '0-9a-f' '\n' | grep -Ex '[0-9a-f]{7,40}' | grep -E '[a-f]' || true)
ver=$(grep -Eo '(pub-)?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?' "$tmp" || true)
cites=$(printf '%s\n%s\n' "$hex" "$ver" | sed '/^$/d' | sort -u)
if [ -z "$cites" ]; then
    printf 'cite-faces: 0 cites in the text read — no pointer was asked to prove anything.\n'
    exit 0
fi

bad=0; n=0
printf '%-34s | %-8s | %-40s | %s\n' 'cite' 'resolves' 'which refs contain it' 'peel / verdict'
while read -r c; do
    [ -n "$c" ] || continue
    n=$((n + 1))
    if [ -n "$(git -C "$REPO" tag -l "$c")" ]; then
        obj=$(git -C "$REPO" rev-parse "$c")
        peel=$(git -C "$REPO" rev-parse --verify -q "$c^{commit}" || echo unpeelable)
        printf '%-34s | %-8s | %-40s | tag object %s peels to %s — %s\n' \
            "$c" 'TAG' "$(reflist "$peel")" "$(short "$obj")" "$(short "$peel")" "$(classify "$peel")"
        continue
    fi
    case $c in
        *[!0-9a-f]*) printf '%-34s | %-8s | %-40s | %s\n' "$c" 'no tag' '-' \
            'a version that names no tag in this clone — informs only'; continue ;;
    esac
    ty=$(git -C "$REPO" cat-file -t "$c" 2>/dev/null || true)
    if [ -z "$ty" ]; then
        if [ "$judge" = 1 ]; then
            printf '%-34s | %-8s | %-40s | %s\n' "$c" 'NOWHERE' '-' \
                'resolves in no object or ref tip here — refetch the faces, or the cite is fabricated'
            bad=$((bad + 1))
        else
            printf '%-34s | %-8s | %-40s | %s\n' "$c" 'unjudged' '-' \
                'no face to read against here — reporting, not a verdict'
        fi
        continue
    fi
    if [ "$ty" = 'tag' ]; then
        peel=$(git -C "$REPO" rev-parse --verify -q "$c^{commit}" || echo unpeelable)
        printf '%-34s | %-8s | %-40s | this is a TAG OBJECT, not a commit — the commit it names is %s (%s)\n' \
            "$c" 'TAGOBJ' "$(reflist "$peel")" "$(short "$peel")" "$(classify "$peel")"
        continue
    fi
    full=$(git -C "$REPO" rev-parse "$c")
    printf '%-34s | %-8s | %-40s | %s\n' "$c" "$ty" "$(reflist "$full")" "$(classify "$full")"
done <<EOF
$cites
EOF

if [ "$judge" = 0 ]; then
    printf 'cite-faces: %s cite(s) read, 0 refused: %s, so there is no face to judge a pointer against.\n' "$n" "$reason"
    printf '%s\n' 'cite-faces: that is the limit of the instrument, not a finding about the text: an'
    printf '%s\n' 'cite-faces: absent object is not a fabricated one in a tree like this. Run the check in'
    printf '%s\n' 'cite-faces: a clone that carries the release line — tags or fetched faces, full depth.'
    exit 0
fi
printf 'cite-faces: %s cite(s) read, %s resolve nowhere.\n' "$n" "$bad"
[ "$bad" -eq 0 ] || exit 1
exit 0
