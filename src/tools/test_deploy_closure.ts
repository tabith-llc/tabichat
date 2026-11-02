// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * DEPLOY-SET CLOSURE (leg 802): every module reachable from the entry point through local imports
 * must be in the deploy script's FILES array, dependency-first, and the gates that guard them must
 * be in GATES.
 *   bun tools/test_deploy_closure.ts      (exit 1 on any failure)
 *
 * WHY A CLOSURE, NOT A NAME. Leg 800 added `roomlog.ts`, imported it from `index.ts`, and walked
 * straight past the guard in `test_diaglog_routing.ts` — because that guard asserts ONE filename
 (`diaglog.ts`, the module of ITS leg). The deploy script's own comment names the incident class:
 * an index.ts shipped beside a missing dependency "dies at import on every lane", and the
 * destination load-check runs AFTER the mv loop, so a real deploy would publish the broken half
 * first. A per-leg assertion can only ever cover the leg that wrote it; the transitive closure
 * covers the next leg nobody thought about. This file is the class, not the instance.
 *
 * Both directions are checked as the script states them:
 *   1. MEMBERSHIP — every reachable module is listed in FILES for its extension case;
 *   2. ORDER — for every import edge a -> b, b appears BEFORE a in FILES, and the entry is last;
 *   3. GATE LIST — this gate and test_roomlog.ts (the leg-800 pair) are IN GATES; a gate nobody
 *      runs is decoration (audit iid 13, same law the diaglog row cites);
 *   4. NEGATIVE CONTROLS — the same instruments run over synthetic inputs: an unlisted module MUST
 *      be named, an inverted order MUST be caught, and a GATES line without this file MUST refuse.
 *      An instrument that cannot go red on the bytes that motivated it is the silent-pass tool that
 *      already failed once here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  } else console.log(`ok   ${name}`);
};

const EXT_DIR = join(import.meta.dir, "..", "extensions", "tabichat");
const deploy = readFileSync(join(import.meta.dir, "deploy-tabichat.sh"), "utf8");

/** The FILES array of the tabichat case — the FIRST FILES line in the script (the fs-gate case has
 * its own entry in the same switch, and a regex that takes whichever line matches is a filter that
 * reads the wrong door: the case block is sliced first, then the array is read INSIDE it). */
const tabichatCase = (() => {
  const t = deploy.match(/\n\s*tabichat\)\n([\s\S]*?)\n\s*;;/);
  if (!t) throw new Error("deploy-tabichat.sh: no `tabichat)` arm found — the instrument is pointed at the wrong shape");
  return t[1];
})();
const filesOf = (arm: string, key: string): string[] => {
  const line = arm.match(new RegExp(`^\\s*${key}=\\((.*)\\)$`, "m"));
  if (!line) throw new Error(`deploy-tabichat.sh: no ${key} array in the tabichat arm`);
  return line[1].trim().split(/\s+/);
};
const FILES = filesOf(tabichatCase, "FILES");
const GATES = filesOf(tabichatCase, "GATES");

/** TRANSITIVE closure over `from "./x.ts"` edges, starting at the entry module. One level would
 * have passed leg 800's FIRST draft two levels deep — roomlog.ts is imported by index.ts directly,
 * but a future roomlog-imported leaf is the case that still bites, so the walk is proper BFS. */
const localImportsOf = (src: string): string[] =>
  [...src.matchAll(/from\s+"(\.\/[^"]+\.ts)"/g)].map((m) => m[1].replace(/^\.\//, ""));
const closureOf = (entry: string, read: (name: string) => string): string[] => {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const dep of localImportsOf(read(cur))) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen];
};
const readExt = (name: string): string => readFileSync(join(EXT_DIR, name), "utf8");
const REACHABLE = closureOf("index.ts", readExt).sort();

// 1. MEMBERSHIP, named module by module (a bare count would not tell the next lane WHAT to fix)
const unshipped = REACHABLE.filter((m) => !FILES.includes(m));
check(`every module reachable from index.ts is in FILES (reachable ${REACHABLE.length}, shipped ${FILES.length})`,
  unshipped, []);
check("and specifically roomlog.ts — the leg-800 miss this gate was written for", FILES.includes("roomlog.ts"), true);

// 2. ORDER: dependency before importer, entry last
const edges: Array<[string, string]> = [];
for (const m of REACHABLE) for (const d of localImportsOf(readExt(m))) if (REACHABLE.includes(d)) edges.push([m, d]);
const orderBad = edges.filter(([a, b]) => !(FILES.includes(a) && FILES.includes(b)) || FILES.indexOf(b) < FILES.indexOf(a) ? false : [a, b])
  .map(([a, b]) => `${b} must sit before ${a}`);
check("FILES order is dependency-first for every import edge (edges checked)", orderBad.length, 0);
check("and the entry point is LAST in FILES", FILES.indexOf("index.ts"), FILES.length - 1);

// 3. GATE LIST
check("this closure gate is IN the deploy GATES array (a gate nobody runs is decoration)", GATES.includes("test_deploy_closure.ts"), true);
check("and the leg-800 room journal gate is IN GATES too", GATES.includes("test_roomlog.ts"), true);

// 4. NEGATIVE CONTROLS — the instruments above must bite on the shapes that motivated them
{
  const filesNoRoomlog = FILES.filter((f) => f !== "roomlog.ts");
  const miss = REACHABLE.filter((m) => !filesNoRoomlog.includes(m));
  check("NEGATIVE CONTROL: a FILES array missing roomlog.ts is reported, naming it", miss, ["roomlog.ts"]);
  const flipped = [...FILES];
  const ri = flipped.indexOf("roomlog.ts");
  const ii = flipped.indexOf("index.ts");
  flipped[ri] = "index.ts";
  flipped[ii] = "roomlog.ts";
  const edgeBad = edges.filter(([a, b]) => !(flipped.includes(b) && flipped.includes(a)) || flipped.indexOf(b) < flipped.indexOf(a) ? false : [a, b]);
  check("NEGATIVE CONTROL: importer-before-dependency is caught by the same predicate", edgeBad.length > 0, true);
  const emptyArm = "    FILES=(roommsg.ts index.ts)\n    GATES=(test_mention.ts)";
  check("NEGATIVE CONTROL: a GATES array without this file is refused by the same predicate", filesOf(emptyArm, "GATES").includes("test_deploy_closure.ts"), false);
  const emptyArmFull = "    FILES=(index.ts)\n    GATES=(test_mention.ts)";
  check("NEGATIVE CONTROL: the two-array arm reader sees a one-file ship set as broken",
    REACHABLE.filter((m) => !filesOf(emptyArmFull, "FILES").includes(m)).includes("roomlog.ts"), true);
}

console.log(failed === 0
  ? `test_deploy_closure: ALL PASS (${REACHABLE.length} reachable, ${FILES.length} shipped, ${edges.length} order edges, ${GATES.length} gates)`
  : `test_deploy_closure: ${failed} FAILURE(S) — unshipped: ${JSON.stringify(unshipped)}`);
process.exitCode = failed ? 1 : 0;
