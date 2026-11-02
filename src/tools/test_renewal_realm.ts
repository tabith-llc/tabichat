// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * iid 20, leg 889 Cell A — THE REALM, MEASURED.
 *
 * Why this file exists. The renewal read failed: a guinea seat went 1 → 2 established sockets on a
 * remote renew while `grep -c '[tabichat][client]'` returned 0 in BOTH diag generations, on bytes
 * re-derived md5-equal to the shipped tip. Every cell in every existing gate FAKES the store — a
 * `{ current: … }` object the test itself builds — so nothing has ever touched the premise the fix
 * stands on: that a SECOND factory pass in the same process reads the SAME
 * `globalThis[Symbol.for("tabichat.mqttClient")]` holder the first pass wrote. `index.ts` is
 * `export default function (pi: ExtensionAPI)`, a factory, so the question is answerable here with
 * no broker, no room, no deploy and no restart: call it twice and look.
 *
 * WHAT IS REAL HERE: `globalThis`, the `Symbol.for` registry, the holder object the factory mints
 * with its own `??=`, the `let client = MQTT_CLIENT.current` read, the shipped
 * `if (MQTT_CLIENT.current === client) endPriorClient(…)` shutdown statement, and all of
 * `endPriorClient`'s bookkeeping. THE STORE IS NEVER FAKED.
 * WHAT IS STUBBED, and why it cannot affect the question: the three package externals
 * (`mqtt`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`), rewritten at load time to
 * scratch files, because this venue has no `node_modules` and creating one would move
 * `typecheck_ext` off the stub face the gates are quoted at. `mqtt.connect` is asserted NEVER to be
 * called, so no socket exists in this run by construction; `Type`/`defineTool` exist only so the
 * factory body can finish registering its tools. The `ExtensionAPI` is the recording fake the spec
 * asked for.
 *
 * HONEST LIMITS, before any number. (1) This is one process and one realm. It measures whether the
 * mechanism holds for two factory passes in a process; it CANNOT show whether pi's replacement path
 * keeps the same V8 realm — that read needs a live seat, which is above a lane. (2) The sentinel
 * stands in for a client a run constructed and published to the store; every assertion about it is
 * executed by the shipped code, not by this file. (3) A cell that cannot fail is not printed as
 * evidence: the mqtt stub's call count and the diag-channel control are reported so a zero is
 * earned, not assumed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";
import {
  CLIENT_EVENTS,
  MQTT_CLIENT_KEY,
  clientFaceNote,
  countBrokerSockets,
  endPriorClient,
  type ClosableClient,
} from "../extensions/tabichat/laneadmin.ts";

let failed = 0;
let okCount = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else {
    okCount++;
    console.log(`ok    ${name}: ${g}`);
  }
};

// ─── the three package externals, stubbed at LOAD time (the store is not) ──────────────────────
const stubDir = mkdtempSync(join(tmpdir(), "iid20-realm-"));
const EXT = join(stubDir, "index.ts");
const EXT_INDEX = join(import.meta.dirname, "..", "extensions", "tabichat", "index.ts");
const EXT_LANE = join(import.meta.dirname, "..", "extensions", "tabichat", "laneadmin.ts");
writeFileSync(
  join(stubDir, "mqtt.ts"),
  `const clients = [];\nexport const connectCalls = () => clients.length;\nconst factory = {\n  connect(url, opts) {\n    globalThis.__iid20_connect_calls = (globalThis.__iid20_connect_calls ?? 0) + 1;\n    const c = {\n      url, opts, calls: [],\n      on(ev) { this.calls.push("on:" + String(ev)); },\n      publish(t, p) { this.calls.push("publish"); },\n      subscribe(t) { this.calls.push("subscribe"); },\n      end(force) { this.calls.push("end:" + (force === true)); },\n      removeAllListeners(ev) { this.calls.push("off:" + String(ev)); },\n      connected: false,\n    };\n    clients.push(c);\n    return c;\n  },\n};\nexport default factory;\n`,
);
writeFileSync(
  join(stubDir, "pi-ai.ts"),
  `const T = new Proxy(function () {}, { get: () => T, apply: () => ({ type: "object" }) });\nexport const Type = T;\n`,
);
writeFileSync(
  join(stubDir, "pi-ca.ts"),
  `export const defineTool = (t) => t;\nexport const isToolCallEventType = () => false;\n`,
);

plugin({
  name: "iid20-realm-externals",
  setup(b) {
    // Only the ENTRY module is rewritten, and only its three bare specifiers; every relative
    // import inside it (laneadmin.ts, roommsg.ts, …) resolves for real from its own directory.
    // The filter tolerates a query string, because A5 deliberately imports the file a SECOND time
    // as `…index.ts?iid20fresh=1` to get a fresh module instance in the same realm. Without this,
    // the fresh import would resolve the REAL package externals and the run would die on bun's strict
    // ESM link check instead of measuring anything.
    b.onLoad({ filter: /[/\\]extensions[/\\]tabichat[/\\]index\.ts(\?.*)?$/ }, (a) => ({
      loader: "ts",
      contents: readFileSync(a.path.split("?")[0], "utf8")
        .replace(`from "mqtt"`, `from "${join(stubDir, "mqtt.ts")}"`)
        .replace(`from "@earendil-works/pi-ai"`, `from "${join(stubDir, "pi-ai.ts")}"`)
        .replace(`from "@earendil-works/pi-coding-agent"`, `from "${join(stubDir, "pi-ca.ts")}"`),
    }));
  },
});

// ─── the recording fake ExtensionAPI ───────────────────────────────────────────────────────────
type Rec = { ev: string; fn: (...a: never[]) => unknown };
const makePi = (tag: string) => {
  const handlers: Rec[] = [];
  const other = new Map<string, number>();
  const flags: Record<string, unknown> = { tabichat: true, room: "realm-test" };
  const base: Record<string, unknown> = {
    on: (ev: string, fn: (...a: never[]) => unknown) => void handlers.push({ ev, fn }),
    getFlag: (name: string) => flags[name],
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    sendUserMessage: () => undefined,
  };
  // Anything the factory touches that this file has not named is RECORDED, not silently no-opped:
  // a hidden call site is how a measured PASS turns into a fake one, so the count is printed below.
  const pi = new Proxy(base, {
    get(t, p: string) {
      if (p in t) return t[p];
      other.set(p, (other.get(p) ?? 0) + 1);
      return () => undefined;
    },
  });
  return { pi, handlers, other, tag };
};

/** the shipped teardown statement, selected by its own source text rather than by an index. */
const teardownHandlers = (hs: Rec[]) => hs.filter((h) => /endPriorClient\(MQTT_CLIENT/.test(String(h.fn)));
const INDEX_SRC = readFileSync(EXT_INDEX, "utf8");
const REGISTERED = (ev: string) =>
  (INDEX_SRC.match(new RegExp(`^\\s*pi\\.on\\("${ev}"`, "gm")) ?? []).length;

const holder = () => (globalThis as Record<PropertyKey, unknown>)[MQTT_CLIENT_KEY] as { current: ClosableClient | null } | undefined;

/** a client with real listener semantics: it answers "how many times would one inbound line execute?" */
const armedClient = () => {
  const attached = new Set<string>();
  const calls: string[] = [];
  return {
    calls,
    on(ev: string) { attached.add(ev); },
    end(force?: boolean) { calls.push(`end:${force === true}`); },
    removeAllListeners(ev?: string | symbol) { attached.delete(String(ev)); calls.push(`off:${String(ev)}`); },
    executions: (ev: string) => (attached.has(ev) ? 1 : 0),
    arm() { for (const ev of CLIENT_EVENTS) attached.add(ev); return this; },
  } as ClosableClient & { calls: string[]; executions: (ev: string) => number; arm(): unknown };
};

// ─── A1 — is the key registered on the realm at all? (read from laneadmin.ts, never hardcoded) ──
const keyName = Symbol.keyFor(MQTT_CLIENT_KEY);
check("A1 the store key is a REGISTERED realm symbol (Symbol.keyFor non-null, so the registry is the shared one)", typeof keyName, "string");
check("A1 re-foring that name returns the SAME symbol object — got " + JSON.stringify({ keyName }), keyName ? Symbol.for(keyName) === MQTT_CLIENT_KEY : false, true);
check("A1 no holder exists on globalThis before any factory pass runs", holder(), undefined);

// ─── A2 — pass 1 ──────────────────────────────────────────────────────────────────────────────
const factory = ((await import(EXT_INDEX)) as { default: (pi: unknown) => void }).default;
const one = makePi("pass1");
factory(one.pi);
const h1 = holder();
check("A2 pass 1 minted the holder on real globalThis under the exported key", typeof h1, "object");
check("A2 and it starts empty", h1?.current ?? null, null);
const ss1 = one.handlers.filter((x) => x.ev === "session_start").length;
const sd1 = one.handlers.filter((x) => x.ev === "session_shutdown").length;
check(`A2 pass 1 registered every session_start the file names (source ${REGISTERED("session_start")}, recorded ${ss1})`, ss1, REGISTERED("session_start"));
check(`A2 pass 1 registered every session_shutdown the file names (source ${REGISTERED("session_shutdown")}, recorded ${sd1})`, sd1, REGISTERED("session_shutdown"));
// A REAL instrument, not a restated literal: the count is kept on the realm by the stub itself, so it
// cannot be zero because nobody read it. It is the control that makes every `unhooked: 0` above mean
// "no socket was involved in this run" rather than "nothing was measured".
check("A2 CONTROL the mqtt stub's own realm counter records the calls this run made", (globalThis as Record<string, number>).__iid20_connect_calls ?? 0, 0);

// ─── A3 — the sentinel, then pass 2 in the SAME process ─────────────────────────────────────────
const sentinel = armedClient();
sentinel.arm();
if (h1) h1.current = sentinel; // stands in for index.ts's `MQTT_CLIENT.current = client` after connect
check("A3 one inbound room line would execute ONCE on the inherited client before any teardown", sentinel.executions("message"), 1);
const two = makePi("pass2");
factory(two.pi);
const h2 = holder();
check("A3 pass 2 binds the SAME holder object identity (not a re-minted one) — realm is SHARED", h2 === h1, true);
check("A3 and pass 2 sees what pass 1 left on it", h2?.current === (sentinel as ClosableClient), true);

// The decisive half: run the SHIPPED shutdown statement of pass 2. Its guard is
// `MQTT_CLIENT.current === client`, where `client` is pass 2's own per-run binding seeded at
// `let client = MQTT_CLIENT.current`. The guard can only match if pass 2 actually read the realm
// holder — so a teardown that fires is proof the channel works, not an assumption about it.
const td2 = teardownHandlers(two.handlers);
check(`A3 the shipped teardown statement was found among pass 2's ${two.handlers.length} registrations (${td2.length} of ${REGISTERED("session_shutdown")} shutdown handlers)`, td2.length >= 1, true);
await td2[td2.length - 1].fn({ reason: "new" } as never, {} as never);
check("A3 pass 2's SHUTDOWN path force-closed then unhooked the inherited client, per event", sentinel.calls, ["end:true", "off:connect", "off:error", "off:message"]);
check("A3 and one inbound room line now executes ZERO times on it — the acceptance, on real code", sentinel.executions("message"), 0);
check("A3 all three events unreachable, not only the one the room duplicates on", CLIENT_EVENTS.map((e) => sentinel.executions(e)), [0, 0, 0]);
check("A3 the holder pass 1 wrote is the one pass 2 emptied (same object, one realm)", h1?.current ?? null, null);

// ─── A4 — NEGATIVE PAIR: no sentinel at the second invocation ──────────────────────────────────
// The cell above cannot pass by both branches going unmeasured: with the store empty, pass 3's
// binding must start null, its guard must still reach the helper, and the helper must report the
// empty store rather than unhooking somebody else's socket.
const bystander = armedClient();
bystander.arm();
if (h1) h1.current = null;
const three = makePi("pass3");
factory(three.pi);
const td3 = teardownHandlers(three.handlers);
await td3[td3.length - 1].fn({ reason: "quit" } as never, {} as never);
check("A4 NEGATIVE: with no sentinel the second pass starts null and the store stays empty", [holder()?.current ?? null, bystander.calls.length], [null, 0]);
check("A4 NEGATIVE: and a bystander that is NOT on the store keeps all three events — the scope negative", CLIENT_EVENTS.map((e) => bystander.executions(e)), [1, 1, 1]);
const emptyVerdict = endPriorClient({ current: null }, "session_start, before connect");
// The control's own negative: the counter must be able to read 1, or the zero above is a dead instrument.
const stubMqtt = (await import(join(stubDir, "mqtt.ts"))) as unknown as {
  default: { connect: (u: string, o: unknown) => unknown };
};
stubMqtt.default.connect("mqtt://127.0.0.1:1883", {});
check("A2 CONTROL NEGATIVE: the realm counter is a live instrument — one stubbed connect reads 1", (globalThis as Record<string, number>).__iid20_connect_calls ?? 0, 1);
check("A4 an empty store returns ended true / unhooked 0 (the exact condition the ONLY printing site refuses to print)", [emptyVerdict.ended, emptyVerdict.unhooked], [true, 0]);

// ─── A5 — a RE-EVALUATED MODULE INSTANCE in the same realm (the `/new` reload shape) ────────────
// `/renew` re-runs the factory against already-loaded bytes; a reload re-evaluates the file. Both
// shapes have to reach the same holder, or the channel is inert for one of them.
const sentinel5 = armedClient();
sentinel5.arm();
if (h1) h1.current = sentinel5;
const fresh = ((await import(`${EXT_INDEX}?iid20fresh=1`)) as { default: (pi: unknown) => void }).default;
check("A5 the query-suffixed import really re-evaluated the module (different factory object)", fresh !== factory, true);
const four = makePi("pass4-fresh-module");
fresh(four.pi);
check("A5 and the re-evaluated module STILL binds the same holder — the `??=` is realm-scoped, not module-scoped", holder() === h1, true);
const td4 = teardownHandlers(four.handlers);
await td4[td4.length - 1].fn({ reason: "new" } as never, {} as never);
check("A5 the fresh instance unhooks the previous instance's client", sentinel5.calls, ["end:true", "off:connect", "off:error", "off:message"]);
check("A5 and one inbound line executes 0 times on it afterwards", sentinel5.executions("message"), 0);

// ─── A6 — what this CANNOT see, printed rather than assumed ────────────────────────────────────
const unknownPi = [...one.other, ...two.other, ...three.other, ...four.other];
check(`A6 the fake recorded no unnamed pi.* call site (known-surface only; observed: ${unknownPi.map(([k, n]) => `${k}x${n}`).join(", ") || "none"})`, unknownPi.length, 0);
const PI_ON_TOTAL = (INDEX_SRC.match(/^\s*pi\.on\("/gm) ?? []).length;
check(`A6 each pass registers the file's full handler set on the pi it is handed (${PI_ON_TOTAL} pi.on lines), and nothing un-registers a previous pass`, [one.handlers.length, two.handlers.length, three.handlers.length, four.handlers.length], [PI_ON_TOTAL, PI_ON_TOTAL, PI_ON_TOTAL, PI_ON_TOTAL]);
check(`A6 the session_start registrations that accumulated across 4 passes in this one process`, [one, two, three, four].reduce((n, p) => n + p.handlers.filter((h) => h.ev === "session_start").length, 0), 4 * REGISTERED("session_start"));

// ─── CELL B — the measurement line, both polarities, no broker in sight ────────────────────────
check("B1 the GUINEA face is printable by the helper (empty store, two sockets)", clientFaceNote(false, 2), "storeShared=false count=2");
check("B1 and the healthy face is the same shape (handle present, one socket)", clientFaceNote(true, 1), "storeShared=true count=1");
check("B2 the counter matches string OR number remotePort, and ignores everything else",
  countBrokerSockets([{ remotePort: "8883" }, { remotePort: 8883 }, { remotePort: "1883" }, {}, { remotePort: null }, null] as never[], "8883"), 2);
check("B2 NEGATIVE: no handle on that port is 0, not a shrug", countBrokerSockets([{ remotePort: "1883" }] as never[], "8883"), 0);
check("B2 NEGATIVE: an absent port answers ? rather than inventing a default", countBrokerSockets([{ remotePort: "8883" }] as never[], ""), "?");
check("B3 the note never borrows the teardown discriminator's words, so leg 888's two greps stay separable",
  clientFaceNote(false, 2).includes("closed the prior client"), false);
const faceOrderOk = (src: string) => {
  const read = src.indexOf("const storeSharedAtEntry = MQTT_CLIENT.current !== null;");
  const teardown = src.indexOf('endPriorClient(MQTT_CLIENT, "session_start');
  const line = src.indexOf("clientFaceNote(");
  const connect = src.indexOf("client = mqtt.connect(");
  return read >= 0 && teardown >= 0 && line >= 0 && connect >= 0 && read < teardown && teardown < line && line < connect;
};
check("B4 wiring: entry read, then the teardown, then the line, then the connect — in that order in the shipped file", faceOrderOk(INDEX_SRC), true);
check("B4 wiring NEGATIVE: the predicate refuses a line whose entry read was moved below the teardown", faceOrderOk(
  INDEX_SRC.replace("const storeSharedAtEntry = MQTT_CLIENT.current !== null;", "/* moved away */")
    .replace("const storeSharedAtEntry,", "")), false);
check("B4 wiring: exactly ONE clientFaceNote call site in the shipped extension",
  (INDEX_SRC.match(/clientFaceNote\(/g) ?? []).length, 1);
check("B5 the line rides the existing diag channel at INFO, under its own tag",
  /diag\(\s*"INFO",\s*`\[tabichat\]\[client-face\]/.test(INDEX_SRC), true);
check("B5 and the teardown discriminator string is UNTOUCHED — still built in laneadmin.ts",
  readFileSync(EXT_LANE, "utf8").includes("closed the prior client before connecting"), true);

// ─── CELL C — why ZERO teardown rows is the healthy face, measured not argued ──────────────────
// Leg 888 read `grep -c '[tabichat][client]'` = 0 on bytes equal to the tip and took that as the fix
// not running. The order pi documents (shutdown the old instance, then start the new one) puts the
// OUTGOING run's teardown first, and that site discards the verdict — so by the time the incoming
// run reaches the one site that prints, the holder it would report on is already empty. Cells C1-C3
// run exactly that sequence in one realm and read what the log would have said.
const SILENCE_SHAPE = /if \(MQTT_CLIENT\.current === client\) endPriorClient\(MQTT_CLIENT, "session_shutdown"\);\s*\n\s*client = null;/;
check("C1 the shipped shutdown site DISCARDS the verdict — no diag between the call and `client = null`", SILENCE_SHAPE.test(INDEX_SRC), true);
check("C1 NEGATIVE: the same predicate refuses a site that does print its verdict", SILENCE_SHAPE.test(
  INDEX_SRC.replace(/if \(MQTT_CLIENT\.current === client\) endPriorClient\(MQTT_CLIENT, "session_shutdown"\);/,
    'if (MQTT_CLIENT.current === client) { const v = endPriorClient(MQTT_CLIENT, "session_shutdown"); diag("WARN", v.note); }')), false);
// C2 was written when the start-path guard honoured TWO signals, and that silence was the finding. Leg 891
// adds the third (`prior.destroyed`), because a stalled close unhooks with a non-zero count and so printed
// anyway — the gap that remained was a destroy that FAILED. Rewritten to the new shape, NOT relaxed: the
// predicate now refuses any guard that omits any of the three signals, which is strictly more than it checked
// before, and the negative below proves it bites.
const THREE_SIGNAL_GUARD = /\n[ \t]*if \(prior\.unhooked \|\| !prior\.ended \|\| prior\.destroyed\) diag\("WARN"/;
check("C2 and the only printing site is the start path, guarded on ALL THREE signals (unhooked, failed close, destroy)", THREE_SIGNAL_GUARD.test(INDEX_SRC), true);
check("C2 NEGATIVE: a guard that omits the destroy signal is refused by the same predicate — a failed destroy would be silent", THREE_SIGNAL_GUARD.test(INDEX_SRC.replace(THREE_SIGNAL_GUARD, '\n    if (prior.unhooked || !prior.ended) diag("WARN"')), false);
{
  // the sequence itself: an inherited handle, the outgoing-style teardown, then the incoming start's.
  const store = { current: null as null | ReturnType<typeof armedClient> };
  const run1 = armedClient();
  run1.arm();
  store.current = run1;
  if (store.current === run1) endPriorClient(store, "session_shutdown");
  const incoming = endPriorClient(store, "session_start, before connect");
  check("C3 shutdown-first: the retained client executes 0 room lines afterwards (the fix DID work)", run1.executions("message"), 0);
  check("C3 shutdown-first: and the incoming run reports unhooked 0 / ended true / no prior client", [incoming.unhooked, incoming.ended, incoming.note.includes("no prior client")], [0, true, true]);
  check("C3 which is precisely the condition that prints NOTHING — so 0 rows in the diag log is this face, not a failure", incoming.unhooked || !incoming.ended, false);
}

console.log();
console.log("B-RESULT the two faces that were indistinguishable in the diag log are now one grep apart: `storeShared=false count=2` (empty store, retained socket — the guinea) versus no line at all (the run never reached the connect). Grep `storeShared=`, not `[tabichat][client]`, for this one.");

console.log();
console.log(`A-RESULT realm face: globalThis/ Symbol.for SHARED across ${4} factory passes and 2 module instances in 1 process`);
console.log(`A-RESULT holders seen: ${[h1, h2, holder()].map((h) => (h ? "object" : "none")).join(", ")} — one object, not ${3}`);
console.log();
if (failed) {
  console.log(`${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log(`all checks pass (${okCount} cells)`);
}
rmSync(stubDir, { recursive: true, force: true });
