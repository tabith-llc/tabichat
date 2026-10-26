// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the transport decision (tlsopts.ts) — the client half of
// features/tabichat-mqtt-broker-auth.md, shape (B), phase 1 + phase 3.
//   bun src/tools/test_tlsopts.ts        (exit 1 on any failure)
//
// PURE: no broker, no filesystem, no network. The PEM reader is injected, so a "file missing" cell
// is a map lookup and not a fixture. The PHYSICAL half — that a broker actually refuses an anonymous
// connect and actually drops another nick's topic — is test_broker_auth.ts, and neither file is
// evidence for the other. A green here says the CLIENT decided right; a green there says the
// artifact ENFORCES.
//
// WHY THE NEGATIVES ARE THE POINT. Every rule this module has is a rule about REFUSING: a TLS URL
// with no CA, a half-configured certificate pair, a credential sitting in the URL, a plaintext URL
// under a fleet lock. A module that always returned "connect anyway" would pass every positive cell
// here and be the exact production-mandate violation the project forbids — no silent downgrade, no
// verification quietly turned off to make connectivity work. So each refusal below is paired with
// the case that must still be ALLOWED, and one of these cells (the insecure opt-in) is checked in
// BOTH directions on the same flag.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasUserinfo,
  isPlainScheme,
  isTlsScheme,
  makePemReader,
  pemLooks,
  redactUrl,
  schemeOf,
  SENDER_TOPIC_ENV,
  senderTopicEnabled,
  TLS_ENV,
  TLS_MAX_VERSION,
  TLS_MIN_VERSION,
  transportDecision,
  userinfoError,
  type PemReader,
} from "../extensions/tabichat/tlsopts.ts";

// The repo root, for the ONE cell that reads the python twin of this module to prove both halves
// name the same TLS version bar.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
const says = (name: string, hay: string, needle: string) =>
  check(name, hay.includes(needle), true);
const never = (name: string, hay: string, needle: string) =>
  check(name, hay.includes(needle), false);

// A fake filesystem: the map IS the cell. Contents are marker strings, not PEMs, except where a
// cell is specifically about the PEM block shape.
const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";
const fsMap = (files: Record<string, string>): PemReader => (path) =>
  path in files ? { text: files[path] } : { error: `not found (${path}) — mint it, or fix the path in the launch line` };
const ALL_OK = fsMap({
  "/k/ca.crt": CA_PEM,
  "/k/client.crt": CA_PEM,
  "/k/client.key": KEY_PEM,
});
const env = (o: Record<string, string> = {}): Record<string, string | undefined> => ({ ...o });

console.log("== scheme recognition (an unknown scheme must NOT be treated as plaintext) ==");
check("mqtt:// is plaintext", isPlainScheme("mqtt://broker.example:1883"), true);
check("mqtts:// is TLS", isTlsScheme("mqtts://broker.example:8883"), true);
check("wss:// is TLS", isTlsScheme("wss://host/mqtt"), true);
check("scheme is lowercased", schemeOf("MQTTS://Host:8883"), "mqtts://");
check("a bare host has no scheme", schemeOf("broker.example:1883"), "");
check("tls:// is NOT claimed as plaintext (it is not a known plain form)", isPlainScheme("tls://h:8883"), false);
check("tls:// is not silently treated as anything the module knows", isTlsScheme("tls://h:8883"), false);

console.log("\n== URL redaction and the credentials-in-the-URL refusal ==");
check("redactUrl hides the password", redactUrl("mqtts://wren:hunter2@broker.example:8883"), "mqtts://wren:***@broker.example:8883");
check("redactUrl leaves a clean URL byte-identical", redactUrl("mqtt://broker.example:1883"), "mqtt://broker.example:1883");
check("redactUrl leaves a user-only URL alone", redactUrl("mqtt://wren@broker.example:1883"), "mqtt://wren:***@broker.example:1883");
never("the secret is NOT in the redacted output", redactUrl("mqtts://wren:hunter2@h:8883"), "hunter2");
check("hasUserinfo true only for userinfo", [hasUserinfo("mqtt://a:b@h"), hasUserinfo("mqtt://h:1883"), hasUserinfo("mqtt://h:1883/a@b")], [true, false, false]);
says("a credential in the URL is a REFUSAL naming the alternative", userinfoError("mqtt://u:p@h"), TLS_ENV.certfile);
never("the refusal line does not echo the secret itself", userinfoError("mqtt://u:hunter2@h"), "hunter2");
check("a clean URL yields no userinfo error", userinfoError("mqtts://h:8883"), "");

console.log("\n== the no-TLS path is UNCHANGED (this leg's own fence) ==");
const dflt = transportDecision("mqtt://broker.example:1883", env(), ALL_OK);
check("a plaintext URL -> plaintext", dflt.mode, "plaintext");
check("no TLS options are invented for it", dflt.tls, undefined);
check("and it is not a refusal", dflt.reasons.length, 0);
check("URL passed through untouched", dflt.url, "mqtt://broker.example:1883");
// SITE-AGNOSTIC by design: there is NO shipped default URL to fall back to,
// and an empty one is a refusal on this side exactly as it is on the python side. A transport layer
// that invents an address is a second path to a broker the operator never configured.
check("an EMPTY url refuses — this repo ships no address", transportDecision("", env(), ALL_OK).mode, "refuse");
check("a null url refuses too", transportDecision(null as unknown as string, env(), ALL_OK).mode, "refuse");
check("and the refusal says there is nothing to connect to", transportDecision("", env(), ALL_OK).reasons[0].includes("empty"), true);

console.log("\n== AC4 positive: TLS with a pinned CA and a client pair connects ==");
const tls = transportDecision(
  "mqtts://broker.example:8883",
  env({
    [TLS_ENV.cafile]: "/k/ca.crt",
    [TLS_ENV.certfile]: "/k/client.crt",
    [TLS_ENV.keyfile]: "/k/client.key",
  }),
  ALL_OK,
);
check("mode is tls", tls.mode, "tls");
check("CA contents were read and carried", tls.tls?.ca, CA_PEM);
check("client cert carried", tls.tls?.cert, CA_PEM);
check("client key carried", tls.tls?.key, KEY_PEM);
check("VERIFICATION IS ON", tls.tls?.rejectUnauthorized, true);
// THE VERSION BAR, ON THIS SIDE, AND AGREEING WITH THE PYTHON SIDE. Node permits 1.2-1.3 by
// default, so these two lines would pass unnoticed if nobody wrote them down; the bar is stated so
// an upgrade cannot move it silently, and the twin check below is what stops the two clients from
// negotiating two different ranges against the same broker.
check("the client states a TLS floor", tls.tls?.minVersion, TLS_MIN_VERSION);
check("and a ceiling", tls.tls?.maxVersion, TLS_MAX_VERSION);
const pyEnv = readFileSync(join(REPO, "src", "src", "tlsenv.py"), "utf8");
check("and the python client names the SAME floor", pyEnv.includes("TLS_MIN_VERSION = ssl.TLSVersion.TLSv1_2"), true);
check("and the SAME ceiling", pyEnv.includes("TLS_MAX_VERSION = ssl.TLSVersion.TLSv1_3"), true);
// The mosquitto-style NAME in quotes is the shape that killed a real connect. tlsenv.py still SPELLS
// it while explaining why it is wrong (header comment, two docstrings), so a substring search on the
// file is the wrong instrument — it reads red on a clean file. This asks the python parser: walk the
// CODE, drop docstrings, and look at real string constants. Green here means the defect cannot be
// back in the code; it says nothing about the prose, which is where the lesson is written down.
const pyProbe = [
  "import ast, sys",
  "src = open(sys.argv[1], encoding='utf-8').read()",
  "t = ast.parse(src)",
  "docs = set()",
  "for n in ast.walk(t):",
  "    if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):",
  "        d = ast.get_docstring(n, clean=False)",
  "        if d: docs.add((n.body[0].lineno, n.body[0].end_lineno))",
  "bad = [c.value for c in ast.walk(t) if isinstance(c, ast.Constant) and isinstance(c.value, str)",
  "       and 'TLSv1.3' in c.value and not any(a <= c.lineno <= b for a, b in docs)]",
  "sys.exit(0 if not bad else 1)",
].join("\n");
// exit 0 = clean, exit 1 = the string is back in CODE, anything else = the probe itself did not run
// (and a probe that did not run is never allowed to read as a pass).
const probe = Bun.spawnSync(["python3", "-c", pyProbe, join(REPO, "src", "src", "tlsenv.py")], {
  stdout: "pipe",
  stderr: "pipe",
});
check("the python-side probe RAN (python3 and tlsenv.py both present)", probe.exitCode <= 1, true);
check("and the python code carries NO string of the form \"TLSv1.3\" (docstrings excepted)", probe.exitCode, 0);
never("no reason recorded on the good path", tls.reasons.join("|"), "not found");

console.log("\n== AC4 negative: a client with no CA configured refuses to start and says why ==");
const noCa = transportDecision("mqtts://broker.example:8883", env(), ALL_OK);
check("no CA at all -> refuse", noCa.mode, "refuse");
says("the refusal names the variable the operator must set", noCa.reasons.join(" "), TLS_ENV.cafile);
says("and it says the thing it refuses to be: a fallback", noCa.reasons.join(" "), "system roots");

const badCa = transportDecision("mqtts://broker.example:8883", env({ [TLS_ENV.cafile]: "/k/nope.crt" }), ALL_OK);
check("CA path set but unreadable -> refuse", badCa.mode, "refuse");
says("the refusal names the PATH", badCa.reasons.join(" "), "/k/nope.crt");
const emptyCa = transportDecision("mqtts://h:8883".replace("h:8883", "broker.example:8883"), env({ [TLS_ENV.cafile]: "/k/empty.crt" }), (p) =>
  p === "/k/empty.crt" ? { text: "" } : { text: CA_PEM },
);
check("a zero-byte CA file -> refuse (not an implicit 'no CA')", emptyCa.mode, "refuse");
const keyAsCa = transportDecision("mqtts://broker.example:8883", env({
  [TLS_ENV.cafile]: "/k/client.key",
  [TLS_ENV.certfile]: "/k/client.crt",
  [TLS_ENV.keyfile]: "/k/client.key",
}), fsMap({ "/k/client.key": KEY_PEM, "/k/client.crt": CA_PEM }));
check("a KEY handed to CAFILE -> refuse, and say it is the wrong block", keyAsCa.mode, "refuse");
says("the message says CERTIFICATE block", keyAsCa.reasons.join(" "), "CERTIFICATE block");

console.log("\n== the certificate pair is all-or-nothing ==");
const halfPair = transportDecision("mqtts://broker.example:8883", env({
  [TLS_ENV.cafile]: "/k/ca.crt",
  [TLS_ENV.certfile]: "/k/client.crt",
}), ALL_OK);
check("cert with no key -> refuse", halfPair.mode, "refuse");
says("and it names the missing half", halfPair.reasons.join(" "), TLS_ENV.keyfile);
const halfPair2 = transportDecision("mqtts://broker.example:8883", env({
  [TLS_ENV.cafile]: "/k/ca.crt",
  [TLS_ENV.keyfile]: "/k/client.key",
}), ALL_OK);
check("key with no cert -> refuse", halfPair2.mode, "refuse");
const noPair = transportDecision("mqtts://broker.example:8883", env({ [TLS_ENV.cafile]: "/k/ca.crt" }), ALL_OK);
check("neither one -> allowed, but the note says the broker may still demand one", noPair.mode, "tls");
says("the note is honest about what will happen", noPair.notes.join(" "), "NO client certificate");

console.log("\n== the fleet lock: MQTT_TLS_REQUIRED must not fall back to plaintext ==");
const locked = transportDecision("mqtt://broker.example:1883", env({ [TLS_ENV.requireTls]: "1" }), ALL_OK);
check("lock on + plaintext URL -> refuse", locked.mode, "refuse");
says("the refusal tells the operator which half to change", locked.reasons.join(" "), "mqtts://");
const lockedTls = transportDecision("mqtts://broker.example:8883", env({ [TLS_ENV.requireTls]: "1", [TLS_ENV.cafile]: "/k/ca.crt" }), ALL_OK);
check("lock on + TLS URL -> connects (the lock is not a ban)", lockedTls.mode, "tls");

console.log("\n== TLS material named against a plaintext URL: that is a misconfiguration, not a no-op ==");
const mixed = transportDecision("mqtt://broker.example:1883", env({ [TLS_ENV.cafile]: "/k/ca.crt" }), ALL_OK);
check("plaintext URL + a pinned CA -> refuse", mixed.mode, "refuse");
says("and it says the CA would be IGNORED", mixed.reasons.join(" "), "IGNORED");

console.log("\n== rejectUnauthorized=false only ever via the explicit opt-in ==");
const insecure = transportDecision("mqtts://broker.example:8883", env({
  [TLS_ENV.cafile]: "/k/ca.crt",
  [TLS_ENV.certfile]: "/k/client.crt",
  [TLS_ENV.keyfile]: "/k/client.key",
  [TLS_ENV.insecure]: "1",
}), ALL_OK);
check("opt-in is honoured when asked for by name", insecure.mode, "tls");
check("and it does turn verification off", insecure.tls?.rejectUnauthorized, false);
check("ONE warning is armed for EVERY connect", insecure.perConnectWarnings.length, 1);
says("the warning names the variable", insecure.perConnectWarnings[0], TLS_ENV.insecure);
const typo = transportDecision("mqtts://broker.example:8883", env({
  [TLS_ENV.cafile]: "/k/ca.crt",
  [TLS_ENV.insecure]: "0",
}), ALL_OK);
check("a typo'd insecure value is a REFUSAL, not a silent 'off'", typo.mode, "refuse");
says("and it says which variable it is complaining about", typo.reasons.join(" "), TLS_ENV.insecure);
const insecureOnPlain = transportDecision("mqtt://broker.example:1883", env({ [TLS_ENV.insecure]: "1" }), ALL_OK);
check("insecure set on a plaintext URL: no TLS to insecure, connects as today", insecureOnPlain.mode, "plaintext");
says("and it says the flag did nothing here", insecureOnPlain.notes.join(" "), "does nothing");

console.log("\n== a URL that is not a URL at all ==");
check("empty MQTT_URL -> refuse, do not connect to nothing", transportDecision("", env(), ALL_OK).mode, "refuse");
check("unknown scheme -> refuse (never inferred as plaintext)", transportDecision("foo://h:1", env(), ALL_OK).mode, "refuse");

console.log("\n== the shape-(B) write gate is opt-in and default-off ==");
check("unset -> off (the shipped flat topic)", senderTopicEnabled(env()), false);
check("MQTT_SENDER_TOPIC=1 -> on", senderTopicEnabled(env({ [SENDER_TOPIC_ENV]: "1" })), true);
check("any other value -> off, and a typo cannot half-enable it", senderTopicEnabled(env({ [SENDER_TOPIC_ENV]: "yes" })), false);

console.log("\n== AC5: no secret value can reach a notify line, a log line or a report ==");
// The ruled test for this is "configure a fake credential and grep the outputs", not an assertion.
// Everything the module can say about a credential is a PATH, so the check is: hand it a value that
// would be catastrophic to print, and prove the string never appears in any output it produces.
const SECRET_MARK = "venya-SUPERSECRET-do-not-print-909";
const leakEnv = {
  [TLS_ENV.cafile]: "/k/ca.crt",
  [TLS_ENV.certfile]: "/k/client.crt",
  [TLS_ENV.keyfile]: "/k/client.key",
};
const leakRead: PemReader = (p) =>
  p.endsWith("ca.crt")
    ? { text: CA_PEM }
    : p.endsWith("client.crt")
      ? { text: CA_PEM }
      : { text: `-----BEGIN PRIVATE KEY-----\n${SECRET_MARK}\n-----END PRIVATE KEY-----` };
for (const d of [
  transportDecision("mqtts://broker.example:8883", env(leakEnv), leakRead),
  transportDecision("mqtts://u:hunter2@broker.example:8883", env(leakEnv), leakRead),
  transportDecision("mqtt://broker.example:1883", env({ ...leakEnv, [TLS_ENV.requireTls]: "1" }), leakRead),
  transportDecision("mqtts://broker.example:8883", env({ ...leakEnv, [TLS_ENV.insecure]: "1" }), leakRead),
]) {
  const spoken = [...d.reasons, ...d.notes, ...d.perConnectWarnings].join(" \n ");
  never("AC5 no refusal/note/warning line carries the key material", spoken, SECRET_MARK);
  never("AC5 no line carries a URL password either", spoken, "hunter2");
  // the KEY CONTENTS are in tls.key by design (the TLS layer needs them); that is the one place a
  // secret is allowed to exist in memory, and it is never a string this module prints.
  if (d.mode === "tls") check("AC5 the key is handed to the socket layer, not dropped", d.tls?.key?.includes(SECRET_MARK), true);
}
// and the DISPLAY form of every URL this module will ever print is redacted
const shownUrl = redactUrl("mqtts://wren:venya-SUPERSECRET-do-not-print-909@broker.example:8883");
never("AC5 redactUrl is what the print path uses, and it hides the value", shownUrl, "venya-SUPERSECRET-do-not-print-909");

console.log("\n== the fs reader the real path uses (makePemReader), on a directory that exists ==");
const real = makePemReader((p) => {
  if (p === "/nope") { const e = new Error("ENOENT") as Error & { code?: string }; e.code = "ENOENT"; throw e; }
  if (p === "/dir") return "";
  return CA_PEM;
});
says("ENOENT reads as 'not found' and names the path", real("/nope").error ?? "", "not found (/nope)");
says("an empty file reads as empty, not as absent", real("/dir").error ?? "", "empty file");
check("a readable file returns its text", real("/k/ca.crt").text, CA_PEM);
check("pemLooks: a certificate is a certificate", pemLooks(CA_PEM, "certificate"), true);
check("pemLooks: a key is NOT a certificate", pemLooks(KEY_PEM, "certificate"), false);
check("pemLooks: a key is a key", pemLooks(KEY_PEM, "private key"), true);

console.log(`\n${failed ? `${failed} FAILED of ${ran}` : `all ${ran} checks pass`}`);
process.exitCode = failed ? 1 : 0;
