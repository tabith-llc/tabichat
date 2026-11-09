#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Truth table for src/tools/check_changelog_headings.sh — the six-heading release-record order.
#   sh src/tools/test_changelog_headings.sh        (exit 1 on any failure)
#
# WHY EVERY CASE RUNS THE REAL SCRIPT. A fixture the check has never seen is decoration, and a driver that
# re-implements the predicate tests the driver. Each cell writes a release record into this run's own scratch
# directory and hands it to the shipped file, so a green run means the shipped file refused or accepted, and
# nothing else.
#
# WHY THE FIXTURES ARE PLANTED AND NOT COMMITTED. The repo must hold no release section that fails on
# purpose: `check_release_record.sh` reads the shipped CHANGELOG.md, and a deliberately malformed section
# committed beside it would either redden every deploy or need an exception list to survive — the two shapes
# this file exists to refuse.
#
# THE PAIRED NEGATIVES, named so a reader can see the set is complete. Out-of-order pair, printed-but-empty
# heading, a heading outside the six, a heading repeated, a violation sitting in the NEWEST numbered section
# rather than in [Unreleased] (which is what makes the scope claim testable instead of asserted), the same
# violation in an OLDER published section (which must NOT refuse, because the ruling forbids re-cutting
# history), no section in scope at all, and a file that cannot be read. Each refusal cell also asserts the
# word `REFUSE` came back, so an empty output never reads as the pass.
#
# Runs under sh (dash here) because that is the interpreter the shell-gate loop consults.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CHK="$REPO/src/tools/check_changelog_headings.sh"
REAL="$REPO/CHANGELOG.md"

failed=0; ran=0
ok()    { ran=$((ran + 1)); printf 'ok    %s\n' "$1"; }
bad()   { ran=$((ran + 1)); failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }
say()   { printf '\n== %s ==\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1" "got '$2', want '$3'"; fi; }
contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3" "output lacks '$2'";; esac; }
lacks()    { case "$1" in *"$2"*) bad "$3" "output CONTAINS '$2'";; *) ok "$3";; esac; }

[ -f "$CHK" ] || { printf 'FAIL  no check at %s\n' "$CHK"; exit 1; }
sh -n "$CHK" 2>/dev/null && ok "the check parses under sh, which is what the gate loop runs" \
                         || bad "the check parses under sh" "syntax error"

SCR=$(mktemp -d "${TMPDIR:-/tmp}/chg-headings-XXXXXX") || { printf 'FAIL  no scratch dir — the controls cannot run, and a skipped control is not a pass\n' >&2; exit 1; }
trap 'rm -rf "$SCR"' EXIT INT TERM

# one record: [Unreleased] carries the six in the ruling's order, then the newest cut, then published history
printf '# Changelog\n\n## [Unreleased]\n\n### New features\n\n- One entry\n\n### Added\n\n- One entry\n\n## [9.9.9] - 2026-01-01\n\n### Changed\n\n- One entry\n\n### Fixed\n\n- One entry\n\n## [8.8.8] - 2025-12-12\n\n### Changed\n\n- One entry\n' > "$SCR/good.md"
# the same three headings that a held branch actually shipped, in the order they shipped: 2, 4, 3
printf '# Changelog\n\n## [Unreleased]\n\n### Breaking changes\n\n- One entry\n\n### Changed\n\n- One entry\n\n### Added\n\n- One entry\n\n## [9.9.9] - 2026-01-01\n\n### Fixed\n\n- One entry\n' > "$SCR/swapped.md"
# the same three, reordered the way the ruling names them
printf '# Changelog\n\n## [Unreleased]\n\n### Breaking changes\n\n- One entry\n\n### Added\n\n- One entry\n\n### Changed\n\n- One entry\n\n## [9.9.9] - 2026-01-01\n\n### Fixed\n\n- One entry\n' > "$SCR/reordered.md"
# a heading printed with nothing under it — the "never print an empty heading" half
printf '# Changelog\n\n## [Unreleased]\n\n### New features\n\n- One entry\n\n### Fixed\n\n## [9.9.9] - 2026-01-01\n\n### Changed\n\n- One entry\n' > "$SCR/empty.md"
# a heading outside the six
printf '# Changelog\n\n## [Unreleased]\n\n### New features\n\n- One entry\n\n### Improvements\n\n- One entry\n\n## [9.9.9] - 2026-01-01\n\n### Fixed\n\n- One entry\n' > "$SCR/outside.md"
# the same heading twice in one section
printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- One entry\n\n### Fixed\n\n- One entry\n\n### Added\n\n- Another entry\n\n## [9.9.9] - 2026-01-01\n\n### Changed\n\n- One entry\n' > "$SCR/dup.md"
# a violation in the NEWEST numbered section, with a clean [Unreleased] beside it — the scope claim, judged
printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- One entry\n\n## [9.9.9] - 2026-01-01\n\n### Fixed\n\n- One entry\n\n### Added\n\n- One entry\n' > "$SCR/newestbad.md"
# the identical inversion, one section later, where the ruling says it is history: [Unreleased] and [9.9.9]
# are both in form, [8.8.8] is inverted and out of scope
printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- One entry\n\n## [9.9.9] - 2026-01-01\n\n### Added\n\n- One entry\n\n## [8.8.8] - 2025-12-12\n\n### Fixed\n\n- One entry\n\n### Added\n\n- One entry\n' > "$SCR/olderbad.md"
# that file with the inverted section promoted to newest: same bytes, one heading moved up the page
printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- One entry\n\n## [8.8.8] - 2025-12-12\n\n### Fixed\n\n- One entry\n\n### Added\n\n- One entry\n\n## [9.9.9] - 2026-01-01\n\n### Added\n\n- One entry\n' > "$SCR/promoted.md"
# nothing in scope — a page that is not a release record
printf '# Some Page\n\n### Added\n\n- One entry\n\nSome prose.\n' > "$SCR/nosec.md"
# [Unreleased] with nothing to say at all — the ruling drops the headings, this file must agree
printf '# Changelog\n\n## [Unreleased]\n\n## [9.9.9] - 2026-01-01\n\n### Changed\n\n- One entry\n' > "$SCR/nounreleased.md"

run() { sh "$CHK" "$1" 2>&1; }

say "THE SHIPPED RECORD IS THE POSITIVE CASE — the tree this gate ships beside must read clean"
rc=0; out=$(run "$REAL") || rc=$?
check "  this tree's CHANGELOG.md passes the check" "$rc" "0"
contains "$out" "headings: OK" "and it says so in words"
contains "$out" "section=[Unreleased] heading=New features rank=1" "and prints the heading it read, so the pass is not silence"

say "PLANTED CASES THAT MUST PASS"
rc=0; out=$(run "$SCR/good.md") || rc=$?
check "  the six in the ruling's order pass" "$rc" "0"
rc=0; out=$(run "$SCR/reordered.md") || rc=$?
check "  the same three headings reordered to the ruling's sequence pass" "$rc" "0"
rc=0; out=$(run "$SCR/nounreleased.md") || rc=$?
check "  an [Unreleased] with no headings passes — dropping a heading with nothing to say is the ruling, not a gap" "$rc" "0"
contains "$out" "headings=0" "and it prints why, rather than reading as nothing happened"
rc=0; out=$(run "$SCR/olderbad.md") || rc=$?
check "  an inversion in an OLDER published section does not refuse — R-2730 does not re-cut history" "$rc" "0"
contains "$out" "read 2 scoped section(s)" "and the scope is printed: two sections read, three on the page"

say "PAIRED NEGATIVES — EACH MUST REFUSE, AND NAME WHAT IT REFUSED"
rc=0; out=$(run "$SCR/swapped.md") || rc=$?
check "  Added after Changed (the sequence a held branch carried) refuses" "$rc" "1"
contains "$out" "REFUSE" "and the refusal is in the output"
contains "$out" "out of order" "and it says which kind of finding it is"
contains "$out" "[Unreleased]" "and it names the section"
rc=0; out=$(run "$SCR/empty.md") || rc=$?
check "  a printed heading with no entry under it refuses" "$rc" "1"
contains "$out" "no entry under it" "and it names the emptiness, not just a count"
rc=0; out=$(run "$SCR/outside.md") || rc=$?
check "  a heading outside the six refuses" "$rc" "1"
contains "$out" "not one of the six" "and it prints the six so the fix needs no second reading"
rc=0; out=$(run "$SCR/dup.md") || rc=$?
check "  the same heading twice in one section refuses" "$rc" "1"
contains "$out" "printed twice" "and it says which shape it saw"
rc=0; out=$(run "$SCR/newestbad.md") || rc=$?
check "  an inversion in the NEWEST numbered section refuses, not only one in [Unreleased]" "$rc" "1"
contains "$out" "section=[9.9.9]" "and it names the section it read the inversion in"
rc=0; out=$(run "$SCR/promoted.md") || rc=$?
check "  the same bytes with the inverted section as newest DO refuse — the older-section pass above is the scope working, not a dead predicate" "$rc" "1"

say "INSTRUMENT FACE — a check that cannot read refuses instead of passing quietly"
rc=0; out=$(run "$SCR/nosec.md") || rc=$?
check "  a file with no section in scope refuses" "$rc" "1"
contains "$out" "not a release record" "and it says why"
rc=0; run "$SCR/does-not-exist.md" >/dev/null 2>&1 || rc=$?
check "  a missing file is rc 2, never rc 0" "$rc" "2"

say "ISOLATION — nothing was written into this repository by these fixtures"
dirty=$(cd "$REPO" && git status --porcelain | grep -c -E 'good\.md|swapped\.md|empty\.md|outside\.md|dup\.md|newestbad\.md|olderbad\.md|promoted\.md|nosec\.md|nounreleased\.md|reordered\.md' || true)
check "  no fixture file appears in the work tree" "$dirty" "0"
left=$(ls "$SCR" 2>/dev/null | grep -c . || true)
[ "$left" = "11" ] && ok "  the scratch holds exactly the 11 fixtures this run wrote (trap clears them at exit)" \
                   || bad "  scratch fixture count" "got '$left', want '11' — a fixture leaked or was never written"

printf '\n%s\n' "$([ "$failed" -gt 0 ] && printf '%d FAILED of %d cells — the six-heading order is not gated' "$failed" "$ran" || printf 'all %d cells pass — the six-heading order is gated both ways' "$ran")"
[ "$failed" -gt 0 ] && exit 1
exit 0
