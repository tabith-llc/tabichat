// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Gate: a tool body may not USE `ctx` while declaring only `_ctx`.
//   bun tools/test_ctx_scope.ts      (exit 1 on any failure)
//
// Why this exists. commit a8245b5 added the over-cap post refusal and wired it as
//   ctx.ui.notify(...)
// inside chat_post's execute, whose fifth parameter was named `_ctx`. `ctx` was never
// declared, so the branch threw `ReferenceError: ctx is not defined` INSTEAD of telling
// the lane its post was refused — and it threw before publishRoom(), so nothing was
// published and the tool result was a bare error. The pure helpers it called
// (postLengthVerdict, postTooLongNote) were fully unit-tested, including the over-cap and
// NEGATIVE halves; only the wiring line was uncovered, and pi runs the extension as plain
// TypeScript with no compile step, so nothing ever resolved those names.
//
// Scope and HONEST LIMITS of this check: it is a source-shape gate, not a behavioural
// one. It attributes to each `async execute(<params>)` the text up to the NEXT execute
// signature, and reports that span only when it uses `ctx.something` while no `ctx`
// declaration appears in the params or the span. Consequence: it is conservative (a span
// that borrows a later `ctx` declaration passes), it does not brace-match, and it cannot
// see a whole class of other reference errors. It catches exactly the shipped bug and its
// near variants, which is all it claims.
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

const EXECUTE_SIG = /async\s+execute\s*\(([^)]*)\)/g;
const USES_CTX = /\bctx\s*\./;              // `_ctx.ui` does NOT match: no word boundary
const DECLARES_CTX = /[,(]\s*ctx\s*[,)]/;   // a later handler in the span that binds ctx
const paramNames = (params: string) => params.split(",").map((p) => p.trim());

/** Spans where `ctx` is used but nowhere declared. Empty means the tree is clean. */
export const escapedCtx = (src: string): string[] => {
  const sigs = [...src.matchAll(EXECUTE_SIG)];
  const hits: string[] = [];
  sigs.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < sigs.length ? (sigs[i + 1]?.index ?? src.length) : src.length;
    const span = src.slice(start, end);
    if (!USES_CTX.test(span)) return;
    if (paramNames(m[1] ?? "").includes("ctx")) return;
    if (DECLARES_CTX.test(span)) return;
    const line = src.slice(0, start).split("\n").length;
    hits.push(`line ${line}: ${span.match(/.{0,60}\bctx\s*\..{0,30}/)?.[0] ?? "?"}`);
  });
  return hits;
};

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const EXT = "../extensions/tabichat/";
const FILES = ["index.ts"];

// --- the real tree ----------------------------------------------------------
for (const f of FILES) {
  check(`${f}: no ctx use outside a ctx-declared scope`, escapedCtx(read(EXT + f)), []);
}

// --- pin the fix itself: the tool that ships refusals must hold the context -----
const idx = read(EXT + "index.ts");
const chatPostSig = EXECUTE_SIG.exec(idx.slice(idx.indexOf('name: "chat_post"')));
EXECUTE_SIG.lastIndex = 0;
check(
  'REGRESSION PIN — chat_post declares ctx (it calls ctx.ui.notify on the over-cap path)',
  paramNames(chatPostSig?.[1] ?? "").includes("ctx"),
  true,
);

// --- NEGATIVE HALVES: the gate has to be able to fail -----------------------
const body = `
        if (!fit.ok) {
          const note = postTooLongNote(fit.len, fit.max);
          ctx.ui.notify(\`[tabichat] \${note}\`, "warning");
        }
`;
check(
  "the shipped shape IS caught: _ctx declared, ctx used",
  escapedCtx(`async execute(_id, params, _signal, _onUpdate, _ctx) {${body}}`).length,
  1,
);
check(
  "...and the fix clears it: ctx declared, ctx used",
  escapedCtx(`async execute(_id, params, _signal, _onUpdate, ctx) {${body}}`),
  [],
);
check(
  "NO FALSE POSITIVE — a body that uses only the underscore name is clean",
  escapedCtx(
    `async execute(_id, params, _signal, _onUpdate, _ctx) {\n  _ctx.ui.notify("x", "info");\n}`,
  ),
  [],
);
check(
  "NO FALSE POSITIVE — a span that borrows a later ctx declaration passes",
  escapedCtx(
    `async execute(_id, params, _signal, _onUpdate, _ctx) {\n  foo();\n}\npi.on("session_start", async (_e, ctx) => {\n  ctx.ui.notify("x", "info");\n});`,
  ),
  [],
);
check(
  "a tool that uses no ctx at all is clean (chat_read's real shape)",
  escapedCtx(`async execute(_id, params, _signal, _onUpdate, _ctx) {\n  return { content: [] };\n}`),
  [],
);

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nall checks pass");
}
