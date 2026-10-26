#!/bin/sh
# mint-tabichat-pki.sh — mint the tabichat PKI: one CA, one broker leaf, one client leaf per nick,
# and the per-nick broker ACL that goes with them.
#
# WHAT THIS IS AND WHAT IT IS NOT. It is the REVIEWED ARTIFACT that features/
# tabichat-mqtt-broker-auth.md asks for as phase 1's key material. It WRITES FILES INTO A
# DIRECTORY YOU NAME. It never touches a broker, never edits /etc/mosquitto, never restarts
# anything, and never contacts a live broker. Installing the output onto a broker host is the
# OWNER'S act (owner order 2026-10-18 releases implementation on a branch; the broker stays
# untouched by any lane).
#
# WHY A DEDICATED CA, NOT THE VENYA CORE CA: a chat harness must not share trust material with
# the product's CA-trust roots. That is the #536 (pinned-CA-only) / #541 (refuse loudly, no
# rewrap) / #538 (split) boundary, and it is a rule this fleet has ruled too hard to let a
# dev-harness key hang off the core CA. There is deliberately NO option here that points at the
# core CA.
#
# WHY CERTIFICATES AND NOT A SHARED PASSWORD: with mTLS the launch sheet and tabichat-aliases.sh
# carry PATHS. A password scheme puts a secret into the file that gets pasted around, and s78's
# recorded lesson is that a launch line silently lies about its effective values.
#
#   usage: sh mint-tabichat-pki.sh -o <outdir> [-c client_days] [-s server_days] <nick...>
#   e.g.   sh mint-tabichat-pki.sh -o /tmp/tabichat/pki -c 90 \
#            lead-agent worker1 worker2 worker3 worker4 worker5 worker6 worker7 assistant relay \
#            records merge-seat archive standby dust   # YOUR OWN nicks go here — this is a
#            site value, it MUST BE CONFIGURED; a roster from another venue mints nothing useful.
# EXPIRY IS A FEATURE: client certs are short-lived (90 days by default, the design row's step 8)
# so revocation is a re-issue, not a ceremony. The CA is the long-lived thing and its key belongs
# on the owner's desk, not in a repo or a lane's scratch dir.
#
# NO SECRET GOES TO STDOUT. The script prints PATHS, subjects, serials and expiry dates only.
# Private keys are written 0600 and their CONTENTS are never read, printed, copied or committed by
# this script — per the fleet law of 2026-10-18, key-file content is one designated lane's work alone; this
# script only ever names a path.
set -eu

OUT=""
DAYS_CLIENT=90
DAYS_SERVER=397
CA_DAYS=3650
ROOM="${TABICHAT_ROOM:-tabith}"

while getopts "o:c:s:h" opt; do
  case "$opt" in
    o) OUT="$OPTARG" ;;
    c) DAYS_CLIENT="$OPTARG" ;;
    s) DAYS_SERVER="$OPTARG" ;;
    h) echo "usage: $0 -o <outdir> [-c client_days] [-s server_days] <nick...>" >&2; exit 0 ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))

[ -n "$OUT" ] || { echo "error: -o <outdir> is required (nothing is written to a default path)" >&2; exit 2; }
[ "$#" -ge 1 ] || { echo "error: no nicks given — a client certificate is minted PER NICK" >&2; exit 2; }

for n in "$@"; do
  case "$n" in
    *[!a-zA-Z0-9_-]*) echo "error: nick '$n' is not topic-leaf safe [A-Za-z0-9_-]" >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null || { echo "error: openssl not found" >&2; exit 127; }

CA_DIR="$OUT/ca"
SRV_DIR="$OUT/server"
CLI_DIR="$OUT/clients"
ACL_OUT="$OUT/acl-generated.conf"
mkdir -p "$CA_DIR" "$SRV_DIR" "$CLI_DIR"

# Refuse to overwrite a CA silently: rotating the CA is a fleet-wide restart event, and a re-run
# that quietly replaces it leaves every pinned client unable to connect.
if [ -f "$CA_DIR/ca.key" ]; then
  echo "error: $CA_DIR/ca.key already exists. A CA re-mint invalidates every pinned client:" >&2
  echo "       remove $OUT on purpose, or use a new -o directory and re-issue every leaf." >&2
  exit 1
fi

echo "== CA (long-lived; the key never leaves this box) =="
# The CA has to be a CA in the X.509 sense. A self-signed `req -x509` alone does NOT set CA:TRUE,
# and mosquitto will not build a chain to a plain end-entity certificate, so the CSR + explicit
# extension file is the only correct form here.
cat > "$CA_DIR/ca.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
[dn]
[ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
CNF
openssl genrsa -out "$CA_DIR/ca.key" 4096 2>/dev/null
chmod 600 "$CA_DIR/ca.key"
openssl req -x509 -new -key "$CA_DIR/ca.key" -sha256 -days "$CA_DAYS" -nodes \
  -config "$CA_DIR/ca.cnf" -extensions ext -subj "/CN=tabichat-ca" -out "$CA_DIR/ca.crt"
openssl x509 -in "$CA_DIR/ca.crt" -noout -subject -dates | sed 's/^/   /'
echo "   CA basicConstraints: $(openssl x509 -in "$CA_DIR/ca.crt" -noout -text | grep -A1 'Basic Constraints' | tail -1 | tr -d ' ')"

echo "== broker leaf (clients pin the CA, not this leaf) =="
openssl genrsa -out "$SRV_DIR/leaf.key" 2048 2>/dev/null
chmod 600 "$SRV_DIR/leaf.key"
openssl req -new -key "$SRV_DIR/leaf.key" -subj "/CN=tabichat-broker" -out "$SRV_DIR/leaf.csr"
# HOSTS is the only operator edit a mint needs: SANs are what a pinning client checks, and a bare
# CN is not a SAN. This repo is SITE-AGNOSTIC, so the default names only
# loopback — for a fixture. A real broker's own hostname comes in through MQTT_SERVER_SAN, set by
# whoever installs it, and a client then connects BY THAT NAME. An IP in a cert is a dated fact.
SAN="${MQTT_SERVER_SAN:-DNS:localhost,IP:127.0.0.1}"
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$SAN" > "$SRV_DIR/leaf.cnf"
openssl x509 -req -in "$SRV_DIR/leaf.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
  -CAcreateserial -days "$DAYS_SERVER" -sha256 -extfile "$SRV_DIR/leaf.cnf" -out "$SRV_DIR/leaf.crt" 2>/dev/null
rm -f "$SRV_DIR/leaf.csr"
echo "   server SAN: $SAN"

echo "== client leaves, one per nick =="
# THE SUBJECT FORM IS A MEASURED CHOICE, NOT A STYLE ONE. mosquitto's
# `use_subject_as_username true` takes the ENTIRE subject DN as the username, in its own RDN order:
# measured on the loopback fixture, a /CN=worker1 subject arrived as `CN=worker1`, while a
# /CN=lead-agent/O=tabith subject arrived as `O=tabith,CN=lead-agent` — the second RDN moved to the FRONT.
# So a second RDN would put a comma and a reordered string into every ACL `user` line, and a `user`
# line that does not match the username the broker computes refuses that lane's every write,
# silently. ONE RDN, `CN=<nick>`, and nothing else, is the only form whose username you can predict
# from the launch sheet. (The design row's `tls_use_subject CN=%s` is not a mosquitto option at all:
# the loopback broker rejects it with "Unknown configuration variable 'tls_use_subject'" — the real
# option name is `use_subject_as_username`, a boolean. See docs/broker/tabichat.conf.)
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n' > "$CLI_DIR/client.cnf"

# The ACL the broker will be given: shared read patterns first, then ONE block per nick.
{
  printf '# GENERATED by docs/broker/mint-tabichat-pki.sh — do not hand-edit a nick into it.\n'
  printf '# Room `%s`. A `user` line MUST name the username the broker computes from the client\n' "$ROOM"
  printf '# certificate DN, which with use_subject_as_username is the WHOLE subject: `CN=<nick>`.\n'
  printf '# This is phase 2 (shape B): a lane writes ONLY chat/%s/msg/<its own nick>.\n' "$ROOM"
  printf '# docs/broker/acl.conf carries the ordering law and what is still open.\n'
  printf '\npattern read chat/%s\n' "$ROOM"
  printf 'pattern read chat/%s/msg/+\n' "$ROOM"
  printf 'pattern read chat/%s/hist/+\n' "$ROOM"
  printf 'pattern read chat/%s/presence/+\n' "$ROOM"
  printf 'pattern read chat/%s/_ctl/#\n' "$ROOM"
} > "$ACL_OUT"

for n in "$@"; do
  d="$CLI_DIR/$n"
  mkdir -p "$d"
  openssl genrsa -out "$d/key.pem" 2048 2>/dev/null
  chmod 600 "$d/key.pem"
  openssl req -new -key "$d/key.pem" -subj "/CN=$n" -out "$d/csr.pem"
  openssl x509 -req -in "$d/csr.pem" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
    -CAcreateserial -days "$DAYS_CLIENT" -sha256 -extfile "$CLI_DIR/client.cnf" -out "$d/cert.pem" 2>/dev/null
  rm -f "$d/csr.pem"
  printf '   %-12s subject=CN=%-11s broker-user=CN=%-11s expires %s\n' "$n" "$n" "$n" \
    "$(openssl x509 -in "$d/cert.pem" -noout -enddate | cut -d= -f2)"
  {
    printf '\nuser CN=%s\n' "$n"
    printf 'topic readwrite chat/%s/msg/%s\n' "$ROOM" "$n"
    printf 'topic readwrite chat/%s/hist/%s\n' "$ROOM" "$n"
    printf 'topic readwrite chat/%s/presence/%s\n' "$ROOM" "$n"
    printf 'topic readwrite chat/%s/_ctl\n' "$ROOM"
    # shape (ii), per tabichat#10: receipts and lane-admin
    # answers are written UNDER THE ACKNOWLEDGING NICK (`_ctl/<nick>/<id>`,
    # `_ctl/admin/<nick>/<id>`), so this one narrow line is what closes the forgery. The parent grant
    # above stays (a lane still posts control requests on the flat `_ctl`), the subtree READ at :138
    # stays (that is why the read side never had to change), and NOTHING here grants `_ctl/#` write —
    # which is precisely what `acl-phase1.conf` does today and what made a peer's receipt forgeable.
    # Measured both ways on the loopback broker: own leaf delivered, foreign leaf refused
    # (src/tools/test_ack_watch_broker.ts).
    printf 'topic write chat/%s/_ctl/%s/#\n' "$ROOM" "$n"
  } >> "$ACL_OUT"
done

echo
echo "== output (paths only; keys are 0600 and their contents were never read or printed) =="
find "$OUT" -type f | sort | sed 's/^/   /'
echo
echo "Next steps are the OWNER's, not a lane's:"
echo "   1. copy $CA_DIR/ca.crt to every client host, and $CLI_DIR/<nick>/{cert,key}.pem into"
echo "      a 0700 per-lane dir (suggested: ~/.tabichat/<nick>/)"
echo "   2. copy $SRV_DIR/leaf.crt, $SRV_DIR/leaf.key, $CA_DIR/ca.crt to the broker host under"
echo "      /etc/mosquitto/certs/ (names per docs/broker/tabichat.conf), and $ACL_OUT to"
echo "      /etc/mosquitto/acl.conf"
echo "   3. apply docs/broker/tabichat.conf on a SECOND port first, prove every client reaches it,"
echo "      then delete 1883"
echo "   4. export for each lane: MQTT_URL, MQTT_TLS_CAFILE, MQTT_TLS_CERTFILE, MQTT_TLS_KEYFILE"
echo "      — all PATHS, no secret values, so the launch sheet stays safe to paste around"
