#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# check_changelog_headings.sh — does the release record's NEW part carry the six headings, in order?
#
#   sh src/tools/check_changelog_headings.sh                  # this tree's CHANGELOG.md
#   sh src/tools/check_changelog_headings.sh FILE             # any release record (a fixture, a branch face)
#
# Exit: 0 every scoped section is in form · 1 a scoped section is out of form · 2 the file cannot be read.
#
# WHY THIS FILE EXISTS. The six-heading order is a ruling (R-2730, carried in CHANGELOG-FORMAT.md: New
# features · Breaking changes · Added · Changed · Fixed · Removed, drop a heading with nothing to say, never
# print an empty one, never invent an entry) and it was enforced by nothing in the tree. The shipped
# release-record check compares the declared version to the newest section and says nothing about the order
# inside it, so a section could be written in any sequence, pass every gate, and reach the public face that
# way. Measured before this file existed: a held branch's own `## [Unreleased]` block carried
# `Breaking changes`, `Changed`, `Added` — three of the six, inverted — and the deploy stage stayed green.
# A convention with no check behind it is a preference, and this one names what a reader sees.
#
# WHAT IS IN SCOPE, and why that is a boundary and not an exception list. R-2730 governs NEW entries: the
# carrier states it in its own words — "Existing entries are history — never re-cut them into this shape."
# What this file READS, stated as the code states it, is exactly two parts of the record:
#   * the `## [Unreleased]` section, where entries land before a cut; and
#   * the FIRST numbered `## [x.y.z]` section in file order — newest by position, and the one
#     check_release_record.sh compares against the declared version.
# Everything after that first numbered section is never read. Say plainly what that costs, and when: on a tree
# where no new section has been cut yet — which is this tree today — the first numbered section is already
# published (`[0.1.3]`), so a released section IS judged in that window. Position is the only marker that
# survives the stamp, so this file pays that cost rather than carrying a list of versions to skip; it is not
# the same act as re-cutting history, which is what the next paragraph refuses to do.
# Older numbered sections are left alone — deliberately, and the reader of this comment can see the reason in
# the tree itself: `0.1.2` and `0.1.1` both spell the first heading `New Features`, which is not one of the six
# as R-2730 names them. Refusing on those would be a gate demanding a rewrite of released notes, which the
# ruling forbids; skipping the newest section silently would be a gate that cannot see the section being cut.
# This file does neither: it names its scope here and prints which sections it read, so an older section never
# looks like a pass it earned.
#
# WHAT IT JUDGES, three things and no more.
#   1. Every `### ` heading in a scoped section is one of the six, spelled as the ruling spells them.
#   2. They appear in the ruling's order — increasing rank, and never the same rank twice.
#   3. No printed heading is empty: each one carries at least one entry line under it.
# It does NOT judge prose, entry counts, or whether a heading *should* have been there — the completeness
# audit that answers that is a cut-time reading job, named in the run sheet.
#
# NAMED LIMIT — an empty record PASSES, and that is a decision, not an oversight. A wholly empty
# `## [Unreleased]` is accepted, and so is a newest numbered section carrying no headings at all. Whether every
# change that landed has an entry somewhere is COMPLETENESS, and completeness is read at the cut by
# RELEASE-RUN-SHEET P4, not by a heading-sequence check. The review at leg 1174 §6 measured this hole. It is
# not closed with a refusal here because the cut commit's own shape makes a refusal the wrong instrument: the
# stamp moves `[Unreleased]` into `## [x.y.z] - <date>`, so between the stamp and the next entry landing the
# block is legitimately empty, and a deploy running inside that window would refuse a CORRECT tree — a false
# refusal in the customer path, the class this repo keeps spending legs to delete. One cell in
# src/tools/test_changelog_headings.sh is named LIMIT and pins that acceptance, so a seat that later wants a
# refusal has to change the cell's name and this paragraph in the same commit, in the open.

set -u

REPO=${HEADINGS_REPO:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
FILE=${1:-$REPO/CHANGELOG.md}

if [ ! -f "$FILE" ]; then
    printf 'headings: REFUSE — no release record to read at %s. A check that reads nothing has not passed.\n' "$FILE" >&2
    exit 2
fi

awk '
function flushsec() {
    if (!scoped) return
    nscoped++
    if (nh == 0) { printf "note  section=%s headings=0 — nothing to say, so no heading is printed (allowed)\n", secname; return }
    prev = 0; badhere = 0
    for (i = 1; i <= nh; i++) {
        r = rank[hname[i]]
        twice = (r > 0 && seen[r] > 0)
        if (r > 0) seen[r]++
        if (r == 0) {
            printf "REFUSE  section=%s heading=%s — not one of the six (New features, Breaking changes, Added, Changed, Fixed, Removed)\n", secname, hname[i]
            badhere = 1; continue
        }
        if (twice) {
            printf "REFUSE  section=%s heading=%s — printed twice in one section; the six are a sequence, not a pile\n", secname, hname[i]
            badhere = 1
        } else if (r < prev) {
            printf "REFUSE  section=%s heading=%s (rank %d) sits after a heading of rank %d — the six are out of order\n", secname, hname[i], r, prev
            badhere = 1
        } else prev = r
        if (hcnt[i] == 0) {
            printf "REFUSE  section=%s heading=%s — printed with no entry under it; drop the heading instead\n", secname, hname[i]
            badhere = 1
        }
        printf "note    section=%s heading=%s rank=%d entries=%d\n", secname, hname[i], r, hcnt[i]
    }
    if (badhere) fails++
}
BEGIN {
    rank["New features"] = 1; rank["Breaking changes"] = 2; rank["Added"] = 3
    rank["Changed"] = 4; rank["Fixed"] = 5; rank["Removed"] = 6
    scoped = 0; nh = 0; cur = 0; seennum = 0; nscoped = 0; fails = 0
}
/^## / {
    flushsec()
    scoped = 0; nh = 0; cur = 0
    for (k = 1; k <= 6; k++) seen[k] = 0
    if ($0 ~ /^## \[Unreleased\]/) { scoped = 1; secname = "[Unreleased]" }
    else if ($0 ~ /^## \[[0-9]/) {
        if (!seennum) {
            seennum = 1; scoped = 1; secname = $0
            sub(/^## /, "", secname); sub(/[[:space:]].*$/, "", secname)
        }
    }
    next
}
scoped && /^### / {
    name = $0; sub(/^###[[:space:]]*/, "", name); sub(/[[:space:]]+$/, "", name)
    nh++; hname[nh] = name; hcnt[nh] = 0; cur = nh
    next
}
scoped && /^[[:space:]]*[-*][[:space:]]/ { if (cur > 0) hcnt[cur]++ ; next }
END {
    flushsec()
    if (nscoped == 0) {
        printf "REFUSE  no section in scope — this file has no `## [Unreleased]` and no `## [x.y.z]` section, so it is not a release record this check can judge: %s\n", FILENAME
        exit 1
    }
    printf "note  read %d scoped section(s) of %s: [Unreleased] and the FIRST numbered section in file order; every later section is published history and R-2730 does not re-cut it\n", nscoped, FILENAME
    if (fails > 0) { printf "headings: REFUSE — %d scoped section(s) out of the six-heading form.\n", fails; exit 1 }
    printf "headings: OK — every scoped section carries the six headings in order, none empty, none outside the six.\n"
    exit 0
}
' "$FILE"
