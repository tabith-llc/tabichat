// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Transport decision for the tabichat client: shape (B),
 * phase 1 + phase 3 of the broker-auth work.
 *
 * PURE BY DESIGN, and it has to stay that way: this is the module that decides whether a lane
 * speaks TLS or plaintext, so it must be checkable on both truth-table halves with no broker and
 * no filesystem (tools/test_tlsopts.ts injects a fake reader). The socket lives in index.ts.
 *
 * THE RULE IT EXISTS TO ENFORCE: no silent downgrade. A `mqtts://` URL is an instruction, not a
 * preference. If the CA it needs cannot be read, the answer here is `refuse` and the lane STOPS —
 * it does not quietly connect plaintext, because a lane that believes it is encrypted while a
 * peer can read the room is worse than a lane that is offline and knows it. That is the same
 * reasoning as the project's production mandate (never disable TLS verification to make a
 * connection work) and acceptance criterion 4 of the feature row ("a client with no CA configured
 * refuses to start and says why").
 *
 * WHAT IS A PATH AND WHAT IS A SECRET: every value this module reads from the environment is a
 * PATH. Key contents are read from a 0600 file and handed to the TLS layer; nothing here puts a
 * secret in a URL, a notify line, a report, or the room. That is why shape (B) was chosen over a
 * shared password — with client certificates the launch sheet carries paths only.
 */

/** What the caller must do with the URL it has. */
export type TransportMode = "plaintext" | "tls" | "refuse";

export interface TlsOptions {
  /** PEM contents of the pinned CA, read from `MQTT_TLS_CAFILE`. */
  ca?: string;
  /** PEM contents of THIS lane's client certificate (`MQTT_TLS_CERTFILE`). */
  cert?: string;
  /** PEM contents of the matching private key (`MQTT_TLS_KEYFILE`). */
  key?: string;
  /** SNI name, for a broker reached by IP or an alias that is not the leaf CN. */
  servername?: string;
  /**
   * The TLS version BAR, stated rather than inherited. Node's default already permits 1.2 and 1.3,
   * so on a stock runtime these two lines change nothing — they are here so the bar is POINTABLE at
   * three lines instead of living in a runtime default somebody can upgrade out from under, and so
   * the python client (`tlsenv.TLS_MIN_VERSION`/`TLS_MAX_VERSION`) and this one can be proved to
   * name the same range. `docs/broker/tabichat.conf` pins `tls_version tlsv1.3` on the broker, so
   * the ceiling is what a real session negotiates today; the floor is what a future broker may be
   * allowed to say.
   */
  minVersion?: string;
  maxVersion?: string;
  /** Only ever false under the explicit `MQTT_TLS_INSECURE=1` opt-in — never by default. */
  rejectUnauthorized: boolean;
}

export interface TransportDecision {
  mode: TransportMode;
  /** The URL to hand the connector. IDENTICAL to the input — this repo applies no default. */
  url: string;
  /** Present for mode "tls": the options object to merge into `mqtt.connect`. */
  tls?: TlsOptions;
  /** One actionable line per thing the operator must know, in order. Never empty on "refuse". */
  notes: string[];
  /** Why a refusal happened, for the caller's error surface. Empty unless mode is "refuse". */
  reasons: string[];
  /**
   * Text that must be printed ON EVERY CONNECT, not once at boot — the ruled condition for the
   * insecure opt-in (design row phase 3: "if it is set, print the warning on *every* connect").
   * Empty for every other path.
   */
  perConnectWarnings: string[];
}

/** The env names this module owns. Named in one place so README and the test cannot drift apart. */
export const TLS_ENV = {
  cafile: "MQTT_TLS_CAFILE",
  certfile: "MQTT_TLS_CERTFILE",
  keyfile: "MQTT_TLS_KEYFILE",
  servername: "MQTT_TLS_SERVERNAME",
  requireTls: "MQTT_TLS_REQUIRED",
  insecure: "MQTT_TLS_INSECURE",
} as const;

/** Schemes that mean TLS. `wss://` is included because mqtt.js treats it the same way. */
const TLS_SCHEMES = ["mqtts://", "wss://", "tcps://", "ssl://"];
const PLAIN_SCHEMES = ["mqtt://", "tcp://", "ws://"];

/** The scheme of a URL, lowercased, with no userinfo and no path. "" when there is none. */
export const schemeOf = (url: string): string => {
  const m = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/.exec(url ?? "");
  return m ? m[1].toLowerCase() : "";
};

/** Does this scheme demand TLS? An unknown scheme is NOT treated as plaintext. */
export const isTlsScheme = (url: string): boolean =>
  TLS_SCHEMES.includes(schemeOf(url));

/** Is this an accepted plaintext scheme? */
export const isPlainScheme = (url: string): boolean =>
  PLAIN_SCHEMES.includes(schemeOf(url));

/**
 * Strip a password from a URL for DISPLAY.
 *
 * Why this exists and is not decoration: `mqtt.js` error objects carry the URL it was given, and
 * this file's own error path hands that message to `ctx.ui.notify` — which lands in a lane's
 * context and, from there, possibly a report file and the room. A URL that reads
 * `mqtts://<user>:<password>@broker.example:8883` would print the whole secret. The design rule is stronger
 * than redacting it though: credentials must not be in the URL at all, so `userinfoError()` makes
 * that a REFUSAL and this function stays the belt for logs of a URL we never accepted.
 *
 * NOT ANCHORED, AND THAT IS THE FIX. This used to match only when the
 * scheme was the FIRST character of the string, and `mqtt.js` does not hand back a bare URL: its
 * error message reads `connect ECONNREFUSED … url=mqtts://<user>:<pass>@host:8883`, so the pre-redaction
 * at the transport-error site no-opped for exactly the shape it was written to cover, and the
 * durable diagnostic log inherited the anchor through `formatDiagLine`. A credential in a
 * log file is worse than one on a screen — the file outlives scrollback, a renew and a reboot, and
 * sits one grep from every lane on a shared box. So every `scheme://userinfo@` occurrence in the
 * text is redacted now, and the surrounding words are left alone: blanking the whole message would
 * be a worse bug than the leak it was hiding.
 *
 * The userinfo span cannot cross `/ ? #` or a second `@`, which is what keeps an ordinary
 * `user@example.com` mention, or a path carrying `@`, from being rewritten. `userinfoError()`
 * stays anchored on purpose: it answers the different question "is THIS URL, whole, credential-
 * bearing", and a substring match there would refuse a config over an unrelated mention.
 */
const USERINFO_URL = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/?#]*)@/g;

export const redactUrl = (url: string): string =>
  (url ?? "").replace(USERINFO_URL, (_matched, scheme: string, userinfo: string) => {
    const at = userinfo.lastIndexOf(":");
    const user = at < 0 ? userinfo : userinfo.slice(0, at);
    return `${scheme}${user}:***@`;
  });

/** True when the URL carries userinfo (a credential in the URL). */
export const hasUserinfo = (url: string): boolean =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^@/?#]+@/s.test(url ?? "");

/** The actionable refusal for a URL with credentials in it, or "" when the URL is clean. */
export const userinfoError = (url: string): string =>
  hasUserinfo(url)
    ? `MQTT_URL must not carry credentials in the URL userinfo (${redactUrl(url)}): ` +
      `mqtt.js puts the URL in its error objects and those reach ctx.ui.notify, the lane context ` +
      `and possibly a report. Authenticate with ${TLS_ENV.certfile}/${TLS_ENV.keyfile} paths. ` +
      `Nothing was published.`
    : "";

/** What the caller injects so this stays testable without a filesystem. */
export type PemReader = (path: string) => { text?: string; error?: string };

/**
 * Build the fs-backed reader in index.ts. Kept as a factory here so the PEM-shape rules below are
 * ONE set, shared by the test (which injects a map) and the real path (which injects readFileSync).
 */
export const makePemReader = (read: (path: string) => string): PemReader => (path) => {
  const p = (path ?? "").trim();
  if (!p) return { error: "empty path" };
  let text: string;
  try {
    text = read(p);
  } catch (e) {
    const code = String((e as { code?: string })?.code ?? e);
    if (code === "ENOENT") return { error: `not found (${p}) — mint it, or fix the path in the launch line` };
    return { error: `unreadable (${p}: ${code})` };
  }
  if (text === "") return { error: `empty file (${p}) — a zero-byte PEM is a broken certificate` };
  return { text };
};

/**
 * Does the PEM look like the block its variable names? A wrong file under a right name is a real
 * operator error (a key handed to CAFILE verifies nothing and reads as a broken broker).
 */
export const pemLooks = (text: string, want: "certificate" | "private key"): boolean => {
  const needle = want === "certificate" ? "BEGIN CERTIFICATE" : "PRIVATE KEY";
  return text.includes(needle);
};

/** Was the insecure opt-in mentioned at all, by any value? */
const insecureRequested = (env: Record<string, string | undefined>): boolean =>
  (env[TLS_ENV.insecure] ?? "").trim() !== "";

/**
 * The shape-(B) per-sender publish gate, `MQTT_SENDER_TOPIC=1`. DEFAULT OFF, and it must stay off
 * until two things are both true: the broker is on the generated phase-2 ACL, and EVERY reader is
 * running bytes that subscribe `chat/<room>/msg/+`.
 *
 * Why a gate and not the shipped default, said plainly because it is the tempting mistake: a lane
 * that flips this on alone writes a topic nobody else reads, so its posts vanish from the room with
 * NO error anywhere — the publish succeeds at the client, and the design row's migration law
 * ("dual-read, single-write… never a big-bang publish change across live lanes mid-round") is what
 * stands between that and a silent fleet. The READ half is unconditional and already landed here;
 * only the WRITE is gated.
 */
export const SENDER_TOPIC_ENV = "MQTT_SENDER_TOPIC";
export const senderTopicEnabled = (env: Record<string, string | undefined>): boolean =>
  onFlag(env[SENDER_TOPIC_ENV]);

/** Is a value the literal "1" that turns a lock on? Anything else is off, and a typo says so. */
const onFlag = (raw: string | undefined): boolean => String(raw ?? "").trim() === "1";

/**
 * The TLS version bar, as STRINGS, because mqtt.js hands these to Node's `tls` module, which names
 * versions the way `TLSQuery` does ("TLSv1.2") rather than the way Python's `ssl.TLSVersion` does.
 * The python twin is `tlsenv.TLS_MIN_VERSION`/`TLS_MAX_VERSION`; `tools/test_tlsenv.py` and
 * `tools/test_tlsopts.ts` each assert their own half, and the range is the same range on both sides.
 * A transport bar that lives in a runtime default is a bar that moves when Node is upgraded.
 */
export const TLS_MIN_VERSION = "TLSv1.2";
export const TLS_MAX_VERSION = "TLSv1.3";

/**
 * The decision. `env` is the environment, `url` is the resolved MQTT_URL (default already
 * applied by the caller, so this function never invents a host), `read` is the PEM reader.
 *
 * Order matters and is the test surface:
 *   1. credentials in the URL  -> refuse (before any file is touched);
 *   2. TLS demanded by the operator (MQTT_TLS_REQUIRED=1) + a plaintext URL -> refuse,
 *      because "required" that falls back to plaintext is the exact silent downgrade;
 *   3. plaintext URL with a TLS file named -> refuse: the operator clearly meant TLS;
 *   4. TLS URL -> the CA is mandatory (no system roots, no implicit trust), cert/key are a pair.
 */
export const transportDecision = (
  url: string,
  env: Record<string, string | undefined>,
  read: PemReader,
): TransportDecision => {
  const base: TransportDecision = {
    mode: "plaintext",
    url,
    notes: [],
    reasons: [],
    perConnectWarnings: [],
  };
  const u = (url ?? "").trim();
  if (!u)
    return { ...base, mode: "refuse", reasons: ["MQTT_URL resolved empty — nothing to connect to."] };

  const uiErr = userinfoError(u);
  if (uiErr) return { ...base, mode: "refuse", reasons: [uiErr] };

  const scheme = schemeOf(u);
  const wantsTls = isTlsScheme(u);
  const plain = isPlainScheme(u);
  if (!wantsTls && !plain)
    return {
      ...base,
      mode: "refuse",
      reasons: [
        `MQTT_URL scheme ${scheme || "(none)"} is not recognised; expected one of ` +
          `${PLAIN_SCHEMES.concat(TLS_SCHEMES).join(", ")}. Treating an unknown scheme as ` +
          `plaintext would be a silent downgrade, so nothing was published.`,
      ],
    };

  const cafile = (env[TLS_ENV.cafile] ?? "").trim();
  const certfile = (env[TLS_ENV.certfile] ?? "").trim();
  const keyfile = (env[TLS_ENV.keyfile] ?? "").trim();
  const servername = (env[TLS_ENV.servername] ?? "").trim();
  const anyTlsFile = cafile !== "" || certfile !== "" || keyfile !== "";

  // 2. the fleet-wide lock. Set it and no lane can end up plaintext by accident.
  if (onFlag(env[TLS_ENV.requireTls]) && !wantsTls)
    return {
      ...base,
      mode: "refuse",
      reasons: [
        `${TLS_ENV.requireTls}=1 but MQTT_URL is plaintext (${redactUrl(u)}). ` +
        `Change the URL to mqtts://<broker>:8883 or unset the flag. Refusing rather than ` +
        `connecting plaintext is the point of the flag.`,
      ],
    };

  // 3. TLS material named against a plaintext URL: an operator mistake that must not pass quietly.
  if (!wantsTls && anyTlsFile)
    return {
      ...base,
      mode: "refuse",
      reasons: [
        `${TLS_ENV.cafile}/${TLS_ENV.certfile}/${TLS_ENV.keyfile} are set but MQTT_URL is ` +
        `plaintext (${redactUrl(u)}), so the pinned CA and client certificate would be IGNORED ` +
        `and the session would be readable by anyone on the path. Set MQTT_URL to mqtts://... ` +
        `or unset the TLS variables.`,
      ],
    };

  // 4. TLS.
  if (!wantsTls) {
    if (insecureRequested(env))
      base.notes.push(`${TLS_ENV.insecure} is set but the URL is plaintext; it does nothing here.`);
    return base;
  }

  const opts: TlsOptions = {
    rejectUnauthorized: true,
    minVersion: TLS_MIN_VERSION,
    maxVersion: TLS_MAX_VERSION,
  };
  const reasons: string[] = [];

  if (cafile === "") {
    reasons.push(
      `MQTT_URL asks for TLS (${redactUrl(u)}) and no ${TLS_ENV.cafile} is set. tabichat pins a ` +
      `dedicated CA rather than trusting system roots, so there is nothing to verify the broker ` +
      `against. Point ${TLS_ENV.cafile} at the tabichat CA PEM (never a venya core CA — the ` +
      `#536/#541 boundary), or use a plaintext URL only where you accept plaintext.`,
    );
  } else {
    const ca = read(cafile);
    if (ca.error) reasons.push(`${TLS_ENV.cafile}: ${ca.error}`);
    else if (!pemLooks(ca.text ?? "", "certificate"))
      reasons.push(`${TLS_ENV.cafile} does not contain a CERTIFICATE block (${cafile}) — is that a key or a stray CSR?`);
    else opts.ca = ca.text;
  }

  if ((certfile === "") !== (keyfile === ""))
    reasons.push(
      `${certfile ? TLS_ENV.certfile : TLS_ENV.keyfile} is set and ${certfile ? TLS_ENV.keyfile : TLS_ENV.certfile} is not. ` +
      `A client certificate and its key are a PAIR: half a pair means the broker's ` +
      `require_certificate refuses the connect later, as a handshake error that reads like a ` +
      `network fault. Set both or neither.`,
    );
  else if (certfile !== "" && keyfile !== "") {
    const c = read(certfile);
    if (c.error) reasons.push(`${TLS_ENV.certfile}: ${c.error}`);
    else if (!pemLooks(c.text ?? "", "certificate"))
      reasons.push(`${TLS_ENV.certfile} does not contain a CERTIFICATE block (${certfile}).`);
    else opts.cert = c.text;
    const k = read(keyfile);
    if (k.error) reasons.push(`${TLS_ENV.keyfile}: ${k.error}`);
    else if (!pemLooks(k.text ?? "", "private key"))
      reasons.push(`${TLS_ENV.keyfile} does not contain a PRIVATE KEY block (${keyfile}).`);
    else opts.key = k.text;
  }
  if (servername !== "") opts.servername = servername;

  // The only opt-in in this file, and the reason it is loud: a broker whose leaf the pinned CA
  // cannot verify is a MAN-IN-THE-MIDDLE OPPORTUNITY, not a config detail. A value that is set
  // but is not "1" is refused rather than read as "off", because the variable that turns off
  // verification is not the one to be forgiving about.
  const insecureRaw = env[TLS_ENV.insecure];
  const insecure = (insecureRaw ?? "").trim() !== "";
  if (insecure && !onFlag(insecureRaw))
    reasons.push(
      `${TLS_ENV.insecure}=${JSON.stringify(insecureRaw)} is set to something other than "1". ` +
      `The variable that disables certificate verification is not one to leave half-typed: unset ` +
      `it, or set it to exactly 1.`,
    );
  else if (insecure) {
    opts.rejectUnauthorized = false;
    base.perConnectWarnings.push(
      `TLS VERIFICATION DISABLED (${TLS_ENV.insecure}=1): this lane accepts ANY certificate for ` +
      `${redactUrl(u)}. Nothing about the session is private against an on-path peer. Unset it.`,
    );
    base.notes.push(
      `Insecure TLS is a per-lane opt-in and is NOT a fallback: it only reached here because you ` +
      `set ${TLS_ENV.insecure}=1 explicitly.`,
    );
  }

  if (reasons.length)
    return { ...base, mode: "refuse", reasons, notes: base.notes };

  base.notes.push(
    `TLS: pinned CA from ${cafile || "(none)"}` +
      (opts.cert ? `, client certificate from ${certfile}` : ", NO client certificate (the broker will refuse you if it demands one)") +
      (opts.servername ? `, SNI ${opts.servername}` : ""),
  );
  return { ...base, mode: "tls", tls: opts, notes: base.notes };
};
