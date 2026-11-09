#!/bin/sh
# mint-tabichat-pki.sh — mint the tabichat PKI: one CA, one broker leaf, one client leaf per nick,
# and the per-nick broker ACL that goes with them.
#
# WHAT THIS IS AND WHAT IT IS NOT. It is the REVIEWED ARTIFACT that features/
# tabichat-mqtt-broker-auth.md asks for as phase 1's key material. It WRITES FILES INTO A
# DIRECTORY YOU NAME. It never touches a broker, never edits /etc/mosquitto, never restarts
# anything, and never contacts a live broker. Installing the output onto a broker host is the
# OWNER'S act, not a lane's: what is released on a branch is the implementation, and the broker stays
# untouched by any lane.
#
# WHY A DEDICATED CA, NOT THE VENYA CORE CA: a chat harness must not share trust material with
# the product's CA-trust roots. That is the #536 (pinned-CA-only) / #541 (refuse loudly, no
# rewrap) / #538 (split) boundary, and it is a rule this fleet has ruled too hard to let a
# dev-harness key hang off the core CA. There is deliberately NO option here that points at the
# core CA.
#
# WHY CERTIFICATES AND NOT A SHARED PASSWORD: with mTLS the launch sheet and tabichat-aliases.sh
# carry PATHS. A password scheme puts a secret into the file that gets pasted around, and the
# recorded lesson is that a launch line silently lies about its effective values.
#
#   usage: sh mint-tabichat-pki.sh -o <outdir> [-c client_days] [-s server_days] [nick...]
#   usage: sh mint-tabichat-pki.sh -o <outdir> add-nick [nick...]   # one leaf AND its ACL block
#   usage: sh mint-tabichat-pki.sh -o <outdir> add-leaf [nick...]   # one leaf ONLY
#          The two `add` paths sign against the CA ALREADY in <outdir> and never create or re-issue
#          one — that is how a nick joins a live PKI, and how a leaf is renewed when it expires.
#          Options come BEFORE the subcommand.
#   e.g.   sh mint-tabichat-pki.sh -o /root/tabichat-pki add-nick dust
#          sh mint-tabichat-pki.sh -o /tmp/tabichat/pki -c 90 wren ultra clerk courier
#
# WHERE THE NICKS COME FROM, and which wins. With no nicks on the command line the list is read from
# the tracked roster `docs/broker/roster.txt` (override the path with TABICHAT_ROSTER). PASSING NICKS
# ON THE COMMAND LINE OVERRIDES THE ROSTER — an explicit run uses ONLY its own arguments and the
# roster is not merged in. The script names the source and the count on every run, because a silently
# ignored argument is how a mint mints the wrong set. The nick list is still a site value: a roster
# from another venue mints nothing useful.
#
# NON-SEAT GRANTS come from `docs/broker/acl-supplementary.conf` (override with
# TABICHAT_ACL_SUPPLEMENT), appended to the generated ACL VERBATIM with a provenance comment naming
# the file. A line hand-added into the installed /etc/mosquitto/acl.conf is deleted by the next
# regeneration, so an identity that is not a chat seat has no durable home until this file exists.
#
# EXPIRY IS A FEATURE: client certs are short-lived (90 days by default, the design row's step 8)
# so revocation is a re-issue, not a ceremony. The CA is the long-lived thing and its key belongs
# on the owner's desk, not in a repo or a lane's scratch dir.
#
# NO SECRET GOES TO STDOUT. The script prints PATHS, subjects, serials and expiry dates only.
# Private keys are written 0600 and their CONTENTS are never read, printed, copied or committed by
# this script: key-file content is one designated lane's work alone, and this script only ever names
# a path.
set -eu

OUT=""
DAYS_CLIENT=90
DAYS_SERVER=397
CA_DAYS=3650
ROOM="${TABICHAT_ROOM:-tabith}"
MODE=mint
# The two tracked inputs, resolved next to THIS script so a mint run from a checkout needs no cwd
# dance. A site that keeps its roster elsewhere names it with the env var; that is the only reason
# the variables are settable.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROSTER="${TABICHAT_ROSTER:-$SCRIPT_DIR/roster.txt}"
SUPPLEMENT="${TABICHAT_ACL_SUPPLEMENT:-$SCRIPT_DIR/acl-supplementary.conf}"

while getopts "o:c:s:h" opt; do
  case "$opt" in
    o) OUT="$OPTARG" ;;
    c) DAYS_CLIENT="$OPTARG" ;;
    s) DAYS_SERVER="$OPTARG" ;;
    h) echo "usage: $0 -o <outdir> [-c client_days] [-s server_days] [nick...]" >&2
       echo "       $0 -o <outdir> add-nick [nick...]   # leaf + ACL block, against the CA in <outdir>"
       echo "       $0 -o <outdir> add-leaf [nick...]   # leaf only: its ACL comes from the include file"
       echo "       no nicks given -> the roster at $ROSTER is used; command-line nicks override it"
       exit 0 ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))

[ -n "$OUT" ] || { echo "error: -o <outdir> is required (nothing is written to a default path)" >&2; exit 2; }

# The subcommand is one word, checked before anything else, and it is the ONLY way an existing CA is
# used: the guard further down still refuses a whole mint over a live ca.key.
case "${1:-}" in
  add-nick|add-leaf) MODE="$1"; shift ;;
esac

if [ "$#" -ge 1 ]; then
  echo "nicks: $# from the command line — the roster at $ROSTER is NOT merged in (an explicit list wins)"
elif [ -f "$ROSTER" ]; then
  # One nick per line; blank lines and `#` comments are dropped. `set -f` is not decoration: without
  # it a garbage roster line containing a glob character would expand into file names and those would
  # be minted as nicks.
  set -f
  for r in $(sed -e 's/#.*//' "$ROSTER" | tr -d ' \t\r' | grep -v '^$'); do set -- "$@" "$r"; done
  set +f
  [ "$#" -ge 1 ] || { echo "error: roster $ROSTER holds no nicks" >&2; exit 2; }
  echo "nicks: $# from the tracked roster $ROSTER"
else
  echo "error: no nicks given, and no roster at $ROSTER — pass the nicks or set TABICHAT_ROSTER" >&2
  exit 2
fi

for n in "$@"; do
  case "$n" in
    # An empty nick is the alteration this guard exists for: topicLeaf("") is "", so a blank line
    # would mint `subject=CN=` and emit `user CN=`, a grant matching a username no client can present.
    '') echo "error: sender-acl-inert — an empty nick has no topic-leaf-safe form; the client sanitises it to nothing and the per-sender ACL silently does not apply" >&2; exit 2 ;;
    *[!a-zA-Z0-9_-]*) echo "error: sender-acl-inert — nick '$n' has no topic-leaf-safe form [A-Za-z0-9_-]; the client sanitises it to a different leaf and the per-sender ACL silently does not apply" >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null || { echo "error: openssl not found" >&2; exit 127; }

# ---------------------------------------------------------------- the shared forms, one place each
# Every path below — the whole mint, add-nick, add-leaf — writes a leaf and an ACL block with THESE
# functions, so a nick added to a live PKI is byte-for-byte the same identity as one minted at the
# start. Two subject shapes or two extension blocks in one script is how a renewal stops matching the
# grant it renews.

# The client extension block. `extendedKeyUsage=clientAuth` and nothing else; the server leaf has its
# own file, and neither is invented a second time.
client_cnf() {
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n'
}

# THE SUBJECT FORM IS A MEASURED CHOICE, NOT A STYLE ONE. mosquitto's
# `use_subject_as_username true` takes the ENTIRE subject DN as the username, in its own RDN order:
# measured on the loopback fixture, a /CN=worker1 subject arrived as `CN=worker1`, while a
# /CN=lead-agent/O=tabith subject arrived as `O=tabith,CN=lead-agent` — the second RDN moved to the FRONT.
# So a second RDN would put a comma and a reordered string into every ACL `user` line, and a `user`
# line that does not match the username the broker computes refuses that lane's every write, silently.
# ONE RDN, `CN=<nick>`, and nothing else, is the only form whose username you can predict from the
# launch sheet. (The design row's `tls_use_subject CN=%s` is not a mosquitto option at all: the
# loopback broker rejects it with "Unknown configuration variable 'tls_use_subject'" — the real option
# name is `use_subject_as_username`, a boolean. See docs/broker/tabichat.conf.)
mint_leaf() {
  d="$CLI_DIR/$1"
  mkdir -p "$d"
  openssl genrsa -out "$d/key.pem" 2048 2>/dev/null
  chmod 600 "$d/key.pem"
  openssl req -new -key "$d/key.pem" -subj "/CN=$1" -out "$d/csr.pem"
  openssl x509 -req -in "$d/csr.pem" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
    -CAcreateserial -days "$DAYS_CLIENT" -sha256 -extfile "$CLI_DIR/client.cnf" -out "$d/cert.pem" 2>/dev/null
  rm -f "$d/csr.pem"
  printf '   %-12s subject=CN=%-11s broker-user=CN=%-11s expires %s\n' "$1" "$1" "$1" \
    "$(openssl x509 -in "$d/cert.pem" -noout -enddate | cut -d= -f2)"
}

# The per-nick ACL block, written once into the header-and-blocks file. Shape (ii), per tabichat#10:
# receipts and lane-admin answers are written UNDER THE ACKNOWLEDGING NICK (`_ctl/<nick>/<id>`,
# `_ctl/admin/<nick>/<id>`), so this one narrow line is what closes the forgery. The parent grant
# stays (a lane still posts control requests on the flat `_ctl`), the subtree READ stays, and NOTHING
# here grants `_ctl/#` write — which is precisely what `acl-phase1.conf` does today and what made a
# peer's receipt forgeable. Measured both ways on the loopback broker: own leaf delivered, foreign
# leaf refused (src/tools/test_ack_watch_broker.ts).
# NOTE what this block is NOT: it is a SEAT's block. A non-seat identity (the drain `operator`) gets
# no part of it — its grants come from the supplementary include, scoped by design.
nick_block() {
  printf '\nuser CN=%s\n' "$1"
  printf 'topic readwrite chat/%s/msg/%s\n' "$ROOM" "$1"
  printf 'topic readwrite chat/%s/hist/%s\n' "$ROOM" "$1"
  printf 'topic readwrite chat/%s/presence/%s\n' "$ROOM" "$1"
  printf 'topic readwrite chat/%s/_ctl\n' "$ROOM"
  printf 'topic write chat/%s/_ctl/%s/#\n' "$ROOM" "$1"
}

acl_header() {
  printf '# GENERATED by docs/broker/mint-tabichat-pki.sh — do not hand-edit a nick into it.\n'
  printf '# A nick belongs in docs/broker/roster.txt; a non-seat grant belongs in\n'
  printf '# docs/broker/acl-supplementary.conf. Both are read by that script on every run, and\n'
  printf '# anything added here by hand is gone at the next regeneration.\n'
  printf '# Room `%s`. A `user` line MUST name the username the broker computes from the client\n' "$ROOM"
  printf '# certificate DN, which with use_subject_as_username is the WHOLE subject: `CN=<nick>`.\n'
  printf '# This is phase 2 (shape B): a lane writes ONLY chat/%s/msg/<its own nick>.\n' "$ROOM"
  printf '# docs/broker/acl.conf carries the ordering law and what is still open.\n'
  printf '\npattern read chat/%s\n' "$ROOM"
  printf 'pattern read chat/%s/msg/+\n' "$ROOM"
  printf 'pattern read chat/%s/hist/+\n' "$ROOM"
  printf 'pattern read chat/%s/presence/+\n' "$ROOM"
  printf 'pattern read chat/%s/_ctl/#\n' "$ROOM"
}

# The include is verbatim on purpose: this script does not interpret an ACL, and a line it had to
# understand could not carry a pattern it has never heard of. It is also VISIBLE — the path and the
# line count are printed, so "the operator grant came from nowhere" is not a state this tool can
# produce.
append_supplement() {
  if [ -f "$SUPPLEMENT" ]; then
    supp_lines=$(grep -c '' "$SUPPLEMENT" || true)   # `|| true`: an EMPTY file makes grep -c exit 1, and
    # under set -e that would kill the mint mid-run with no message at all — silence is the failure
    # class this whole file exists to close.
    {
      printf '\n# SUPPLEMENTARY INCLUDE, appended verbatim from %s\n' "$SUPPLEMENT"
      printf '# Non-seat grants live in that tracked file, never hand-added into this generated one.\n'
      cat "$SUPPLEMENT"
    } >> "$ACL_OUT"
    echo "   supplementary include: $SUPPLEMENT — $supp_lines line(s) appended verbatim"
  else
    echo "   supplementary include: none ($SUPPLEMENT does not exist)"
  fi
}

require_existing_ca() {
  # The whole-mint guard above refuses an existing ca.key; this is its mirror, and the two together are
  # the whole rule: a CA is created once, by hand, on purpose, and everything after that is a signature.
  if [ ! -f "$CA_DIR/ca.key" ] || [ ! -f "$CA_DIR/ca.crt" ]; then
    echo "error: $MODE signs against a CA that must already be in $CA_DIR — ca.key and ca.crt are not both there." >&2
    echo "       A new CA is a whole mint into a new -o directory, never a side effect of adding a nick." >&2
    exit 1
  fi
}

ensure_client_cnf() {
  [ -f "$CLI_DIR/client.cnf" ] || { mkdir -p "$CLI_DIR"; client_cnf > "$CLI_DIR/client.cnf"; }
}

CA_DIR="$OUT/ca"
SRV_DIR="$OUT/server"
CLI_DIR="$OUT/clients"
ACL_OUT="$OUT/acl-generated.conf"
mkdir -p "$CA_DIR" "$SRV_DIR" "$CLI_DIR"

# ---------------------------------------------------------------- add-nick / add-leaf: an existing CA
# These paths run first and leave, so nothing below them can be reached by accident: they sign, and a
# signature is all that a live CA is ever asked to do.
if [ "$MODE" != mint ]; then
  require_existing_ca
  ensure_client_cnf
  echo "== $MODE: leaves signed against the CA already in $CA_DIR (the CA is not created or re-issued) =="
  [ -f "$ACL_OUT" ] || acl_header > "$ACL_OUT"
  # The include is applied whether this ACL file is brand new or already in use. Why that matters: an
  # operator who has been hand-adding grants to the installed copy has a generated file that never
  # carried them, and adding one nick to that file is exactly the run that should fix it. The marker is
  # matched on the file this run reads, so a changed include path re-applies rather than being hidden by
  # a line an earlier run wrote from a different file.
  grep -qF "# SUPPLEMENTARY INCLUDE, appended verbatim from $SUPPLEMENT" "$ACL_OUT" || append_supplement
  for n in "$@"; do
    mint_leaf "$n"
    if [ "$MODE" = add-leaf ]; then
      echo "   $n: no ACL block written — a non-seat identity is granted in $SUPPLEMENT"
      continue
    fi
    if grep -q "^user CN=$n\$" "$ACL_OUT"; then
      echo "   $n: leaf re-issued; its ACL block was already in $ACL_OUT, so none was duplicated"
    else
      nick_block "$n" >> "$ACL_OUT"
      echo "   $n: ACL block appended to $ACL_OUT"
    fi
  done
  echo
  echo "== output (paths only; keys are 0600 and their contents were never read or printed) =="
  find "$OUT" -type f | sort | sed 's/^/   /'
  echo
  echo "Installing anything from this directory onto a broker is the operator's act, not a lane's."
  exit 0
fi

# Refuse to overwrite a CA silently: rotating the CA is a fleet-wide restart event, and a re-run
# that quietly replaces it leaves every pinned client unable to connect. This guard is NOT a defect
# and is not relaxed by the paths above: a whole mint over a live CA still refuses, exit 1.
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
# The subject form and the extension block are mint_leaf()/client_cnf() above — ONE form, shared with
# the add paths, because a renewed leaf that does not match the minted one is a second identity.
client_cnf > "$CLI_DIR/client.cnf"

# The ACL the broker will be given: shared read patterns first, then ONE block per nick.
acl_header > "$ACL_OUT"

for n in "$@"; do
  mint_leaf "$n"
  nick_block "$n" >> "$ACL_OUT"
done

# ...then the non-seat grants, so the file the broker is handed is COMPLETE on its own and a
# regeneration cannot delete an identity it was never told about.
echo "== supplementary include =="
append_supplement

echo
echo "== output (paths only; keys are 0600 and their contents were never read or printed) =="
find "$OUT" -type f | sort | sed 's/^/   /'
echo
echo "Next steps are the OWNER's, not a lane's:"
echo "   1. copy $CA_DIR/ca.crt to every client host, and $CLI_DIR/<nick>/{cert,key}.pem into"
echo "      a 0700 per-lane dir (suggested: ~/.tabichat/<nick>/)"
echo "   2. copy $SRV_DIR/leaf.crt, $SRV_DIR/leaf.key, $CA_DIR/ca.crt to the broker host under"
echo "      /etc/mosquitto/certs/ (names per docs/broker/tabichat.conf). For $ACL_OUT there is no"
echo "      destination to print here: read the acl_file name off the broker's own config (grep -rn"
echo "      acl_file in its conf.d), then run the enumerate-and-diff in docs/broker/README.md before"
echo "      anything is copied — a non-empty identity diff is a STOP."
echo "   3. apply docs/broker/tabichat.conf on a SECOND port first, prove every client reaches it,"
echo "      then delete 1883"
echo "   4. export for each lane: MQTT_URL, MQTT_TLS_CAFILE, MQTT_TLS_CERTFILE, MQTT_TLS_KEYFILE"
echo "      — all PATHS, no secret values, so the launch sheet stays safe to paste around"
