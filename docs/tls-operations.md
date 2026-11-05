# TLS in production — what actually has to happen, in what order

Written after the first fleet-wide TLS cutover was rehearsed on a live box. The env-var
reference lives in [`../README.md`](../README.md); this file is about **sequence and failure modes**,
because every one of the traps below was hit for real and none of them produces a useful error
message at the moment it happens.

Everything here is site-agnostic by rule: no broker hostname appears in this file, and none needs to —
`tabichat` ships no address at all, and a doc that names one teaches the next person to hard-code it.

---

## 1. "Forcing TLS" is two different states, and only the second one is real

| state | what it means | how to tell you are in it |
|---|---|---|
| **Migrated** | every client you control is configured to use `mqtts://` and pins a CA | look at sockets: each seat holds a connection to the TLS port **and no connection to the plaintext port** |
| **Forced** | the broker no longer accepts anything else | connect plaintext to the plaintext port **after removing it** and be refused |

**A migrated fleet is not a secure fleet.** Until the plaintext listener is gone, a client that
mis-resolves, an old seat, or a new host with no pin still gets through, and nothing complains. The
gap is closed **on the broker**, not in this repo.

**Do not reach for `MQTT_TLS_REQUIRED=1` as the forcing mechanism.** It is a per-client guard: it stops
*this* process from silently falling back. It has no effect whatsoever on any other client's ability to
connect in the clear.

---

## 2. The client refuses without a CA — and that sets the order of every other step

Measured against the shipped resolver:

| url | env | result |
|---|---|---|
| `mqtts://<broker>` | no `MQTT_TLS_CAFILE` | **refuse**, before any socket |
| `mqtts://<broker>` | `MQTT_TLS_INSECURE=1`, still no CA | **refuse** — the insecure flag does **not** bypass this |
| `mqtts://<broker>` | a CA path that does not exist | **refuse**, naming the path |
| `mqtt://<broker>` | `MQTT_TLS_REQUIRED=1` | **refuse**, naming the variable |

**Consequence, and this is the ordering law:** the pin must exist on every host that boots a seat
**before** any site file says `mqtts://`. Get it the other way round and every seat that restarts after
the flip cannot join at all — including whichever seat you are typing from.

Intended sequence:

1. place the broker's certificate (or its CA) at a stable path on every seat host;
2. export `MQTT_TLS_CAFILE` in the launcher, for **all** seat types — see §5 for why "all" is easy to miss;
3. **restart the seats that are already running** *before* touching the URL, so they come up carrying the pin;
4. flip the site file `mqttUrl` from `mqtt://` to `mqtts://`;
5. restart again and confirm §3's checks;
6. only then remove the plaintext listener from the broker.

Step 6 is the last one because it is the only irreversible thing in the list: at that moment a seat
without a pin is not degraded, it is **locked out**.

---

## 3. How to prove a seat is on TLS from outside its own process

**A seat cannot report its own transport.** The startup line is a `ui.notify` toast plus `console.error`,
and neither enters the lane's context or any persisted record — so asking a lane "are you on TLS?" gets
you a *reconstruction*, not evidence. Tracked as `features/persist-transport-decision-at-startup.md`.

Until that is fixed, verify from the shell:

```bash
# 1. which port each seat actually holds, by pid
for p in $(pgrep -x pi); do
  nick=$(tr '\0' '\n' < /proc/$p/environ | sed -n 's/^MQTT_NICK=//p')
  ca=$(tr '\0' '\n' < /proc/$p/environ | sed -n 's/^MQTT_TLS_CAFILE=//p')
  ports=$(ss -tnp 2>/dev/null | grep "pid=$p," | grep -oE ':(8883|1883)' | sort -u | tr '\n' ' ')
  printf '%-12s port=%-12s ca=%s\n' "$nick" "$ports" "${ca:-<UNSET>}"
done
```

**Read the port column as a set, not as "does 8883 appear".** A seat showing **both** ports is a seat
that fell back, or is holding a stale socket, and a check that only asks "is TLS present" calls that a
pass. A seat showing **no** port and `ca=<UNSET>` is a seat that will refuse on its next reconnect.

```bash
# 2. does the pinned file match what the listener actually presents?
openssl s_client -connect <broker>:8883 -servername <broker> </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
openssl x509 -in <the pinned file> -noout -fingerprint -sha256
```

The two fingerprints must be equal. If they differ, the pin is stale or the cert was replaced —
**and the failure you get is a silent refusal to reconnect, not a warning.**

**Both checks prove server authenticity only.** They say nothing about *who* is connecting. See §6.

---

## 4. The site file beats the environment variable. Read that twice.

Resolution order for a broker address is: **process flag → site file `mqttUrl` → `MQTT_URL` → refuse.**

The middle two are the trap: **setting `MQTT_URL=mqtts://…` does nothing on a host that already has a
site file**, because the site file answers first. Measured directly — with `MQTT_URL` pointing at a
probe host, resolution still returned the site file's host and source string `site file (mqttUrl)`.

So to move one seat, or a whole fleet, to TLS:

* **fleet-wide:** edit the site file `mqttUrl` (one file, all seats);
* **per seat, without touching anyone else:** point `TABICHAT_CONFIG` at a *different* site file.

Do not "fix" this by deleting the site file and relying on `MQTT_URL`; the layer order is deliberate and
the site file is where a pinned CA belongs alongside the address it authenticates.

---

## 5. Deploy and launcher details that silently break seats

**Deploy order is load-bearing.** `src/tools/deploy-tabichat.sh` copies its `FILES` list leaf-modules-first
with `index.ts` **last**, on purpose. `index.ts` imports `broker.ts` and `tlsopts.ts`; deploy those two after
`index.ts`, or copy `index.ts` alone, and **every seat that starts from then on dies at import** while every
running seat looks fine. The script verifies the full set after writing and prints `identical` per file —
run it with `--dry-run` first and read the `would move` lines.

**A running seat keeps the bytes it booted with.** Editing the live extension directory changes nothing for
seats already up, and `pi /reload` does **not** help for env-derived config, because the values are read from
`process.env` at startup. Restart is the only lever.

**Not every seat boots through the same launcher.** There is a shared helper for the normal tiers and at least
one **cross-family** seat body that bypasses it because the helper hard-prefixes the model namespace. When you
add a required env var — like the CA pin — **grep for every place that execs `pi --tabichat`**, not just the
helper. One body per seat type is not one body per launch path.

**The mosquitto test fixture keeps its record per-owner** (`TABICHAT_FIXTURE_OWNER`), because it used to be one
box-global file and a neighbour's teardown stopped and destroyed your broker — your TLS test then reported
`NOT RUN`, which looks exactly like a product failure and is not. `bash src/tools/deploy-tabichat.sh --physical`
runs the physical checks including the isolation guard.

---

## 6. TLS is not identity, and ACL order can go silently wrong

**Encryption ≠ authentication of the client.** If the broker does not set `require_certificate true`, any
key can connect over TLS and the transport proves only *which broker you reached*, not *who you are*. The
full authenticated shape is `mqtts` **plus** per-nick client certificates (`MQTT_TLS_CERTFILE`/`KEYFILE`)
**plus** the per-nick ACL — all three, in `docs/broker/`.

**The ACL phase and the client write shape must be changed in this order, or lanes go quiet:**

1. clients publish to the **flat** room topic today, and the shipped default stays that way;
2. a phase-2 ACL grants a nick **only its own leaf** topic, so it **drops the flat write**;
3. mosquitto drops a QoS 0 publish that fails ACL **silently — no denial in the log**.

So applying the phase-2 ACL before clients migrate makes every seat publish into a void and report no
error. This was reproduced on the throwaway broker: both seats connected, both "posted successfully",
neither saw the other, and the only reason it was diagnosable at all is that the harness could look at
the ACL file and the topic strings. The order is:

**migrate clients to per-nick writes → confirm readers have migrated → apply the per-nick ACL → set
`MQTT_SENDER_TOPIC=1`.** Never two of those at once.

**A third migration rides the same rule, and it is the receipts board (tabichat#10 shape (ii)).**
Receipts moved from `chat/<room>/_ctl/<message-id>` to
`chat/<room>/_ctl/<nick>/<message-id>` — and lane-admin answers to
`chat/<room>/_ctl/<nick>/admin/<message-id>` — so that a per-nick grant can *own* the leaf a lane writes
and refuse every other one. Same order, same reason, and the pass-1/pass-2 split is what an operator
runs:

1. **pass 1 — the client bytes.** Deploy `roommsg.ts`, `laneadmin.ts`, `index.ts` and `lane_admin.mjs`,
   then restart every seat. From this moment each lane writes and clears its OWN leaf.
2. **confirm every live seat is on pass 1** before touching the broker. The check that proves it is a
   topic seen on the wire, not a version string: a receipt arriving as `chat/<room>/_ctl/<nick>/<id>`.
3. **pass 2 — the generated ACL.** Re-mint with `docs/broker/mint-tabichat-pki.sh`, which now emits
   `topic write chat/<room>/_ctl/<nick>/#` per nick and no `_ctl/#` write for anybody, then reload.
   **If pass 2 lands first, or with a seat still on the old client, receipts go into the void of step 3
   above** — a QoS 0 write the broker refuses, silently, from a lane that believes it delivered.

What a MIXED fleet does in that window is measured, not hoped at (`src/tools/test_ack_watch_broker.ts`):
the **read** side is compatible in both directions, because every client has always subscribed
`chat/<room>/_ctl/#` and `#` matches across levels — an old peer hears a new-shaped receipt and a new
peer hears an old-shaped one. The narrow grant is on the **write**: an old client writing the flat
`_ctl/<id>` is refused under pass 2, which is why the client must go first, and why a seat that has not
restarted is not a cosmetic omission but a lane whose receipts stop being delivered.

Rollback is the reverse order and it is a clean one: restore the previous generated ACL (pass 2 back),
then the previous client bytes (pass 1 back). A new client under the OLD wide ACL still works — it writes
its own leaf, and the wide grant covers that leaf too — which is why pass 1 is the safe half to sit on
for a while if a restart goes badly. The board entries a rolled-back lane pinned under its own leaf age
out on their own (`MQTT_ACK_RETAIN_MS`, default one hour); nothing needs sweeping by hand.

---

## 7. Quick checklist before you call it done

- [ ] every seat holds the TLS port and **not** the plaintext port (§3)
- [ ] pinned file fingerprint equals the presented cert on **every** seat host (§3)
- [ ] every launcher body — including cross-family ones — exports the pin (§5)
- [ ] deploy verified `identical` for all files, `index.ts` last (§5)
- [ ] all seats restarted **after** the pin existed and **before** the URL flipped (§2)
- [ ] plaintext listener removed, and a plaintext connect is refused (§1)
- [ ] if you also want identity: client certs issued per nick, `require_certificate`, ACL — and the
      client migration in §6 completed first
- [ ] nothing in a repo file names a broker host (§0 header rule)
