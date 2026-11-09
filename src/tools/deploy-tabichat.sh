#!/usr/bin/env bash
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# Deploy the tabichat pi extension WITHOUT leaving a window where a starting lane
# loads half a change.
#
# Why this exists: `cp index.ts ... extensions/tabichat/` writes the file that
# IMPORTS its siblings before the siblings land. A lane that starts inside that
# window loads a new index.ts with no roommsg.ts beside it and dies at import.
# The window is milliseconds, which is exactly the kind of cause that is a
# nuisance to find and trivial to avoid.
#
# Rules this script enforces:
#   1. stage first, then move — nothing is read out of the repo while the live
#      directory is in a mixed state;
#   2. leaf modules land BEFORE the file that imports them (index.ts last), so
#      every intermediate state on disk is loadable;
#   3. refuse to touch the live directory unless every source file exists and
#      the tree passes its gates;
#   4. say what changed, afterwards, by diffing what is there now.
#
# Usage:
#   tools/deploy-tabichat.sh --dry-run     # show what would move, touch nothing
#   tools/deploy-tabichat.sh               # verify gates, stage, move, re-diff
#   tools/deploy-tabichat.sh --no-gates    # skip the test suites (NOT for the live dir)
#   tools/deploy-tabichat.sh --loadcheck DIR  # read-only: load-check DIR with the deploy's own probe.
#       Nothing is staged, nothing is published, no gate runs. This exists so a harness that builds a
#       tree of shipped bytes (src/tools/tls-two-seat.sh builds a seat dir) can ask the same question the
#       deploy asks instead of carrying a third copy of the answer.
#
# Env:
#   EXT      which extension to deploy: tabichat (default) or fs-gate
#   TARGET   live extension directory (default ~/.pi/agent/extensions/$EXT)
#   BASE     the src tree (default: this script's parent directory)
set -euo pipefail

# BASE is the src tree: this script lives in <BASE>/tools/
BASE="${BASE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUN="${BUN:-$HOME/.bun/bin/bun}"

# ORDER IS THE POINT: dependencies first, the importer last.
EXT="${EXT:-tabichat}"
case "$EXT" in
  tabichat)
    # broker.ts sits AFTER laneadmin.ts because that is the direction it imports, and the rule of
    # this list is "dependencies first, index.ts last". It was ADDED when index.ts began to import
    # ./broker.ts for the broker location, so a deploy that copied the old nine would have shipped an
    # extension whose first act is `Cannot find module "./broker.ts"` on every lane — a missing file
    # is the loud outcome, and the partial-tree check below is what catches it.
    # tlsopts.ts joins it for the same reason: index.ts IMPORTS it, and this array is the
    # reason the deploy is safe — a file that is not listed here never moves, so an omitted sibling
    # lands an index.ts importing a module that is not in the live directory, and every lane starting
    # after it dies at import. ORDER STILL MATTERS: leaf modules first, index.ts last.
    FILES=(mention.ts ctxwarn.ts errnote.ts exitlog.ts roommsg.ts mentionq.ts laneadmin.ts broker.ts tlsopts.ts diaglog.ts roomlog.ts steer.ts index.ts)
    # diaglog.ts joins FILES for the reason recorded above: index.ts IMPORTS it, and a file
    # not listed here never moves — so the deploy would ship an index.ts whose first act is
    # `Cannot find module "./diaglog.ts"` on every lane. test_diaglog_routing.ts ASSERTS both halves
    # of that (this gate is in GATES, and diaglog.ts is in FILES before index.ts), because a gate
    # nobody runs is decoration — audit `iid 13`.
    # roomlog.ts joins FILES for the same recorded reason: index.ts IMPORTS it (an earlier edit
    # added the module and missed this array — the miss is why tools/test_deploy_closure.ts now
    # derives the transitive closure instead of asserting one filename). Dependencies first:
    # roomlog.ts imports roommsg.ts only, so it sits right after diaglog.ts and before index.ts.
    LOADCHECK=(index.ts)
    GATES=(test_mention.ts test_ctxwarn.ts test_errnote.ts test_exitlog.ts test_roommsg.ts test_notice_prefix.ts test_mentionq.ts test_laneadmin.ts test_broker.ts test_steer.ts test_ctx_scope.ts test_ctx_handle.ts test_tlsopts.ts test_diaglog_routing.ts test_roomlog.ts test_deploy_closure.ts typecheck_ext.ts)
    # NOT deploy gates, on purpose: these need docker and an image, and a deploy gate that depends on
    # host tooling is a gate that fails for reasons unrelated to the code (the same lesson that put
    # `env -u MQTT_LEAD_NICK` below). They are PHYSICAL checks, and this array is now READ, not just
    # declared — see the `physical` action at the bottom. An array that nothing consumes is a list
    # that quietly stops meaning anything, and that is how a mandatory check becomes a rumour.
    #   bash src/tools/deploy-tabichat.sh --physical
    PHYSICAL=(test_broker_auth.ts test_fixture_isolation.py)
    # tabichat#13: two more cells join that stage. `test_ack_watch_broker.ts` is the only physical proof
    # that the ACL carries a granted control-child publish and drops a refused one, and
    # `test_tlsenv_paho.py` is the real-paho handshake against a real broker — the reading of the config
    # cannot show either, which is why they were never satisfied by the pure truth tables beside them.
    # Both start their own owner-scoped fixture, both tear it down, and both exit non-zero when the
    # fixture is not there, so a run that could not happen never reads as a pass. Still not GATES: a
    # deploy gate that depends on docker fails for reasons unrelated to the code.
    PHYSICAL+=(test_ack_watch_broker.ts test_tlsenv_paho.py)
    # leg 1123: the lead hold's real-socket proof. It runs the throwaway loopback fixture with a seat on
    # one nick and a peer on another, so the claim it measures (the hold reaches a peer, is journalled by
    # its author as the SAME line, and its own echo settles the watch the leg armed) is read off a broker
    # rather than off a stub. It is PHYSICAL and not GATES for the reason every member above is: it needs
    # docker, and a stage run must not depend on a broker no lane owns.
    PHYSICAL+=(test_hold_journal_broker.ts)
    # leg 1124: `test_retention.ts` joins the same stage for the same reason. Whether a RETAINED
    # publish carrying the v5 expiry property is actually dropped is a fact about a broker's memory, and
    # no truth table in this repository can produce it — the paired negative (a leaf with no property
    # survives the same wait) needs one broker holding both. It stands its own owner-scoped fixture and
    # tears it down on every path, so it is docker-dependent and stays out of GATES for the reason the
    # block above records.
    PHYSICAL+=(test_retention.ts)    ;;
  fs-gate)
    FILES=(fsrules.ts index.ts)
    LOADCHECK=(index.ts)
    GATES=(test_fsgate.ts)
    ;;
  *) printf 'unknown EXT: %s (expected tabichat or fs-gate)\n' "$EXT" >&2; exit 2 ;;
esac
# tabichat#13: three repo-level checks join the gate stage, appended here rather than folded into the
# two array literals above. Both arms get them — each one reads the repository (the provider-error
# instrument's truth table, the rule that no gate file may end its own run early, the lead model's
# register contract) and none of them touches an extension directory, so gating them per-EXT would
# describe a dependency that is not there. It is also the shape that keeps a count honest:
# `test_deploy_closure.ts` reads the tabichat arm's own `GATES=(…)` line and prints how many names it
# finds there, and folding new names into that literal moves the number it prints.
#   test_400_meta_capture.ts — the meta-only provider-failure instrument, mocked events, no live call
#   test_exit_class.ts       — the rule that a gate reports through its exit code, not process.exit
#   test_lead_model.ts       — the lead-model extension's register contract
GATES+=(test_400_meta_capture.ts test_exit_class.ts test_lead_model.ts)
# the realm gate joins the same stage, appended rather than folded into the literal above —
# test_deploy_closure.ts reads that line by exact text and prints how many names it finds there, and a
# registration that re-aims a pinned line is the mistake a prior leg booked once already. This one is the
# only gate in the repo that LOADS index.ts in-process (the three package externals are stubbed at load
# time, the store is not), because the question it answers — does a second factory pass in one process
# see the same realm holder — has never been measurable from a source-shape cell, and a prior leg read 0
# teardown rows against a seat that had retained a socket.
GATES+=(test_renewal_realm.ts)
# iid 29: the owed-turn notice joins the stage for the reason the census exists — a check in
# src/tools/ that no array names is run by nobody. This one LOADS index.ts and drives a real turn (arm,
# publish, agent_end) against a stub socket, so it is the only gate that measures the sentence the seat
# reads at end of turn rather than its text. It is GATES and not PHYSICAL: no broker, no fixture.
GATES+=(test_owed_notice.ts)
# iid 28: the sink guard joins the stage because the census is the whole point of this row —
# a check in src/tools/ that no array names is run by nobody, and the protection must be reachable by
# every stage run rather than by a cell author's memory. Appended in the same shape as the lines above
# so test_deploy_closure.ts keeps reading the `GATES=(…)` literal it pins by exact text.
GATES+=(test_sink_guard.ts)
# leg 1123: the room-publish journal gate joins the stage for the same census reason — a check in
# src/tools/ that no array names is run by nobody. Like test_owed_notice.ts it LOADS index.ts and drives
# the shipped `/renew`, `/say` and inbound handlers against a stub socket and a REAL scratch journal file,
# because the claim it measures (a room line that reaches the socket also reaches the author's own
# journal) is not observable from a source-shape cell. GATES, not PHYSICAL: no broker, no fixture.
GATES+=(test_hold_journal.ts)
TARGET="${TARGET:-$HOME/.pi/agent/extensions/$EXT}"
SRC="$BASE/extensions/$EXT"

dry=0; gates=1; want_physical=0
# --loadcheck is recognised HERE, before the loop below, for one reason: the loop refuses any word it
# does not know, and a directory name is exactly such a word. The handler runs further down, after
# load_check_tree exists (line numbers are not the point — the function must be defined first) and before
# the first write to TARGET, which is the `mkdir -p` below it. Gates are forced off: a load proof must not
# depend on the whole suite, and it must not move a byte. The positional list is cleared so the deploy's
# own argument loop sees nothing to refuse; --physical and --dry-run are therefore not combinable with it.
LOADCHECK_DIR=""
if [ "${1:-}" = "--loadcheck" ]; then
  [ -n "${2:-}" ] || { printf 'REFUSED: --loadcheck wants exactly one directory\n' >&2; exit 2; }
  LOADCHECK_DIR="$2"; gates=0; set --
fi
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --no-gates) gates=0 ;;
    --physical) want_physical=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

# THE PHYSICAL ARRAY HAS AN EXECUTOR NOW. These are the checks that need docker, so they are not
# deploy gates — but they are also the checks that prove a broker REFUSES, and a list nobody runs is a
# list that silently stops being a requirement. Run them explicitly:
#   bash src/tools/deploy-tabichat.sh --physical
# Each one is responsible for its own fixture and for leaving nothing behind; each one exits NON-ZERO
# when it could not run, so "NOT RUN" can never be read as a pass.
if [ "$want_physical" = 1 ]; then
  say "physical checks for EXT=$EXT: ${PHYSICAL[*]}"
  phy_fail=0; phy_failed=""
  for t in "${PHYSICAL[@]}"; do
    [ -f "$BASE/tools/$t" ] || { say "  MISSING  $t — declared but not in the tree"; phy_fail=1; phy_failed="$phy_failed $t(file absent)"; continue; }
    # The interpreter is chosen into an array and the call happens once, below, inside the `if`. The old
    # shape put the capture in each `case` arm, and that is what silenced the runner (see the note there).
    case "$t" in
      *.py) run=(python3 "$BASE/tools/$t") ;;
      *)    run=(env -u MQTT_LEAD_NICK bun "$BASE/tools/$t") ;;
    esac
    # THE CAPTURE SITS INSIDE `if`, exactly the shape this file already uses at the shell-gate loop and at
    # the load-check. `out=$(...failing member...) ; rc=$?` DOES NOT WORK under `set -e`: the assignment is
    # a simple command whose status is the member's non-zero status, so the script ends AT THE ASSIGNMENT
    # and neither the member's name nor its own words ever print. Measured on a cold box: the
    # header, 3 PASS, then silence at rc 1 — a red release gate that looked like a green one that had
    # simply stopped talking. The success case comes FIRST and the code is read in the `else`, never
    # `if ! out=$(...)`: `!` makes the tested status 0, so the `$?` in the body would print "exited 0" —
    # the false number in the one sentence written to carry it.
    if out=$( "${run[@]}" 2>&1 ); then
      say "  PASS     $t"
    else
      rc=$?
      say "  FAIL     $t (exit $rc)"
      printf '%s\n' "$out" | sed 's/^/           /' | tail -12
      phy_fail=1; phy_failed="$phy_failed $t(exit $rc)"
    fi
  done
  # Every member gets a line and the run reports the whole set, so the last refusal names which members
  # did not pass instead of leaving the reader to count PASS lines against the declared set above.
  [ "$phy_fail" = 0 ] || die "physical checks did not all pass — not green:${phy_failed}"
  say "all physical checks pass"
  exit 0
fi

[ -d "$SRC" ] || die "source directory not found: $SRC"
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || die "missing module: $SRC/$f (a partial tree never deploys)"
done

if [ "$dry" = 1 ]; then
  say "DRY RUN — nothing will be written."
  say "target : $TARGET"
  say "order  : ${FILES[*]}   (dependencies first, index.ts last)"
  mkdir -p "$TARGET" 2>/dev/null || true
  for f in "${FILES[@]}"; do
    if [ -f "$TARGET/$f" ] && cmp -s "$SRC/$f" "$TARGET/$f"; then
      say "  same : $f"
    else
      say "  would move : $f"
    fi
  done
  exit 0
fi

if [ "$gates" = 1 ]; then
  command -v "$BUN" >/dev/null 2>&1 || die "bun not found at $BUN — gates cannot be trusted"
  # DETERMINISM, measured on this host and FIXED at the source on :
  # test_steer.ts and test_ctxwarn.ts assert the DEFAULT lead nick ("lead-agent"), and both read the
  # module that honours MQTT_LEAD_NICK. An operator's shell may export MQTT_LEAD_NICK (a launcher
  # alias can set it per seat), so a deploy fired from a shell that inherited it failed
  # those two gates for a reason that had nothing to do with the code. Those two files now scrub the
  # variable themselves before importing the module-under-test, so the result no longer depends on
  # which terminal fired it. `env -u MQTT_LEAD_NICK` is kept here as a belt-and-braces guard for any
  # OTHER gate that ever grows the same dependency; it is no longer load-bearing for these two.
  for t in "${GATES[@]}"; do
    say "gate: $t (MQTT_LEAD_NICK withheld — the tests pin the shipped default)"
    (cd "$BASE" && env -u MQTT_LEAD_NICK "$BUN" "tools/$t" >/dev/null) \
      || die "$t is not green; fix it instead of deploying around it"
  done
  # The python room clients carry the SAME broker rule as the extension (that rule covers the whole
  # repo, and the python clients were three of the twelve files that shipped the
  # address). This script does not deploy them, but a deploy that ignores their half of one rule is
  # how a repo ends up holding two answers. Skipped LOUDLY if the box has no python3.
  #
  # WHY THIS IS AN ARRAY AND NOT ONE LINE: `tools/test_wrap_rows.py` sat in the
  # tree unable to even import — it named four symbols no client has — and the gate read "13 of 13
  # green" all day, because the thirteen were the `.ts` GATES above and a python harness was only ever
  # run if a seat happened to run it. A check nobody runs is not a requirement, so every python harness
  # this file can run without a broker or a fixture is listed here and dies the deploy.
  #
  # The one escape hatch, and it is LOUD rather than silent: `test_wrap_rows.py` imports the client,
  # and the client imports paho-mqtt, so on a box whose python3 has no paho the harness fails for a
  # reason that has nothing to do with the code under the gate (the same lesson that put
  # `env -u MQTT_LEAD_NICK` above, and why the docker suites are PHYSICAL and not GATES). It is
  # probed for and refused BY NAME, so a skip is a sentence in the deploy log, never an absence.
  PYGATES=(test_broker.py test_wrap_rows.py)
  # tabichat#13: the five python truth tables that need no broker, no fixture and no device join this
  # array by the rule written a few lines above — "every python harness this file can run without a
  # broker or a fixture is listed here and dies the deploy". Appended, not folded into the line above.
  # Each one is the mirror of something the shipped clients do: the transport decision (tlsenv), the
  # recipient-field addressing rule, the paste/fold rules, presence-record precedence, and the scrollback
  # client a human reads their missed messages with. All five were green standing alone before they were
  # named here, which is the only reason naming them is safe.
  PYGATES+=(test_tlsenv.py test_addressing.py test_paste.py test_presence.py test_tabichat_cli.py)
  # THE PAHO-DEPENDENT SET, declared (F4). The exemption below used to name ONE file, and
  # `test_tabichat_cli.py` joined PYGATES in this same release by the `+=` line above — so on a host whose
  # python3 has no paho the deploy died on the second name with an import traceback and no skip line, an
  # unrelated-looking refusal for a host shape that is normal. Measured at 4f97ada6 by running every member
  # both ways: without paho, `test_wrap_rows.py` rc 1 and `test_tabichat_cli.py` rc 1, the other five rc 0;
  # with paho, all seven rc 0. `test_tlsenv.py` IMPORTS paho and handles its absence, so it is not in this
  # set — membership here means "dies without it", not "mentions it", and tools/test_paho_skip.sh derives
  # that set by running each member and requires this list to equal it. The array is the point: an exemption
  # written against a name cannot be warned about when the array grows, and this one did not grow with it.
  PYGATES_NO_PAHO=(test_wrap_rows.py test_tabichat_cli.py)
  # THE SHELL GATES, and why they are not in GATES above: that array is executed through bun, and bun
  # 1.4.3 does not run a shell script — it parses the file as a module and stops at the first `case`
  # arm. Measured at this leg's gate run: `bun tools/check_guard_armed.sh` -> "Failed to run
  # ... Unexpected ')'" (rc 1), while `sh tools/check_guard_armed.sh` -> rc 0. Putting a shell check in
  # GATES would therefore red EVERY deploy with a parse error instead of gating anything — the same
  # reason PYGATES is its own array: a gate has to be run by an interpreter that can run it.
  SHGATES=(check_guard_armed.sh)
  # the enabler's truth table joins the same stage. Appended with +=, the shape a prior leg
  # established in this same spot, because test_secret_guard.sh pins the line above by exact text and
  # a gate wiring must not re-aim a check that is already running.
  SHGATES+=(test_hook_chain.sh)
  # the two attribution checks join the same stage. Appended with +=, the shape a prior leg
  # established at this exact spot for the same reason: test_secret_guard.sh pins the line above by its
  # full text, and folding new names into it re-aims a pin that is already doing its job.
  SHGATES+=(check_attributions.sh test_attribution_pins.sh)
  # the truth table for THIS loop, run in a scratch clone of the tree being deployed.
  SHGATES+=(test_gate_words.sh)
  # the subject-nickname guard joins the same stage, one appended registration and not two —
  # test_secret_guard.sh counts the array across BOTH shapes, so a second line naming this file would
  # register the same check twice while the deploy still looks green.
  SHGATES+=(check_subject_armed.sh)
  # the subject guard's BEHAVIOUR test joins the same stage. The armed check that asks whether the
  # guard EXISTS was already registered; nothing asked whether it still DOES what it claims, and a check that
  # cannot tell a working guard from one that quietly stopped existing is the class this array exists for.
  # Appended at the END rather than inserted: the loop dies at the first refusal, so a registration's
  # position decides which cells go red when something fails (a prior leg's own finding), and the literal line
  # above is pinned by exact text in test_secret_guard.sh.
  #
  # Why its sibling file is NOT on this line: test_secret_guard.sh was measured here too, and it cannot be
  # a member of the array it counts while test_gate_words.sh — also registered — runs the deploy against a
  # scratch clone whose array it rewrites on purpose. The census then asserts one number about a tree that
  # holds another, and two further cells read pinned objects out of published history that a git-init clone
  # cannot have. That registration was backed out — the census's own rule, not a preference — and the
  # durable shape is booked as the secret guard's own design work; the measurement of both faces is
  # recorded in the check's own header comment.
  SHGATES+=(test_subject_guard.sh)
  # the release-record check joins the same stage, appended at the END so every line above
  # keeps the exact text another check pins it by. It reads the declared version and the newest
  # CHANGELOG section out of the same tree and refuses when they disagree — the invariant README.md
  # states in prose (tabichat iid 24). A shell check lives here, not in GATES, for the reason already
  # written above this array: bun parses a .sh as a module and stops at the first `case` arm, so a
  # shell name in GATES reddens every deploy with a parse error while gating nothing.
  SHGATES+=(check_release_record.sh)
  # iid 13's coverage cell: the directory census and the one repaired truth table join the stage,
  # appended at the END so every line above keeps the exact text another check pins it by.
  #   test_gate_coverage.sh — enumerates src/tools/ for `test_*`/`check_*` files and refuses any name that
  #     sits in no gate array and on no ruled exclusion. Nothing does this today: the arrays were counted by
  #     test_secret_guard.sh, and a count over arrays cannot see the file no array names — which is how
  #     test_deploy_pi_nm.sh pinned a line a prior leg deleted and went rc 1 while the 37-line stage passed.
  #     It reads and refuses: it never edits an array and never runs this script, so unlike the two files
  #     below it, being a member of what it censuses asserts nothing about a tree it changed.
  #   test_deploy_pi_nm.sh — re-pointed at the current load-check mechanism by a prior leg, green at this base
  #     (rc 0, 76 cells), and measured under BOTH interpreters: `bash` rc 0 and `sh` rc 0, which is what this
  #     loop consults.
  # test_paho_skip.sh now joins this array too — see the earlier registration below, and the earlier note
  # preserved there: it was the last bash-only file, and the fix was to port the file, not the loop.
  # test_secret_guard.sh remains out of this array for the mechanism reason recorded above it, and the census
  # carries that as a named exclusion with the reason printed, so an exclusion cannot silently become a habit.
  SHGATES+=(test_gate_coverage.sh test_deploy_pi_nm.sh)
  # iid 13 finished: test_paho_skip.sh joins the same stage. It was the last bash-only file in the
  # directory — the shell loop consults `sh`, which is dash here, and its two `grep -vxF -f <(printf …)`
  # process substitutions stopped that file at parse time (rc 2, `Syntax error: "(" unexpected`) while bash ran
  # it green. a prior leg ported both to a temp-file set comparison, so the 34 cells now agree under `sh` and
  # `bash`, and the file can be registered without teaching this loop to sniff shebangs. It is not the
  # self-census case a prior leg excluded: its planted faces strip the arrays inside ITS OWN scratch clone (see
  # the guard below for why that still works), and its static cells read the shipped tree untouched.
  SHGATES+=(test_paho_skip.sh)
  # iid 27: the face-cite check joins the same stage, appended at the END for the reason every
  # line above keeps the same shape — another check pins these registrations by exact text. It reads
  # pointers out of Markdown (or a diff on stdin) and prints, per cite: does it resolve, which refs carry
  # it, and for a tag name what it peels to. It exits non-zero for one case only — a cite that resolves
  # nowhere — because a cite that opens on the wrong release line is a writing problem a gate must not
  # settle by force. POSIX sh, and the loop's interpreter is `sh` (dash here), so `sh -n` was run on it.
  SHGATES+=(check_cite_faces.sh)
  # leg 1132: the PKI minter's truth table joins the same stage, appended at the END for the same
  # reason every line above keeps this shape — test_secret_guard.sh pins these registrations by exact
  # text, and the census in test_gate_coverage.sh refuses any test_ file in this directory that no
  # array names. It is a shell file, so it belongs here and not in GATES: bun parses a shell script as
  # a module and stops at the first `case` arm. Cost, stated rather than discovered: six throwaway CA
  # mints (RSA-4096), about 15 seconds, and it needs `openssl` on the deploying box.
  SHGATES+=(test_mint_pki.sh)
  # The minter's truth table is the one registered shell gate that needs `openssl`: it mints throwaway
  # CAs, and its cells are about the minter, not about the box that deploys tabichat. Declared as a SET
  # for the same reason PYGATES_NO_PAHO above is a set and not a filename — an exemption written against
  # one name cannot be warned about when the array grows — and the deployer probes the capability itself
  # rather than reading a gate's output to decide whether to skip it. A gate that did not run is NAMED
  # in the run's own words; it is never counted as a pass.
  SHGATES_NO_OPENSSL=(test_mint_pki.sh)
  # leg 1165: the cite instrument's own truth table joins the stage, appended at the END in the shape every
  # line above keeps. `check_cite_faces.sh` has been a member since the iid-27 leg, and NOTHING ran it — the
  # only check that looked at that name was the one counting the array, which is how a word-tail read as a
  # commit cite (`succeeded` -> `cceeded`) could sit in the deploy loop unrehearsed. A check no array names is
  # run by nobody; a check that IS in the array but is never exercised is the same hole one step in. Shell
  # file, so here and not in GATES: bun parses a shell script as a module. Cost, stated: it builds one
  # throwaway `git init` face clone, no openssl, no docker, no network, under a tenth of a second.
  SHGATES+=(test_cite_faces.sh)
  # AN EMPTY SHELL-GATE ARRAY IS NOT AN EMPTY RUN (the class a prior leg closed for FILES and LOADCHECK).
  # Measured here: every `SHGATES`/`SHGATES+=` registration line emptied to `()` gave rc 0, 29 gate lines,
  # zero shell gates, and `deployed set complete and identical` — ten checks deleted, nothing said so. A census
  # cannot close this from inside the array, because emptying the array also removes the census.
  # The position is deliberate and it is the paired negative: this sits at the REGISTRATION site, so deleting
  # registrations refuses, while a run that empties the array later — test_paho_skip.sh inserts `SHGATES=()`
  # immediately before its own loop on purpose, to keep a nested deploy from re-running the whole stage — still
  # passes. Stripping ONE registration (what test_gate_words.sh does to close its own re-entrance) also passes:
  # ten members remain, and the guard asks only that the stage is not empty.
  [ "${#SHGATES[@]}" -gt 0 ] || die "SHGATES is empty — the shell-gate array registers nothing, so no shell check ran and a green deploy here would be silence wearing a completion line"
  # WHAT THE LOOP NOW SAYS, and why it said something false before. The old shape sent the
  # check's ordinary output to /dev/null and then printed one fixed sentence about the hook path — so a
  # gate whose file was sitting in the clone and whose own words said something else was described by a
  # cause the loop had never observed, and the words that named the real reason were thrown away. Two
  # faces are knowable from here, and they are now the two faces that get said:
  #   * the registered name has no file -> the check never ran, and that is the whole true statement;
  #   * the file ran and left non-zero -> its output is shown first, then its exit code, and the wrapper
  #     adds no reason of its own. A check is a pass at rc 0 and a refusal at anything else.
  # Requirement 4 is the one that matters most: the FIRST refusal still stops the deploy, with rc 1. That
  # is also what makes the capture awkward here, and both traps are recorded rather than rediscovered:
  #   * `out=$(...failing gate...) ; rc=$?` DOES NOT WORK under `set -e` — the assignment is a simple
  #     command whose status is the substituted command's non-zero status, so the script exits with the
  #     GATE's code and the refusal never prints (traced at this leg's scratch run: the deploy came back
  #     rc 3, rc 5 and rc 7, never rc 1). The capture therefore sits in an `if`, the same shape the
  #     destination load-check below uses for the same reason.
  #   * `if ! out=$(...)`, the obvious way to write that, is ALSO wrong: `!` makes the tested status 0, so
  #     the `$?` read in the body is 0 whatever the gate exited, and the refusal would print "it ran and
  #     exited 0" — a false number in the one sentence that exists to carry it (measured at this leg's
  #     first scratch run, all three planted codes). So the success case comes FIRST and the code is read
  #     in the `else`, where the tested command's real status is still what `$?` holds.
  for t in "${SHGATES[@]}"; do
    say "gate: sh tools/$t"
    # Absence is decided BEFORE the run, because `sh` on a missing file also exits non-zero (127 there):
    # running first would report "it ran and exited 127" about a check that never ran at all.
    if [ ! -f "$BASE/tools/$t" ]; then
      # file absent: say the file is absent and that the check therefore never ran
      die "$t is not green: the file src/tools/$t is not in this clone, so the check never ran."
    fi
    # The capability is probed here, once per gate, in the deployer's own words: a box without openssl
    # deploys tabichat fine and simply cannot exercise a minter harness. Declared set, not a filename.
    needssl=0
    for k in "${SHGATES_NO_OPENSSL[@]}"; do [ "$k" = "$t" ] && needssl=1; done
    if [ "$needssl" = 1 ] && ! command -v openssl >/dev/null 2>&1; then
      say "WARNING: openssl is absent on this box — tools/$t did NOT RUN"
      continue
    fi
    if out=$( (cd "$BASE" && env -u MQTT_LEAD_NICK sh "tools/$t" 2>&1) ); then
      continue
    else
      rc=$?
      # Two branches, never one `${out:-...}` after a bare print: the nothing-line must not appear next to
      # a check that DID print, and a `[ -n ... ] && print` list would end the iteration on a false test.
      if [ -n "$out" ]; then
        printf '%s\n' "$out" >&2
      else
        printf '%s\n' "(the check printed nothing)" >&2
      fi
      die "$t is not green: it ran and exited $rc. Its words are above; to see them again: sh src/tools/$t"
    fi
  done
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import paho.mqtt.client" >/dev/null 2>&1 || PY_HAVE_PAHO=0
    for t in "${PYGATES[@]}"; do
      # Membership in the declared set, not a filename: see PYGATES_NO_PAHO above. The skip stays LOUD and
      # names the gate it skipped, because a skipped gate must never read as a passed one (the contract
      # #396 was written for). Nothing here looks at the gate's output to decide whether to skip.
      nopaho=0
      for k in "${PYGATES_NO_PAHO[@]}"; do [ "$k" = "$t" ] && nopaho=1; done
      if [ "$nopaho" = 1 ] && [ "${PY_HAVE_PAHO:-1}" = 0 ]; then
        say "WARNING: python3 has no paho-mqtt — tools/$t did NOT RUN"
        continue
      fi
      # test_broker.py reads MQTT_URL/MQTT_HOST as inputs to the resolver rule, so those go out of
      # its environment too; the rest of the list does not care and is run the same way for one reason:
      # a gate must not pass because of which terminal fired it.
      say "gate: python3 tools/$t"
      # CAPTURE FIRST, THEN SURFACE ONLY WHAT A CAPABILITY DECIDED. The swallow had a reason and it is
      # still the rule: this one gate prints 60 `ok` lines on a green run and the array prints hundreds,
      # so a green python gate contributes nothing to the record but its `gate:` marker — measured before
      # choosing, not assumed. What must NOT be swallowed is a capability declaration: on a box with no
      # `openssl` the gate names every check it could not drive (14 `NOT APPLICABLE` lines plus its own
      # `did NOT RUN` summary), and dropping those leaves the customer's honest-absence story unread in
      # the very document a deploy leaves behind. Same capture shape as the shell loop above, and the
      # success branch comes FIRST because `if !` would hand the `else` a `$?` of 0 about a gate that
      # failed — a false number in the one sentence written to carry it.
      if pyout=$( (cd "$BASE" && env -u MQTT_LEAD_NICK -u MQTT_URL -u MQTT_HOST python3 "tools/$t" 2>&1) ); then
        pycaps=$(printf '%s\n' "$pyout" | grep -E 'NOT APPLICABLE|did NOT RUN' || true)
        if [ -n "$pycaps" ]; then
          while IFS= read -r pyline; do
            say "  $pyline"
          done <<< "$pycaps"
        fi
        continue
      else
        # The refusal keeps its words byte-identical to before this change — `REFUSED: <gate> is not green;
        # fix it instead of deploying around it` is pinned by gate-word cells, and a rewrite here is a
        # gate-word defect, not a tidy-up. The gate's own output is printed above the refusal so a red
        # python gate is diagnosable from the record alone, the way a red shell gate already was.
        if [ -n "$pyout" ]; then
          printf '%s\n' "$pyout" >&2
        else
          printf '%s\n' "(the check printed nothing)" >&2
        fi
        die "$t is not green; fix it instead of deploying around it"
      fi
    done
  else
    say "WARNING: python3 not found — NEITHER python gate ran (${PYGATES[*]})"
  fi
  say "gate: bun build (syntax + module graph)"
  (cd "$BASE" && "$BUN" build --target=bun --outdir "$(mktemp -d)" \
      "$SRC/index.ts" \
      --external @earendil-works/pi-ai --external @earendil-works/pi-coding-agent \
      --external mqtt >/dev/null) || die "index.ts does not build"
else
  # The sentence is chosen by which action asked for the skip. `--no-gates` on a deploy is a rehearsal and
  # says so; `--loadcheck` never meant to deploy at all, and telling it that its gates were skipped would
  # be a warning about something nobody asked for. The --no-gates text is unchanged, word for word.
  if [ -n "$LOADCHECK_DIR" ]; then
    say "note: no gate runs for --loadcheck; this action proves one tree loads, and nothing else"
  else
    say "WARNING: gates skipped — this is a repo rehearsal, not a deploy"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────────
# LOAD-CHECK A TREE — execute the shipped set, with the three package externals supplied.
#
# Two things this guard has to hold at once, and each one comes from an incident:
#   * it must RUN the entry module's own bytes together with the sibling modules that will sit beside
#     it, because a file omitted from FILES never moves, and a build over the SOURCE tree cannot see
#     that (#12, legs 576/579);
#   * it must not depend on which `@earendil-works/pi-ai` the host happens to resolve. The shape this
#     replaces pointed NODE_PATH at pi's install tree and imported the entry directly, and at 21b34e1
#     that refused the live, working deployment this box is running: `SyntaxError: Export named 'Type'
#     not found in module '…/pi-ai/dist/index.js'`, against bytes every lane loads right now. pi's own
#     loader supplies that value by a route this probe does not reproduce — no cause is claimed here,
#     which is exactly why the check stopped trying to guess it.
# So the three externals are supplied here, the way tools/test_renewal_realm.ts supplies them, and ONLY
# the entry's three specifier lines are rewritten. Every relative import still resolves for real against
# the copied set, and the copy carries EXACTLY the FILES array — not the directory — so a shipped name
# missing from the tree being checked is still a load failure. That is the thing this guard exists to
# catch; stubs that replaced the destination's own modules instead would be decoration, and are not what
# this does.
#
# What it cannot prove is said rather than implied, and there are three items on that list:
#   * it does not show pi's real pi-ai exports the same names as the stub — how pi's loader supplies that
#     value was never established here, so the check no longer tries to guess it (a prior leg's NODE_PATH
#     derivation was the guess, and it refused a healthy deployment);
#   * it does not CALL the factory. The set is imported, and a default export that is a function is what is
#     asserted. Running the extension's real startup against a fake `pi` is a separate decision, recorded
#     as open (a prior leg's L-2), not quietly folded into a load check.
#   * an UNUSED import is erased by the loader, so a dead specifier of an unshipped file is not something a
#     lane can die from — and it is still named by the hermeticity scan below, because the scan reads the
#     bytes and not the executed graph.
# Why a probe directory and not a rewritten file written next to the entry: $TARGET is the directory pi
# loads extensions from, and a stray rewritten copy living there would be offered to every lane that starts
# while the check runs. The probe is removed on every path, including the refusing one.
#
# HERMETIC, in the sense this uses it: after the copy, every package specifier in the probe that the shipped
# set actually reaches has been replaced by a relative path into this probe, and nothing else survives the
# scan. Before this was true, a bare specifier reached from a SIBLING file (not the entry) was left alone by
# the rewrite — the rewrite touched only the entries of LOADCHECK — and bun answered it from the host's
# `~/.bun/install/cache` (that cache holds `mqtt@5.16.1` on this box, measured). The check then reported
# `load ok` about a module graph that mixed the tree under test with a host package it never stubbed: a
# silent pass, and the prose here claimed the opposite. So the rewrite now covers EVERY copied member, and
# the scan is what makes "no host can answer for this tree" a property the code holds rather than a hope.
probe_bare_specifiers() { # prints "<file> <specifier>" for each quoted module specifier that is neither relative nor a node: builtin
  local dir="$1" f s
  for f in "$dir"/*.ts; do
    [ -f "$f" ] || continue
    # The character class excludes a space on purpose: the shipped set carries quoted PROSE of exactly this
    # shape inside template strings (`from "never arrived"`, three such tokens measured at 510e4ab), and no
    # package specifier can contain a space. Without that exclusion the scan would refuse a valid tree.
    grep -oE '(from|import)[[:space:]]*\(?[[:space:]]*["'"'"'][^"'"'"' ]+["'"'"']' "$f" 2>/dev/null \
      | sed -E 's/^(from|import)[[:space:]]*\(?[[:space:]]*["'"'"']//; s/["'"'"']$//' \
      | while IFS= read -r s; do
          case "$s" in
            ./*|../*|node:*) ;;
            *) printf '%s %s\n' "$(basename -- "$f")" "$s" ;;
          esac
        done
  done
}

load_check_tree() { # $1 = a directory holding the FILES set; $2 = which stage of the deploy this is, said back on refusal
  local dir="$1" what="$2" out m bare
  command -v "$BUN" >/dev/null 2>&1 || die "bun not found at $BUN — the shipped set cannot be load-checked"
  [ -d "$dir" ] || die "load-check tree $dir does not exist — $what: the check cannot run against nothing"
  # An empty array here is not an empty run: it is a check that never happened, and it prints as green.
  # Measured at 510e4ab with both LOADCHECK literals emptied: rc 0, 37 gate lines, 13 files moved, and ZERO
  # load lines — nothing in the repo requires that array to hold anything (`grep -rn LOADCHECK src/tools/*.ts`
  # answers only this script). Same duty for FILES: a deploy with no ship set would "succeed" at everything.
  [ "${#FILES[@]}" -gt 0 ] || die "FILES is empty ($what) — there is no shipped set, so nothing was load-checked"
  [ "${#LOADCHECK[@]}" -gt 0 ] || die "LOADCHECK is empty ($what) — the array that must be load-checked holds nothing, so the tree was never executed"
  loadcheck_probe="$(mktemp -d "${TMPDIR:-/tmp}/tabichat-loadcheck.XXXXXX")" \
    || die "could not make a probe directory — the load-check did not run"
  for m in "${FILES[@]}"; do
    if [ ! -f "$dir/$m" ]; then
      printf '%s\n' "  $dir has no $m" >&2
      rm -rf "$loadcheck_probe"; loadcheck_probe=""
      die "$m is not in the tree being checked ($what), so the shipped set is short and nothing was load-checked"
    fi
    if ! cp -p "$dir/$m" "$loadcheck_probe/$m"; then
      rm -rf "$loadcheck_probe"; loadcheck_probe=""
      die "could not copy $dir/$m into the probe — the load-check did not run"
    fi
  done
  # The three externals, stubbed at LOAD time only — the same shapes tools/test_renewal_realm.ts writes.
  # Kept here rather than borrowed from that harness because a deploy guard must not depend on a test file.
  cat > "$loadcheck_probe/pi-ai.ts" <<'STUB_AI'
const T = new Proxy(function () {}, { get: () => T, apply: () => ({ type: "object" }) });
export const Type = T;
STUB_AI
  cat > "$loadcheck_probe/pi-ca.ts" <<'STUB_CA'
export const defineTool = (t) => t;
export const isToolCallEventType = () => false;
STUB_CA
  cat > "$loadcheck_probe/mqtt.ts" <<'STUB_MQ'
const clients = [];
export const connectCalls = () => clients.length;
const factory = {
  connect(url, opts) {
    const c = {
      url, opts, calls: [],
      on(ev) { this.calls.push("on:" + String(ev)); },
      publish(t, p) { this.calls.push("publish"); },
      subscribe(t) { this.calls.push("subscribe"); },
      end(force) { this.calls.push("end:" + (force === true)); },
      removeAllListeners(ev) { this.calls.push("off:" + String(ev)); },
      connected: false,
    };
    clients.push(c);
    return c;
  },
};
export default factory;
STUB_MQ
  # The three known package specifiers, replaced in EVERY copied member, quote-paired by backreference and
  # global per line, and anchored on the `from`/`import` keyword so a data string that happens to read
  # "mqtt" is not rewritten. That closes the sibling hole a prior leg measured (the rewrite used to touch only
  # the LOADCHECK entries, so a bare specifier reached from a sibling stayed bare and bun answered it from
  # the host cache), and it also closes the mirror failure: `from '@earendil-works/pi-ai'` in single quotes
  # and two specifiers on one line were left untouched by the old exact-text sed, which refused a VALID
  # tree for a host reason — the same class on the opposite side. Today only `index.ts` carries any of
  # the three (each token counted once across the 13 names, zero in the other twelve), so widening this
  # changes no current behaviour; it makes the guarantee structural instead of incidental.
  for m in "${FILES[@]}"; do
    if ! sed -E -e 's#(from|import)([[:space:]]*)(\(?)["'"'"']@earendil-works/pi-ai["'"'"']#\1\2\3"./pi-ai.ts"#g' \
                 -e 's#(from|import)([[:space:]]*)(\(?)["'"'"']@earendil-works/pi-coding-agent["'"'"']#\1\2\3"./pi-ca.ts"#g' \
                 -e 's#(from|import)([[:space:]]*)(\(?)["'"'"']mqtt["'"'"']#\1\2\3"./mqtt.ts"#g' \
            "$loadcheck_probe/$m" > "$loadcheck_probe/$m.rewritten"; then
      rm -rf "$loadcheck_probe"; loadcheck_probe=""
      die "could not rewrite the package specifiers in $m ($what) — the load-check did not run"
    fi
    if ! mv -f "$loadcheck_probe/$m.rewritten" "$loadcheck_probe/$m"; then
      rm -rf "$loadcheck_probe"; loadcheck_probe=""
      die "could not install the rewritten $m into the probe ($what) — the load-check did not run"
    fi
  done
  # HERMETICITY, asserted BEFORE anything is imported. Anything the scan still finds is a package the probe
  # has no stub for, and the only thing that can answer it is this machine — which would make a green line a
  # statement about the host. The refusal names the file and the specifier so the next person knows what to
  # stub, and `moved=0` because this runs before the move loop.
  bare=$(probe_bare_specifiers "$loadcheck_probe" || true)
  if [ -n "$bare" ]; then
    printf '%s\n' "$bare" | sed 's/^/    no stub for: /' >&2
    rm -rf "$loadcheck_probe"; loadcheck_probe=""
    die "the load-check probe is not hermetic ($what): the shipped set reaches a package specifier the probe does not stub, so a pass here would be the host's answer, not the tree's. Files and specifiers are listed above — add the stub in load_check_tree, or import it relatively and carry it in FILES."
  fi
  say "  probe hermetic: ${#FILES[@]} member(s) copied and rewritten, no package specifier left outside ./ ../ node: ($what)"
  for m in "${LOADCHECK[@]}"; do
    # The capture sits inside `if` because a bare failing assignment under set -e ends the script before
    # the refusal can print — the trap the block this replaces recorded, and it still applies here.
    if out=$(TABICHAT_LOAD_TARGET="$loadcheck_probe/$m" "$BUN" -e 'const M = await import(process.env.TABICHAT_LOAD_TARGET); if (typeof M.default !== "function") { console.error("loads but exports no default function"); process.exit(1); }' 2>&1); then
      say "  load ok  : $m (the shipped set executes, default export present; tree checked: $dir)"
    else
      printf '%s\n' "$out" | sed 's/^/    /' >&2
      rm -rf "$loadcheck_probe"; loadcheck_probe=""
      die "$m does not LOAD from $dir ($what) — that tree is short or broken, and a lane starting against it dies at import"
    fi
  done
  rm -rf "$loadcheck_probe"; loadcheck_probe=""
}

# THE READ-ONLY ACTION, placed here because `load_check_tree` must exist to serve it and because nothing
# above this line has written anywhere: the first write to TARGET is the mkdir below.
if [ -n "$LOADCHECK_DIR" ]; then
  say "load-check only: $LOADCHECK_DIR — no gate ran, nothing was staged, nothing was published"
  load_check_tree "$LOADCHECK_DIR" "an external --loadcheck request"
  say "load ok: the shipped set loads from $LOADCHECK_DIR"
  exit 0
fi

# Stage INSIDE the target directory, so every mv below is a rename on one
# filesystem. /tmp is a separate filesystem on this host, and mv across
# filesystems copies and unlinks instead of renaming, which is the very partial
# window this script exists to remove. The name is dotted so it never reads as
# an extension directory while it is alive.
mkdir -p "$TARGET"
stage="$(mktemp -d "$TARGET/.staging.XXXXXX" 2>/dev/null || true)"
if [ -n "$stage" ]; then
  say "staged in $stage (same filesystem as the target: mv renames atomically)"
else
  stage="$(mktemp -d "${TMPDIR:-/tmp}/tabichat-stage.XXXXXX")"
  say "WARNING: cannot stage inside $TARGET, staging in $stage"
  say "WARNING: different filesystem, so mv copies rather than renames - not atomic"
fi
trap 'rm -rf "$stage" ${loadcheck_probe:+"$loadcheck_probe"}' EXIT
loadcheck_probe=""
for f in "${FILES[@]}"; do cp -p "$SRC/$f" "$stage/$f"; done

# VERIFY BEFORE PUBLISHING. The load-check used to run only after the `mv -f` loop below, so a
# refusal — which is the whole point of a check that can refuse — arrived after the shared load path had
# already been replaced: measured at 21b34e1, the run that died on `Export named 'Type' not found` had left
# 13 files in its destination. Same bytes, same assertion, one order change: the staged tree is checked
# first, so a refusal leaves $TARGET exactly as it was. The post-move check below stays, because #12 asks
# for what landed to be executed and not only compared; `cmp -s` proves the two trees are identical, so
# neither half is decoration.
load_check_tree "$stage" "the staged tree, checked before anything was published"

for f in "${FILES[@]}"; do
  if [ -f "$TARGET/$f" ] && cmp -s "$stage/$f" "$TARGET/$f"; then
    say "  same  : $f"
  else
    # mv within the same filesystem is an atomic rename: a reader sees the old
    # file or the new one, never a partial one
    if mv -f "$stage/$f" "$TARGET/$f"; then say "  moved : $f"; else die "could not move $f"; fi
  fi
done

say "verifying what is deployed now:"
rc=0
for f in "${FILES[@]}"; do
  if cmp -s "$SRC/$f" "$TARGET/$f"; then
    say "  identical: $f"
  else
    say "  DIFFERS  : $f"; rc=1
  fi
done
[ "$rc" = 0 ] || die "deploy is not complete — a lane must never start against this state"

# LOAD THE DESTINATION, NOT THE SOURCE (#12). `bun build` above compiles $SRC/index.ts,
# where every sibling exists on disk, so an omitted module in the directory a lane actually
# starts from passes the build, passes every gate, and ships — the exact incident this script's
# header records: "a new index.ts with no roommsg.ts beside it and dies at import". The
# byte-identity loop above cannot catch it either: it compares only the FILES list it just
# shipped, so an omitted sibling matches nothing and that loop still reads green. This imports
# what landed, from where it landed. Safe to run: the top level of both index.ts files is
# imports plus pure consts and the factory (verified at d751c72) — no connect, no fs write, no
# spawn — so the load needs no broker and leaves no state behind. LOADCHECK is consumed here, after every
# real deploy, and in the same leg it is consumed BEFORE the move on the staged tree; an array nothing reads
# is how a mandatory check becomes a rumour, and a check that only ever runs after the publication it gates
# can warn but never prevent.
# This runs whatever --no-gates said: "gates skipped" must never mean "destination skipped".
# (--dry-run exits earlier and --physical exits before this point, so neither can reach it.)
command -v "$BUN" >/dev/null 2>&1 || die "bun not found at $BUN — the deployed tree cannot be load-checked"
# The NODE_PATH derivation this line replaces is the earlier shape: pi resolves bare specifiers from its
# own install tree, so pointing the check at that tree refused a HEALTHY deployment (measured at 21b34e1,
# and the earlier "host shape" reading of it was wrong in the benign direction). load_check_tree supplies
# the three externals itself, so no resolution context is guessed. What that guarantee rests on is stated
# with it, because the sentence below was written too broadly and a prior leg falsified the broad reading: a bare
# specifier reached from a SIBLING file was not rewritten and bun answered it from this machine's
# `~/.bun/install/cache`, so a host WAS the reason a tree passed — the opposite direction, same root cause.
# The guard now rewrites every copied member and refuses unless the probe is hermetic (see load_check_tree),
# which is the form of the claim the code actually supports: no package outside ./ ../ node: can be reached,
# and a fourth one the probe does not stub stops the deploy by name instead of resolving somewhere else.
# Nothing here is skipped for want of a derivation: bun missing, the probe directory missing, an empty FILES
# or LOADCHECK array, a shipped name missing, a rewrite that fails, a specifier with no stub, or a load that
# fails each refuse in their own words.
load_check_tree "$TARGET" "the published destination"

say "deployed set complete and identical: ${FILES[*]}"
say "remember: lanes already running hold the PREVIOUS code in memory. It loads on"
say "their restart, and a restart is the operator's call."
