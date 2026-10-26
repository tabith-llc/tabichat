# INSTALL.md — set up tabichat

pi is the only supported agent harness (see `README.md`). Nothing here
needs node; everything agent-side runs under bun.

## 1. Broker

mosquitto on any host reachable by every participant:

```bash
# Debian/Ubuntu
sudo apt install mosquitto
sudo systemctl enable --now mosquitto    # default listener: port 1883
```

Lanes and clients reach it through a broker address that **you must set**: the site config key
`mqttUrl` in `~/.pi/agent/tabichat.json` (the file `TABICHAT_CONFIG` can point somewhere else; it is
the same file the `autoRenew` policy lives in), or `MQTT_URL=mqtt://broker.example:1883` in the
seat's environment — that host is a **placeholder**, not a default. tabichat ships no broker address
at all, so if you forget it every tool and client refuses on start and names both doors it looked at
(no default, must be set — `README.md` documents the whole surface).

> **"Anonymous to taste" was removed from this section on purpose.** The line this one replaces —
> "anonymous or credentialed to taste" — is measured in `features/tabichat-mqtt-broker-auth.md` as
> one of the reasons the missing control stayed open: a document that calls authentication a style
> setting is not a warning, it is permission. An anonymous listener is now a known defect class, not
> an option.
>
> The authenticated shape is in [`docs/broker/README.md`](docs/broker/README.md): a dedicated
> tabichat CA, one client certificate per nick, `mqtts://` on 8883, and 1883 deleted rather than
> narrowed. **Applying any of it to a broker host is the operator's own act — the files there are
> artifacts, and `src/tools/broker-fixture.sh` is where they are proven, on a loopback container you
> own.**

**Order matters more than configuration.** See [`docs/tls-operations.md`](docs/tls-operations.md) for the
cutover sequence — the pin must exist on every seat host before any address becomes `mqtts://`, the client
refuses without it, `MQTT_TLS_INSECURE` does not bypass that refusal, and removing the plaintext listener is
the last step because it is the only one that locks a mis-pinned seat out completely.

## 2. pi (the agent harness)

This project deliberately keeps **no node** installed; bun runs everything:

```bash
curl -fsSL https://bun.sh/install | bash
bun install -g @earendil-works/pi-coding-agent
```

bun's global `pi` shim has a node shebang, so write a bun launcher at
`~/.local/bin/pi` (and `chmod +x` it):

```sh
#!/bin/sh
exec bun "$HOME/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"
```

Verify with `pi --version`. Custom model endpoints live in
`~/.pi/agent/models.json` (shape: see pi's `docs/models.md`; declare
`contextWindow` on custom models or pi assumes a small window and the
context advisory cannot compute a percentage).

## 3. The tabichat pi extension (each machine hosting an agent)

```bash
mkdir -p ~/.pi/agent/extensions
cp -r src/extensions/tabichat ~/.pi/agent/extensions/
bun install --cwd ~/.pi/agent/extensions/tabichat
```

Re-copy after editing (plain copy, not symlink). For deploys from this
repo on a regular basis use `src/tools/deploy-tabichat.sh` instead of
hand-copies — it runs the gates, stages, moves dependency modules before
the importer, and verifies with `cmp` (`--dry-run` first; see
`src/tools/deploy-tabichat.sh` header for the runbook rules). Optional
siblings in `src/extensions/`: `fs-gate` (directory-access gate) and
`tabichat-lead-model` (virtual-model routing; `<ROLE>_THINKING` sets a role's thinking
level) — same copy-in pattern.

## 4. The human room client (one machine is enough)

Needs Python 3.12+ and uv:

```bash
cd src && uv venv --python 3.12 && uv pip install paho-mqtt
.venv/bin/python src/tabichat_cli.py <room>
```

`src/tabichat_cli.py` is THE human room client, and it has SCROLLBACK (PageUp to
read what you missed, `TABICHAT_HISTORY` messages of buffer, default 5000). It is
one file: run it in whatever terminal you read the room in. The two test/measure
harnesses for it are `tools/test_tabichat_cli.py` and
`tools/pty_tabichat_probe.py` (the second drives a real pty and checks that the
screen actually scrolls).

## 5. First run

One terminal per agent — `MQTT_NICK` must be unique per participant:

```bash
MQTT_NICK=lead-agent pi --tabichat --room demo --model <provider/model>
MQTT_NICK=worker1  pi --tabichat --room demo --model <provider/model>
```

From the room client: `@worker1 say hi` — expect the answer back in the
room and the thinking visible in that lane's window. `/mqtt-status`
inside any lane shows live room state; `/room` and `/peers` read recent
lines and who is online.

Environment surface: `MQTT_URL` is **required** (§1 above — no shipped default, and a missing one
refuses loudly). All optional: `MQTT_ROOM`,
`MQTT_LEAD_NICK`, `MQTT_OWNER_NICK`, `MQTT_CTX_WARN`, `MQTT_CTX_TOKENS`,
`MQTT_STEER_NICKS`, `MQTT_HB_MS`, `MQTT_EXIT_LOG` — each is documented
in `README.md`.

The names in the launch line above are placeholders on purpose: `lead-agent` and `worker1` stand
for a coordinating seat and a worker seat, and the fallbacks the code carries (`bot`, `owner`,
the fixture pair `seat-a seat-b`) document shapes, not sites. **Site names MUST BE CONFIGURED —
set them to your own site's names**; the full table, its fallback behavior, and a note on why the
tier alias `lead-agent` in `tabichat-lead-model` and the lead-nick `lead-agent` here are different
things living on different planes, are in `README.md` under **“Site names are settings — they MUST
BE CONFIGURED”**. A running seat keeps the environment it booted with, so a name change lands on
that seat's next launch.

Agent-side conduct for your project: `AGENTS.md`.
