// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * THE TYPECHECK GATE (PART 2.1). Run from `src/`:
 *   bun tools/typecheck_ext.ts        (exit 1 on any UNLISTED error)
 *
 * WHY THIS EXISTS. The defect 45 + 236 + 421 + 10 cells all missed was one missing key in one
 * object literal at `index.ts` — `makeRoomLogIo({…})` without `appendFileSync`, on the journal's
 * hot path. `bun build` does not typecheck, and no gate in this repo ran the typechecker until
 * this file. The compiler names this class of mistake exactly; this gate lets it.
 *
 * SCOPE, DISCLOSED (the leg spec's own instruction): it covers `src/extensions/tabichat/*.ts` —
 * every SHIPPED module, including `index.ts`, the file that broke. `tools/` and `preview-ext/` are
 * not covered: they have no types story yet and pretending otherwise would have buried the signal
 * under environment noise this repo cannot resolve offline. A whole-tree check is a separate leg,
 * not a quiet omission.
 *
 * PRE-EXISTING DEBT is a NAMED allow-list, the same house pattern as the `console.error` denylist
 * in test_diaglog_routing.ts ("3 sites, all NAMED; 3 approved"). Fingerprints are
 * `file|TScodes|message-prefix` — never line numbers, which rot under the cite law. Any UNLISTED
 * error goes red, which is what makes tonight's regression class impossible to ship; a listed
 * entry that has been FIXED stays listed until a human prunes the list, and the gate prints the
 * live count so drift is visible. The instrument proves it bites by the RED-at-the-old-tip record
 * in the report that found it: TS2741 naming `appendFileSync` before the fix commit, silence after.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join(import.meta.dir, "..", "extensions", "tabichat");

let failed = 0;
const fail = (m: string) => {
  failed++;
  console.log(`FAIL ${m}`);
};

// the config must exist where the lane17 will find it — if it drifts away, the check silently
// degrades into "Cannot find module" flood; the unlisted fingerprints catch that too, but naming
// it first makes the cause readable.
for (const need of ["tsconfig.json", "externals.d.ts"]) {
  if (!existsSync(join(EXT_DIR, need))) fail(`extensions/tabichat/${need} is MISSING — the scoped typecheck cannot mean anything without it`);
}

// self-listing law (audit iid 13, same as diaglog's row): a gate nobody runs is decoration.
const deploy = readFileSync(join(import.meta.dir, "deploy-tabichat.sh"), "utf8");
const armMatch = deploy.match(/\n\s*tabichat\)\n([\s\S]*?)\n\s*;;/);
const gatesLine = armMatch ? ((armMatch[1].match(/^\s*GATES=\((.*)\)$/m) ?? ["", ""])[1]) : "";
if (!gatesLine.includes("typecheck_ext.ts")) fail("this gate is NOT in the deploy GATES array");

const run = spawnSync(process.execPath, ["--check", "index.ts"], {
  cwd: EXT_DIR,
  encoding: "utf8",
  env: { ...process.env, MQTT_LEAD_NICK: undefined, MQTT_OWNER_NICK: undefined },
});
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const errors: string[] = [];
for (const line of out.split("\n")) {
  const m = line.match(/^([A-Za-z0-9_.-]+\.ts)\(\d+,\d+\): error (TS\d+): (.*?)(?:\s*$)/);
  if (m) errors.push(`${m[1]}|${m[2]}|${m[3].replace(/\s+/g, " ").trim().slice(0, 70)}`);
}

// APPROVED pre-existing debt. Every entry was READ from the compiler's own output at the leg-806
// tip (`bun --check index.ts` in `extensions/tabichat`, deduplicated) and is either (a) the repo's
// house union type style — accesses guarded at runtime by the `ok`/`deliberate` discriminants and
// exercised by the shipped gates, just not narrowed the way `tsc` wants — or (b) a `node:fs` stub
// member short of the real thing (statSync `mtimeMs`/`isFile`). 25 distinct fingerprints, 32 live
// occurrences at this tip; the printed count is the drift detector. NONE of these is the wiring
// class: TS2741 on a fresh object literal is NOT and never will be on this list — that is the line
// this gate was built to make impossible to ship, and the finding's own report holds the RED output at
// the pre-fix tip. Prune entries as files get narrowed; never add one without naming it here.
const APPROVED: string[] = [
  "broker.ts|TS2339|Property 'message' does not exist on type 'BrokerResolution'.",
  "broker.ts|TS2339|Property 'reason' does not exist on type '{ ok: true; config: Record<s",
  "broker.ts|TS2339|Property 'reason' does not exist on type '{ ok: true; url: string; } |",
  "broker.ts|TS2353|Object literal may only specify known properties, and 'message' does n",
  "diaglog.ts|TS2339|Property 'reason' does not exist on type 'DiagTarget'.",
  "diaglog.ts|TS2339|Property 'reason' does not exist on type '{ ok: true; rotated: boolean",
  "diaglog.ts|TS2345|Argument of type 'string' is not assignable to parameter of type '\"0\" ",
  "index.ts|TS2339|Property 'deliberate' does not exist on type 'DiagTarget'.",
  "index.ts|TS2339|Property 'deliberate' does not exist on type 'RoomLogTarget'.",
  "index.ts|TS2339|Property 'isFile' does not exist on type '{ size: number; isDirectory(",
  "index.ts|TS2339|Property 'len' does not exist on type '{ ok: true; } | { ok: false; le",
  "index.ts|TS2339|Property 'max' does not exist on type '{ ok: true; } | { ok: false; le",
  "index.ts|TS2339|Property 'message' does not exist on type 'BrokerResolution'.",
  "index.ts|TS2339|Property 'mtimeMs' does not exist on type '{ size: number; isDirectory",
  "index.ts|TS2339|Property 'reason' does not exist on type 'AdminVerdict'.",
  "index.ts|TS2339|Property 'reason' does not exist on type 'AutoRenewVerdict'.",
  "index.ts|TS2339|Property 'reason' does not exist on type 'DiagTarget'.",
  "index.ts|TS2339|Property 'reason' does not exist on type '{ ok: true; config: Record<s",
  "index.ts|TS2339|Property 'reason' does not exist on type '{ ok: true; } | { ok: false;",
  "index.ts|TS2339|Property 'reason' does not exist on type '{ ok: true; trimmed: number;",
  "index.ts|TS2339|Property 'reason' does not exist on type 'ResumeDirResolution'.",
  "index.ts|TS2339|Property 'reason' does not exist on type 'RoomLogTarget'.",
  "index.ts|TS2339|Property 'scratch' does not exist on type 'ResumeDirResolution'.",
  "index.ts|TS2339|Property 'speak' does not exist on type 'AdminVerdict'.",
  "index.ts|TS2339|Property 'why' does not exist on type 'AuthorVerdict'.",
];

const unlisted = errors.filter((e) => !APPROVED.includes(e));
if (unlisted.length > 0) {
  fail(`${unlisted.length} UNLISTED typecheck error(s):`);
  for (const e of unlisted) console.log(`  RED ${e}`);
}
console.log(
  `typecheck_ext: ${errors.length} error(s) live, ${unlisted.length} unlisted, ${APPROVED.length} approved entries (scoped: src/extensions/tabichat; tools/ and preview-ext/ NOT covered — disclosed)`
);
process.exit(failed === 0 && unlisted.length === 0 ? 0 : 1);
