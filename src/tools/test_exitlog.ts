// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the lane exit breadcrumb.
//   bun tools/test_exitlog.ts      (exit 1 on any failure)
// Both halves: the record must be written when it can be, and must report a failure
// rather than swallow one - a breadcrumb silently missing is the same false
// confidence as a lane silently dead.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendExitLine,
  endStateOf,
  exitLine,
  EXIT_LOG_DEFAULT,
  type EndMessage,
  type ExitRecord,
} from "../extensions/tabichat/exitlog.ts";

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

const asst = (stopReason: string): EndMessage => ({ role: "assistant", stopReason });

// --- which way did the turn end? ---
check("empty transcript is unknown, not clean", endStateOf([]), "unknown");
check("clean stop", endStateOf([asst("stop")]), "clean");
check("tool use is a normal ending, not an error", endStateOf([asst("toolUse")]), "clean");
check("provider error", endStateOf([asst("error")]), "error");
check("human interrupt", endStateOf([asst("aborted")]), "aborted");
check("missing stopReason is not guessed", endStateOf([{ role: "assistant" }]), "unknown");
check("a tool result does not become the verdict", endStateOf([asst("error"), { role: "toolResult" }]), "error");
check("a later clean turn wins", endStateOf([asst("error"), asst("stop")]), "clean");
check("no assistant message", endStateOf([{ role: "user" }]), "unknown");
check("case is not significant", endStateOf([{ role: "assistant", stopReason: "ERROR" }]), "error");

// --- the line itself ---
const rec: ExitRecord = {
  kind: "exit", pid: 1234, nick: "lane1", room: "tabith", reason: "quit",
  lastTurn: "error", ctxPercent: 68.7, uptimeMs: 5000, at: 1791244000000,
};
const line = exitLine(rec);
check("line ends with exactly one line feed", line.endsWith("\n") && !line.slice(0, -1).includes("\n"), true);
check("line parses back as JSON", typeof JSON.parse(line), "object");
const parsed = JSON.parse(line);
check("carries the pid", parsed.pid, 1234);
check("carries pi's own reason", parsed.reason, "quit");
check("carries how the turn ended", parsed.lastTurn, "error");
check("percent is rounded", parsed.ctxPercent, 69);
check("uptime kept", parsed.uptimeMs, 5000);
check("unknown percent stays null, never 0", JSON.parse(exitLine({ ...rec, ctxPercent: null })).ctxPercent, null);
check("no uptime when the start was never seen", "uptimeMs" in JSON.parse(exitLine({ ...rec, uptimeMs: undefined })), false);
const odd = JSON.parse(exitLine({ ...rec, nick: "odd\"nick\\x" })).nick;
check("a quote in a nick cannot break the line", odd, 'odd"nick\\x');
check("default log lives in the sanctioned scratch dir", EXIT_LOG_DEFAULT.startsWith("/tmp/"), true);

// --- append: positive half, real filesystem ---
const dir = mkdtempSync(join(tmpdir(), "exitlog-"));
const nested = join(dir, "deeper", "lane-exits.log");
const r1 = appendExitLine(nested, exitLine({ ...rec, kind: "start" }));
const r2 = appendExitLine(nested, exitLine(rec));
check("first write reports success", r1.ok, true);
check("missing directories were created", existsSync(nested), true);
const r3 = appendExitLine(nested, "x\n");
check("appending does not replace the file", readFileSync(nested, "utf8").split("\n").filter(Boolean).length, 3);
check("third write also reports success", r3.ok, true);

// --- append: negative half, an unwritable target must be reported ---
const blocker = join(dir, "not-a-dir");
writeFileSync(blocker, "I am a file");
const bad = appendExitLine(join(blocker, "lane-exits.log"), "x\n");
check("a path under a file fails", bad.ok, false);
check("and says why", typeof bad.error, "string");
check("the failure did not create anything", existsSync(join(blocker, "lane-exits.log")), false);
const injected = appendExitLine("/tmp/whatever/x.log", "x\n", {
  mkdir: () => undefined,
  append: () => {
    throw new Error("disk on fire");
  },
});
check("an injected append error is reported", injected.ok, false);
check("with the injected message", injected.error, "disk on fire");

statSync(nested);
rmSync(dir, { recursive: true, force: true });

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks pass");
process.exitCode = failed ? 1 : 0;
