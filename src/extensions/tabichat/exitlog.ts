// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Lane exit breadcrumb.
 *
 * What is already known from measurement: nothing in this project has a crash record
 * (~/.pi/agent/crashes.json has never existed), no lane has a supervisor, and every
 * lane that vanished during a one-hour watch left an offline presence record within a
 * few seconds. So the lanes are exiting, not crashing - but "exiting" still covers a
 * human quit, a signal, and a terminal dying under the process, and those three want
 * different fixes.
 *
 * The discriminator is a start line paired with an exit line. A lane that writes
 * neither, or writes a start and no exit, was killed too hard to say goodbye; a lane
 * that writes an exit carries pi's own reason ("quit", "reload", "new", "resume",
 * "fork") plus how its last turn ended, which is what tells a stall apart from a stop.
 *
 * The record building is pure; only appendExitLine touches the filesystem, and it never
 * throws - a lane must never fail on its way out because a log file was unwritable.
 */

import { appendFileSync, mkdirSync as fsMkdir } from "node:fs";

/** How the most recent turn finished. */
export type EndState = "clean" | "error" | "aborted" | "unknown";

/** Where a lane writes its breadcrumb. /tmp is the sanctioned scratch area. */
export const EXIT_LOG_DEFAULT = "/tmp/tabichat/lane-exits.log";

export type EndMessage = { role?: string; stopReason?: string };

/**
 * Read back to the last assistant message - it is the decision point - and name how
 * the turn ended. An `aborted` ending is a human interrupt; anything other than a
 * recognized reason stays `unknown` rather than being guessed at.
 */
export const endStateOf = (messages: readonly EndMessage[]): EndState => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const reason = String(m.stopReason ?? "").trim().toLowerCase();
    if (reason === "error") return "error";
    if (reason === "aborted") return "aborted";
    if (reason === "") return "unknown";
    return "clean";
  }
  return "unknown";
};

export type ExitRecord = {
  kind: "start" | "exit";
  pid: number;
  nick: string;
  room: string;
  reason: string;
  lastTurn: EndState;
  ctxPercent: number | null;
  uptimeMs?: number;
  at?: number;
};

/**
 * One record as one line of JSON plus the line feed. Nothing inside may carry a raw
 * newline, or the log stops being line-per-event.
 */
export const exitLine = (r: ExitRecord): string => {
  const rec = {
    at: r.at ?? Date.now(),
    kind: r.kind,
    pid: r.pid,
    nick: r.nick,
    room: r.room,
    reason: r.reason,
    lastTurn: r.lastTurn,
    ctxPercent: r.ctxPercent === null ? null : Math.round(r.ctxPercent),
    uptimeMs: r.uptimeMs,
  };
  return JSON.stringify(rec) + "\n";
};

/**
 * Append one line. Returns whether it landed so the caller can be loud about a miss -
 * a silently missing breadcrumb is the same false confidence as a silently dead lane.
 */
export const appendExitLine = (
  path: string,
  line: string,
  io?: { mkdir?: (p: string, o: { recursive: boolean }) => void; append?: (p: string, d: string) => void },
): { ok: boolean; error?: string } => {
  try {
    const dir = path.slice(0, path.lastIndexOf("/")) || ".";
    (io?.mkdir ?? defaultMkdir)(dir, { recursive: true });
    (io?.append ?? defaultAppend)(path, line);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// Both defaults promise `void` and the node:fs calls they forward to do not all keep it:
// `appendFileSync` returns the byte count. A value-producing body under an explicit `void`
// annotation is the type error, so the bodies are blocks and the count is discarded here,
// which is what `appendExitLine` already does with it at the call site above.
const defaultMkdir = (p: string, o: { recursive: boolean }): void => {
  fsMkdir(p, o);
};
const defaultAppend = (p: string, data: string): void => {
  appendFileSync(p, data);
};
