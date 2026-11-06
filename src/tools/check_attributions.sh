#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# The attribution check the repo's own rule asks for: no line in a public-facing
# repo credits a decision to a person or to a seat, and no co-author trailer is ever carried.
# Exit 1 on a hit, so a deploy or a reviewer gets a refusal rather than an opinion.
#   sh src/tools/check_attributions.sh [base]      base defaults to the merge-base with the published line
#   ATTRIB_BASE=<ref> sh src/tools/check_attributions.sh
#   ATTRIB_HEAD=<ref> ...                          check a tip other than HEAD, with no checkout: what a
#                                                  reviewer needs to ask is "would this have caught that",
#                                                  and the answer must not require moving the work tree.
#
# THE BASE CONTRACT, in candidate order, and it is the whole site-agnostic question for this file. A
# customer clone of a RELEASE FACE has no `dev` branch in it: the published main line is its own root, so a
# gate that resolves only origin/dev / gitlab/dev / dev refuses that customer for the shape of their clone.
#   (a) an argument, or ATTRIB_BASE                - a reviewer's explicit base always wins;
#   (b) the merge-base with origin/dev, gitlab/dev, dev  - the crew and branch-face case, as before;
#   (c) the most recent tag reachable from HEAD^   - the previous release, printed with the reason it chose it;
#   (d) HEAD IS EXACTLY A RELEASE TAG and no base resolved - NOT APPLICABLE, rc 0: there is no lineage under
#       this snapshot to diff, and that is stated out loud rather than answered as a clean diff;
#   (e) none of the above                          - REFUSED, rc 1. An uncomputable diff is still not a
#       clean diff, and a face with neither a base nor a tag is not a release snapshot either.
#
# WHY THIS EXISTS. The rule was enforced by nobody: the thing that caught a violation of it was a grep
# written in a report, and a rule with no
# instrument is a wish — the same reason the subject guard exists. This is the instrument.
#
# SCOPE, and it is the load-bearing part. Only ADDED lines are read (`^+`, never `+++`), because the base
# face already carries a population of these references — at the face this was written against:
# index.ts 47, AGENTS.md 12, docs/use.md 11 — counted at that face, and deliberately NOT swept here. A
# gate that arrives red gets widened to green, and that is the forbidden move; a gate that arrives green
# because it judges only what this branch added is the one that survives contact with a convenient
# reviewer. Sweeping the old population is its own leg, on its own face.
#
# WHY IT MATCHES A SHAPE AND NOT A WORD. A bare case-insensitive grep for that possessive-person token
# over the tree hits 410 lines at this face, and nearly all of them are the product's own vocabulary — an
# env var, a payload field, a sentence about what the human's own posts may do. Banning the word would red
# half the shipped docs and teach the next reviewer to reach for the one escape that hides everything. What
# What the rule bans is ATTRIBUTION: a decision credited to a person or a seat. So that is what the patterns name.
#
# ONE MATCHER, NOT TWO. The file each hit came from is resolved by streaming the diff through awk into
# `path<TAB>added line` pairs, and those pairs are then matched by grep alone. The first draft matched once
# with grep and again inside awk, and on this host awk is mawk, which has no word-boundary escape — so a
# nickname hit was counted and then LOST from the listing: it refused without naming the file it refused,
# which is a refusal nobody can act on. One matcher cannot disagree with itself.
#
# IT CANNOT CHECK ITSELF INTO A PASS, and cannot be a violation by describing itself. Two rules: it
# REFUSES when no base can be resolved (a diff it cannot compute is not a clean diff), and it always prints
# how many added lines it scanned, so a scan of nothing reads as the vacuous case it is. Its own text
# therefore never spells a banned phrase it is quoting — the patterns below are the only place the shapes
# exist, and each is written so it cannot match its own source line.
#
# THE ROSTER IS CLOSED, and that limit is named here rather than left to be discovered: a person or seat
# whose name is not on the NAMES line is invisible to every form below, whatever verb or preposition it is
# credited with. a prior leg measured the blind faces this file used to have and a prior leg closed them; what
# remains is this sentence, not a surprise.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$REPO" || { printf 'attributions: REFUSED — cannot enter the repo.\n' >&2; exit 1; }

base=${1:-${ATTRIB_BASE:-}}
base_why="an argument or ATTRIB_BASE (a reviewer's explicit base)"
if [ -z "$base" ]; then
    # The point where this branch left the published line, not the tip of it: a plain `origin/dev..HEAD`
    # diff would re-scan another lane's merged work and call it this branch's.
    for cand in origin/dev gitlab/dev dev; do
        git rev-parse --verify -q "$cand" >/dev/null 2>&1 || continue
        mb=$(git merge-base HEAD "$cand" 2>/dev/null || true)
        [ -n "$mb" ] && { base=$mb; base_why="the merge-base with $cand (the published line)"; break; }
    done
fi
if [ -z "$base" ]; then
    # (c) a release face carries tags and no dev lineage: the previous release is a real base, and it is
    # named here rather than left for the reader to infer from a sha.
    prev=$(git describe --tags --abbrev=0 'HEAD^' 2>/dev/null || true)
    if [ -n "$prev" ] && git rev-parse --verify -q "${prev}^{commit}" >/dev/null 2>&1; then
        base=$(git rev-parse "$prev")
        base_why="the previous release tag $prev (this clone carries no origin/dev, gitlab/dev or dev merge-base)"
    fi
fi
if [ -z "$base" ]; then
    # (d) HEAD sits exactly on a release tag and nothing above resolved: a snapshot face, not a branch.
    snap=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
    if [ -n "$snap" ]; then
        printf 'attributions: NOT APPLICABLE — release snapshot face: HEAD is tagged %s and no base lineage exists on this face (no origin/dev, gitlab/dev or dev merge-base, no argument or ATTRIB_BASE, and no tag below HEAD^ to compare against). Nothing was scanned, and this check does not claim a clean diff it did not compute.\n' "$snap"
        exit 0
    fi
fi
[ -n "$base" ] || { printf 'attributions: REFUSED — no base to diff against: none of origin/dev, gitlab/dev, dev resolved a merge-base with HEAD, no tag resolved below HEAD^, HEAD is not a release tag, and neither an argument nor ATTRIB_BASE was given. An uncomputable diff is not a clean diff.\n' >&2; exit 1; }
git rev-parse --verify -q "${base}^{commit}" >/dev/null \
    || { printf 'attributions: REFUSED — base "%s" is not a commit in this clone.\n' "$base" >&2; exit 1; }
printf 'attributions: base = %s — %s\n' "$(printf '%s' "$base" | cut -c1-10)" "$base_why"

# The owner-credit class, phrase by phrase. Each alternative is written so the line it sits on cannot
# match itself: a bracketed final character is the same regex and a different string.
PATTERN='[Oo]wner (direc[t]ive|direc[t]ed|rule[d]|order[s]|ordere[d]|wor[d]|aske[d]|decide[d]|decisio[n]|cal[l]|approva[l]|approve[d]|not[e]|pi[n]|caution|conditio[n]|requirement|instructio[n])|per the [Oo]wne[r]|as per the own[e]r|the own[e]r.s (wor[d]|cal[l]|approva[l]|orde[r]|decisio[n]|rulin[g]|instructio[n]|conditio[n]|caution|requirement|wish|word|call)|own[e]r.s (direc[t]ive|ruling|verdict)|as (instructe[d]|rule[d]|ordere[d]|directe[d]) by the own[e]r|writt[e]n by the own[e]r|requeste[d] by the own[e]r|the own[e]r (rule[d]|decide[d]|ordere[d]|aske[d]|directe[d]|approve[d])|requeste[d] by the leade[r]|pe[r] the leade[r]|Co-authored-b[y]:|owner-nic[k]|seat nic[k]s? (rule[d]|rule[s]|decide[d]|decide[s]|order[s]|ordere[d]|direc[t]|directe[d]|approv[e]|approve[d]|as[k]|aske[d]|sai[d]|verdic[t]|decisio[n]|wor[d]|cal[l])'
# Why the possessive branch lists nouns instead of matching anything after `owner's`: the product's own
# vocabulary legitimately uses the word — an env var, a payload field, a sentence about what the human's
# posts may do — and a gate that reds shipped documentation on its first day is a gate that gets turned
# off by the end of the week. The noun list is the compromise, and its limit is stated plainly below.
# Both halves are written so neither line, nor the joined value, is an instance of what it matches: every
# word that could complete a credit phrase keeps its final letter in a bracket, which is the same regex and
# a different string. `NAMES` carries no credit preposition and `CRED` carries no person word, so the pair
# exists only at run time — which is the same discipline the harness below uses for its planted fixtures.
#
# THE SEAT-NICK BRANCH SCOPES TO A CREDIT NOW (F2). It used to end `PATTERN` above as a bare phrase, so it
# refused any added line that merely CONTAINED the two-word term — and it caught honest test data doing it:
# an assertion naming the variable concept under test, crediting nobody. That is the shape :31 warns about,
# read the other way: a branch that bans a phrase rather than a credit reds the line that describes the thing
# being tested, and the next lane teaches itself to reword the fixture instead of scoping the matcher. So the
# branch now requires a decision word after the term, the same construction the owner-credit branches above
# already use, and the roster rule is unchanged: a seat word alone is not a credit and is not refused.
# Removing the branch outright was the other option and was not taken: a credit phrased as "the seat nic[k]
# decided X" names no roster member, and this branch is the only place that shape is caught. The term is
# bracketed here for the reason :41-44 gives: a comment that spelled the phrase would be refused by its own
# file the day the wrap moved, and a gate that reds its own documentation teaches people to delete the gate.
CRED='pe[r]|a[s] requested b[y]|a[s] ruled b[y]|a[s] directed b[y]|a[s] instructed b[y]|a[s] ordered b[y]|a[s] decided b[y]|a[s] approved b[y]|a[t] the request of|requeste[d] by|aske[d] by|rule[d] by|direc[t]ed by|instructe[d] by|ordere[d] by|approve[d] by|deci[d]ed by|according t[o]'
# THE ROSTER. Two of its entries were blind when a prior leg arrived, and both are named here because a reader
# of a diff is the audience for that sentence:
#   * `writter` — not an English word, so it could never fire, and it matched nothing while looking intact.
#     It becomes `write[r]`: the entry's neighbours are all whoever-decided-something words, and a credit
#     naming whoever wrote the line is the same class as a credit naming whoever ruled it.
#   * `dust[y]` — this matched only the longer spelling, so the person this rule is about was the one name on the
#     fleet this gate could not see. It becomes `dust[y]?`, which covers both spellings and nothing else.
NAMES='write[r]|owne[r]|wr[e]n|ultr[a]|flas[h][1-7]|stewar[d]|cler[k]|libraria[n]|courie[r]|dust[y]?|hea[d] agent|leade[r]'
NICKS="($CRED) +(the )?($NAMES)"
# TWO MORE SHAPES, added because a credit does not have to arrive in the preposition's form to be a credit.
#   NAMED    — the roster name is the SUBJECT of a decision verb, so `($NAMES)` then the verb, no preposition
#              anywhere in the line (planted one and got a CLEAN back).
#   POSSESS  — the decision arrives as a noun owned by a name: `($NAMES)` then `.s` then a decision noun, the
#              `.` standing for the apostrophe in the same idiom `own[e]r.s` uses above, so neither line can
#              match itself.
# Both are shapes, not name checks: a roster word on its own, or inside an env-var name or a payload field,
# stays legal, and the shipped vocabulary that made the closed noun list necessary is pinned CLEAN by cells.
DECIDE='rule[d]|rul[e]s|decid[e]d|decide[s]|ordere[d]|orde[r]s|directe[d]|instructe[d]|approv[e]d|approv[e]s|aske[d]|cautioned|decline[d]|vetoed|insiste[d]'
NAMED="($NAMES) +($DECIDE)"
CREDIT_NOUN='wor[d]|cal[l]|approva[l]|orde[r]|decisio[n]|rulin[g]|instructio[n]|conditio[n]|requirement|caution|wish|verdic[t]|pi[n]|not[e]|ve[to]'
POSSESS="($NAMES).s ($CREDIT_NOUN)"

head_ref=${ATTRIB_HEAD:-HEAD}
git rev-parse --verify -q "${head_ref}^{commit}" >/dev/null \
    || { printf 'attributions: REFUSED — ATTRIB_HEAD="%s" is not a commit in this clone.\n' "$head_ref" >&2; exit 1; }
diff=$(git diff --no-color "$base".."$head_ref" 2>/dev/null) || { printf 'attributions: REFUSED — git diff %s..%s failed.\n' "$base" "$head_ref" >&2; exit 1; }

# path<TAB>added-line, one pass, in diff order. `+++ b/<path>` is the only thing that carries a name.
pairs=$(printf '%s\n' "$diff" | awk '
    /^\+\+\+/ { f = substr($0, 7); sub(/^b\/[^ 	]*[ 	]/, "", f); sub(/^b\//, "", f); next }
    /^\+/     { if ($0 !~ /^\+\+\+/) printf "%s\t%s\n", (f == "" ? "(unknown)" : f), substr($0, 2) }
')
scanned=$(printf '%s' "$pairs" | grep -c . || true)

# All four lists are joined into the ONE matcher, and a list that is declared but not joined here is a dead
# branch wearing a comment — which is the exact defect a prior leg came to close, so the harness asserts it.
hits=$(printf '%s\n' "$pairs" | grep -inE "$PATTERN|$NICKS|$NAMED|$POSSESS" || true)
n=$(printf '%s' "$hits" | grep -c . || true)

if [ "$n" -gt 0 ]; then
    printf 'attributions: REFUSED — %s added line(s) since %s credit a decision to a person or to a seat.\n' "$n" "$(printf '%s' "$base" | cut -c1-10)" >&2
    # grep's own `NN:` line-number prefix is dropped; what a reader needs is path, then the line as typed.
    printf '%s\n' "$hits" | sed 's/^[0-9]*://' | awk -F '\t' '{ printf "attributions:   %s\n                       %s\n", $1, $2 }' >&2
    printf 'attributions:   scanned %s added line(s); the base face'"'"'s pre-existing population is not in that count and is not this branch'"'"'s to fix.\n' "$scanned" >&2
    printf 'attributions:   the rule is the attribution ban: state what the code does, name the file, carry the ticket ref. Mechanism and urgency live in the ticket body and the ledger.\n' >&2
    printf 'attributions:   nothing was widened and no exclusion was added to make this pass. If a hit is genuinely not a credit to a person, that is a named pattern change with its reason written down — not a quiet exception.\n' >&2
    exit 1
fi

printf 'attributions: CLEAN — 0 new person-or-seat credits in %s added line(s) since %s\n' "$scanned" "$(printf '%s' "$base" | cut -c1-10)"
exit 0
