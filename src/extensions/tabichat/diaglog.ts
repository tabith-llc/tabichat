// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * DIAGNOSTIC SINK: machine-readable errors stay out of the place a human types.
 *
 * A lane's terminal is where a human types. `console.error` is not a log, it is an interruption, and
 * The class survives the instance: fix one emitter and the rest keep printing. This module is the ONE destination machine-readable diagnostics are written to, so
 * the answer to "where did that line go" is a file a person can grep, not a scrollback a renew has
 * already thrown away.
 *
 * The decision (which path, or none) is pure; the writing is a runner with injected I/O. The same
 * shape as `tlsopts.ts:transportDecision`, `broker.ts:resolveBrokerFromDisk` and
 * `ctxwarn.ts:pickResumeHandoff`, so both truth-table halves are checkable in `tools/` with no
 * broker, no terminal, and no touch of the real disk.
 */

import { redactUrl } from "./tlsopts.ts";

/** Per-seat override. Highest layer, and it is how one seat is pointed somewhere else. */
export const DIAG_ENV = "MQTT_DIAG_LOG";
/** Venue-wide key in the site config file — the same file that carries `autoRenew` and `mqttUrl`. */
export const DIAG_SITE_KEY = "diagLog";
/** Byte cap before rotation. */
export const DIAG_MAX_ENV = "MQTT_DIAG_MAX_BYTES";
export const DIAG_DEFAULT_MAX_BYTES = 1024 * 1024;
/** The rotate target: `<path>.1`, ONE generation. Keeping a set nobody reads is just a bigger leak. */
export const DIAG_ROTATE_SUFFIX = ".1";
/** Durable by default and derived from the resolved home — never a literal venue path. */
export const DIAG_DEFAULT_SUBPATH = ".pi/agent/tabichat-diag.log";
/** Scratch is NOT a default: tmpfs has eaten this fleet's artifacts twice (root `AGENTS.md` /tmp law). */
export const DIAG_TMPFS_PREFIXES = ["/tmp", "/var/tmp"] as const;
/** Values that MEAN "no file". An explicit answer, not an absence — `parseBoolSlot`'s discipline. */
export const DIAG_OFF_TOKENS = ["off", "none", "no", "false", "0", "disable", "disabled"] as const;

export type DiagLayers = { env?: unknown; site?: unknown; home?: unknown };

export type DiagTarget =
  | { ok: true; path: string; source: string }
  /** `deliberate: true` = the operator ANSWERED "no file"; a refusal worth printing carries false. */
  | { ok: false; path: ""; source: string; reason: string; deliberate: boolean };

const homeOf = (layers: DiagLayers): string => (typeof layers.home === "string" ? layers.home.trim() : "");

const isOff = (v: string): boolean => DIAG_OFF_TOKENS.includes(v.toLowerCase());

/** A path must be absolute, `~`-prefixed, or a Windows drive path — anything else names no place. */
const looksPlaced = (v: string): boolean =>
  v.startsWith("/") || v.startsWith("~") || /^[A-Za-z]:[\\/]/.test(v);

const expandHome = (v: string, home: string): string | null => {
  if (v === "~") return home !== "" ? home : null;
  if (v.startsWith("~/")) return home !== "" ? `${home.replace(/\/+$/, "")}/${v.slice(2)}` : null;
  return v;
};

/**
 * PRECEDENCE, highest first: `MQTT_DIAG_LOG` -> site-config `"diagLog"` -> the default under the
 * resolved home. No shipped venue host, no project directory, no tmpfs.
 *
 * Both rejection halves matter: an explicit `off` is an ANSWER (say why, write nothing), and a
 * garbage value is REFUSED (never quietly replaced by the default, which would put a file in a
 * directory nobody named and still report success).
 */
export const resolveDiagTarget = (layers: DiagLayers = {}): DiagTarget => {
  const home = homeOf(layers);
  for (const [raw, source] of [
    [layers.env, `pi env ${DIAG_ENV}`],
    [layers.site, `site file (${DIAG_SITE_KEY})`],
  ] as const) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "boolean")
      return {
        ok: false,
        path: "",
        source,
        deliberate: raw === false,
        reason: raw ? `${source} is \`true\`, which names no path` : `${source} is false — diagnostics are not written`,
      };
    if (typeof raw !== "string")
      return { ok: false, path: "", source, deliberate: false, reason: `${source} is not a string` };
    const v = raw.trim();
    if (v === "") continue; // an empty slot is an absence, like a missing key: next layer answers
    if (isOff(v))
      return { ok: false, path: "", source, deliberate: true, reason: `${source} says "${v}" — diagnostics are not written` };
    if (!looksPlaced(v))
      return {
        ok: false,
        path: "",
        source,
        deliberate: false,
        reason: `${source} = "${v}" is not an absolute path (nor ~-prefixed) — refused rather than written where nobody aimed it`,
      };
    const expanded = expandHome(v, home);
    if (expanded === null)
      return { ok: false, path: "", source, deliberate: false, reason: `${source} = "${v}" needs a home directory and none is resolved` };
    return { ok: true, path: expanded, source };
  }

  if (home === "")
    return {
      ok: false,
      path: "",
      source: "default",
      deliberate: false,
      reason: `no ${DIAG_ENV} and no site "${DIAG_SITE_KEY}", and no home directory to put ${DIAG_DEFAULT_SUBPATH} under`,
    };
  const path = `${home.replace(/\/+$/, "")}/${DIAG_DEFAULT_SUBPATH}`;
  if (DIAG_TMPFS_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)))
    return { ok: false, path: "", source: "default", deliberate: false, reason: `the resolved home ${home} is tmpfs; set ${DIAG_ENV}` };
  return { ok: true, path, source: `default (${DIAG_DEFAULT_SUBPATH} under the resolved home)` };
};

/** The byte cap. A garbage value is the DEFAULT, never "unlimited". */
export const resolveDiagMaxBytes = (raw?: unknown): number => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw !== "string" || raw.trim() === "") return DIAG_DEFAULT_MAX_BYTES;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DIAG_DEFAULT_MAX_BYTES;
};

/** Rotate decision, pure: does an `incoming`-byte line fit under `max` at the current size? */
export const rotateNeeded = (currentBytes: number, incomingBytes: number, max: number): boolean =>
  currentBytes > 0 && currentBytes + incomingBytes > max;

/**
 * ONE record, redacted HERE rather than at each caller so a future call site cannot forget it, and
 * flattened to a single line: a message carrying a newline would otherwise write a second record
 * that never was one.
 */
export const formatDiagLine = (l: { ts: string; nick: string; level: string; message: string; stack?: string }): string => {
  const one = (s: string) => redactUrl(String(s)).replace(/\s+/g, " ").trim();
  return `${l.ts} ${l.nick} ${l.level} ${one(l.message)}${l.stack ? ` stack="${one(l.stack)}"` : ""}\n`;
};

/** Injected, so the gate drives the whole writer without touching a real disk. */
export type DiagIo = {
  size: (path: string) => number; // 0 means "no such file"
  append: (path: string, data: string) => void; // throws on failure
  rename: (from: string, to: string) => void; // throws on failure
  ensureDir: (path: string) => void; // throws on failure
};

/**
 * The writer. It NEVER falls back to the terminal: a failed write is RETURNED, because a "best
 * effort" that prints at the human is exactly the defect this module exists to end.
 */
export const writeDiagLine = (
  target: DiagTarget,
  io: DiagIo,
  line: string,
  maxBytes: number,
): { ok: true; rotated: boolean } | { ok: false; reason: string } => {
  if (!target.ok) return { ok: false, reason: target.reason };
  try {
    io.ensureDir(target.path);
    const rotated = rotateNeeded(io.size(target.path), line.length, maxBytes);
    if (rotated) io.rename(target.path, `${target.path}${DIAG_ROTATE_SUFFIX}`);
    io.append(target.path, line);
    return { ok: true, rotated };
  } catch (e) {
    return { ok: false, reason: `${target.path}: ${e instanceof Error ? e.message : String(e)}` };
  }
};

export type DiagSink = {
  target: DiagTarget;
  maxBytes: number;
  /** Set on the first failed write; the caller tells the operator ONCE, not per dropped line. */
  failed: boolean;
  reason: string;
  /** `stack` reaches the file only when the operator asked for stacks (`TABICHAT_ERR_STACK=1`). */
  write: (level: string, message: string, stack?: string) => void;
};

/** The runner index.ts installs. `now` and `io` are injected; a boot passes real `fs` and real time. */
export const makeDiagSink = (
  layers: DiagLayers,
  opts: { nick: string; maxRaw?: unknown; stackOn?: boolean; now: () => string; io: DiagIo },
): DiagSink => {
  const sink: DiagSink = {
    target: resolveDiagTarget(layers),
    maxBytes: resolveDiagMaxBytes(opts.maxRaw),
    failed: false,
    reason: "",
    write: () => {},
  };
  sink.write = (level, message, stack) => {
    const r = writeDiagLine(
      sink.target,
      opts.io,
      formatDiagLine({ ts: opts.now(), nick: opts.nick, level, message, stack: opts.stackOn ? stack : undefined }),
      sink.maxBytes,
    );
    if (!r.ok) {
      sink.failed = true;
      sink.reason = r.reason;
    }
  };
  return sink;
};

/** The real-`fs` block, in one place so the extension never hand-rolls a rotation. */
export const makeDiagIo = (fs: {
  appendFileSync: (p: string, d: string) => void;
  renameSync: (a: string, b: string) => void;
  statSync: (p: string) => { size: number };
  mkdirSync: (p: string, o: { recursive: boolean }) => void;
}): DiagIo => ({
  size: (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  },
  append: (p, d) => fs.appendFileSync(p, d),
  rename: (from, to) => fs.renameSync(from, to),
  // the file's own directory, taken from the last separator: no `node:path` import needed here,
  // and a path with no separator is impossible because the resolver only accepts absolute forms.
  ensureDir: (p) => fs.mkdirSync(p.slice(0, p.lastIndexOf("/") + 1) || "/", { recursive: true }),
});
