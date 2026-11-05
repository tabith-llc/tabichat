#!/bin/sh
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
# broker-fixture.sh — start docs/broker/tabichat.conf on a LOOPBACK mosquitto you own, so the
# artifact's refusals are OBSERVED instead of asserted.
#
# WHY THIS EXISTS. The feature row's acceptance criteria are "proven by test, not by reading
# config", and the fence on this leg is that no lane may touch the operator's live broker. A fixture in a
# container on 127.0.0.1 on a port I own is the only way to hold both. It has already paid for
# itself: three load errors that no amount of reading the artifact would have shown are recorded in
# the header of docs/broker/tabichat.conf, each one a broker that REFUSES TO START.
#
# WHAT IS SUBSTITUTED, AND THAT IS THE WHOLE POINT — exactly three things, all mechanical:
#   cert/acl PATHS   /etc/mosquitto/... and /etc/mosquitto/acl.conf -> /fixture/... (the CONTAINER
#                    view; a host path here is the failure mode measured on this seat's first run:
#                    "Unable to open acl_file" for a file that exists and is world-readable)
#   ROOM NAME        `tabith` -> $TABICHAT_FIXTURE_ROOM (default `fixture`), so a test cannot write
#                    into the real room even by accident
#   NOTHING ELSE. No option added, removed, reordered or re-worded. If the artifact does not parse,
#   or parses and does not enforce, that is what this script shows.
#
# The PKI is throwaway material this script mints into a mktemp dir with the project's own
# mint-tabichat-pki.sh, valid for 2 days, and DESTROYED on `down`. It is never the fleet's CA.
# Key CONTENTS are never read, printed or copied by this script — only paths are handled, per the
# fleet law of that key-file content is one designated lane's work alone.
#
#   sh broker-fixture.sh up [phase1|phase2]   # start; prints FIXTURE_* lines on stdout
#   sh broker-fixture.sh down                 # stop + destroy the fixture dir
set -eu

TOOLS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$TOOLS_DIR/../.." && pwd)
MINT="$REPO/docs/broker/mint-tabichat-pki.sh"
ARTIFACT_CONF="$REPO/docs/broker/tabichat.conf"
ARTIFACT_ACL1="$REPO/docs/broker/acl-phase1.conf"
# THE RECORD IS SCOPED TO AN OWNER, NOT TO THE BOX.
# It used to be one global path, `${TMPDIR}/tabichat-fixture.state`, and that was a live hazard:
# `test_broker_auth.ts` runs its own `up`/`down` pair, so any seat that had a fixture running found
# its broker stopped and its record deleted by a neighbour's teardown — and the victim's own test
# then correctly reported NOT RUN, which reads like a product failure. Measured and reproduced by
# the lead on twice, deterministically. Same disease as a host-wide pattern kill: a
# teardown that acts on whatever it finds rather than on what it started.
# `default` keeps the hand-run recipe working: `up` with no env and `python3
# test_tlsenv_paho.py` with no env agree on one file. A test file that manages its own fixture sets
# TABICHAT_FIXTURE_OWNER to something unique to the run, and then cannot see or touch anyone
# else's broker. Derive the same name in any reader: `tabichat-fixture-<owner>.state`.
OWNER="${TABICHAT_FIXTURE_OWNER:-default}"
STATE="${TMPDIR:-/tmp}/tabichat-fixture-${OWNER}.state"
OWNER_PREFIX="tabichat-fixture-"
IMAGE="${TABICHAT_FIXTURE_IMAGE:-eclipse-mosquitto:2}"
ROOM="${TABICHAT_FIXTURE_ROOM:-fixture}"
# Site-neutral by default. The broker takes the nick from the certificate subject
# (`use_subject_as_username true`), so minting a real lane's name means the throwaway broker will
# accept that name — and a demo authenticating as a live lane is the thing this harness exists to
# avoid. A cell that NEEDS specific identities declares them itself (test_broker_auth.ts and
# test_ack_watch_broker.ts now set TABICHAT_FIXTURE_NICKS explicitly, as tls-two-seat.sh and the
# third-nick block already did); the unset case stays neutral AND LOUD, so no run ever mints an
# identity silently out of a default it never reads.
if [ -z "${TABICHAT_FIXTURE_NICKS:-}" ]; then
  printf '[fixture] %s\n' "TABICHAT_FIXTURE_NICKS unset — minting the site-neutral pair 'seat-a seat-b'; a cell that needs named nicks must declare them in the env" >&2
  NICKS="seat-a seat-b"
else
  NICKS="$TABICHAT_FIXTURE_NICKS"
fi

log() { printf '[fixture] %s\n' "$*" >&2; }

need_tools() {
  command -v docker >/dev/null || { log "docker not found — the broker refusal cells are NOT RUN"; exit 127; }
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "image $IMAGE absent"; exit 127; }
  command -v bun >/dev/null || { log "bun not found (needed for a free port)"; exit 127; }
}

free_port() {
  bun -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close(()=>process.exit(0))});' 2>/dev/null
}

start() {
  PHASE="${1:-phase1}"
  case "$PHASE" in phase1|phase2) ;; *) log "usage: $0 up [phase1|phase2]"; exit 2 ;; esac
  need_tools
  # The predecessor we clear is OUR OWN (same owner) and nothing else. The record is owner-scoped
  # now, so this can no longer reach a neighbour's broker; the name and image checks are the second
  # guard, and a refusal leaves the other container and its record exactly as they were.
  if [ -f "$STATE" ]; then
    read -r OLD _ < "$STATE"
    if [ -n "$OLD" ]; then
      case "$OLD" in
        ${OWNER_PREFIX}*)
          IMG_OLD="$(docker inspect -f '{{.Config.Image}}' "$OLD" 2>/dev/null)"
          if [ -z "$IMG_OLD" ] || [ "$IMG_OLD" = "$IMAGE" ]; then
            docker stop "$OLD" >/dev/null 2>&1 || true
            docker rm -f "$OLD" >/dev/null 2>&1 || true
          else
            log "REFUSING to clear predecessor '$OLD' — image '$IMG_OLD' is not '$IMAGE'"
            log "  REFUSING to overwrite its record at $STATE too. Two fixtures cannot share an owner;"
            log "  set TABICHAT_FIXTURE_OWNER to a unique value for this run."
            exit 1
          fi
          ;;
        *) log "REFUSING to clear predecessor '$OLD' — not a ${OWNER_PREFIX}* container"; exit 1 ;;
      esac
    fi
    rm -f "$STATE"
  fi

  FIX=$(mktemp -d "${TMPDIR:-/tmp}/tabichat-fixture-XXXXXX")
  PORT=$(free_port)
  [ -n "$PORT" ] || { log "could not get a free port"; exit 1; }
  NAME="tabichat-fixture-$PORT"

  # 1. throwaway PKI + the per-nick ACL, by the artifact's OWN mint script (so the ACL's `user`
  #    lines are produced by the same code that produces the certs they must match)
  TABICHAT_ROOM="$ROOM" sh "$MINT" -o "$FIX/pki" -c 2 -s 2 $NICKS >/dev/null 2>&1
  [ -f "$FIX/pki/ca/ca.crt" ] || { log "mint failed"; exit 1; }

  # 2. the broker config: the artifact, paths and room substituted, nothing else
  mkdir -p "$FIX/config"
  sed -e "s|/etc/mosquitto/certs/tabichat-server.crt|/fixture/pki/server/leaf.crt|" \
      -e "s|/etc/mosquitto/certs/tabichat-server.key|/fixture/pki/server/leaf.key.open|" \
      -e "s|/etc/mosquitto/certs/tabichat-ca.crt|/fixture/pki/ca/ca.crt|" \
      -e "s|acl_file /etc/mosquitto/acl.conf|acl_file /fixture/config/acl.conf|" \
      "$ARTIFACT_CONF" > "$FIX/config/mosquitto.conf"
  if [ "$PHASE" = phase2 ]; then
    cp "$FIX/pki/acl-generated.conf" "$FIX/config/acl.conf"
  else
    sed "s|chat/tabith|chat/$ROOM|g" "$ARTIFACT_ACL1" > "$FIX/config/acl.conf"
  fi
  [ -s "$FIX/config/acl.conf" ] || { log "empty acl after substitution"; exit 1; }

  # 3. the daemon in this image drops to the `mosquitto` user, which cannot traverse a 0700 mktemp
  #    dir or read a 0600 agent-owned key, so the tree the CONTAINER sees is opened. Throwaway
  #    material, rm -rf'd on `down`, never a certificate authority and never a person's own keys. Only the
  #    SERVER key needs to be readable by the daemon; CLIENT keys stay 0600 and are opened by the
  #    test client process, which runs as the lane user.
  chmod 755 "$FIX" "$FIX/config" "$FIX/pki" "$FIX/pki/ca" "$FIX/pki/server" "$FIX/pki/clients"
  chmod 644 "$FIX/config/mosquitto.conf" "$FIX/config/acl.conf" \
           "$FIX/pki/ca/ca.crt" "$FIX/pki/server/leaf.crt" "$FIX/pki/acl-generated.conf"
  for n in $NICKS; do
    chmod 755 "$FIX/pki/clients/$n"; chmod 644 "$FIX/pki/clients/$n/cert.pem"
  done
  cp "$FIX/pki/server/leaf.key" "$FIX/pki/server/leaf.key.open"
  chmod 644 "$FIX/pki/server/leaf.key.open"

  # 3b. a SECOND, UNRELATED throwaway CA, for the negative half of AC4 ("a wrong CA fails the
  # handshake"). It must be a real CA that verifies nothing the broker trusts, not a stray file:
  # a test that "fails" because a path does not exist proves nothing about TLS. Paths only again —
  # the rogue CA's private key is minted and never read by anything here.
  mkdir -p "$FIX/pki/rogue"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$FIX/pki/rogue/ca.key" \
    -out "$FIX/pki/rogue/ca.crt" -days 2 -subj "/CN=rogue-not-tabichat-ca" >/dev/null 2>&1
  chmod 755 "$FIX/pki/rogue"; chmod 644 "$FIX/pki/rogue/ca.crt"

  docker run -d --name "$NAME" \
    -p "127.0.0.1:$PORT:8883" \
    -v "$FIX:/fixture:ro" \
    "$IMAGE" mosquitto -c /fixture/config/mosquitto.conf >/dev/null

  # 4. wait for the bind. On failure dump the EFFECTIVE CONFIG with paths masked, never a key, and
  #    exit loudly — a fixture that silently did not start is how a green test lies.
  i=0
  until docker logs "$NAME" 2>&1 | grep -q 'Opening ipv4 listen socket'; do
    i=$((i + 1))
    if [ "$i" -gt 50 ]; then
      log "broker did not bind within 5s. Container log:"
      docker logs "$NAME" 2>&1 | tail -15 >&2
      log "effective config (comments stripped, paths shown):"
      grep -vE '^[[:space:]]*(#|$)' "$FIX/config/mosquitto.conf" >&2
      docker stop "$NAME" >/dev/null 2>&1 || true
      rm -rf "$FIX"
      exit 1
    fi
    sleep 0.1
  done
  # a refusal the broker prints at boot is information, not a failure; anything AFTER the bind that
  # says "Error" is, so the test still asserts, and this line only catches a config that loads and
  # then dies.
  if docker logs "$NAME" 2>&1 | grep -qE 'Error'; then
    log "broker bound but logged an Error:"
    docker logs "$NAME" 2>&1 | grep -E 'Error' >&2
    docker stop "$NAME" >/dev/null 2>&1 || true
    rm -rf "$FIX"
    exit 1
  fi

  printf '%s\n' "$NAME $FIX $PORT $ROOM $PHASE" > "$STATE"
  log "up: name=$NAME port=$PORT room=$ROOM acl=$PHASE dir=$FIX"
  echo "FIXTURE_NAME=$NAME"
  echo "FIXTURE_DIR=$FIX"
  echo "FIXTURE_PORT=$PORT"
  echo "FIXTURE_ROOM=$ROOM"
  echo "FIXTURE_ACL=$PHASE"
}

stop() {
  [ -f "$STATE" ] || { log "no fixture recorded for owner=$OWNER (at $STATE) — nothing stopped"; exit 0; }
  read -r NAME FIX PORT ROOM PHASE < "$STATE"
  # IDENTIFY BEFORE YOU SIGNAL, the serve-pidfile law applied to a container: the name must be a
  # fixture this script makes, and the image must be the fixture image. A record that names anything
  # else is refused with the record AND the process left alone — a stale or tampered file must not
  # become a kill command.
  case "$NAME" in
    ${OWNER_PREFIX}*) ;;
    *) log "REFUSING to stop '$NAME' — not a ${OWNER_PREFIX}* container; record left in place"; exit 1 ;;
  esac
  if docker inspect "$NAME" >/dev/null 2>&1; then
    IMG="$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null)"
    if [ -n "$IMG" ] && [ "$IMG" != "$IMAGE" ]; then
      log "REFUSING to stop '$NAME' — image '$IMG' is not the fixture image '$IMAGE'; record left in place"
      exit 1
    fi
  fi
  # stop AND rm: the run carries --rm, but on this daemon an externally-stopped container can stay
  # in `docker ps -a` as an Exited record, and a name that lingers is what makes the next seat's
  # `docker run --name` fail with a conflict it cannot explain.
  [ -n "$NAME" ] && { docker stop "$NAME" >/dev/null 2>&1 || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; }
  # the rm is scoped to a directory THIS script created by mktemp with this exact prefix
  case "$FIX" in
    */tabichat-fixture-*) [ -n "$FIX" ] && rm -rf "$FIX" ;;
    *) log "REFUSING to remove '$FIX' — not a fixture directory" ;;
  esac
  rm -f "$STATE"
  log "down: owner=$OWNER name=$NAME stopped, dir=$FIX destroyed"
}

case "${1:-}" in
  up) shift; start "${1:-phase1}" ;;
  down) stop ;;
  *) echo "usage: $0 up [phase1|phase2] | down" >&2; exit 2 ;;
esac
