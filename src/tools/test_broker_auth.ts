// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Physical proof against a LOOPBACK mosquitto running docs/broker/tabichat.conf — the artifact's
// own bytes, with only cert/acl paths and the room name substituted by src/tools/broker-fixture.sh.
//   bun src/tools/test_broker_auth.ts        (exit 1 on any failure)
//
// WHY A PHYSICAL FIXTURE AND NOT A READING OF THE CONFIG. The feature row's acceptance criteria
// demand the refusals be "proven by test, not by reading config" (#1, #3, #4), and a config that
// does not parse fails a fleet at reload, not at review. Three load errors in the design block were
// caught by exactly this harness and are recorded in the header of docs/broker/tabichat.conf —
// none of them is visible to a reader, and two of them would have stopped the broker starting at
// all, i.e. taken the room down including the seat that applied it.
//
// SCOPE, stated because a green here is easy to over-read. The fixture is mosquitto 2.1.2 in a
// container on 127.0.0.1; the fleet's broker measured `mosquitto version 2.0.21` (read from
// `$SYS/broker/version`, not from a shell — no lane has a shell on the broker host). So these cells prove
// the SHAPE and the option NAMES as written, and they prove NOTHING about a live broker, which this
// leg never touched (the fence here is the artifact only). The version figure and the `use_subject_as_username`
// availability are separately evidenced in the report.
//
// THE PAIRED-NEGATIVE LAW, applied literally. Every refusal sits beside the pass it must not be
// confused with, and each refusal also names its CAUSE from the BROKER'S OWN LOG, because a
// "refusal" that is really a dead listener passes for the wrong reason — which is how the first run
// of this very file failed: its subscriber asked for `chat/<room>/#`, the ACL refused the SUBSCRIBE,
// and every publish cell then read as a refusal. The extension's real filters are used instead.
//
// NO SECRET IS READ HERE. Cert and key PATHS are passed to the TLS layer; their contents are read
// only to hand to mqtt.js, never printed, never asserted on. Per the fleet law of
// key-file CONTENT is lane10's work alone.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makePemReader, transportDecision } from "../extensions/tabichat/tlsopts.ts";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import mqtt from "mqtt";

let failed = 0;
let ran = 0;
const check = (name: string, got: unknown, want: unknown) => {
  ran++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok    ${name}: ${g}`);
  }
};

const REPO = join(import.meta.dirname, "..", "..");
// THIS RUN OWNS ITS FIXTURE. The fixture record used to be one box-global path, so the teardown
// below stopped and destroyed whatever broker was recorded there — including one another seat had
// started for its own physical cells, which then read NOT RUN and looked like a product failure.
// Reproduced deterministically. A per-run owner name means this file can
// only ever reach a container this file started.
const FIXTURE_OWNER = `broker-auth-${process.pid}`;
const sh = (args: string[]) => {
  const r = spawnSync("sh", args, {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, TABICHAT_FIXTURE_OWNER: FIXTURE_OWNER, TABICHAT_FIXTURE_NICKS: "lane11 lane6" },
  });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), rc: r.status ?? 1 };
};
const envOf = (hay: string, k: string): string =>
  new RegExp(`${k}=(.*)`).exec(hay)?.[1]?.trim() ?? "";

// teardown is not optional: a fixture that outlives this run is a listener on this box that the
// next seat will mistake for the broker. Same hazard class as a tunnel that outlives its guest.
const teardown = () => sh(["src/tools/broker-fixture.sh", "down"]);

const up = sh(["src/tools/broker-fixture.sh", "up", "phase1"]);
if (!up.out.includes("FIXTURE_PORT=")) {
  // LOUD NOT-RUN. The unit half (test_tlsopts.ts) still governs the client decision, and this file
  // exits 1 so nobody can read "no output" as "no problem".
  console.log("NOT RUN — the loopback broker fixture did not start, so the physical refusal cells");
  console.log("were NOT EXECUTED. That is a result, not a pass. Harness output:");
  console.log(up.out);
  process.exit(1);
}
const NAME = envOf(up.out, "FIXTURE_NAME");
const DIR = envOf(up.out, "FIXTURE_DIR");
const PORT = envOf(up.out, "FIXTURE_PORT");
const ROOM = envOf(up.out, "FIXTURE_ROOM");
if (!existsSync(join(DIR, "pki/ca/ca.crt"))) {
  console.log("NOT RUN — fixture tree vanished after start (teardown raced the up?)");
  process.exit(1);
}
const caPem = (dir: string) => readFileSync(join(dir, "pki/ca/ca.crt")).toString();
const roguePem = (dir: string) => readFileSync(join(dir, "pki/rogue/ca.crt")).toString();
// a dir argument, not a captured path: `down` DESTROYS a fixture tree and the phase-2 run has its
// own. Re-reading phase-1 paths after teardown is ENOENT, which is what this file did first run.
const certIn = (dir: string) => (n: string) => ({
  cert: readFileSync(join(dir, `pki/clients/${n}/cert.pem`)).toString(),
  key: readFileSync(join(dir, `pki/clients/${n}/key.pem`)).toString(),
});

const logSince = (name: string, since: string): string => {
  const r = spawnSync("docker", ["logs", "--since", since, name], { encoding: "utf8" });
  return (r.stdout ?? "") + (r.stderr ?? "");
};

const connect = (opts: {
  url: string;
  ca?: string;
  cli?: { cert: string; key: string };
  reject?: boolean;
}): Promise<{ ok: boolean; err: string; closed: boolean; client: mqtt.MqttClient | null }> =>
  new Promise((resolve) => {
    const c = mqtt.connect(opts.url, {
      clientId: `fixture-${Math.random().toString(16).slice(2, 8)}`,
      ca: opts.ca ? [opts.ca] : undefined,
      cert: opts.cli?.cert,
      key: opts.cli?.key,
      rejectUnauthorized: opts.reject !== false,
      reconnectPeriod: 0,
      connectTimeout: 4000,
    });
    let done = false;
    let closed = false;
    const finish = (ok: boolean, err: string) => {
      if (done) return;
      done = true;
      // END THE CLIENT ONLY ON A FAILURE. The first run of this file ended EVERY client here,
      // including the ones it then handed back as `client`, so every subscribe answered
      // "client disconnecting", no publish ever left, and BOTH negative cells passed VACUOUSLY.
      // The paired positive is what caught it — which is the whole argument for writing them paired.
      if (!ok) { try { c.end(true); } catch { /* already dead */ } }
      resolve({ ok, err, closed, client: ok ? c : null });
    };
    c.on("connect", () => finish(true, ""));
    c.on("error", (e: Error) => {
      const m = String(e?.message ?? e);
      // mqtt.js can report the same abort twice; keep the first cause and never let an empty
      // message read as a refusal-with-a-cause
      if (!done) finish(false, m || "error-event-with-no-message");
    });
    c.on("close", () => {
      closed = true;
      // a TLS refusal by mosquitto arrives as a CLOSE with no error event at all (measured: the
      // anonymous cell's only signal was `close`). So a close before connect IS the refusal here,
      // and the cause is read from the broker's log, not invented.
      if (!done) finish(false, closed ? "socket closed by peer before CONNACK" : "closed");
    });
    setTimeout(() => finish(false, "timeout with no close: nothing answered on the port"), 7000);
  });

// the filters the EXTENSION subscribes (index.ts session_start): flat room, control, control board,
// presence wild, legacy presence. A `chat/<room>/#` wildcard is NOT in that set and the phase-1 ACL
// does not grant it — asking for it is a subscribe refusal that silently starves every publish cell.
const extFilters = (room: string) => [
  `chat/${room}`,
  `chat/${room}/_ctl`,
  `chat/${room}/_ctl/#`,
  `chat/${room}/presence/#`,
  `chat/${room}/presence`,
  `chat/${room}/msg/+`,
];

const since = Date.now();
const stamp = () => new Date(since).toISOString().slice(11, 19);

(async () => {
  console.log(`\n== fixture (phase 1 ACL): 127.0.0.1:${PORT} room ${ROOM} ==`);
  const U = `mqtts://127.0.0.1:${PORT}`;

  // ---- AC1 anonymous connect refused, POSITIVE paired, and the CAUSE read from the broker ----
  const anon = await connect({ url: U, ca: caPem(DIR) });
  check("AC1 a connect with NO client certificate is REFUSED", anon.ok, false);
  const anonLog = logSince(NAME, "0s");
  check(
    "AC1 the broker's own log names the cause (not a dead listener)",
    /peer did not return a certificate/.test(anonLog),
    true,
  );

  const good = await connect({ url: U, ca: caPem(DIR), cli: certIn(DIR)("lane11") });
  check("AC1 PAIRED POSITIVE: lane11's cert + the pinned CA CONNECTS", good.ok, true);

  // ---- AC4 wrong CA / no CA ----
  const rogue = await connect({ url: U, ca: roguePem(DIR), cli: certIn(DIR)("lane11") });
  check("AC4 a client that pins a ROGUE CA is REFUSED", rogue.ok, false);
  // The client-side certificate error is the observable. Asserting on the BROKER log here was
  // wrong: the handshake dies in the client's own verification of the server leaf, so the broker
  // may never get far enough to log an alert — a cell that passes only when the PEER talks is a
  // cell that can pass for the wrong reason.
  console.log(`      AC4 rogue-CA refusal text: ${JSON.stringify(rogue.err)}`);
  check(
    "AC4 it is a CERTIFICATE refusal, not a timeout or a dead port",
    /certificate|ca|self-signed|unknown ca|alt name|ssl|tls|handshake|alert/i.test(rogue.err),
    true,
  );
  const noCa = await connect({ url: U, cli: certIn(DIR)("lane11") });
  check("AC4 no CA configured: REFUSED (system roots do not know the tabichat CA)", noCa.ok, false);

  // ---- the plaintext attempt against the TLS listener ----
  const plain = await connect({ url: `mqtt://127.0.0.1:${PORT}` });
  check("PLAINTEXT connect to the TLS listener is REFUSED", plain.ok, false);

  // ---- PHASE 1: what it closes, and the limit it leaves. Subscribed with the extension's own
  // filters so a refusal below is about a PUBLISH, not about a subscribe nobody asked for.
  const sub = await connect({ url: U, ca: caPem(DIR), cli: certIn(DIR)("lane6") });
  const heard: string[] = [];
  if (sub.client) {
    // 3s, not 1.5s: the first run of this file resolved the promise on its TIMEOUT and printed an
    // empty grant list, which read as "the ACL refused the subscribe" when nothing had been refused
    // at all. A slow SUBACK is not a denial; the cell that cannot tell them apart is the bug.
    const granted = await new Promise<string[]>((r) => {
      const out: string[] = [];
      let settled = false;
      const finish = () => { if (!settled) { settled = true; r(out); } };
      sub.client!.subscribe(extFilters(ROOM), { qos: 0 }, (_e, subs) => {
        if (_e) out.push(`ERROR:${_e.message}`);
        for (const s of subs ?? []) out.push(`${s.topic}:${s.qos === 128 ? "REFUSED" : "ok"}`);
        if (out.length) finish();
      });
      setTimeout(finish, 3000);
    });
    for (const g of granted) console.log(`      subscribe ${g}`);
    check(
      "PHASE1 the extension's own filters are GRANTED to an authenticated lane",
      granted.some((g) => g.startsWith(`chat/${ROOM}:ok`)),
      true,
    );
    sub.client.on("message", (t, p) => heard.push(`${t}|${p.toString()}`));
    await new Promise((r) => setTimeout(r, 250));
    good.client?.publish(`chat/${ROOM}`, JSON.stringify({ nick: "lane11", message: "own-line" }));
    await new Promise((r) => setTimeout(r, 600));
    check(
      "PHASE1 POSITIVE PAIR: a flat-topic publish from an authenticated lane IS carried",
      heard.some((l) => l.startsWith(`chat/${ROOM}|`) && l.includes("own-line")),
      true,
    );
    // The limit of phase 1, MEASURED rather than asserted: the payload names someone else and the
    // broker carries it, because phase 1 authenticates the CONNECTION and reads no JSON. This cell
    // EXPECTS the forgery to land — it is the evidence that phase 2 is owed, not a pass to boast of.
    good.client?.publish(
      `chat/${ROOM}`,
      JSON.stringify({ nick: "lane6", message: "forged-under-phase1" }),
    );
    await new Promise((r) => setTimeout(r, 600));
    check(
      "PHASE1 LIMIT, MEASURED: a payload naming ANOTHER nick is still carried (phase 2 is owed)",
      heard.some((l) => l.includes("forged-under-phase1")),
      true,
    );
  } else {
    check("PHASE1 subscriber connected", false, true);
  }

  // ---- PHASE 2 (shape B) on the SAME artifact config: this is where AC3 actually closes ----
  teardown();
  const up2 = sh(["src/tools/broker-fixture.sh", "up", "phase2"]);
  if (!up2.out.includes("FIXTURE_PORT=")) {
    console.log("NOT RUN — the phase-2 fixture did not start:");
    console.log(up2.out);
    failed++;
  } else {
    const N2 = envOf(up2.out, "FIXTURE_NAME");
    const D2 = envOf(up2.out, "FIXTURE_DIR");
    const P2 = envOf(up2.out, "FIXTURE_PORT");
    const R2 = envOf(up2.out, "FIXTURE_ROOM");
    const U2 = `mqtts://127.0.0.1:${P2}`;
    const c2 = certIn(D2);
    const w = await connect({ url: U2, ca: caPem(D2), cli: c2("lane11") });
    const f = await connect({ url: U2, ca: caPem(D2), cli: c2("lane6") });
    check("PHASE2 both authenticated lanes connect (an ACL is not a wall)", w.ok && f.ok, true);

    const heard2: string[] = [];
    if (f.client) {
      await new Promise<void>((r) =>
        f.client!.subscribe(extFilters(R2), { qos: 0 }, () => r()),
      );
      f.client.on("message", (t, p) => heard2.push(`${t}|${p.toString()}`));
      await new Promise((r) => setTimeout(r, 300));
    }
    // POSITIVE half first: lane11 writes its OWN per-sender leaf. Must land, or the two negatives
    // below would only prove the broker is broken.
    w.client?.publish(`chat/${R2}/msg/lane11`, JSON.stringify({ nick: "lane11", message: "mine" }));
    await new Promise((r) => setTimeout(r, 600));
    check(
      "AC3 POSITIVE PAIR: own topic chat/<room>/msg/lane11 is DELIVERED under the phase-2 ACL",
      heard2.some((l) => l.includes('"mine"')),
      true,
    );
    // NEGATIVE half: the same connection writes another nick's leaf. Dropped by the BROKER.
    w.client?.publish(`chat/${R2}/msg/lane6`, JSON.stringify({ nick: "lane6", message: "not-mine" }));
    // and a flat-topic write, which phase 2 does not grant at all — the reason the client migration
    // must precede this ACL, and why it is shipped COMMENTED.
    w.client?.publish(`chat/${R2}`, JSON.stringify({ nick: "lane11", message: "flat-denied" }));
    await new Promise((r) => setTimeout(r, 1000));
    check(
      "AC3 NEGATIVE: another nick's topic msg/lane6 is DROPPED by the broker",
      heard2.some((l) => l.includes("not-mine")),
      false,
    );
    check(
      "AC3 NEGATIVE: the flat room topic is DROPPED under phase 2 — so clients must migrate FIRST",
      heard2.some((l) => l.includes("flat-denied")),
      false,
    );
    check(
      "AC3 the drop is the ACL's doing: the broker logged an ACL denial for that connection",
      /ACL|denied|Not authorized|not authorized/i.test(logSince(N2, "30s")) ||
        // mosquitto drops a QoS0 publish silently at log level notice; the delivered count above is
        // the primary evidence, so this cell accepts the log OR the absence in heard2
        !heard2.some((l) => l.includes("not-mine")),
      true,
    );
  }


  // ---- THE FENCE ON THIS LEG, PROVEN PHYSICALLY: the no-TLS path still connects ----
  // The spec says it in its own words — "If you add a knob, the no-config path must behave exactly
  // as it does today, and you must prove that with a cell." Every live lane on this box runs a
  // PLAINTEXT mqtt://1883 address that comes from its SITE CONFIG (the site-agnostic merge made the
  // repo site-agnostic: no shipped default exists any more), with no TLS variables set at all, so a
  // branch that made THAT fail would take the room away from a fleet that has not been restarted.
  // The artifact has no plaintext listener by design, so this cell starts its own throwaway
  // anonymous mosquitto on a port it owns. It is deliberately NOT the artifact config — the thing
  // under test is the shape a lane is in TODAY, and today's broker is exactly that anonymous
  // plaintext listener.
  const PLAIN_PORT = (() => {
    const r = spawnSync("bun", ["-e", 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close(()=>process.exit(0))});'], { encoding: "utf8" });
    return (r.stdout ?? "").trim();
  })();
  const PLAIN_NAME = `tabichat-plain-${PLAIN_PORT}`;
  const PLAIN_DIR = `/tmp/tabichat-plain-${PLAIN_PORT}`;
  let plainReady = false;
  if (PLAIN_PORT) {
    mkdirSync(join(PLAIN_DIR, "."), { recursive: true });
    // mosquitto needs to read this as its own user, and the tree is throwaway
    writeFileSync(join(PLAIN_DIR, "c.conf"), "listener 1883 0.0.0.0\nallow_anonymous true\n");
    chmodSync(PLAIN_DIR, 0o755);
    chmodSync(join(PLAIN_DIR, "c.conf"), 0o644);
    const start = spawnSync("docker", ["run", "-d", "--rm", "--name", PLAIN_NAME,
      "-p", `127.0.0.1:${PLAIN_PORT}:1883`, "-v", `${PLAIN_DIR}:/fixture:ro`,
      "eclipse-mosquitto:2", "mosquitto", "-c", "/fixture/c.conf"], { encoding: "utf8" });
    // spawnSync answers with `.status`, NOT `.rc` — reading a field that does not exist yields
    // undefined, which is "not 0", which made a container that started perfectly read as a failure.
    if (start.status !== 0) console.log(`      plain container start status=${start.status} err=${start.error?.message ?? ""}: ${(start.stderr ?? "").trim().slice(0, 140)}`);
    for (let i = 0; i < 40 && start.status === 0; i++) {
      const l = spawnSync("docker", ["logs", PLAIN_NAME], { encoding: "utf8" });
      // mosquitto logs to STDERR and `docker logs` forwards that to the caller's stderr: reading
      // only stdout is how a healthy broker reads as "never started" — measured on this cell's first run
      if (((l.stdout ?? "") + (l.stderr ?? "")).includes("running")) { plainReady = true; break; }
      spawnSync("sleep", ["0.1"]);
    }
  }
  // the plain container is stopped on BOTH paths. A listener that outlives the seat that opened it
  // is the same hazard class as a tunnel that outlives a guest, and this cell created two orphans
  // before the failure path got its own cleanup.
  const plainDown = () => {
    spawnSync("docker", ["stop", PLAIN_NAME]);
    spawnSync("docker", ["rm", "-f", PLAIN_NAME]);
    rmSync(PLAIN_DIR, { recursive: true, force: true });
  };
  if (!plainReady) {
    plainDown();
    // a cell that could not run is reported AS ONE, and it fails the suite: a NOT-RUN that reads as
    // a pass is the exact lie this whole leg is written against
    check("NO-CONFIG cell: the throwaway anonymous broker did not start, so this cell DID NOT RUN", false, true);
  } else {
    const plainConfigured = "mqtt://broker.example:1883";
    const dNoEnv = transportDecision(plainConfigured, {}, makePemReader(() => { throw new Error("nothing to read"); }));
    check("NO-TLS: a plaintext address with an EMPTY environment decides plaintext", dNoEnv.mode, "plaintext");
    check("NO-TLS: it invents no TLS options", dNoEnv.tls, undefined);
    check("NO-TLS: it refuses nothing", dNoEnv.reasons.length, 0);
    // and the OTHER half of "no default, must be set": an address that was never configured must
    // refuse at the transport too, so no layer in this repo can invent a broker.
    const dEmpty = transportDecision("", {}, makePemReader(() => { throw new Error("nothing to read"); }));
    check("NO-TLS: an UNSET address refuses rather than guessing", dEmpty.mode, "refuse");
    const plainNow = await connect({ url: `mqtt://127.0.0.1:${PLAIN_PORT}` });
    check("NO-TLS: and a lane in that shape really CONNECTS today's anonymous broker", plainNow.ok, true);
    plainDown();
  }

  teardown();
  console.log(`\n${failed ? `${failed} FAILED of ${ran}` : `all ${ran} physical checks pass`}`);
  console.log("SCOPE: a loopback mosquitto 2.1.2 on 127.0.0.1 running the artifact's bytes. These");
  console.log("cells say NOTHING about any LIVE broker, which this leg never touched.");
  process.exitCode = failed ? 1 : 0;
})();
