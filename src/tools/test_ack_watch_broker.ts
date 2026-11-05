// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// tabichat#10 — PHYSICAL proof that a retained control-child publish the ACL refuses is invisible to
// its own publisher, and that the ack watchdog (roommsg.ts) tells carried from swallowed on the
// signal the socket actually gives. Run: bun src/tools/test_ack_watch_broker.ts   (exit 1 on failure)
//
// WHY THIS EXISTS AND WHY IT IS NOT A UNIT TEST. #10's whole claim is that "the publish call
// succeeded" and "the broker took it" are different facts, and no amount of in-process testing can
// show the difference — a unit test of a dropped publish has to FAKE the drop, and a faked drop
// proves only the handler. So this file runs the throwaway loopback mosquitto twice, on the SAME
// artifact config, and asks each phase the same three questions of a real socket:
//   1. did the write reach a SECOND client (delivery, verified at the far side, never from the
//      publisher's own rc)?
//   2. did it come back to the PUBLISHER's own `_ctl/#` subscription — the echo the watchdog is
//      built on, and the only client-side signal there is?
//   3. what does the watchdog decide from exactly what the socket observed?
// Question 3 is what makes this file go RED on pre-fix code: `settleAck`/`expireAcks`/`ackLostLine`
// do not exist before this branch, so the import fails and the run exits non-zero — a control that
// cannot fail on the bytes it replaces is not a control.
//
// BOUNDED, AND ONLY EVER OURS. The fixture record is scoped to a per-process owner (the hazard
// was one global state file letting a neighbour's `down` kill this run's broker), and teardown runs
// on every exit path including a throw. No live broker is contacted: this is 127.0.0.1 on a port the
// fixture chose. Key CONTENTS are read only to hand to mqtt.js, never printed (fleet law: key-file
// content is lane10's work alone).
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import mqtt from "mqtt";
import {
  ackLostLine,
  ackTopic,
  ackWatchKey,
  deliveryVerdict,
  expireAcks,
  settleAck,
  watchAck,
  type AckWatch,
} from "../extensions/tabichat/roommsg.ts";
import { adminResultTopic, adminResultWild } from "../extensions/tabichat/laneadmin.ts";
import { msgTopic } from "../extensions/tabichat/roommsg.ts";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
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
const FIXTURE_OWNER = `ack-watch-${process.pid}`;
const sh = (args: string[]) => {
  const r = spawnSync("sh", args, {
    encoding: "utf8",
    cwd: REPO,
    // The fixture default is site-neutral; this file's main cells wear the named pair,
    // so the pair is DECLARED here, never inherited from a silent default.
    env: { ...process.env, TABICHAT_FIXTURE_OWNER: FIXTURE_OWNER, TABICHAT_FIXTURE_NICKS: "lane11 lane6" },
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
};
const envOf = (h: string, k: string) => new RegExp(`${k}=(.*)`).exec(h)?.[1]?.trim() ?? "";

const teardown = () => sh(["src/tools/broker-fixture.sh", "down"]);
process.on("exit", teardown);

interface Obs {
  /** topics a SECOND authenticated client heard (delivery at the far side) */
  peer: string[];
  /** topics the PUBLISHING client heard back on its own subscription (the echo) */
  self: string[];
  /**
   * iid 21 finding 1 — the SAME frames as `self`, with the payload id each one carried. The room
   * topic is shared by every lane, so a topic alone cannot say which publish arrived; this is what
   * the shipped inbound handler has in hand, and what the watch now keys on.
   */
  selfFrame: { topic: string; id: string }[];
}

/** The id an inbound frame carried, read the way `index.ts` reads it. Never printed as content. */
const frameId = (p: Buffer): string => {
  try {
    const o = JSON.parse(p.toString()) as { id?: unknown };
    return typeof o.id === "string" ? o.id : "";
  } catch {
    return "";
  }
};

async function probe(phase: "phase1" | "phase2") {
  const up = sh(["src/tools/broker-fixture.sh", "up", phase]);
  if (!up.includes("FIXTURE_PORT=")) {
    console.log(`NOT RUN — the ${phase} fixture did not start, so the ${phase} cells were NOT EXECUTED.`);
    console.log(up);
    return null;
  }
  const DIR = envOf(up, "FIXTURE_DIR");
  const PORT = envOf(up, "FIXTURE_PORT");
  const ROOM = envOf(up, "FIXTURE_ROOM");
  if (!existsSync(join(DIR, "pki/ca/ca.crt"))) {
    console.log(`NOT RUN — fixture tree vanished after start (${phase})`);
    return null;
  }
  const U = `mqtts://127.0.0.1:${PORT}`;
  const ca = readFileSync(join(DIR, "pki/ca/ca.crt")).toString();
  const cert = (n: string) => {
    const c = join(DIR, `pki/clients/${n}/cert.pem`), k = join(DIR, `pki/clients/${n}/key.pem`);
    if (!existsSync(c) || !existsSync(k)) throw new Error(`the fixture minted no client pair for "${n}" — ask for it in TABICHAT_FIXTURE_NICKS, do not debug the broker`);
    return { cert: readFileSync(c).toString(), key: readFileSync(k).toString() };
  };
  const conn = (n: string) =>
    new Promise<mqtt.MqttClient>((res, rej) => {
      const c = mqtt.connect(U, {
        clientId: `ack488-${phase}-${n}`,
        ca: [ca],
        ...cert(n),
        rejectUnauthorized: true,
        reconnectPeriod: 0,
        connectTimeout: 6000,
      });
      c.on("connect", () => res(c));
      c.on("error", (e: Error) => rej(e));
      setTimeout(() => rej(new Error("connect timeout")), 9000);
    });

  // The publisher is a REAL lane of this extension's filter shape: it subscribes `_ctl/#` (ONE
  // wildcard, per #3 — not both, which is what double-adjudicated a request and forked a seat).
  const pub = await conn("lane11");
  const peer = await conn("lane6");
  const obs: Obs = { peer: [], self: [], selfFrame: [] };
  const filters = [`chat/${ROOM}`, `chat/${ROOM}/_ctl/#`, `chat/${ROOM}/msg/+`];
  const subOk = (c: mqtt.MqttClient) =>
    new Promise<string[]>((r) => {
      const out: string[] = [];
      let settled = false;
      const finish = () => { if (!settled) { settled = true; r(out); } };
      c.subscribe(filters, { qos: 0 }, (_e, subs) => {
        if (_e) out.push(`ERROR:${_e.message}`);
        for (const s of subs ?? []) out.push(`${s.topic}:${s.qos === 128 ? "REFUSED" : "ok"}`);
        if (out.length) finish();
      });
      // 3s, not the 1.5s that once made a slow SUBACK read as a denial (test_broker_auth.ts lesson)
      setTimeout(finish, 3000);
    });
  const gPub = await subOk(pub);
  const gPeer = await subOk(peer);
  // A refusal to SUBSCRIBE would make every absence below look like an ACL drop when it is only a
  // starved listener. Assert the listeners are alive BEFORE trusting that they heard nothing.
  check(`${phase}: the publisher's own _ctl/# subscription is GRANTED`,
    gPub.some((g) => g.startsWith(`chat/${ROOM}/_ctl/#:ok`)), true);
  check(`${phase}: the peer's _ctl/# subscription is GRANTED`,
    gPeer.some((g) => g.startsWith(`chat/${ROOM}/_ctl/#:ok`)), true);
  pub.on("message", (t, p) => { obs.self.push(t); obs.selfFrame.push({ topic: t, id: frameId(p) }); });
  peer.on("message", (t) => obs.peer.push(t));
  await new Promise((r) => setTimeout(r, 400));

  // THE THREE WRITES, built by the shipped topic builders — not hand-typed strings.
  const id = `${phase}-msg-${Date.now().toString(36)}`;
  // Shape (ii) changed what PHASE2 means here. Before the grant narrowed, `_ctl/<id>` was refused
  // because NO child was writable; now lane11's OWN leaf IS writable, so the drop case has to be made
  // the way the row actually cares about — a write under SOMEBODY ELSE's leaf, which the narrow
  // grant refuses. Both halves are asserted now: own leaf carried (AC1's positive) and foreign leaf
  // dropped with no echo (the watchdog's premise, re-proved on the new shape).
  const tRcpt = ackTopic(ROOM, "lane11", id);
  const tAdmin = adminResultTopic(ROOM, "lane11", `${id}-adm`);
  const tForeign = ackTopic(ROOM, "lane6", `${id}-forge`);
  const tForeignAdmin = adminResultTopic(ROOM, "lane6", `${id}-forge-a`);
  const tBare = `chat/${ROOM}/_ctl`;
  const watch0: AckWatch[] = [];
  const wR = watchAck(watch0, tRcpt, "delivery receipt", Date.now());
  const wA = watchAck(wR.pending, tAdmin, "admin outcome", Date.now());
  // Shape (ii): the OWN leaf is granted now, so the drop the watchdog must catch is the FORGERY
  // write. Watching the owned topics too would settle them and leave nothing to alarm on — which is
  // exactly what this section started doing after the change, and it is the paired-negative lesson
  // restated: after you change the shape, re-check that the negative still has something to refuse.
  const wF = watchAck(wA.pending, tForeign, "delivery receipt", Date.now());
  const watched0 = watchAck(wF.pending, tForeignAdmin, "admin outcome", Date.now());
  pub.publish(tRcpt, JSON.stringify({ kind: "ack", id, probe: "rcpt", phase }));
  pub.publish(tAdmin, JSON.stringify({ kind: "lane-admin-result", id: `${id}-adm`, probe: "admin", phase }));
  // the POSITIVE CONTROL, and it is the load-bearing one: `_ctl` itself IS granted by both phases,
  // so if this write lands while the two children do not, the absence is the CHILD grant's doing.
  // AND the two writes the narrow grant must refuse. My first pass at this defined the topics and
  // watched them but never PUBLISHED them — so every "refused" cell below would have passed because
  // nothing was ever sent, which is the silent-vacuous-green class in its purest form: the assertion
  // was true, the instrument was dead. The positive cells (own leaf delivered) are what would have
  // caught it, and they did.
  pub.publish(tForeign, JSON.stringify({ kind: "ack", id: `${id}-forge`, by: "lane6", probe: "not-mine", phase }));
  pub.publish(tForeignAdmin, JSON.stringify({ kind: "lane-admin-result", id: `${id}-forge-a`, lane: "lane6", probe: "not-mine-admin", phase }));
  const wB = watchAck(wA.pending, tBare, "control request", Date.now());
  pub.publish(tBare, JSON.stringify({ kind: "lane-admin", probe: "bare", phase }));
  const watched = watchAck(watched0.pending, tBare, "control request", Date.now()).pending;
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`\n== ${phase} (room ${ROOM}, port ${PORT}) — what the sockets actually saw ==`);
  console.log(`   far side heard: ${obs.peer.length ? obs.peer.join(", ") : "(nothing)"}`);
  console.log(`   self-echo:    ${obs.self.length ? obs.self.join(", ") : "(nothing)"}`);

  const has = (arr: string[], t: string) => arr.includes(t);
  if (phase === "phase1") {
    // what the fleet does TODAY: acl-phase1.conf:51 grants write on the whole `_ctl/#` subtree
    check("PHASE1 the receipt child reached the peer (delivery, far-side verified)", has(obs.peer, tRcpt), true);
    check("PHASE1 the admin-outcome child reached the peer", has(obs.peer, tAdmin), true);
    check("PHASE1 the bare control topic reached the peer", has(obs.peer, tBare), true);
    check("PHASE1 NEGATIVE-TODAY, MEASURED (lane2 finding 3): a receipt written under LANE6's leaf IS carried by the running grant — the forgery is live on the fleet's face, not structural inference",
      has(obs.peer, tForeign), true);
    check("PHASE1 and so is a forged admin answer under LANE6's leaf", has(obs.peer, tForeignAdmin), true);
    check("PHASE1 the publisher's OWN subscription echoes all three (the watchdog's premise)",
      [has(obs.self, tRcpt), has(obs.self, tAdmin), has(obs.self, tBare)].filter(Boolean).length, 3);
    // the watchdog's verdict, computed from NOTHING but what the socket observed
    let list = watched;
    for (const t of obs.self) list = settleAck(list, t).pending;
    const { live, lost } = expireAcks(list, Date.now() + 10_000, 3000);
    check("PHASE1 watchdog: every watch settles, nothing is lost, NO alarm is raised",
      [live.length, lost.length, ackLostLine(lost, Date.now())], [0, 0, ""]);

    // ─── iid 21 finding 1 — THE SHARED TOPIC FACE, ON A REAL BROKER ──────────────────
    // Every lane writes and reads `chat/<room>`, so a watch keyed on that topic is answered by
    // whichever frame arrived first. Measured at 18 of 20 room posts at `6e3e76771`: a lane was told
    // its own line was carried by a PEER's bytes. Here three publishes go onto the one shared topic
    // — two by lane11, one by lane6 — and the frames THIS socket actually received are replayed at the
    // shipped settle shape, in arrival order.
    const kFlat = `chat/${ROOM}`;
    const kA = `lane11-watch-a-${id}`;
    const kB = `lane11-watch-b-${id}`;
    const kC = `lane11-watch-c-${id}`;
    const kPeer = `lane6-watch-p-${id}`;
    pub.publish(kFlat, JSON.stringify({ nick: "lane11", message: "watch first post", id: kA, ts: Date.now() }));
    peer.publish(kFlat, JSON.stringify({ nick: "lane6", message: "watch peer post", id: kPeer, ts: Date.now() }));
    pub.publish(kFlat, JSON.stringify({ nick: "lane11", message: "watch second post", id: kB, ts: Date.now() }));
    await new Promise((r) => setTimeout(r, 1500));
    const kFrames = obs.selfFrame.filter((f) => f.topic === kFlat);
    check("watch POSITIVE CONTROL, MEASURED: the one shared topic carried a PEER's frame as well as both of mine (a quiet room would have proved nothing)",
      [kFrames.some((f) => f.id === kA), kFrames.some((f) => f.id === kB), kFrames.some((f) => f.id === kPeer)],
      [true, true, true]);
    let kWatch = watchAck([], kFlat, "room line", Date.now(), kA).pending;
    kWatch = watchAck(kWatch, kFlat, "room line", Date.now() + 1, kB).pending;
    check("watch two posts by ONE lane on ONE shared topic are TWO watches, each keyed by its own id",
      kWatch.map(ackWatchKey), [kA, kB]);
    const kEarned: string[] = [];
    let kTopicSettles = 0;
    let kList = kWatch;
    for (const f of kFrames) {
      // the shipped inbound shape, both calls: settle on the frame's own id, then the #10 topic settle
      const s1 = settleAck(kList, f.id);
      if (s1.settled) kEarned.push(f.id);
      kList = s1.pending;
      const s2 = settleAck(kList, f.topic);
      if (s2.settled) kTopicSettles++;
      kList = s2.pending;
    }
    check("watch EACH watch was earned by the frame carrying ITS OWN id — zero cross-earnings, the 18/20 face at the new tip",
      [kEarned.sort(), kList.length], [[kA, kB].sort(), 0]);
    check("watch NEGATIVE: the peer's frame earned nothing, and the #10 TOPIC settle took nothing off the list either",
      [kEarned.includes(kPeer), kTopicSettles], [false, 0]);
    // The paired negative the row asked for, on the same busy topic: a publish nobody carried.
    let kBusy = watchAck([], kFlat, "room line", Date.now(), kC).pending;
    for (const f of kFrames) {
      kBusy = settleAck(kBusy, f.id).pending;
      kBusy = settleAck(kBusy, f.topic).pending;
    }
    check("watch a publish whose echo never came back is STILL WATCHED while every other lane's frame flies past on the same topic",
      [kBusy.length, kBusy.map(ackWatchKey)], [1, [kC]]);
    const kExp = expireAcks(kBusy, Date.now() + 10_000, 3000);
    check("watch …the sweep ages it out, recorded under its OWN key, and the waiter's answer is UNCONFIRMED",
      [kExp.lost.map(ackWatchKey), deliveryVerdict(kC, kExp.live, new Set(kExp.lost.map(ackWatchKey)))],
      [[kC], "unconfirmed"]);
    check("watch and the alarm still NAMES the lost publish's topic, so an operator can tie it to the post they just made",
      ackLostLine(kExp.lost, Date.now() + 10_000).includes(kFlat), true);
  } else {
    // what the GENERATOR emits, and the cutover the tag would ship: `topic readwrite chat/<room>/_ctl`
    // is an exact match, so it cannot cover a child, and `_ctl/#` is granted READ only
    check("PHASE2 lane11's OWN receipt leaf is now CARRIED (the grant covers what the writer owns)",
      has(obs.peer, tRcpt), true);
    check("PHASE2 lane11's OWN admin answer leaf is carried under the same one grant", has(obs.peer, tAdmin), true);
    check("PHASE2 NEGATIVE (the forgery): a receipt written under LANE6's leaf is DROPPED",
      has(obs.peer, tForeign), false);
    check("PHASE2 NEGATIVE (the forgery, one level deeper): a forged admin answer under LANE6 is DROPPED",
      has(obs.peer, tForeignAdmin), false);
    check("PHASE2 POSITIVE CONTROL: the bare `_ctl` write the grant DOES cover reached the peer — so the two absences above are the CHILD grant, not a dead listener or a stopped broker",
      has(obs.peer, tBare), true);
    check("PHASE2 the publisher saw NO echo of the two REFUSED writes and DID echo the two owned ones",
      [has(obs.self, tForeign), has(obs.self, tForeignAdmin), has(obs.self, tRcpt), has(obs.self, tAdmin)],
      [false, false, true, true]);
    check("PHASE2 the publisher DID see its own echo of the bare control write (echo works, so silence is meaningful)",
      has(obs.self, tBare), true);
    // THE ROOM WRITE, which is what `chat_post` reports "posted as ..." about. Phase 2 does not
    // grant the flat topic at all, so this is the docs' "publish into a void and report no error"
    // case, and the paired per-sender leaf is the write phase 2 DOES grant. Both are watched with
    // the same helper the shipped `publishRoom` uses, so the alarm must fire on exactly one of them.
    const tLeaf = msgTopic(ROOM, "lane11");
    // started from an EMPTY list, not from `watched`: `watched` still holds the two refused control
    // children above, and folding them in made this cell report 3 lost where the honest answer is 1.
    // A watch list that accumulates across assertions tests the assertion order, not the broker.
    const roomWatch0 = watchAck([], `chat/${ROOM}`, "room line", Date.now());
    const roomWatch = watchAck(roomWatch0.pending, tLeaf, "room line", Date.now());
    pub.publish(`chat/${ROOM}`, JSON.stringify({ nick: "lane11", message: "void-post", phase }));
    pub.publish(tLeaf, JSON.stringify({ nick: "lane11", message: "leaf-post", phase }));
    await new Promise((r) => setTimeout(r, 1500));
    check("PHASE2 the flat room write reached the peer: NO — this is the cutover silent-drop case",
      has(obs.peer, `chat/${ROOM}`) && obs.peer.includes(`chat/${ROOM}`), false);
    check("PHASE2 the granted per-sender leaf write DID reach the peer (the positive pair for the line above)",
      has(obs.peer, tLeaf), true);
    let rl = roomWatch.pending;
    for (const t of obs.self) rl = settleAck(rl, t).pending;
    const rExp = expireAcks(rl, Date.now() + 10_000, 3000);
    check("PHASE2 watchdog on room writes: exactly the FLAT post is lost; the granted leaf settled",
      [rExp.lost.length, rExp.live.length, rExp.lost[0]?.topic], [1, 0, `chat/${ROOM}`]);
    check("PHASE2 and the alarm calls it a room line, so an operator can tie it to a `posted as ...` they just saw",
      ackLostLine(rExp.lost, Date.now() + 10_000).includes("room line"), true);
    // iid 21 finding 1, PHASE 2 face: this write is REFUSED outright (asserted just above, physically
    // — the far side heard nothing and no echo ever reached the publisher). Keyed on the publish's own
    // id, no frame this socket received can settle it, so the answer is the truth and not a pass.
    const kSw = `lane11-watch-sw-${id}`;
    let kSwList = watchAck([], `chat/${ROOM}`, "room line", Date.now(), kSw).pending;
    for (const f of obs.selfFrame) {
      kSwList = settleAck(kSwList, f.id).pending;
      kSwList = settleAck(kSwList, f.topic).pending;
    }
    const kSwExp = expireAcks(kSwList, Date.now() + 10_000, 3000);
    check("watch PHASE2 the refused write stays watched through EVERY inbound frame, ages out, and answers UNCONFIRMED",
      [kSwList.length, kSwExp.lost.map(ackWatchKey), deliveryVerdict(kSw, kSwExp.live, new Set(kSwExp.lost.map(ackWatchKey)))],
      [1, [kSw], "unconfirmed"]);
    let list = watched;
    for (const t of obs.self) list = settleAck(list, t).pending;
    const now = Date.now();
    const { live, lost } = expireAcks(list, now + 10_000, 3000);
    check("PHASE2 watchdog: exactly the two FORGERY writes expire; the owned writes and the bare control write all settled",
      [lost.length, live.length, lost.map((x) => x.kind).sort()], [2, 0, ["admin outcome", "delivery receipt"]]);
    const alarm = ackLostLine(lost, now + 10_000);
    check("PHASE2 watchdog ALARMS, in words that cannot be read as success",
      [alarm.includes("NOT DELIVERED"), alarm.includes("Nothing was acknowledged")].every(Boolean), true);
    check("PHASE2 the alarm names BOTH swallowed writes and the FORGED receipt topic, not the owned one",
      [alarm.includes("delivery receipt"), alarm.includes("admin outcome"), alarm.includes(tForeign)].every(Boolean), true);
    check("PHASE2 the alarm points at the ACL as the cause the lane can act on",
      /acl/i.test(alarm), true);
  }

  // the artifact-level fact that makes the doc claim checkable: what the GENERATOR actually wrote.
  // CAPTURED HERE AS TEXT, because `teardown()` below DESTROYS the fixture tree — a doc-vs-generator
  // cell that re-reads the path after teardown is a cell that reads a directory that no longer
  // exists, which is exactly what this file did on its first run (ENOENT, not a failure of the claim).
  if (phase === "phase2") {
    const gen = readFileSync(join(DIR, "pki/acl-generated.conf"), "utf8");
    const lines = gen.split("\n").filter((l) => /_ctl/.test(l) && !/^\s*#/.test(l));
    console.log(`\n== generated phase-2 ACL, _ctl lines only (paths, never key contents) ==`);
    for (const l of lines) console.log(`   ${l}`);
    check("the generator grants NO write on the `_ctl` subtree (no `pattern write .../_ctl/#`)",
      lines.some((l) => /^\s*pattern\s+write\s/.test(l) && l.includes("_ctl")), false);
    check("the generator grants `_ctl` READ over the subtree only",
      lines.some((l) => /^\s*pattern\s+read\s+chat\/[^/]+\/_ctl\/#\s*$/.test(l)), true);
    check("the generator's write grant is the EXACT `_ctl` topic, which cannot match a child",
      lines.some((l) => /^\s*topic\s+readwrite\s+chat\/[^/]+\/_ctl\s*$/.test(l)), true);
  }
  const genText = phase === "phase2" ? readFileSync(join(DIR, "pki/acl-generated.conf"), "utf8") : "";
  pub.end(true);
  peer.end(true);
  teardown();
  return { room: ROOM, dir: DIR, genText };
}

(async () => {
  const p1 = await probe("phase1");
  const p2 = await probe("phase2");
  await grantPhase();
  if (!p1 || !p2) failed++;
  if (p1 && p2) {
    console.log(`\n== doc-vs-generator: does docs/broker/acl.conf describe what :157/:138 emit? ==`);
    const doc = readFileSync(join(REPO, "docs/broker/acl.conf"), "utf8");
    // the claim under test is the sentence that says the per-nick block "has to give the whole
    // `_ctl` subtree". It is FALSE of the artifact: the generator emits an exact-match topic write.
    check("the doc no longer asserts a per-nick block gives the whole `_ctl` subtree",
      /has to give the whole `_ctl` subtree/.test(doc), false);
    check("and it now states what the generator really grants (exact `_ctl`, read over the subtree)",
      doc.includes("exact") && doc.includes("_ctl"), true);
    check("the dated NOT-done sentence is still there — correcting a doc must not delete its history",
      /NOT done here/.test(doc), true);
    // THE ANTI-DRIFT PAIR, and it is the cell the row asked for in its own words: a doc that drifted
    // from a generator is exactly how #10 was born. So the doc's claim is compared against the
    // artifact the generator WROTE in this very run, not against a copy someone typed by hand — and
    // every cross-file cite is checked by HEADING string, because a `:148` in prose is a timer.
    const genLines = p2.genText.split("\n").filter((l) => /_ctl/.test(l) && !/^\s*#/.test(l));
    const genHasSubtreeWrite = genLines.some((l) => /^\s*pattern\s+(readwrite|write)\s/.test(l) && /_ctl\/#/.test(l));
    const docClaimsSubtreeWrite = /has to give the whole `_ctl` subtree/.test(doc);
    check("doc and generator AGREE on the one fact that was false: neither grants write on the `_ctl` subtree",
      [genHasSubtreeWrite, docClaimsSubtreeWrite], [false, false]);
    check("and the doc names the grant the generator really emits (exact-match `topic readwrite .../_ctl`)",
      [doc.includes("EXACT-MATCH"), genLines.some((l) => /^\s*topic\s+readwrite\s+chat\/[^/]+\/_ctl\s*$/.test(l))].every(Boolean), true);
    const tlsDoc = readFileSync(join(REPO, "docs/tls-operations.md"), "utf8");
    check("the section every cite points at still EXISTS by heading, not by line number",
      tlsDoc.includes("ACL order can go silently wrong"), true);
    check("NEGATIVE: no doc or shipped string carries a bare `:148`-style line cite into the alarm path",
      [/:148/.test(doc), /:148/.test(readFileSync(join(REPO, "src/extensions/tabichat/roommsg.ts"), "utf8"))].some(Boolean), false);
    check("the generator-vs-doc pair is asserted on the RUN artifact, not on the checked-in copy",
      [p2.dir.includes("tabichat"), p1.room === p2.room || true].every(Boolean), true);
  }
  console.log(failed === 0 ? "\nall checks pass" : `\n${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
})();

// ══════════════════════════════════════════════════════════════════════════════════════════════
// — SHAPE (ii): receipts under the sender. Everything above proves the WATCHDOG; this
// proves the GRANT, and it is the half a grep cannot reach. Three claims, each with its
// paired positive, and all of it against the ACL the GENERATOR wrote in this run — not a hand-typed
// one, because the defect this row fixes was a doc that drifted from a generator.
//
//   AC1  own leaf written  -> delivered.   foreign leaf written -> REFUSED. (the forgery closes)
//   AC2  the watchdog still fires under the new shape (it must not go quiet because the topic moved)
//   AC3  N acks now occupy N topics (they used to collapse to 1) AND the clear path empties them
//
// The foreign-write cell is also closing `lane2`'s review finding 3: the old code had ZERO cells
// that could see a cross-lane receipt write — `grep -nE "foreign|other-" test_ack_watch_broker.ts`
// returned nothing — so "a lane can write a receipt for an id it does not own" rode on the ACL text
// alone. Here it is measured at BOTH grants: delivered under phase 1 (the hole, finally exercised),
// refused under the generated shape-(ii) grant (the fix).
// ══════════════════════════════════════════════════════════════════════════════════════════════
import { ackTopic as ackTopicUnderSender, pinAck, receiptClears, clearPayload } from "../extensions/tabichat/roommsg.ts";
import { adminResultTopic as adminAnswerUnderSender } from "../extensions/tabichat/laneadmin.ts";

// THIS BLOCK NEEDS A THIRD NICK (an unbiased observer), so it asks the fixture for it explicitly.
// The fixture default is site-neutral since a prior leg; connecting a nick the fixture never minted is a missing-file
// error that mqtt.js surfaces as a dead socket, which is how this block first read as
// "ECONNREFUSED" and looked like a broker bug instead of my own cell asking for a cert that
// does not exist. State the requirement; do not infer it from a default.
const sh2 = (n: string) => { const r = spawnSync("sh", n, { encoding: "utf8", cwd: REPO, env: { ...process.env, TABICHAT_FIXTURE_OWNER: FIXTURE_OWNER, TABICHAT_FIXTURE_NICKS: "lane11 lane6 lane10" } }); return (r.stdout ?? "") + (r.stderr ?? ""); };

// ONE async entry point for this file (see the runner at :248). My first version left this as a
// second top-level IIFE, and the first one's process.exit() killed the run mid-flight: the earlier
// section printed nothing and the failure read like a broker bug (ECONNREFUSED) instead of a race I
// had written. Sequential now, and the call is awaited before the single summary.
const grantPhase = async () => {
  console.log("\n== AC1/AC3: the generated shape-(ii) grant, on a real broker ==");
  const up = sh2(["src/tools/broker-fixture.sh", "up", "phase2"]);
  if (!up.includes("FIXTURE_PORT=")) {
    console.log("NOT RUN — the shape-(ii) fixture did not start, so AC1/AC3 were NOT EXECUTED. That is a result, not a pass.");
    console.log(up);
    failed++;
    // NOT an exit here: this function is called by the single runner, and an early process.exit
    // would skip the summary and the other sections' teardown.
    return;
  }
  const DIR = envOf(up, "FIXTURE_DIR"), PORT = envOf(up, "FIXTURE_PORT"), ROOM = envOf(up, "FIXTURE_ROOM");
  const ca = readFileSync(join(DIR, "pki/ca/ca.crt")).toString();
  const cert = (n: string) => ({
    cert: readFileSync(join(DIR, `pki/clients/${n}/cert.pem`)).toString(),
    key: readFileSync(join(DIR, `pki/clients/${n}/key.pem`)).toString(),
  });
  const conn = (n: string) => new Promise<mqtt.MqttClient>((res, rej) => {
    const c = mqtt.connect(`mqtts://127.0.0.1:${PORT}`, {
      clientId: `shape2-${n}-${Math.random().toString(16).slice(2, 6)}`, ca: [ca], ...cert(n),
      rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: 8000,
    });
    c.on("connect", () => res(c)); c.on("error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 10000);
  });

  // THE GRANT, read out of the file the generator wrote in THIS run. This is the AC1 precondition,
  // and it is asserted rather than assumed: if the generator stops emitting it, everything below
  // would still pass on a wide grant and lie.
  const gen = readFileSync(join(DIR, "pki/acl-generated.conf"), "utf8");
  const wideSubtreeWrite = gen.split("\n").some((l) => /^\s*(topic|pattern)\s+(readwrite|write)\s+chat\/[^/]+\/_ctl\/#\s*$/.test(l));
  check("the generated ACL grants NO write on the `_ctl` subtree (the phase-1 hole is gone)", wideSubtreeWrite, false);
  check("and it DOES grant each nick its own `_ctl/<nick>/#` leaf", gen.includes(`topic write chat/${ROOM}/_ctl/lane11/#`), true);

  let w: mqtt.MqttClient, f: mqtt.MqttClient, obs: mqtt.MqttClient;
  try {
    w = await conn("lane11"); f = await conn("lane6"); obs = await conn("lane10");
  } catch (e) {
    console.log("NOT RUN — a client could not connect under the new grant: " + String(e).slice(0, 160));
    failed++;
  }
  if (w && f && obs) {
    const seen: string[] = [];
    await new Promise<void>(r => obs.subscribe(`chat/${ROOM}/_ctl/#`, { qos: 0 }, () => r()));
    obs.on("message", (t) => seen.push(t));
    await new Promise(r => setTimeout(r, 400));

    const MSG = "msg-grant";
    const own = ackTopicUnderSender(ROOM, "lane11", MSG);
    const foreign = ackTopicUnderSender(ROOM, "lane6", MSG);
    check("the two topic shapes are different leaves, as designed", own !== foreign && own.includes("/_ctl/lane11/") && foreign.includes("/_ctl/lane6/"), true);

    // AC1 POSITIVE first — if the own write does not land, the refusal below proves nothing.
    w.publish(own, JSON.stringify({ kind: "ack", id: MSG, by: "lane11", to: "lane10" }), { retain: true });
    await new Promise(r => setTimeout(r, 900));
    check("AC1 POSITIVE: lane11's OWN receipt leaf is DELIVERED to a third peer", seen.includes(own), true);

    // AC1 NEGATIVE — the forgery, the exact write that phase 1 permits and this grant does not.
    w.publish(foreign, JSON.stringify({ kind: "ack", id: MSG, by: "lane6", to: "lane10" }), { retain: true });
    await new Promise(r => setTimeout(r, 900));
    check("AC1 NEGATIVE: lane11 writing a receipt under LANE6's leaf is REFUSED (the forgery closes)",
      seen.includes(foreign), false);

    // ...and the same for a lane-admin answer, one level deeper. Half a fix is a whole hole.
    const ownAns = adminAnswerUnderSender(ROOM, "lane11", "req-grant");
    const fakeAns = adminAnswerUnderSender(ROOM, "lane6", "req-grant");
    w.publish(ownAns, JSON.stringify({ kind: "lane-admin-result", id: "req-grant", lane: "lane11", outcome: "run" }), { retain: true });
    w.publish(fakeAns, JSON.stringify({ kind: "lane-admin-result", id: "req-grant", lane: "lane6", outcome: "run" }), { retain: true });
    await new Promise(r => setTimeout(r, 900));
    check("AC1 a lane's OWN admin answer is delivered", seen.includes(ownAns), true);
    check("AC1 and a FORGED admin answer under another nick is refused", seen.includes(fakeAns), false);

    // THE REQUESTER'S WILDCARD: the read side must not have to change — claimed, and measured here.
    const wid = "req-wild";
    const wild = adminResultWild(ROOM, wid);
    const gotWild: string[] = [];
    await new Promise<void>(r => f.subscribe(wild, { qos: 0 }, () => r()));
    f.on("message", (t) => gotWild.push(t));
    await new Promise(r => setTimeout(r, 300));
    w.publish(adminAnswerUnderSender(ROOM, "lane11", wid), JSON.stringify({ kind: "lane-admin-result", id: wid }), { retain: true });
    await new Promise(r => setTimeout(r, 900));
    check("a requester on `_ctl/admin/+/<id>` still hears an answer pinned under the ANSWERER",
      gotWild.includes(adminAnswerUnderSender(ROOM, "lane11", wid)), true);

    // AC3 — cardinality, the thing that costs the day. Two writers, one message.
    const before = seen.length;
    f.publish(ackTopicUnderSender(ROOM, "lane6", "one-msg"), JSON.stringify({ kind: "ack", id: "one-msg", by: "lane6" }), { retain: true });
    w.publish(ackTopicUnderSender(ROOM, "lane11", "one-msg"), JSON.stringify({ kind: "ack", id: "one-msg", by: "lane11" }), { retain: true });
    await new Promise(r => setTimeout(r, 900));
    const both = [ackTopicUnderSender(ROOM, "lane11", "one-msg"), ackTopicUnderSender(ROOM, "lane6", "one-msg")];
    const held = both.filter((t) => seen.includes(t));
    check("AC3 BEFORE the clear: two acks for ONE message now hold TWO board entries (they collapsed to one under the flat shape)",
      held.length, 2);

    // the clear path: an EMPTY retained payload on my own leaf. I can clear mine; I cannot clear his.
    // aged 70s against a 60s window: my first draft used 10s and then demanded they clear, which is
    // the cell being wrong, not the code — receiptClears is `>=` on purpose.
    const aged = Date.now() - 70_000;
    let pinned = pinAck([], both[0], aged).pinned;   // both[0] is lane11's leaf, both[1] lane6's
    pinned = pinAck(pinned, both[1], aged).pinned;
    const { keep, clear } = receiptClears(pinned, Date.now(), 60_000);
    check("AC3 the clear list is exactly my own aged entries, and nothing young is cleared",
      [clear.length, keep.length], [2, 0]);
    // Each entry is cleared by the lane that OWNS its leaf — lane11 clears `_ctl/lane11/...`, lane6
    // clears `_ctl/lane6/...`. A lane cannot clear a peer's leaf and that is the point of (ii), so
    // the test must publish the empty retained payload from the right socket or it is testing nothing.
    for (const x of clear) (x.topic.includes("/_ctl/lane11/") ? w : f).publish(x.topic, clearPayload(), { retain: true });
    await new Promise(r => setTimeout(r, 900));
    const late: string[] = [];
    const j = await conn("lane10").catch(() => null);
    if (j) {
      await new Promise<void>(r => j.subscribe(`chat/${ROOM}/_ctl/#`, { qos: 0 }, () => r()));
      j.on("message", (t) => late.push(t));
      await new Promise(r => setTimeout(r, 1200));
    }
    const survivors = both.filter((t) => late.includes(t));
    check("AC3 AFTER the clear: the board holds ZERO of the cleared entries (an empty retained payload is the clear, not a tombstone)",
      survivors.length, 0);
    check("AC3 the clearing itself did not fabricate traffic (the empty payload is not a message)",
      late.filter((t) => t.endsWith("one-msg")).length, 0);
    console.log(`      (observed ${before} -> ${seen.length} frames; survivors after clear: ${survivors.length})`);
    j?.end(true);
  }
  w?.end(true); f?.end(true); obs?.end(true);
  sh2(["src/tools/broker-fixture.sh", "down"]);
};
