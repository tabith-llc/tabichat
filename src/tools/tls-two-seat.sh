#!/usr/bin/env bash
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# tls-two-seat.sh — stand up TWO isolated tabichat seats against a THROWAWAY TLS broker, so the
# transport can be tested end-to-end WITHOUT any chance of downtime on the live room.
#
# WHY IT IS SHAPED THIS WAY (read this before running it).
# The live fleet rides `mqtt://<host>:1883` — plaintext. That is a fact about the estate, not a bug in
# the client. Testing TLS by editing `~/.pi/agent/extensions/tabichat/` or the operator's site file
# would put every live lane at risk: the live dir is missing `broker.ts` and `tlsopts.ts` that `main`
# now imports, so a partial deploy there makes every seat that starts AFTER it die at import. That is
# precisely the downtime this script exists to prevent.
#
# Isolation comes from three places at once, each independently sufficient:
#   1. `PI_CODING_AGENT_DIR` — pi loads extensions from the dir this names (verified on this box by
#      loading a probe extension from a scratch dir). The live `~/.pi/agent/extensions/` is NEVER read
#      or written, so no running seat is affected and no restart is needed.
#   2. A throwaway mosquitto on 127.0.0.1 with its OWN minted PKI, on a port this script owns, under
#      its OWN fixture-record owner. The estate broker is never contacted, and a neighbour lane's
#      teardown cannot reach this fixture (the s140 hazard fixed at f00d224).
#   3. A test ROOM and test NICKS. Topics are room-scoped, so a stray publish cannot land in `tabith`,
#      and identity comes from the certificate subject (`use_subject_as_username true`), so a test seat
#      physically cannot authenticate as a real lane.
#
# Usage:
#   bash src/tools/tls-two-seat.sh up      # fixture + both seat dirs, LOAD-CHECKED, then the two run lines
#   bash src/tools/tls-two-seat.sh up --client   # the same, plus two HUMAN-CLIENT run lines (typed line = publish)
#   bash src/tools/tls-two-seat.sh loop    # headless TLS proof: round trip + refusals + ACL halves
#   bash src/tools/tls-two-seat.sh down    # destroy everything this script made
set -uo pipefail

TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$TOOLS/../.." && pwd)
ROOT="${TMPDIR:-/tmp}/tls-two-seat"
ROOM=tlstest
NICKS="tlstest-a tlstest-b"
OWNER="${TWO_SEAT_OWNER:-tls-two-seat}"
# The owner is a namespace for the fixture record, and `up` clears its own predecessor by design. Measured
# at this face: a `tls-two-seat` fixture was already live (container tabichat-fixture-45523, state written
# at 09:59, room tlstest) while this leg was being built — that is the lead's staging for the owner's
# witnessed run, and a second seat running the documented `up` line would have stopped its broker through
# `broker-fixture.sh down`. Override per run; the default is unchanged so every recorded command still
# reads the same:  TWO_SEAT_OWNER=my-run TMPDIR=/tmp/my-scratch bash src/tools/tls-two-seat.sh up
# THE ACL PHASE IS THE WHOLE DIFFERENCE between "the seats can chat" and "both publish into a void".
# The shipped client writes the FLAT topic `chat/<room>` by default (`MQTT_SENDER_TOPIC` is off and
# must stay off until every reader has migrated), and the phase-2 ACL grants a nick ONLY its own leaf —
# so under phase 2 both seats publish, the broker drops it SILENTLY at QoS0, no denial is logged, and
# neither ever sees the other. That is exactly what `loop` proves as `FLAT topic DROPPED`.
# Default here is therefore phase1: the shape the clients actually have TODAY, which is what a
# two-seat conversation test must run against. Set ACL_PHASE=phase2 with MQTT_SENDER_TOPIC=1 exported
# in the launchers to test the post-migration shape instead.
ACL_PHASE="${ACL_PHASE:-phase1}"
# A seat needs a model, and `PI_CODING_AGENT_DIR` replaces the whole agent dir — including the default
# model resolution, which on this box picked a tier whose access is DISABLED and returned
# `403: Model access is disabled`. That is a model-routing failure, NOT a tabichat failure, and the
# distinction matters: the TLS transport line printed fine either way. An explicit local model boots
# clean (measured: `[tabichat][transport] TLS: pinned CA … client certificate … SNI` then the model
# answered). Override with:  MODEL_ARGS="--provider X --model Y" bash src/tools/tls-two-seat.sh up
MODEL_ARGS="${MODEL_ARGS:---provider oregon --model Qwen3.8-Flash-Next-Dynamic-oQ5e-BF16-PLE-mtp}"
# NOTE the distinct path. My first version wrote this to `tabichat-fixture-$OWNER.state` — exactly the
# path `broker-fixture.sh` uses for that owner — and in a DIFFERENT field order. The fixture then read
# my PORT as a container name and, thanks to the identify-before-signal guard, REFUSED to stop a
# container called `45383`. The guard caught a bug of mine rather than a tamper story, which is the
# whole point of the guard. This harness's record now lives inside $ROOT and cannot be confused.
STATE="$ROOT/self.state"

EXT_SRC="$REPO/src/extensions/tabichat"
NODE_MODULES="$HOME/.pi/agent/extensions/tabichat/node_modules"

log() { printf '[two-seat] %s\n' "$*" >&2; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

link_modules() {
  command -v node >/dev/null || die "node absent"
  [ -d "$NODE_MODULES/mqtt" ] || die "no mqtt package under $NODE_MODULES — lanes do not install (Rule 7)"
  [ -e "$ROOT/node_modules" ] || ln -s "$NODE_MODULES" "$ROOT/node_modules" \
    || die "cannot link the npm tree at $ROOT/node_modules"
}

# THE SHIPPED SET IS READ, NOT CARRIED. This loop used to hold twelve names by hand while
# deploy-tabichat.sh declared thirteen: `roomlog.ts` joined the shipped set on 10-30 in bd45bff, this
# script was last touched 10-24, and every seat it built since has failed to load with
# `Cannot find module './roomlog.ts'` — pi then reports `Unknown options: --tabichat, --room`, which is a
# downstream symptom of a seat that never started. The transport harness (`loop`) stayed green the whole
# time, because the transport never reads the seat dir. Two lists of one set is the defect; this parse is
# the same one test_diaglog_routing.ts uses against the same array, arm-scoped to tabichat, so a future
# shipped file lands in a seat dir with no second edit anywhere.
shipped_set() { # one name per line, in the deploy's own order
  local line
  line=$(awk '/^  tabichat\)/ {f=1} f && /^    FILES=\(/ {sub(/^    FILES=\(/,"");sub(/\)$/,"");print;exit}' \
    "$TOOLS/deploy-tabichat.sh")
  [ -n "$line" ] || return 1
  printf '%s\n' "$line" | tr ' ' '\n' | sed '/^$/d'
}

build_seat() { # $1 = nick
  # TWO `local` statements on purpose. As one line — `local nick="$1" dir="$ROOT/$nick"` — bash expands
  # `$nick` BEFORE the first assignment lands, so `dir` silently became "$ROOT/" and the `rm -rf` below
  # would have removed EVERY seat dir. Measured on this box. The case guard is the second half of the fix.
  local nick="$1"
  [ -n "$nick" ] || die "build_seat called with an empty nick"
  local dir="$ROOT/$nick"
  case "$dir" in
    "$ROOT"/*/*) die "refusing to build a seat at nested path '$dir'" ;;
    "$ROOT"/?*) ;;
    *) die "refusing to build a seat at '$dir' — not a per-nick path under $ROOT" ;;
  esac
  rm -rf "$dir"
  # 0700: this dir ends up holding a link to the provider credential store. Default umask would leave
  # it group-readable, which is a needless widening for a directory that points at `auth.json`.
  mkdir -p "$dir/extensions/tabichat"
  chmod 700 "$dir"
  local f names
  names=$(shipped_set) || die "no FILES array could be read out of $TOOLS/deploy-tabichat.sh — refusing to build a seat from an empty shipped set"
  [ -n "$names" ] || die "the shipped set parsed empty — refusing to build a seat from nothing"
  for f in $names package.json; do
    # package.json is the one name that is NOT in the deploy's FILES array: a seat dir needs the
    # extension's package metadata to be offered by pi, and the deploy does not move it. It is named
    # here as this harness's own extra rather than smuggled into a list that is supposed to be derived.
    [ -f "$EXT_SRC/$f" ] || die "$f missing from $EXT_SRC — cannot build a faithful seat"
    cp "$EXT_SRC/$f" "$dir/extensions/tabichat/"
  done
  ln -sfn "$NODE_MODULES" "$dir/extensions/tabichat/node_modules"
  # the seat's OWN site file: it must not read the operator's, and autoRenew is OFF so a test seat can
  # never renew or replace a real lane
  printf '{ "mqttUrl": "mqtts://127.0.0.1:%s", "autoRenew": false }\n' "$PORT" > "$dir/tabichat.json"
  # pi resolves credentials from `<agent-dir>/auth.json`, and `PI_CODING_AGENT_DIR` replaces that whole
  # agent dir — so WITHOUT this the seat loads the extension, connects, and then cannot run a model.
  # A SYMLINK, not a copy: copying the credential store into /tmp would put a second copy of live
  # provider secrets on disk (and one of them is in tmpfs that a reboot clears anyway). Same file, one
  # copy, and the seat never writes it.
  [ -f "$HOME/.pi/agent/auth.json" ] && ln -s "$HOME/.pi/agent/auth.json" "$dir/auth.json" \
    || log "WARNING: no auth.json to link — the seat will load but cannot call a model"
  [ -f "$HOME/.pi/agent/models.json" ] && cp "$HOME/.pi/agent/models.json" "$dir/"
  [ -f "$HOME/.pi/agent/settings.json" ] && cp "$HOME/.pi/agent/settings.json" "$dir/"
  printf '%s\n' "$dir"
}

up() {
  # `up --client` also writes the two HUMAN-CLIENT launch lines. The flag is matched, never ignored:
  # an unrecognised second argument used to fall through silently, and a flag that does nothing is how a
  # harness reads as run when it was not.
  local client_flag="${1:-}"
  case "$client_flag" in
    "" | --client) ;;
    *) die "up: unknown argument '$client_flag' — expected --client or nothing" ;;
  esac
  command -v docker >/dev/null || die "docker absent"
  mkdir -p "$ROOT"
  link_modules
  if [ -f "$STATE" ]; then
    log "clearing a previous two-seat fixture"
    TABICHAT_FIXTURE_OWNER="$OWNER" sh "$REPO/src/tools/broker-fixture.sh" down >/dev/null 2>&1 || true
  fi
  local out
  out=$(TABICHAT_FIXTURE_OWNER="$OWNER" TABICHAT_FIXTURE_ROOM="$ROOM" \
        TABICHAT_FIXTURE_NICKS="$NICKS" sh "$REPO/src/tools/broker-fixture.sh" up "$ACL_PHASE" 2>&1) \
    || { printf '%s\n' "$out" >&2; die "fixture did not start"; }
  PORT=$(printf '%s\n' "$out" | sed -n 's/^FIXTURE_PORT=//p')
  FIX=$(printf '%s\n' "$out" | sed -n 's/^FIXTURE_DIR=//p')
  [ -n "$PORT" ] && [ -n "$FIX" ] || die "fixture printed no port/dir"
  log "fixture port=$PORT dir=$FIX room=$ROOM nicks=$NICKS acl=$ACL_PHASE"

  local n DIR
  for n in $NICKS; do
    chmod 644 "$FIX/pki/clients/$n/cert.pem" 2>/dev/null || true
    # A `die` inside a command substitution only exits the SUBSHELL — this script runs without `set -e`,
    # so the old shape logged an empty seat dir and went on to write a launcher for a seat that was never
    # built, which the operator then ran. Measured at this leg's plant: with a declared name absent from
    # the tree, `up` printed the seat's real refusal AND then refused the load of a path called
    # `/extensions/tabichat`. The status is now read where it is produced.
    DIR=$(build_seat "$n") || die "seat $n was not built — the refusal above names what went wrong"
    [ -n "$DIR" ] || die "build_seat printed no directory for seat $n"
    [ -d "$DIR/extensions/tabichat" ] || die "seat $n has no extension tree at $DIR/extensions/tabichat"
    log "seat dir: $DIR"
    # PROVE IT LOADS. `loop` proves the TLS transport and says nothing about the seat dir, which is
    # exactly how a five-day-old failure stayed invisible; this line asks the deploy's own probe — the
    # same `load_check_tree` that gates a publication — whether THIS directory can load the shipped set.
    # TARGET is pinned to scratch even though --loadcheck writes nothing anywhere, because every command
    # in this harness names its target out loud.
    if TARGET="${TARGET_DIR:-${TMPDIR:-/tmp}/tabichat}/tls-two-seat-loadcheck" \
       bash "$TOOLS/deploy-tabichat.sh" --loadcheck "$DIR/extensions/tabichat" >/dev/null; then
      log "seat load proof: $n — the shipped set loads from $DIR/extensions/tabichat"
    else
      die "seat $n cannot LOAD its extension — the deploy's own probe refused $DIR/extensions/tabichat; re-run with the command printed above to see which name is short"
    fi
  done
  printf '%s %s %s %s\n' "$PORT" "$FIX" "$ROOM" "$ACL_PHASE" > "$STATE"

  # Write a launcher PER SEAT, so the operator pastes one short line instead of a ten-line env block.
  # A long wrapped block is a real hazard, not just annoying: `bash -c '…$F…'` silently empties an
  # unexported variable, and the seat then asks the broker for `/pki/ca/ca.crt`. Measured on this box —
  # the product refused correctly and named each bad path, but the operator should never have had to
  # get that right. Values are baked in absolute here, so there is nothing to export and nothing to set.
  local n
  for n in $NICKS; do
    {
      printf '#!/usr/bin/env bash\n'
      printf '# seat %s — generated by tls-two-seat.sh, absolute values baked in. Do not hand-edit.\n' "$n"
      printf 'export PI_CODING_AGENT_DIR=%q\n' "$ROOT/$n"
      printf 'export TABICHAT_CONFIG=%q\n' "$ROOT/$n/tabichat.json"
      printf 'export MQTT_NICK=%q\n' "$n"
      printf 'export MQTT_ROOM=%q\n' "$ROOM"
      printf 'export MQTT_OWNER_NICK=%q\n' "owner-test"
      printf 'export MQTT_URL=%q\n' "mqtts://127.0.0.1:$PORT"
      printf 'export MQTT_TLS_CAFILE=%q\n' "$FIX/pki/ca/ca.crt"
      printf 'export MQTT_TLS_CERTFILE=%q\n' "$FIX/pki/clients/$n/cert.pem"
      printf 'export MQTT_TLS_KEYFILE=%q\n' "$FIX/pki/clients/$n/key.pem"
      printf 'export MQTT_TLS_SERVERNAME=%q\n' "127.0.0.1"
      printf 'export MQTT_TLS_REQUIRED=%q\n' "1"
      # only in the post-migration shape: the client must WRITE its own leaf or phase 2 drops it
      [ "$ACL_PHASE" = phase2 ] && printf 'export MQTT_SENDER_TOPIC=%q\n' "1"
      printf 'unset LANE_ADMIN_RENEW LANE_ADMIN_SELFRENEW LANE_AUTO_RENEW LANE_ADMIN_SHUTDOWN LANE_ADMIN_COMPACT\n'
      printf 'unset MQTT_LEAD_NICK MQTT_STEER_NICKS\n'
      # cwd is the SEAT dir, not the repo: a test seat must not load a product repo's AGENTS.md into
      # its context, and there is nothing in the seat dir for pi to treat as project extensions.
      # "$@" is passed through so the operator (or a cold seat) can add --print/--model/flags without
      # editing the launcher. Without it, extra args were silently dropped and pi then tried to draw a
      # TUI with no TTY and died inside readable-stream — measured on this box.
      printf 'cd %q && exec pi --tabichat --room %q %s "$@"\n' "$ROOT/$n" "$ROOM" "$MODEL_ARGS"
    } > "$ROOT/$n.sh"
    chmod 700 "$ROOT/$n.sh"
  done
  log "launchers written: $ROOT/tlstest-a.sh  $ROOT/tlstest-b.sh"

  if [ "$client_flag" = "--client" ]; then
    # THE HUMAN CLIENT, IN ITS OWN TWO TERMINALS. The fixture has always started two model-driven `pi`
    # seats, and a plain line typed at a `pi` seat is a PROMPT, not a publish — whether it becomes a room
    # line depends on a model choosing to call a tool. So the harness could never produce the instrument
    # the owner's precondition asks for: a human line at one terminal painting at the other. These two
    # launchers run the shipped human client (`src/src/tabichat_cli.py`) against THIS fixture, as the
    # fixture's own two nicks, in the fixture's own room.
    #
    # The broker address is set by a per-client SITE FILE, not by $MQTT_URL. Layer order in
    # `src/src/broker.py` is cli arg → site config `mqttUrl` → env, and this box's operator site file
    # names the ESTATE broker in that key. A launcher that relied on the env layer alone would have been
    # outranked by that file and pointed a test client at the live broker address — which is the one thing
    # this harness must never do. Same rule the seat dirs already follow (`TABICHAT_CONFIG` at
    # $ROOT/$n/tabichat.json). The address itself is not repeated here: `test_broker.ts` refuses a venue
    # address in tracked text, and it caught my first draft of this comment.
    local py n2
    py="$REPO/src/.venv/bin/python"
    [ -x "$py" ] || py="$(command -v python3)"
    [ -n "$py" ] || die "no python to run the human client with — python3 absent"
    log "client python: $py"
    for n2 in $NICKS; do
      printf '{ "mqttUrl": "mqtts://127.0.0.1:%s", "autoRenew": false }\n' "$PORT" > "$ROOT/$n2-client.json"
      {
        printf '#!/usr/bin/env bash\n'
        printf '# human client %s — generated by tls-two-seat.sh up --client. Absolute paths only; do not hand-edit.\n' "$n2"
        printf '# Runs the SHIPPED human client, so a typed line publishes on its own — no model in the path.\n'
        printf 'export TABICHAT_CONFIG=%q\n' "$ROOT/$n2-client.json"
        printf 'export MQTT_TLS_CAFILE=%q\n' "$FIX/pki/ca/ca.crt"
        printf 'export MQTT_TLS_CERTFILE=%q\n' "$FIX/pki/clients/$n2/cert.pem"
        printf 'export MQTT_TLS_KEYFILE=%q\n' "$FIX/pki/clients/$n2/key.pem"
        printf 'export MQTT_TLS_SERVERNAME=%q\n' "127.0.0.1"
        printf 'export MQTT_TLS_REQUIRED=%q\n' "1"
        printf 'unset MQTT_URL MQTT_HOST MQTT_PORT MQTT_SENDER_TOPIC\n'
        printf 'unset MQTT_LEAD_NICK MQTT_STEER_NICKS MQTT_NICK MQTT_ROOM\n'
        printf 'cd %q && exec %q src/tabichat_cli.py %q --nick %q\n' "$REPO/src" "$py" "$ROOM" "$n2"
      } > "$ROOT/$n2-client.sh"
      chmod 700 "$ROOT/$n2-client.sh"
    done
    log "client launchers written: $ROOT/tlstest-a-client.sh  $ROOT/tlstest-b-client.sh"
    printf '%s\n' "$client_flag" > "$ROOT/client.flag"
  fi

  echo
  echo "START EACH SEAT IN ITS OWN TERMINAL, ON IDAHO — one line each:"
  echo
  echo "  sh $ROOT/tlstest-a.sh"
  echo "  sh $ROOT/tlstest-b.sh"
  if [ -f "$ROOT/client.flag" ]; then
    echo
    echo "HUMAN CLIENT — one line each, in the OTHER two terminals (no model, no tool call in the path):"
    echo
    echo "  sh $ROOT/tlstest-a-client.sh"
    echo "  sh $ROOT/tlstest-b-client.sh"
    echo
    echo "Type a plain line at one and it publishes; the other paints it. /live, /back, /grep, /join are the client's own commands."
  fi
  echo
  echo "You should see a '[tabichat][transport] TLS: pinned CA …' line as each one starts."
  echo "Then tell seat A to chat_post to tlstest-b, and seat B to chat_read and report."
  echo "Teardown: bash src/tools/tls-two-seat.sh down"
  log "headless proof (no model needed): bash src/tools/tls-two-seat.sh loop"
}

# The same transport, driven headless. This does not need a model, so it separates "does TLS work" from
# "is pi happy", which is the distinction that keeps a harness bug from being reported as a product bug.
loop() {
  [ -f "$STATE" ] || die "no two-seat fixture recorded — run 'up' first"
  link_modules
  read -r PORT FIX ROOM PHASE < "$STATE"
  [ -d "$FIX/pki" ] || die "fixture dir $FIX is gone — run 'up' again"

  echo "=== 1. ROUND TRIP over TLS on 127.0.0.1:$PORT (room=$ROOM) ==="
  NONCE="tls-proof-$(date +%s)-$$"
  export SEAT_NONCE="$NONCE"
  cat > "$ROOT/loop.mjs" <<'JS'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import mqtt from "mqtt";
const [PORT, FIX, ROOM] = process.argv.slice(2);
const nick = process.env.SEAT_NICK;
const role = process.env.SEAT_ROLE;
// the nonce is FIXED per run by the parent, so the two halves can agree on it. Generating one per
// process meant each side waited on a value the other had already thrown away — a harness bug that
// printed as a TLS failure for about a minute before anyone re-read it.
const nonce = process.env.SEAT_NONCE || "tls-proof-fixed";
const fs = require("fs");
const opts = {
  ca: fs.readFileSync(`${FIX}/pki/ca/ca.crt`),
  cert: fs.readFileSync(`${FIX}/pki/clients/${nick}/cert.pem`),
  key: fs.readFileSync(`${FIX}/pki/clients/${nick}/key.pem`),
  servername: "127.0.0.1",
  rejectUnauthorized: true,
  clientId: nick,
  reconnectPeriod: 0,
};
// publish where the ACL IN EFFECT actually grants the write: phase 1 grants the FLAT topic only
// (`pattern write chat/<room>`, no msg/+), phase 2 grants ONLY the per-nick leaf. Choosing wrong is
// how this loop reported "round trip FAILED" against a phase-1 broker that was working perfectly.
const topic = (process.env.SEAT_TOPIC_MODE || "flat") === "leaf"
  ? `chat/${ROOM}/msg/${nick}` : `chat/${ROOM}`;
const c = mqtt.connect(`mqtts://127.0.0.1:${PORT}`, opts);
c.on("error", (e) => { console.log(`${nick} ERROR ${e.message}`); process.exit(1); });
c.on("connect", () => {
  const sec = c.stream.getPeerCertificate ? c.stream.getPeerCertificate() : {};
  const cip = c.stream.getCipher ? c.stream.getCipher().name : "?";
  if (role === "sub") {
    console.log(`${nick} CONNECTED cipher=${cip} authorized=${c.stream.authorized} issuer=${sec.issuer ? sec.issuer.CN : "?"}`);
    c.subscribe([`chat/${ROOM}`, `chat/${ROOM}/msg/+`], { qos: 0 });
  } else {
    console.log(`${nick} CONNECTED cipher=${cip} authorized=${c.stream.authorized} subject=${sec.subject ? sec.subject.CN : "?"}`);
    setTimeout(() => c.publish(topic, JSON.stringify({ nick, message: nonce })), 400);
    setTimeout(() => process.exit(0), 8000);
  }
});
c.on("message", (t, p) => {
  const m = JSON.parse(p.toString());
  console.log(`${nick} RECEIVED ${t} from=${m.nick} body=${m.message}`);
  if (role === "sub" && m.message === nonce) {
    console.log(`${nick} ROUNDTRIP_OK over TLS (${c.stream.getCipher().name})`);
    process.exit(0);
  }
});
if (role === "sub")
  setTimeout(() => { console.log(`${nick} TIMEOUT — no round trip in 12s`); process.exit(1); }, 12000);
JS
  if [ "$PHASE" = phase2 ]; then export SEAT_TOPIC_MODE=leaf; else export SEAT_TOPIC_MODE=flat; fi
  echo "  (publishing to the $SEAT_TOPIC_MODE topic, the shape the $PHASE ACL grants)"
  ( SEAT_NICK=tlstest-b SEAT_ROLE=sub node "$ROOT/loop.mjs" "$PORT" "$FIX" "$ROOM" > "$ROOT/b.log" 2>&1 ) &
  local subpid=$!
  sleep 1
  SEAT_NICK=tlstest-a SEAT_ROLE=pub node "$ROOT/loop.mjs" "$PORT" "$FIX" "$ROOM" 2>&1 | grep -v DeprecationWarning | sed 's/^/  /'
  wait $subpid 2>/dev/null
  grep -v DeprecationWarning "$ROOT/b.log" | sed 's/^/  /'
  local roundtrip=0
  grep -q 'ROUNDTRIP_OK' "$ROOT/b.log" && echo "  → round trip over TLS: OK" || { echo "  → round trip over TLS: FAILED"; roundtrip=1; }

  echo "=== 2. NEGATIVE: a WRONG CA must be refused (real second CA, not a stray path) ==="
  # a FILE beside $ROOT/node_modules, not `node -e`: an eval'd script resolves imports from the CWD,
  # which is the repo, where mqtt is not installed — that ERR_MODULE_NOT_FOUND looked like a TLS result.
  cat > "$ROOT/rogue.mjs" <<'JR'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mqtt = require("mqtt");
const fs = require("fs");
const [PORT, FIX] = process.argv.slice(2);
const c = mqtt.connect(`mqtts://127.0.0.1:${PORT}`, {
  ca: fs.readFileSync(`${FIX}/pki/rogue/ca.crt`),
  cert: fs.readFileSync(`${FIX}/pki/clients/tlstest-a/cert.pem`),
  key: fs.readFileSync(`${FIX}/pki/clients/tlstest-a/key.pem`),
  servername: "127.0.0.1", rejectUnauthorized: true, reconnectPeriod: 0, clientId: "tlstest-a",
});
c.on("error", (e) => { console.log("  REFUSED as expected:", String(e.message).slice(0, 70)); process.exit(0); });
c.on("connect", () => { console.log("  NOT REFUSED — a rogue CA was ACCEPTED. Real defect."); process.exit(1); });
setTimeout(() => { console.log("  no connect within 9s — treated as refusal"); process.exit(0); }, 9000);
JR
  node "$ROOT/rogue.mjs" "$PORT" "$FIX" 2>&1 | grep -v 'Use of\|trace-deprecation' | sed 's/^/  /'
  roguec=${PIPESTATUS[0]}
  [ "$roguec" -eq 0 ] || echo "  → ROGUE CA WAS ACCEPTED — real defect (node exit $roguec)"

  echo "=== 3. NEGATIVE: a PLAINTEXT client must not get in ==="
  cat > "$ROOT/plain.mjs" <<'JP'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mqtt = require("mqtt");
const [PORT] = process.argv.slice(2);
// deliberately NO tls options: this is the shape a pre-TLS client has today
const c = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { reconnectPeriod: 0, clientId: "plain-probe" });
c.on("error", (e) => { console.log("  REFUSED as expected:", String(e.message).slice(0, 70)); process.exit(0); });
c.on("connect", () => { console.log("  NOT REFUSED — a plaintext client reached the TLS listener"); process.exit(1); });
setTimeout(() => { console.log("  no CONNACK within 8s — plaintext refused"); process.exit(0); }, 8000);
JP
  node "$ROOT/plain.mjs" "$PORT" 2>&1 | grep -v 'Use of\|trace-deprecation' | sed 's/^/  /'
  plainrc=${PIPESTATUS[0]}
  [ "$plainrc" -eq 0 ] || echo "  → PLAINTEXT WAS ACCEPTED — real defect (node exit $plainrc)"

  echo "=== 4. ACL halves — phase in effect: $PHASE ==="
  if [ "$PHASE" = phase2 ]; then
    echo "  (phase 2: a nick may write ONLY its own leaf, so the flat write MUST be dropped)"
  else
    echo "  (phase 1: the shipped flat write is ALLOWED, which is what lets two seats converse;)"
    echo "   the foreign-leaf drop and the migration law are proved under phase 2 — see loop in $PHASE,"
    echo "   then re-run with ACL_PHASE=phase2 to see the drop)"
  fi
  cat > "$ROOT/acl.mjs" <<'JA'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mqtt = require("mqtt");
const fs = require("fs");
const [PORT, FIX, ROOM] = process.argv.slice(2);
const mk = (nick) => mqtt.connect(`mqtts://127.0.0.1:${PORT}`, {
  ca: fs.readFileSync(`${FIX}/pki/ca/ca.crt`),
  cert: fs.readFileSync(`${FIX}/pki/clients/${nick}/cert.pem`),
  key: fs.readFileSync(`${FIX}/pki/clients/${nick}/key.pem`),
  servername: "127.0.0.1", rejectUnauthorized: true, reconnectPeriod: 0, clientId: nick,
});
const sub = mk("tlstest-b"), pub = mk("tlstest-a");
const heard = [];
sub.on("connect", () => sub.subscribe([`chat/${ROOM}/msg/+`, `chat/${ROOM}`], { qos: 0 }));
sub.on("message", (t, p) => heard.push(`${t}|${JSON.parse(p.toString()).message}`));
pub.on("error", (e) => console.log("  pub error", e.message));
pub.on("connect", () => setTimeout(() => {
  pub.publish(`chat/${ROOM}/msg/tlstest-a`, JSON.stringify({ nick: "tlstest-a", message: "MINE" }));
  pub.publish(`chat/${ROOM}/msg/tlstest-b`, JSON.stringify({ nick: "tlstest-a", message: "NOT-MINE" }));
  pub.publish(`chat/${ROOM}`, JSON.stringify({ nick: "tlstest-a", message: "FLAT" }));
}, 400));
setTimeout(() => {
  const own = heard.some((x) => x.endsWith("|MINE"));
  const other = heard.some((x) => x.endsWith("|NOT-MINE"));
  const flat = heard.some((x) => x.endsWith("|FLAT"));
  console.log(`  heard: ${heard.join("  ") || "nothing"}`);
  console.log(`  own leaf DELIVERED                              : ${own}`);
  console.log(`  another nick's leaf DROPPED by the broker       : ${!other}`);
  console.log(`  FLAT topic DROPPED (=> clients migrate FIRST)   : ${!flat}`);
  process.exit(own && !other && !flat ? 0 : 1);
}, 3000);
JA
    cat > "$ROOT/acl1.mjs" <<'J1'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mqtt = require("mqtt");
const fs = require("fs");
const [PORT, FIX, ROOM] = process.argv.slice(2);
const mk = (nick) => mqtt.connect(`mqtts://127.0.0.1:${PORT}`, {
  ca: fs.readFileSync(`${FIX}/pki/ca/ca.crt`),
  cert: fs.readFileSync(`${FIX}/pki/clients/${nick}/cert.pem`),
  key: fs.readFileSync(`${FIX}/pki/clients/${nick}/key.pem`),
  servername: "127.0.0.1", rejectUnauthorized: true, reconnectPeriod: 0, clientId: nick,
});
const sub = mk("tlstest-b"), pub = mk("tlstest-a");
const heard = [];
sub.on("connect", () => sub.subscribe([`chat/${ROOM}`, `chat/${ROOM}/msg/+`], { qos: 0 }));
sub.on("message", (t, p) => heard.push(`${t}|${JSON.parse(p.toString()).message}`));
pub.on("connect", () => setTimeout(() => {
  pub.publish(`chat/${ROOM}`, JSON.stringify({ nick: "tlstest-a", message: "FLAT" }));
  pub.publish(`chat/${ROOM}/msg/tlstest-a`, JSON.stringify({ nick: "tlstest-a", message: "LEAF" }));
}, 400));
setTimeout(() => {
  const flat = heard.some((x) => x.endsWith("|FLAT"));
  const leaf = heard.some((x) => x.endsWith("|LEAF"));
  console.log(`  heard: ${heard.map((h) => h.split("|")[0]).join("  ") || "nothing"}`);
  console.log(`  FLAT write DELIVERED (phase 1 allows it — this is why seats converse today): ${flat}`);
  console.log(`  per-nick LEAF write delivered under phase 1: ${leaf}`);
  console.log(`  NOTE: the migration law is not inverted here — under phase 2 the FLAT write stops`);
  console.log(`        working. Re-run with ACL_PHASE=phase2 to see that half.`);
  process.exit(flat ? 0 : 1);
}, 3000);
J1
  if [ "$PHASE" = phase2 ]; then
    node "$ROOT/acl.mjs" "$PORT" "$FIX" "$ROOM" 2>&1 | grep -v 'Use of\|trace-deprecation' | sed 's/^/  /'
  else
    # under phase 1 the expectation for the flat write INVERTS: it is DELIVERED. Asserting the phase-2
    # shape against a phase-1 broker produced "ACL did NOT match the documented shape" on a broker that
    # was working perfectly, which is a wrong verdict from a wrong expectation, not a product finding.
    node "$ROOT/acl1.mjs" "$PORT" "$FIX" "$ROOM" 2>&1 | grep -v 'Use of\|trace-deprecation' | sed 's/^/  /'
  fi
  # the verdict must come from NODE, not from the last filter in the pipe: `$?` after a pipeline is
  # `sed`'s status, which is 0 even when node failed — so an ACL that did NOT match would still have
  # printed "behaves exactly as documented". That is a check that cannot fail, which is worse than no check.
  aclrc=${PIPESTATUS[0]}
  if [ "$aclrc" -eq 0 ]; then
    if [ "$PHASE" = phase2 ]; then
      echo "  → phase-2 ACL behaves exactly as docs/broker/acl.conf documents"
    else
      echo "  → phase-1 ACL behaves exactly as docs/broker/acl-phase1.conf documents"
    fi
  else
    echo "  → ACL did NOT match the documented shape (node exit $aclrc)"
  fi

  [ $roundtrip -eq 0 ] || return 1
}

down() {
  TABICHAT_FIXTURE_OWNER="$OWNER" sh "$REPO/src/tools/broker-fixture.sh" down
  rm -rf "$ROOT"
  log "down: seat dirs, loop scripts and scratch destroyed"
}

case "${1:-}" in
  up) up "${2:-}" ;;
  loop) loop ;;
  down) down ;;
  *) echo "usage: $0 up [--client] | loop | down" >&2; exit 2 ;;
esac
