// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Gate: the socket's callbacks must not hold a session-scoped ctx.  #585
//   bun tools/test_ctx_handle.ts      (exit 1 on any failure)
//
// Why this shape. The MQTT client is created ONCE per process and kept in `client`; the
// pi context belongs to a SESSION. `/renew` and `/reload` replace the session without
// rebuilding the socket, and `if (client) return;` makes the second session_start leave
// before it could hand the new ctx to anything. Every callback registered by the FIRST
// session_start therefore kept dereferencing a dead ctx — the throw has no catch, pi exits
// on uncaughtException, and the seat dies. Three seats on 2026-10-13, one of them a lead.
//
// The fix (shape A) is a HANDLE: `currentCtx` is refreshed on every session_start BEFORE
// the client guard, and the socket's callbacks read it through `liveCtx()`. So this gate
// checks three properties of the source, in the order that matters:
//   1. the handle is refreshed before the guard (ordering, not mere presence),
//   2. no `client.on(...)` callback body mentions a captured `ctx`,
//   3. the callbacks really do go through `liveCtx()` — the handle is not dead code.
//
// SCOPE AND HONEST LIMITS: this is a SOURCE-SHAPE gate, not a runtime test, and it says so
// (same standing as test_ctx_scope.ts and the labelled source-shape half of
// test_laneadmin.ts). index.ts imports mqtt and the pi SDK, and no gate in this repo has a
// dependency-free way to load it — loading it for real would open a live MQTT connection and
// publish presence into the room. So a stale-ctx reference is proven by structure here, and
// the negative halves below (a fixture of the exact pre-fix shape, and the base file itself
// when run against it) prove the checker can fail. What this gate CANNOT see: a callback
// that captures ctx through some other name, or a helper that stores a ctx in a closure it
// builds elsewhere. Those would need the real handler running.
import { readFileSync } from "node:fs";

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

const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

// Both lookups are anchored to STATEMENT position (a line break plus indentation, then the
// code). A prose mention of the guard — in a comment, which is how this file explains itself —
// must not be mistaken for the thing itself. The first draft of this gate made exactly that
// mistake, so the rule is pinned below as its own case.
const GUARD_STMT = /\n[ \t]*if \(client\) return;/;
const HANDLE_STMT = /\n[ \t]*currentCtx = ctx;/;
const posOf = (src: string, re: RegExp): number => {
  const m = re.exec(src);
  return m ? m.index + 1 : -1;
};

const CLIENT_ON = /client\.on\("([a-z]+)"/g;
const HANDLER_CLOSE = /\n {2}\}\);/;
/** Any mention of the session-scoped `ctx` identifier — `liveCtx()` does not match. */
const CAPTURED_CTX = /\bctx\b/;

/**
 * Drop comment-only lines before scanning a callback.
 *
 * This file narrates at length — the message handler carries a paragraph about the old
 * `ctx.hasPendingMessages()` gate, and prose about `ctx` is not a reference to it. Only
 * WHOLE-LINE comments are removed on purpose: stripping a trailing `// ...` would mean
 * cutting at the first `//` in a line, and a line holding `"https://…"` would lose real
 * code, turning a loud false positive into a silent false negative. A code line with a
 * prose mention of ctx at the end therefore still flags — reword the comment.
 */
const codeOnly = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

/** The text of every `client.on("<name>", ...)` callback. */
const clientCallbackBodies = (src: string): { name: string; body: string }[] => {
  const matches = [...src.matchAll(CLIENT_ON)];
  const positions = matches.map((m) => m.index as number);
  const out: { name: string; body: string }[] = [];
  positions.forEach((at, i) => {
    // The next callback if there is one, otherwise the line that CLOSES the
    // session_start handler (`  });` at two spaces) — stopping there keeps the
    // scan inside the handler instead of running into the helpers after it.
    const after = i + 1 < positions.length ? (positions[i + 1] as number) : src.length;
    const close = HANDLER_CLOSE.exec(src.slice(at));
    const end = close ? at + close.index : after;
    out.push({ name: matches[i]?.[1] as string, body: src.slice(at, Math.min(end, after)) });
  });
  return out;
};

/** Every way the #585 mechanism can come back. Empty means the tree is safe. */
export const staleCtxRisks = (src: string): string[] => {
  const hits: string[] = [];

  const guardAt = posOf(src, GUARD_STMT);
  if (guardAt < 0) {
    return ["no `if (client) return;` client guard statement found — the shape this gate checks has moved, re-read it"];
  }
  const handlerAt = src.lastIndexOf('pi.on("session_start"', guardAt);
  if (handlerAt < 0) {
    return ["the client guard is not inside a session_start handler — this gate cannot judge it"];
  }

  const handleOff = posOf(src.slice(handlerAt), HANDLE_STMT);
  const handleAt = handleOff < 0 ? -1 : handlerAt + handleOff;
  if (handleAt < 0) {
    hits.push("session_start never refreshes the ctx handle, so a replaced session leaves the socket on a dead ctx");
  } else if (handleAt > guardAt) {
    hits.push(
      `ctx handle refreshed at line ${lineOf(src, handleAt)}, AFTER the client guard at line ${lineOf(src, guardAt)} — ` +
        "a second session_start returns at the guard and the refresh never runs",
    );
  }

  const callbacks = clientCallbackBodies(src);
  if (!callbacks.length) hits.push("no client.on(...) callbacks found — the socket wiring has moved");
  for (const { name, body } of callbacks) {
    const code = codeOnly(body);
    if (CAPTURED_CTX.test(code)) {
      hits.push(`client.on("${name}") still mentions ctx — it must read the handle via liveCtx()`);
    }
    if (!code.includes("liveCtx()")) {
      hits.push(`client.on("${name}") neither uses ctx nor liveCtx() — the handle is not being read there`);
    }
  }
  return hits;
};

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// --- the real tree ----------------------------------------------------------
const EXT = "../extensions/tabichat/";
check("index.ts: no socket callback holds a session ctx", staleCtxRisks(read(EXT + "index.ts")), []);

// --- the positive wiring pin: the handle is refreshed, and it is read -------
const idx = read(EXT + "index.ts");
check("REGRESSION PIN — session_start assigns the handle", idx.includes("currentCtx = ctx;"), true);
check(
  "REGRESSION PIN — the socket callbacks read the handle",
  (idx.match(/liveCtx\(\)/g) ?? []).length >= 3,
  true,
);

// --- NEGATIVE HALVES: the gate has to be able to fail ----------------------

// The shipped (pre-#585) shape, verbatim in structure: guard first, no handle, and the
// callbacks closed over the ctx they were registered with.
const BASE_SHAPE = `
  let client: mqtt.MqttClient | null = null;
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("tabichat") !== true) return;
    ctx.ui.setStatus("nick", "@x");
    if (client) return;
    client = mqtt.connect(url, {});
    client.on("connect", () => {
      ctx.ui.notify("connected", "info");
    });
    client.on("error", (err: Error) => {
      ctx.ui.notify("error", "error");
    });
    client.on("message", (topic, payload) => {
      const idle = ctx.isIdle();
      ctx.ui.setStatus("hold", "x");
    });
  });
  pi.on("agent_end", async (_event, ctx) => {
    ctx.ui.notify("end", "info");
  });
`;
const baseRisks = staleCtxRisks(BASE_SHAPE);
check("the shipped shape IS caught (no handle refresh)", baseRisks.some((r) => r.includes("never refreshes the ctx handle")), true);
check(
  "and it is caught at the callbacks too",
  baseRisks.filter((r) => r.includes("still mentions ctx")).length,
  3,
);
check("...while a clean handler is not flagged at all", staleCtxRisks(BASE_SHAPE.replace(`if (client) return;`, `currentCtx = ctx;\n    if (client) return;`)).length > 0, true);

// The fix landed in the WRONG ORDER — refresh after the guard. Same bug, different line.
const LATE_HANDLE = `
  pi.on("session_start", async (_event, ctx) => {
    if (client) return;
    currentCtx = ctx;
    client = mqtt.connect(url, {});
    client.on("connect", () => {
      liveCtx().ui.notify("connected", "info");
    });
  });
  pi.on("agent_end", async (_event, ctx) => { ctx.ui.notify("end", "info"); });
`;
check(
  "a handle refreshed AFTER the guard is caught",
  staleCtxRisks(LATE_HANDLE).some((r) => r.includes("AFTER the client guard")),
  true,
);

// NO FALSE POSITIVE — the fixed shape, and an unrelated handler that legitimately binds ctx.
const FIXED_SHAPE = `
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (client) return;
    client = mqtt.connect(url, {});
    client.on("connect", () => {
      liveCtx().ui.notify("connected", "info");
    });
    client.on("message", () => {
      takeAdmin(msg, liveCtx());
    });
  });
  pi.on("agent_end", async (_event, ctx) => {
    ctx.ui.notify("end", "info");
  });
`;
check("NO FALSE POSITIVE — the fixed shape is clean, and per-event ctx is not the bug", staleCtxRisks(FIXED_SHAPE), []);

// A guard-less tree (the wiring moved) must be reported, not silently passed.
check(
  "a tree with no client guard is reported, not skipped",
  staleCtxRisks(`pi.on("session_start", async (_event, ctx) => { currentCtx = ctx; });`).length,
  1,
);

// A prose mention of the guard is not the guard. Caught live: the fix's own comment
// quotes `if (client) return;`, and an unanchored lookup judged THAT as the wiring.
check(
  "a guard named only in a COMMENT is not mistaken for the statement",
  staleCtxRisks(
    `// the \`if (client) return;\` guard guards the socket\npi.on("session_start", async (_event, ctx) => {\n  client = mqtt.connect(url, {});\n});`,
  ),
  ["no `if (client) return;` client guard statement found — the shape this gate checks has moved, re-read it"],
);

// Prose about ctx is not a reference to it, and a real one is still caught beside the prose.
const PROLIX = `
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (client) return;
    client = mqtt.connect(url, {});
    client.on("message", () => {
      // The gate used to read \`ctx.hasPendingMessages()\`, and that is the defect.
      // Both signals here are public API — see \`ctx.isIdle()\` in steer.ts.
      liveCtx().ui.setStatus("hold", "2 held");
    });
  });
  pi.on("agent_end", async (_event, ctx) => { ctx.ui.notify("end", "info"); });
`;
check("comment-only mentions of ctx do not trip the gate", staleCtxRisks(PROLIX), []);
check(
  "...and a real one on a code line is caught beside them",
  staleCtxRisks(PROLIX.replace('liveCtx().ui.setStatus("hold", "2 held");', 'ctx.ui.setStatus("hold", "2 held");')).length,
  2, // the captured ctx, and the handle it displaced is no longer read
);

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nall checks pass");
}
