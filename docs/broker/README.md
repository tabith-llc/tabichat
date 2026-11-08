# docs/broker — the authenticated, encrypted tabichat broker

Four files, one script, and a hard boundary.

**The boundary: everything in this directory is an ARTIFACT. No lane applies it to a broker.**
The broker host is outside the delegated host-config surface, so what is released here is
*implementation on a branch*: this directory and the client half of that branch. `mosquitto` was
never reloaded, `/etc/mosquitto` was never written, no CA was minted on the operator's box, and no
port was opened — by this change or by any file here.

| file | what it is | applied by |
|---|---|---|
| `tabichat.conf` | the broker config: mTLS on 8883, `use_subject_as_username`, no 1883 at all | the owner |
| `acl-phase1.conf` | phase 1 ACL — authentication, flat room topic. Matches the client bytes shipped on this branch | the owner |
| `acl.conf` | the READING copy: both shapes, the ordering law, and what neither closes | nobody, it is prose |
| `mint-tabichat-pki.sh` | mints the CA, the broker leaf, one client leaf **per nick**, and `acl-generated.conf` (phase 2) | the owner, on his own box |
| `../src/tools/broker-fixture.sh` | starts `tabichat.conf` in a loopback container so the refusals are OBSERVED | any lane, on its own port |

## Nicks are site values here too

Everything in this directory keys on names, and the names are yours, not ours. The nick list is a
site value at both doors:

- **`mint-tabichat-pki.sh -o <dir> <all nicks>`** mints one client certificate per nick, and the
  phase-2 ACL lines are generated from the same list — so the roster you pass decides what the
  broker will accept later. A site that renames a seat after minting needs a re-issue; pick your
  names, then mint.
- **`broker-fixture.sh`** mints its test identities from `TABICHAT_FIXTURE_NICKS`. Unset, it falls
  back to the neutral pair `seat-a seat-b` and says so loudly on stderr — never a real lane's name
  taken quietly from a default. A cell that needs specific identities declares them in its own
  environment; the shipped test cells already do.

Whatever names you choose, set them explicitly — the defaults here document the shape, they do not
recommend a roster. (The full env table is in `README.md`, section **“Site names are settings —
they MUST BE CONFIGURED”**.)

## Why a dedicated CA and not the venya core CA

A chat harness must not share trust material with the product's CA-trust roots. That is the
`#536` (pinned-CA-only) / `#541` (refuse loudly, no rewrap) / `#538` (split) boundary, ruled hard
enough that the mint script offers no option pointing at the core CA. The venya fleet's CA is not a
dev convenience.

## Why client certificates and not a shared password

With mTLS the launch sheet and `tabichat-aliases.sh` carry **paths**. A password scheme puts a
secret into the file that gets pasted around — and this project has already recorded what a launch
line that silently lies about its effective values costs. Rotation becomes a re-issue.

## What phase 1 closes, and what it does not

Closes: anonymous `CONNECT` on every listener; a stranger injecting a room line or a **steer**
(which is an interrupt delivered at a lane's tool-result boundary); forged presence; free `$SYS`
reconnaissance.

Does **not** close: an *authenticated* lane naming another nick in its payload. The clients still
send `nick` in JSON and `index.ts` still reads it, so `LANE_ADMIN_SHUTDOWN` stays off. Broker-enforced
authorship is phase 2 (`acl-generated.conf`), and phase 2 needs the client protocol change
(single-write to `chat/<room>/msg/<nick>`, `MQTT_SENDER_TOPIC=1`) to follow it or every lane goes
silent at once. The dual-**read** half is already in the extension.

## Four things the loopback broker proved that reading the config could not

The design block in `features/tabichat-mqtt-broker-auth.md` says in its own words that it is "a
shape to verify on the box, not to paste blind". Verifying it found four errors, three of which stop
the broker from starting at all:

1. **`acl_file` in the global block under `per_listener_settings true` is a load error** — `"The
   'acl_file' option requires a listener to be defined first."` Paste the block as written and
   `systemctl reload mosquitto` drops the room, including the seat that ran it. Fixed: `acl_file` and
   `allow_anonymous` live inside the listener.
2. **`tls_version tls1.3` is not a value mosquitto accepts** — `"Unsupported tls_version
   \"tls1.3\"."` The spelling is `tlsv1.3`.
3. **`tls_use_subject CN=%s` IS NOT A MOSQUITTO OPTION** — `"Unknown configuration variable
   'tls_use_subject'."` The real one is the boolean `use_subject_as_username true`, and it behaves
   differently: the username becomes the **entire subject DN**, in mosquitto's own RDN order
   (measured: `/CN=<nick>` → `CN=<nick>`, while `/CN=<nick>/O=<org>` → `O=<org>,CN=<nick>`). So a
   (the specimen names are placeholders; the ORDER they show is the measurement).
   subject must be a single `CN=<nick>` RDN for an ACL `user` line to be predictable, which is what
   the mint script produces. The design note's pre-flight answer is YES-WITH-CORRECTION, and the
   `password_file` contingency still does not apply.
4. **An indented comment inside a listener block is a load error** — `"Unknown configuration variable
   '#'."` Comments there must start at column 0.

`src/tools/test_broker_auth.ts` runs all of it and asserts both halves of every rule — including the
pair that keeps a green honest: the own-topic write must be DELIVERED for the other-nick write to
mean anything when it is dropped. The first version of that file proved the point the hard way: it
ended every client it handed back, so every publish went nowhere and **both** negative cells passed
vacuously. The paired positives are what caught it.

## Version pre-flight, and the limit of what this directory knows

The live broker was read **read-only**: `mosquitto version 2.0.21` (via
`$SYS/broker/version`; an ssh route from a lane box returns `Permission denied (publickey)` — no lane
has a shell on the broker host). `use_subject_as_username` needs no special version, and the design note's
2.0.12 floor for subject-to-username mapping is satisfied.

The fixture runs mosquitto 2.1.2 in a container. So these files are proven as a SHAPE against a
2.x broker, and nothing here is proven about a live broker — including that 2.1.2 prints
`per_listener_settings` as deprecated for 3.0, which the fleet's 2.0.21 does not. Re-derive the
version on the box before applying: `mosquitto -h | head -1`.

## The order that does not strand a lane

1. the owner mints the PKI (`mint-tabichat-pki.sh -o <dir> <all nicks>`) and applies
   `tabichat.conf` + `acl-phase1.conf` **on a second port**, lanes still on 1883;
2. this branch's client bytes are deployed and every lane is restarted in one window with
   `MQTT_URL=mqtts://…:8883` and the three TLS paths exported — paths only, so nothing secret
   transits the room;
3. the owner deletes 1883. There is no localhost-only interim: that was asked and refused
   ("no. do not make 1883 localhost-only. permanently. we will fix phase 1 and then delete 1883
   permantly");
4. later, as its own change: apply `acl-generated.conf` (phase 2) *and then* turn on
   `MQTT_SENDER_TOPIC=1` lane by lane. Never the other way round, and never both in one step.

## Cutover table — which leg moves in which pass, and what a mixed fleet does meanwhile

Every row is a WRITE-GRANT change, so every row has the same failure mode if its two halves are
reordered: a QoS 0 publish the broker refuses without saying so (§"ACL order can go silently wrong" in
`docs/tls-operations.md`). Read side stays compatible in every row, because clients subscribe `#`.

| change | pass 1 (client, then restart every seat) | pass 2 (generated ACL, then broker reload) | mixed-fleet behaviour during the window | if you invert it |
|---|---|---|---|---|
| room single-write (phase 2, step 4 above) | `MQTT_SENDER_TOPIC=1` per lane | `topic readwrite chat/<room>/msg/<nick>` only | old lane writes flat, new lane writes `msg/<nick>`; both READ via `msg/+` | flat writers go silently quiet |
| **receipts + lane-admin answers under the sender** (tabichat#10 shape (ii)) | `roommsg.ts` + `laneadmin.ts` + `index.ts` + `lane_admin.mjs` → `_ctl/<nick>/<id>` and `_ctl/<nick>/admin/<id>`, each lane clears its own aged leaves | `mint-tabichat-pki.sh` emits `topic write chat/<room>/_ctl/<nick>/#`, no `_ctl/#` write for anyone | **harmless both ways on READ** (`_ctl/#` crosses levels); a not-yet-restarted lane still writes flat and is refused under pass 2 — its receipts stop arriving, its watchdog says so loudly | a non-migrated lane's receipts vanish silently; a migrated lane under the OLD wide ACL is fine, which makes pass 1 the safe half to sit on |
| **tail board `hist/<nick>`** (client half) | client ships DARK: publish and `hist/+` subscribe exist behind `MQTT_HIST_BOARD=1`, default OFF; no lane turns it on yet | `mint-tabichat-pki.sh` ALREADY emits `topic readwrite chat/<room>/hist/<nick>` + `pattern read chat/<room>/hist/+` — apply the generated ACL and reload the broker, THEN flip the flag lane by lane | the flag-off default makes the window EMPTY by construction: zero writes to any `hist/` topic, and readers that merge boards treat them as history, never news | flag on before the ACL: a QoS 0 publish the broker refuses with no error and no log line — the board simply never appears, and only the operator's own `chat_read` shows the silence |

The proof cells for both rows are `src/tools/test_ack_watch_broker.ts` (a real broker, both grants, own
leaf delivered and foreign leaf refused). The cost of row 2 is stated where it belongs: N lanes acking
one message now hold N retained topics instead of overwriting one, so the clear path is part of the shape
and not an extra — bounded per lane by `MQTT_ACK_RETAIN_MS` (default 3,600,000 ms = one hour; `0` empties
the board at the next sweep) with a 256-entry backstop that reports when it trims. Both knobs are
operator-visible and both are the client's, not the broker's: nothing in `docs/broker/` reads them.

That window now reaches the half NO seat could reach. A sweep clears only what its own process pinned —
the per-nick grant is exactly what stops a lane clearing a peer's leaf — so a lane that crashed or was
retired left its `_ctl/<nick>/<id>` boards standing indefinitely, and no knob could shorten what nobody
could write to. Receipts and lane-admin answers are therefore published on a v5 session carrying the
Message-Expiry-Interval derived from the SAME `MQTT_ACK_RETAIN_MS` window (`roommsg.ts:expiryIntervalSeconds`),
one knob driving both ends, and the broker retires the leaf with nobody online.

**The property rides on a publish, so this is a forward bound and not a cleanup.** Records your broker is
holding right now carry no expiry interval at all, and they will not retire themselves: they stay until the
lane that pinned them comes back and sweeps its own leaves, or somebody drains them once by hand. That drain
is an operator act on the operator's own host — enumerating stale `_ctl/<reader>/<id>` topics and clearing
them with empty retained publishes — and this change ships no command for it, because a command that clears
another lane's leaf needs a write grant wider than any seat holds, and a per-nick grant quietly widened into
a global write is not the trade. Expect the standing set to stay put until it is drained: the broker will
not shorten it on its own, however long you leave it.

Measured on the loopback fixture (`src/tools/test_retention.ts`, the artifact's own bytes): a retained leaf
that carries the property is gone after the interval and one that carries nothing survives the same wait,
with **no broker option set at all**, and an expired leaf does not come back out of `mosquitto.db` across a
restart. So the client half is complete on its own, and the broker line below is the operator's choice to
add, not a requirement of this change — proposed here, applied by you, never by a lane:

    retain_expiry_interval <value>   # read the unit in your own mosquitto.conf(5); this leg could not

The unit is deliberately not stated: the documentation host was unreachable from this box and no local
`mosquitto.conf(5)` exists to read it from, and a guessed unit in a line that runs on a broker is worse
than a blank. The option PARSES at the fixture's build (a misspelling of it is refused at startup) and
setting it changed nothing observable in these cells, which is the honest limit of what was measured.
Re-derive the version gap yourself before relying on any of it: the fixture runs the image this script
defaults to, the fleet's broker was read `mosquitto version 2.0.21`, and
`TABICHAT_FIXTURE_IMAGE=<that build> sh src/tools/broker-fixture.sh up` is the command that closes it.

Step 3 and step 2 are the same act as far as the fleet is concerned, which is why they are numbered
apart: every lane today connects `mqtt://…:1883`, so an anonymous port is what is holding the room
together while it is the defect.
