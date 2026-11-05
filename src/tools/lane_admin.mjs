// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// one-shot lane admin request:
//   bun tools/lane_admin.mjs <by-nick> <target-nick> <renew|compact|shutdown>
//
// Publishes ONE control-topic request. It is a request, never a command: the lane that would
// be renewed, compacted or ended is the one that decides, in laneadmin.ts — the recipient field
// must name THIS lane (or `all`), the sender must be on the steer allowlist (lead + owner +
// MQTT_STEER_NICKS) — unless it is the lane's own name and LANE_ADMIN_SELFRENEW is on — the
// matching LANE_ADMIN_* flag must be on in that lane, and renew/shutdown additionally require a
// RESUME file for that seat.
//
// `to` is REQUIRED and it is the only thing that decides delivery: pass a nick,
// a comma-separated list, or the literal `all` when fleet-wide is genuinely what you mean. A
// publish that names nobody is inert on every lane by design — fan-out is never an accident.
//
// TRUST MODEL, stated plainly: MQTT here carries no authentication, so `by` is self-asserted
// — exactly as it is for a room post. Anyone who can reach the broker can already put words
// in a lane's mouth. This tool adds no new authority; it only speaks the admin dialect that
// the receiving lane then judges against its own allowlist and flags.
//
// ─── IT SPEAKS THE SAME TRANSPORT AS THE LANES (ticket row 2) ─────────────
// Until this file called `mqtt.connect(broker.url)` with NO options at all. The fleet
// moved to `mqtts://`, so every remote renew / compact / shutdown request died at the
// broker — `broker error: self signed certificate`, rc 4 — BEFORE any lane ever judged it. Measured
// again on this leg at `main` `68e4973` against the throwaway fixture broker: rc 4, same
// message, with MQTT_TLS_CAFILE exported (the variable was never read, because there was no TLS
// code path to read it in). So #2's "renewed by a peer" half was unreachable, not merely unproven.
//
// The fix is NOT a fourth TLS variant: it calls the SAME pure decision the lanes run
// (`tlsopts.ts:transportDecision` + `makePemReader`), so a request can never travel a transport the
// target lane would refuse. A `refuse` decision is final and loud here, and it exits 4 with the
// reason printed, because a control-channel tool that quietly falls back to plaintext is exactly the
// silent downgrade the design row forbids.
//
// ─── IT REPORTS AN OUTCOME, NOT A PUBLISH (ticket row 2) ─────────────────────────────
// Until this printed `published lane-admin <action> ...` and exited 0 whatever
// happened, because publishing is the only thing a one-shot publisher can see. That lie cost a
// seat: `lane_admin.mjs lead-agent lead-agent renew` was REFUSED by the self-address guard, the tool said
// `published`, exit 0, and the lead planned on a refresh that had not happened
// (the sheet that lane wrote says so). The lead seat reproduced the face twice more — refused
// at the RESUME bar, same `published` + rc 0. So the request now carries an `id`, the lane that
// JUDGES it answers on `chat/<room>/_ctl/admin/<id>` (laneadmin.ts: adminResultPayload), and this
// tool waits for that answer and exits on it:
//
//   ARMED    the addressee took it and will run it at its next idle boundary   rc 0
//   RUN      the addressee accepted and dispatched it now                       rc 0
//   REFUSED  the addressee said no, and its own reason is printed               rc 1
//   NOTHING  no lane answered inside LANE_ADMIN_ACK_MS — unknown, NOT success   rc 3
//
// ARMED and RUN are still not proof the session changed. For renew that observable is the target's
// BOOT TAG moving on its next post plus its own wake line (row 2; proven live on a real seat).
// This tool says what the lane decided, never DONE.
//
// Exit codes: 0 taken · 1 refused · 2 usage · 3 no answer · 4 broker error (including no broker
// configured — the refusal below, which is a broker error from the caller's point of view).
//
// Run it from the repo (`bun src/tools/lane_admin.mjs ...`): it imports the same pure decision
// helpers the lane itself runs, so the rc map cannot drift from the verdict it reports.
import mqtt from "mqtt";
import { readFileSync } from "node:fs";
import {
  makePemReader,
  redactUrl,
  transportDecision,
} from "../extensions/tabichat/tlsopts.ts";
import {
  ADMIN_KIND,
  ADMIN_EXIT,
  adminExitCode,
  adminResultWild,
  isAdminResult,
} from "../extensions/tabichat/laneadmin.ts";
import { resolveBrokerFromDisk } from "../extensions/tabichat/broker.ts";

// Does `topic` satisfy the `+`-wildcard `filter`? One level per `+`, exact elsewhere — the MQTT 3.1.1
// §4.7 rule, written out here rather than trusted to a string compare, because the subscribe filter
// and the delivered topic stopped being equal under shape (ii).
const matchesResultTopic = (topic, filter) => {
  const t = String(topic).split("/"), f = String(filter).split("/");
  if (t.length !== f.length) return false;
  return f.every((part, i) => part === "+" || part === t[i]);
};

const [by, to, action] = process.argv.slice(2);
if (!by || !to || !action) {
  console.error("usage: lane_admin.mjs <by-nick> <target-nick> <renew|compact|shutdown>");
  process.exit(2);
}

// BROKER LOCATION: site config "mqttUrl" → MQTT_URL → REFUSE, exit 4, message names BOTH the config
// path it searched and the variable it wanted — site-agnostic by design: "no default, must
// be set" + "the mqtt url can be set in a config, not hardcoded"). This tool was one of the twelve
// files that shipped a venue's host as a fallback; the rule now lives in one place, broker.ts.
// Usage is checked FIRST above: a caller who forgot their arguments should hear about those.
const broker = resolveBrokerFromDisk();
if (!broker.ok) {
  console.error(broker.message);
  process.exit(ADMIN_EXIT.broker);
}
if (broker.note) console.error(`[tabichat] ${broker.note} — it may hold the setting you meant.`);
const room = process.env.MQTT_ROOM ?? "tabith";
// An id is what makes an answer findable: the same shape the room uses, with `admin` in the middle
// so a request can never be confused with a room post's receipt. Sanitised by the same function
// that builds the topic, so nothing here can address a level the id does not belong to.
const id = `${by}-admin-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
// SHAPE (ii): the answer now lives under the ANSWERER's nick, so the requester subscribes the
// one-level wildcard and still correlates by the id in the payload. One subscription, one step — same
// as before; what changed is only who owns the leaf that lands under it.
const resultTopic = adminResultWild(room, id);
if (!resultTopic) {
  console.error(`refusing to dispatch: the request id sanitises to an empty topic leaf`);
  process.exit(2);
}
// A lane answers as soon as it decides, so the window is short. A lane that is mid-turn answers
// ARMED immediately rather than at the boundary, which is the whole point of that word.
const waitMs = Number.parseInt(process.env.LANE_ADMIN_ACK_MS ?? "", 10) || 15_000;
// One-shot process: no reconnect, so the per-connect warnings ride with the connect they describe.
// No type annotation here — this file is `.mjs`, plain JavaScript that node runs without a
// transpile step, so an annotation (or a `type` import) is a SYNTAX ERROR, not a style choice.
const TRANSPORT = transportDecision(
  broker.url,
  process.env,
  makePemReader((path) => readFileSync(path, "utf8")),
);
if (TRANSPORT.mode === "refuse") {
  // Loud and final: no socket, no retry, no plaintext fallback. The reason is the actionable part.
  console.error(
    `REFUSED to connect — ${(TRANSPORT.reasons ?? []).join(" | ") || "no reason recorded"}`,
  );
  process.exit(ADMIN_EXIT.broker);
}
const c = mqtt.connect(TRANSPORT.url, { ...(TRANSPORT.tls ?? {}) });
let settled = false;

const finish = (line, code) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.log(line);
  c.end(true);
  process.exit(code);
};
const timer = setTimeout(
  () =>
    finish(
      `NOTHING    no lane answered ${id} in ${waitMs}ms — outcome UNKNOWN, treat it as not done ` +
        `(the target may be offline, mid-turn past the window, or running bytes that do not answer)`,
      ADMIN_EXIT.unknown,
    ),
  waitMs,
);

c.on("connect", () => {
  // `MQTT_TLS_INSECURE=1` is the one setting whose warning must be printed on EVERY connect, not
  // once at boot — the ruled condition in tlsopts.ts, honoured here so an operator who aims this
  // tool at a broker with verification off is told so on every run.
  for (const w of TRANSPORT.perConnectWarnings ?? []) console.error(`[tabichat][transport] ${w}`);
  // subscribe BEFORE publishing, so an answer that lands while we were still handshaking is
  // replayed from the broker's retained copy instead of missed.
  if (!resultTopic) return finish(`NOTHING    cannot subscribe to an empty topic`, ADMIN_EXIT.unknown);
  c.subscribe(resultTopic, () => {
    c.publish(
      `chat/${room}/_ctl`,
      JSON.stringify({ kind: ADMIN_KIND, action, by, to, id, ts: Date.now() }),
    );
    console.log(`published lane-admin ${action} for ${to} from ${by} on chat/${room}/_ctl — awaiting outcome`);
  });
});

c.on("message", (topic, payload) => {
  // The subscription is a wildcard now, so an equality test would drop EVERY answer: the frame
  // arrives on `_ctl/admin/<responder>/<id>` and we asked for `_ctl/admin/+/<id>`. Match the shape,
  // then let the id comparison below do the real work. One level only, so a deeper topic is a miss.
  if (!matchesResultTopic(topic, resultTopic)) return;
  let msg = null;
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    return; // not ours to read; a malformed answer is a miss, and the timeout says so
  }
  if (!isAdminResult(msg) || msg.id !== id) return;
  const label = msg.outcome.toUpperCase().padEnd(9);
  const why = msg.reason ? ` — ${msg.reason}` : "";
  finish(`${label}${msg.lane} ${msg.outcome} ${msg.action}${why}`, adminExitCode(msg.outcome));
});

c.on("error", (err) =>
  finish(`broker error: ${redactUrl(String(err?.message ?? err))}`, ADMIN_EXIT.broker),
);
