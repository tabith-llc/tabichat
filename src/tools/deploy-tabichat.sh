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
    # this list is "dependencies first, index.ts last". It was ADDED at s138d: index.ts now imports
    # ./broker.ts for the broker location, so a deploy that copied the old nine would have shipped an
    # extension whose first act is `Cannot find module "./broker.ts"` on every lane — a missing file
    # is the loud outcome, and the partial-tree check below is what catches it.
    # tlsopts.ts joins it at s140 for the same reason: index.ts IMPORTS it, and this array is the
    # reason the deploy is safe — a file that is not listed here never moves, so an omitted sibling
    # lands an index.ts importing a module that is not in the live directory, and every lane starting
    # after it dies at import. ORDER STILL MATTERS: leaf modules first, index.ts last.
    FILES=(mention.ts ctxwarn.ts errnote.ts exitlog.ts roommsg.ts mentionq.ts laneadmin.ts broker.ts tlsopts.ts diaglog.ts roomlog.ts steer.ts index.ts)
    # diaglog.ts joins FILES at leg 517 for the reason recorded above: index.ts IMPORTS it, and a file
    # not listed here never moves — so the deploy would ship an index.ts whose first act is
    # `Cannot find module "./diaglog.ts"` on every lane. test_diaglog_routing.ts ASSERTS both halves
    # of that (this gate is in GATES, and diaglog.ts is in FILES before index.ts), because a gate
    # nobody runs is decoration — audit `iid 13`.
    # roomlog.ts joins FILES at leg 802 for the same recorded reason: index.ts IMPORTS it (leg 800
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
    ;;
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
# leg 889: the realm gate joins the same stage, appended rather than folded into the literal above —
# test_deploy_closure.ts reads that line by exact text and prints how many names it finds there, and a
# registration that re-aims a pinned line is the mistake leg 825 booked once already. This one is the
# only gate in the repo that LOADS index.ts in-process (the three package externals are stubbed at load
# time, the store is not), because the question it answers — does a second factory pass in one process
# see the same realm holder — has never been measurable from a source-shape cell, and leg 888 read 0
# teardown rows against a seat that had retained a socket.
GATES+=(test_renewal_realm.ts)
TARGET="${TARGET:-$HOME/.pi/agent/extensions/$EXT}"
SRC="$BASE/extensions/$EXT"

dry=0; gates=1; want_physical=0
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
  phy_fail=0
  for t in "${PHYSICAL[@]}"; do
    [ -f "$BASE/tools/$t" ] || { say "  MISSING  $t — declared but not in the tree"; phy_fail=1; continue; }
    case "$t" in
      *.py) out=$(python3 "$BASE/tools/$t" 2>&1) ; rc=$? ;;
      *)    out=$(env -u MQTT_LEAD_NICK bun "$BASE/tools/$t" 2>&1) ; rc=$? ;;
    esac
    if [ "$rc" -eq 0 ]; then
      say "  PASS     $t"
    else
      say "  FAIL     $t (exit $rc)"
      printf '%s\n' "$out" | sed 's/^/           /' | tail -12
      phy_fail=1
    fi
  done
  [ "$phy_fail" = 0 ] || die "physical checks did not all pass"
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
  # DETERMINISM, measured on this host 2026-10-09 and FIXED at the source on 2026-10-25 (leg 540):
  # test_steer.ts and test_ctxwarn.ts assert the DEFAULT lead nick ("lead-agent"), and both read the
  # module that honours MQTT_LEAD_NICK. An operator's shell may export MQTT_LEAD_NICK (on this box, ~/.bashrc:252, and
  # the owner's aliases set it per seat), so a deploy fired from a shell that inherited it failed
  # those two gates for a reason that had nothing to do with the code. Those two files now scrub the
  # variable themselves before importing the module-under-test, so the result no longer depends on
  # which terminal fired it. `env -u MQTT_LEAD_NICK` is kept here as a belt-and-braces guard for any
  # OTHER gate that ever grows the same dependency; it is no longer load-bearing for these two.
  for t in "${GATES[@]}"; do
    say "gate: $t (MQTT_LEAD_NICK withheld — the tests pin the shipped default)"
    (cd "$BASE" && env -u MQTT_LEAD_NICK "$BUN" "tools/$t" >/dev/null) \
      || die "$t is not green; fix it instead of deploying around it"
  done
  # The python room clients carry the SAME broker rule as the extension (the owner's ruling s138d
  # covers the whole repo, and the python clients were three of the twelve files that shipped the
  # address). This script does not deploy them, but a deploy that ignores their half of one rule is
  # how a repo ends up holding two answers. Skipped LOUDLY if the box has no python3.
  #
  # WHY THIS IS AN ARRAY AND NOT ONE LINE (leg 506, 2026-10-24): `tools/test_wrap_rows.py` sat in the
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
  # THE SHELL GATES, and why they are not in GATES above: that array is executed through bun, and bun
  # 1.4.3 does not run a shell script — it parses the file as a module and stops at the first `case`
  # arm. Measured at this leg's gate run: `bun tools/check_guard_armed.sh` -> "Failed to run
  # ... Unexpected ')'" (rc 1), while `sh tools/check_guard_armed.sh` -> rc 0. Putting a shell check in
  # GATES would therefore red EVERY deploy with a parse error instead of gating anything — the same
  # reason PYGATES is its own array: a gate has to be run by an interpreter that can run it.
  SHGATES=(check_guard_armed.sh)
  # leg 842: the enabler's truth table joins the same stage. Appended with +=, the shape leg 825
  # established in this same spot, because test_secret_guard.sh pins the line above by exact text and
  # a gate wiring must not re-aim a check that is already running.
  SHGATES+=(test_hook_chain.sh)
  # leg 845: the two attribution checks join the same stage. Appended with +=, the shape leg 825
  # established at this exact spot for the same reason: test_secret_guard.sh pins the line above by its
  # full text, and folding new names into it re-aims a pin that is already doing its job.
  SHGATES+=(check_attributions.sh test_attribution_pins.sh)
  # leg 851: the truth table for THIS loop, run in a scratch clone of the tree being deployed.
  SHGATES+=(test_gate_words.sh)
  # leg 825: the subject-nickname guard joins the same stage, one appended registration and not two —
  # test_secret_guard.sh counts the array across BOTH shapes, so a second line naming this file would
  # register the same check twice while the deploy still looks green.
  SHGATES+=(check_subject_armed.sh)
  # leg 862: the subject guard's BEHAVIOUR test joins the same stage. C registered the armed check that
  # asks whether the guard EXISTS; nothing asked whether it still DOES what it claims, and a check that
  # cannot tell a working guard from one that quietly stopped existing is the class this array exists for.
  # Appended at the END rather than inserted: the loop dies at the first refusal, so a registration's
  # position decides which cells go red when something fails (leg 860's own finding), and the literal line
  # above is pinned by exact text in test_secret_guard.sh.
  #
  # Why its sibling file is NOT on this line: test_secret_guard.sh was measured here too, and it cannot be
  # a member of the array it counts while test_gate_words.sh — also registered — runs the deploy against a
  # scratch clone whose array it rewrites on purpose. The census then asserts one number about a tree that
  # holds another, and two further cells read pinned objects out of published history that a git-init clone
  # cannot have. That registration was backed out on the lead's ruling and the durable shape is booked as
  # the secret guard's own design leg; the measurement of both faces is in
  # wave44-specs-20261101/flash1-gate-registration-862-report.md.
  SHGATES+=(test_subject_guard.sh)
  # WHAT THE LOOP NOW SAYS, and why it said something false before (leg 851). The old shape sent the
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
      if [ "$t" = "test_wrap_rows.py" ] && [ "${PY_HAVE_PAHO:-1}" = 0 ]; then
        say "WARNING: python3 has no paho-mqtt — tools/test_wrap_rows.py did NOT RUN"
        continue
      fi
      # test_broker.py reads MQTT_URL/MQTT_HOST as inputs to the resolver rule, so those go out of
      # its environment too; the rest of the list does not care and is run the same way for one reason:
      # a gate must not pass because of which terminal fired it.
      say "gate: python3 tools/$t"
      (cd "$BASE" && env -u MQTT_LEAD_NICK -u MQTT_URL -u MQTT_HOST python3 "tools/$t" >/dev/null) \
        || die "$t is not green; fix it instead of deploying around it"
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
  say "WARNING: gates skipped — this is a repo rehearsal, not a deploy"
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
trap 'rm -rf "$stage"' EXIT
for f in "${FILES[@]}"; do cp -p "$SRC/$f" "$stage/$f"; done

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

# LOAD THE DESTINATION, NOT THE SOURCE (leg 576, #12). `bun build` above compiles $SRC/index.ts,
# where every sibling exists on disk, so an omitted module in the directory a lane actually
# starts from passes the build, passes every gate, and ships — the exact incident this script's
# header records: "a new index.ts with no roommsg.ts beside it and dies at import". The
# byte-identity loop above cannot catch it either: it compares only the FILES list it just
# shipped, so an omitted sibling matches nothing and that loop still reads green. This imports
# what landed, from where it landed. Safe to run: the top level of both index.ts files is
# imports plus pure consts and the factory (verified at d751c72) — no connect, no fs write, no
# spawn — so the load needs no broker and leaves no state behind. LOADCHECK is consumed here, at
# the end of every real deploy; an array nothing reads is how a mandatory check becomes a rumour.
# This runs whatever --no-gates said: "gates skipped" must never mean "destination skipped".
# (--dry-run exits earlier and --physical exits before this point, so neither can reach it.)
command -v "$BUN" >/dev/null 2>&1 || die "bun not found at $BUN — the deployed tree cannot be load-checked"
# pi resolves bare specifiers (e.g. @earendil-works/pi-ai) from its OWN install tree, not from the
# extension's node_modules, so a bare import of a HEALTHY deployed tree failed resolution and this
# guard refused a correct deployment (leg 579, #12). Give the check pi's resolution context, derived
# so no version is hardcoded. If no install tree is found, the check still runs exactly as before —
# a missing derivation must never become a skipped check — and says which context it used.
PI_NM="$(ls -d "$HOME/.pi/agent/install/releases/"*/node_modules 2>/dev/null | sort -V | tail -1)"
if [ -n "$PI_NM" ]; then say "  load-check context: NODE_PATH=$PI_NM (pi install tree)"; else say "  load-check context: no pi install tree found — default resolution, check unchanged"; fi
for m in "${LOADCHECK[@]}"; do
  # The capture sits inside `if` because a bare failing assignment under set -e ends the script
  # before the refusal can print — seen in the scratch run for this leg, where the load failed
  # correctly but said nothing.
  if out=$(NODE_PATH="${PI_NM:-}" TABICHAT_LOAD_TARGET="$TARGET/$m" "$BUN" -e 'const M = await import(process.env.TABICHAT_LOAD_TARGET); if (typeof M.default !== "function") { console.error("loads but exports no default function"); process.exit(1); }' 2>&1); then
    say "  load ok  : $m (default export resolves at $TARGET)"
  else
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    die "$m does not LOAD from $TARGET — the destination is short or broken; a lane starting against it dies at import"
  fi
done

say "deployed set complete and identical: ${FILES[*]}"
say "remember: lanes already running hold the PREVIOUS code in memory. It loads on"
say "their restart, and a restart is the owner's call."
