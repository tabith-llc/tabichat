// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * THE ROOM JOURNAL.
 *
 * Room lines publish WITHOUT the MQTT retain flag while receipts and presence ARE retained, so a
 * late subscriber is handed the paperwork of the conversation and never the conversation itself.
 * The only bridge across a session change used to be `INBOUND_PARK`, an in-process array that dies
 * with the process. A seat that restarts is deaf to everything said before it subscribed. This
 * module puts one participant's view of the room on disk, and hands the newest lines back to the
 * next session BEFORE the socket's first live line — as history, marked as history, never as news.
 *
 * ONE JOURNAL PER SEAT PER ROOM: the default key is (home, room, nick-leaf). Eleven
 * lanes under one uid sharing one file lost 93 journaled lines in one measurement while every
 * writer returned ok — and the write path was read-whole → rewrite-whole per line, which loses
 * concurrent writers even before naming. The hot path is now APPEND-ONLY (O_APPEND); the line cap
 * is enforced by a boot-time trim of that seat's own file, the single-writer moment.
 *
 * The decision (which path, or none) is pure; the writing is a runner with injected I/O. This is
 * the same shape as `diaglog.ts` on purpose: the precedence, the two rejection halves (an explicit
 * `off` is an ANSWER; a garbage value is REFUSED, never quietly replaced by the default), the
 * tmpfs bar, and the refusal text a person can act on. One addition diaglog does not need: a
 * journal holds other people's room text, so a resolved path inside a git working tree is refused
 * — a file in a repo is a file that can be committed.
 */

import { topicLeaf } from "./roommsg.ts";

/** Per-seat override. Highest layer, exactly like `MQTT_DIAG_LOG` beside it. */
export const ROOMLOG_ENV = "MQTT_ROOMLOG";
/** Venue-wide key in the site config file — the same file that carries `autoRenew` and `diagLog`. */
export const ROOMLOG_SITE_KEY = "roomLog";
/** Line cap. On overflow the newest are kept and the oldest dropped, and the trim is REPORTED. */
export const ROOMLOG_MAX_ENV = "MQTT_ROOMLOG_MAX_LINES";
export const ROOMLOG_MAX_DEFAULT = 500;
/**
 * Age cap, beside the line cap and not instead of it: a seat that journals 40 lines a day is under
 * 500 for a fortnight, so a count alone bounds the file and not the history. Unset or garbage keeps
 * today's behaviour exactly — no age bound — because this file is the evidence base the attribution
 * checks run on, and a default that quietly shrank it would be a worse instrument than a long one.
 * `0` is the aggressive value: everything older than this boot goes at boot. As with the receipt
 * board, no value means "keep forever" other than leaving it unset.
 */
export const ROOMLOG_MAX_AGE_ENV = "MQTT_ROOMLOG_MAX_AGE_DAYS";
/** -1 = no age bound. It is the shipped default, so the file keeps behaving as it does today. */
export const ROOMLOG_MAX_AGE_DEFAULT_DAYS = -1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How many of the newest lines a fresh session takes back into its buffer. */
export const ROOMLOG_REPLAY_ENV = "MQTT_ROOMLOG_REPLAY";
export const ROOMLOG_REPLAY_DEFAULT = 50;
/** Durable by default, under the resolved home — never a project directory, never tmpfs. */
export const ROOMLOG_DEFAULT_DIR_SUBPATH = ".pi/agent/tabichat-roomlog";
export const ROOMLOG_TMPFS_PREFIXES = ["/tmp", "/var/tmp"] as const;
/** Values that MEAN "no journal". An explicit answer, not an absence — diaglog's discipline. */
export const ROOMLOG_OFF_TOKENS = ["off", "none", "no", "false", "0", "disable", "disabled"] as const;

/** One journaled room line. `dir` is whose act it was: "in" heard, "out" sent by this seat. */
export interface RoomLogRecord {
  id: string;
  nick: string;
  to?: string;
  ts: number;
  text: string;
  dir: "in" | "out";
}

export type RoomLogLayers = { env?: unknown; site?: unknown; home?: unknown; room?: unknown; nick?: unknown };

export type RoomLogTarget =
  | { ok: true; path: string; source: string }
  /** `deliberate: true` = the operator ANSWERED "no journal"; a refusal worth printing carries false. */
  | { ok: false; path: ""; source: string; reason: string; deliberate: boolean };

/** The file name for a room: the topic-leaf filter, one implementation, never a copy. */
export const roomLogFileLeaf = (room: string): string => topicLeaf(room ?? "");

const homeOf = (layers: RoomLogLayers): string => (typeof layers.home === "string" ? layers.home.trim() : "");

const isOff = (v: string): boolean => (ROOMLOG_OFF_TOKENS as readonly string[]).includes(v.toLowerCase());

/** A path must be absolute, `~`-prefixed, or a Windows drive path — anything else names no place. */
const looksPlaced = (v: string): boolean =>
  v.startsWith("/") || v.startsWith("~") || /^[A-Za-z]:[\\/]/.test(v);

const expandHome = (v: string, home: string): string | null => {
  if (v === "~") return home !== "" ? home : null;
  if (v.startsWith("~/")) return home !== "" ? `${home.replace(/\/+$/, "")}/${v.slice(2)}` : null;
  return v;
};

const onTmpfs = (p: string): boolean => ROOMLOG_TMPFS_PREFIXES.some((t) => p === t || p.startsWith(`${t}/`));

/**
 * PRECEDENCE, highest first: `MQTT_ROOMLOG` -> site-config `"roomLog"` -> the default under the
 * resolved home (`<home>/.pi/agent/tabichat-roomlog/<room>/<nick>.jsonl` — ONE FILE PER SEAT PER
 * ROOM). Both rejection halves are
 * diaglog's: an explicit `off` is an answer, a garbage value is refused and never defaulted.
 * `isInGitTree` is injected (a real boot walks the parent directories for a `.git` entry); when it
 * answers true the target is REFUSED — a journal in a repo is a file that can be committed, and it
 * holds other people's room text.
 */
export const resolveRoomLogTarget = (
  layers: RoomLogLayers = {},
  isInGitTree?: (dir: string) => boolean,
): RoomLogTarget => {
  const home = homeOf(layers);
  const room = typeof layers.room === "string" ? layers.room : "";
  const nickRaw = typeof layers.nick === "string" ? layers.nick : "";
  for (const [raw, source] of [
    [layers.env, `pi env ${ROOMLOG_ENV}`],
    [layers.site, `site file (${ROOMLOG_SITE_KEY})`],
  ] as const) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "boolean")
      return {
        ok: false,
        path: "",
        source,
        deliberate: raw === false,
        reason: raw
          ? `${source} is \`true\`, which names no path`
          : `${source} is false — the room journal is not written`,
      };
    if (typeof raw !== "string") return { ok: false, path: "", source, deliberate: false, reason: `${source} is not a string` };
    const v = raw.trim();
    if (v === "") continue; // an empty slot is an absence: next layer answers
    if (isOff(v))
      return { ok: false, path: "", source, deliberate: true, reason: `${source} says "${v}" — the room journal is not written` };
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
    return guarded(expanded, source, isInGitTree);
  }

  if (home === "")
    return {
      ok: false,
      path: "",
      source: "default",
      deliberate: false,
      reason: `no ${ROOMLOG_ENV} and no site "${ROOMLOG_SITE_KEY}", and no home directory to put the journal under`,
    };
  const roomLeaf = roomLogFileLeaf(room);
  if (!roomLeaf)
    return {
      ok: false,
      path: "",
      source: "default",
      deliberate: false,
      reason: `the room name "${room}" has no file-leaf-safe form; set ${ROOMLOG_ENV} to an explicit path`,
    };
  // the nick is part of the KEY: the SAME sanitiser as msgTopic/histTopic — one filter,
  // never a second — and the same empty-leaf refusal. A journal without a seat component is the
  // shared-file defect back, so a default with no usable nick is REFUSED, not silently shared.
  const nickLeaf = topicLeaf(nickRaw);
  if (!nickLeaf)
    return {
      ok: false,
      path: "",
      source: "default",
      deliberate: false,
      reason: `the nick "${nickRaw}" has no file-leaf-safe form, and the journal is keyed per seat — refused rather than shared between seats`,
    };
  const dir = `${home.replace(/\/+$/, "")}/${ROOMLOG_DEFAULT_DIR_SUBPATH}/${roomLeaf}`;
  const path = `${dir}/${nickLeaf}.jsonl`;
  if (onTmpfs(path))
    return { ok: false, path: "", source: "default", deliberate: false, reason: `the resolved home ${home} is tmpfs; a journal there is wiped by any reboot — set ${ROOMLOG_ENV}` };
  return guarded(path, `default (${ROOMLOG_DEFAULT_DIR_SUBPATH}/${roomLeaf}/${nickLeaf}.jsonl under the resolved home)`, isInGitTree);
};

/** The shared tail of every ok path: the git-tree bar, applied to whatever was finally resolved. */
const guarded = (
  path: string,
  source: string,
  isInGitTree?: (dir: string) => boolean,
): RoomLogTarget => {
  if (isInGitTree && isInGitTree(path.slice(0, path.lastIndexOf("/"))) )
    return {
      ok: false,
      path: "",
      source,
      deliberate: false,
      reason: `${source} resolves inside a git working tree — a journal holds other lanes' room text and a file in a repo is a file that can be committed; refused, nothing written. Point ${ROOMLOG_ENV} outside any tree.`,
    };
  return { ok: true, path, source };
};

/** The cap. A garbage value is the DEFAULT, never "unlimited" — `resolveDiagMaxBytes`' rule. */
export const parseRoomLogCap = (raw: unknown, fallback: number): number => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * The age bound, in whole days, floor at 0. `parseRoomLogCap`'s rule with the zero allowed: a
 * garbage or negative value is the DEFAULT (no bound), never "delete the history", because an
 * unparseable knob that destroys evidence is the one failure this module must not have. `0` is a
 * real answer and means "nothing older than this boot survives".
 */
export const parseRoomLogAgeDays = (raw: unknown, fallback: number): number => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** One record per line. JSON carries the newlines inside `text` as escapes, so a message can
 * never write a second record that was not one. */
export const formatRoomLogRecord = (rec: RoomLogRecord): string => JSON.stringify(rec) + "\n";

/** A line of the journal file back into a record, or null when it is not one (never defaulted). */
export const parseRoomLogRecord = (line: string): RoomLogRecord | null => {
  const t = line.trim();
  if (t === "") return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.nick !== "string" || typeof r.text !== "string" || typeof r.ts !== "number") return null;
  if (r.dir !== "in" && r.dir !== "out") return null;
  const rec: RoomLogRecord = {
    id: typeof r.id === "string" ? r.id : "",
    nick: r.nick,
    ts: r.ts,
    text: r.text,
    dir: r.dir,
  };
  if (typeof r.to === "string" && r.to.trim() !== "") rec.to = r.to;
  return rec;
};

/** Injected I/O, so the gate drives the whole writer without touching a real disk. */
export type RoomLogIo = {
  read: (path: string) => string; // "" means "no such file"
  append: (path: string, data: string) => void; // O_APPEND: one record per call, never a rewrite
  write: (path: string, data: string) => void; // the BOOT TRIM's whole-file write, and nothing else
  ensure: (path: string) => void; // dir 0700 + file 0600, once at boot (appends and the trim keep it)
};

const splitRecords = (content: string): string[] => content.split("\n").filter((l) => l.trim() !== "");

/**
 * Append one record — the HOT PATH, append-only BY CONSTRUCTION: a read-whole →
 * rewrite-whole cycle with no lock lost concurrent writers silently (measured at a0471508:
 * 160 intended, 68 on disk, every writer returned ok). One O_APPEND write cannot overwrite a
 * neighbour, and the per-seat file means there is no neighbour on the hot path anyway. The cap is
 * enforced by `trimRoomLog` at boot — never here, never mid-session.
 */
export const appendRoomLogRecord = (
  io: RoomLogIo,
  path: string,
  rec: RoomLogRecord,
): { ok: true } | { ok: false; reason: string } => {
  try {
    io.append(path, formatRoomLogRecord(rec));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/**
 * The boot trim (both bounds, moved off the hot path): drop what is past the age bound, then keep
 * the newest `maxLines`, and RETURN the drop count so the wiring reports it — a silent trim is the
 * silent-drop class this module exists to end. Under both bounds nothing is touched.
 *
 * Age first, then the count: applying the cap first would let a file that sits under its line cap
 * keep records the site asked to lose. A line that does not parse is KEPT — it is counted by
 * `loadRoomLogTail`'s malformed report, and an unreadable line is not this bound's to destroy.
 * `maxAgeDays` defaults to no bound, so a three-argument call is today's behaviour byte for byte.
 */
export const trimRoomLog = (
  io: RoomLogIo,
  path: string,
  maxLines: number,
  maxAgeDays: number = ROOMLOG_MAX_AGE_DEFAULT_DAYS,
  nowMs: number = Date.now(),
): { ok: true; trimmed: number } | { ok: false; reason: string } => {
  try {
    const lines = splitRecords(io.read(path));
    let live = lines;
    if (maxAgeDays >= 0) {
      const cut = nowMs - maxAgeDays * DAY_MS;
      live = lines.filter((l) => {
        const r = parseRoomLogRecord(l);
        return !r || r.ts >= cut;
      });
    }
    const over = live.length > maxLines ? live.length - maxLines : 0;
    const aged = lines.length - live.length;
    if (!over && !aged) return { ok: true, trimmed: 0 };
    const kept = over ? live.slice(over) : live;
    io.write(path, kept.map((l) => `${l}\n`).join(""));
    return { ok: true, trimmed: over + aged };
  } catch (e) {
    return { ok: false, reason: `${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/** The newest `limit` records, oldest first — history for a fresh session, in the order lived.
 * A malformed line is COUNTED, never silently skipped: the wiring says how many were unreadable. */
export const loadRoomLogTail = (
  io: RoomLogIo,
  path: string,
  limit: number,
): { records: RoomLogRecord[]; malformed: number } => {
  const out: { records: RoomLogRecord[]; malformed: number } = { records: [], malformed: 0 };
  let content = "";
  try {
    content = io.read(path);
  } catch {
    return out; // no file yet is an absence, not an error
  }
  const recs: RoomLogRecord[] = [];
  for (const l of splitRecords(content)) {
    const r = parseRoomLogRecord(l);
    if (r) recs.push(r);
    else out.malformed += 1;
  }
  out.records = recs.slice(Math.max(0, recs.length - limit));
  return out;
};

/** The real-`fs` block in one place: file 0600, its directory 0700, both enforced once at boot
 * (`ensure`), because the hot path is O_APPEND and the boot trim writes a file this writer owns. */
export const makeRoomLogIo = (fs: {
  readFileSync: (p: string, enc?: string) => string;
  appendFileSync: (p: string, data: string) => void;
  writeFileSync: (p: string, data: string, opts?: { mode?: number }) => void;
  mkdirSync: (p: string, o: { recursive: boolean; mode?: number }) => void;
  chmodSync: (p: string, mode: number) => void;
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory: () => boolean };
}): RoomLogIo & { isInGitTree: (dir: string) => boolean } => ({
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return "";
    }
  },
  append: (p, data) => fs.appendFileSync(p, data),
  write: (p, data) => {
    fs.writeFileSync(p, data, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  },
  ensure: (p) => {
    const dir = p.slice(0, p.lastIndexOf("/") + 1) || "/";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    if (!fs.existsSync(p)) fs.writeFileSync(p, "", { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  },
  /** Walk the parent chain looking for a `.git` entry (directory OR file — a worktree's `.git`
   * is a file). The home-directory default never hits it; an explicit path under /srv does. */
  isInGitTree: (dir: string): boolean => {
    let cur = dir || "/";
    for (;;) {
      try {
        if (fs.existsSync(`${cur}/.git`)) return true;
      } catch {
        /* unreadable directory: keep walking, the resolver refuses on write failure anyway */
      }
      if (cur === "/" || cur === "") return false;
      const next = cur.slice(0, cur.lastIndexOf("/"));
      cur = next === "" ? "/" : next;
    }
  },
});

/** The tail-board payload (A2, flag-gated): ONE topic per lane, so board count = lane count. */
export const histBoardPayload = (o: {
  nick: string;
  leaf: string;
  journalPath: string;
  outLines: readonly RoomLogRecord[];
}): { v: 1; nick: string; leaf: string; lastId: string; lastTs: number; journalPath: string; lines: RoomLogRecord[] } => {
  const tail = o.outLines.slice(-10);
  const last = tail.length ? tail[tail.length - 1] : null;
  return {
    v: 1,
    nick: o.nick,
    leaf: o.leaf,
    lastId: last?.id ?? "",
    lastTs: last?.ts ?? Date.now(),
    journalPath: o.journalPath,
    lines: [...tail],
  };
};
