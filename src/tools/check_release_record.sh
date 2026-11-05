#!/bin/sh
# The release-record invariant: the version this tree DECLARES must be the version its CHANGELOG
# most recently RECORDS. Both readings come from the same tree, so no cross-face comparison and no
# remembered sha is involved -- which is what makes the check able to fire at all (a tree that
# contradicts itself needs no second opinion). Run by the deploy loop's SHGATES stage.
# Paths resolve from this script's own location, not the caller's cwd: the deploy loop cds to src/
# before running tools/<name>, and a check that reads CHANGELOG.md relative to cwd would be reading
# whatever directory it happened to be invoked from.
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
decl=$(grep -m1 -oE '"version": *"[0-9][^"]*"' "$REPO/src/extensions/tabichat/package.json" 2>/dev/null | grep -oE '[0-9][^"]*')
sect=$(grep -m1 -oE '^## \[[0-9][^]]*\]' "$REPO/CHANGELOG.md" 2>/dev/null | grep -oE '[0-9][^]]*')
printf 'declared=%s changelog=%s\n' "$decl" "$sect"
if [ -z "$decl" ] || [ -z "$sect" ]; then
  echo "REFUSE: a release record needs BOTH readings; an empty one is not agreement." >&2
  exit 1
fi
if [ "$decl" != "$sect" ]; then
  echo "REFUSE: this tree declares a version that is not its newest CHANGELOG section." >&2
  exit 1
fi
echo "OK: declared version equals the newest release section."
