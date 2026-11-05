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
const printf_ = (t: string): void => { process.stdout.write(t); };
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  } else console.log(`ok   ${name}`);
};
/** Assert what a refusal SAYS, not only the boolean beside it (the helper `test_laneadmin.ts` already
 *  uses under the name `says`, spelled here because this file has no such helper yet). */
const says988 = (name: string, hay: string, needle: string) => check(name, hay.includes(needle), true);

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

/**
 * EVERY name the array ends up declaring: the arm's own literal plus every top-level `+=` registration.
 *
 * WHY THIS EXISTS (iid 13, leg 969). `filesOf` takes the FIRST single-line `KEY=(…)$` match and a `+=`
 * line never matches that shape at all, so `${GATES.length}` counted 17 while the tabichat stage declares
 * 21 `.ts` names — 17 in the literal and 4 appended after `esac`, which the shell adds to whichever arm
 * ran. The run was never lying about its own scope; the LABEL was, and a cold seat quoting it reports a
 * number that no gate produces. So the count is derived from both forms and every printed figure names
 * which denominator it is.
 *
 * `deploy-tabichat.sh` carries a SECOND single-line `GATES=(test_fsgate.ts)` in the fs-gate arm, so the
 * literal half is read INSIDE the tabichat case slice and only the `+=` forms — which are not arm-specific
 * — are read from file scope. A reader that took whichever `GATES=(` matched would count the other arm's
 * gate into this one: one wrong number replaced by another, which is the failure this file exists to stop.
 */
// `src` DEFAULTS to the shipped script, so every call site above reads the same bytes it always did.
// The argument exists because leg 974's review returned D2: one cell asserted a de-duplication with a
// `Set` demo on two literal strings, never calling this reader, so it could not go red. A claim about
// counting needs the counter. Widening a reader's reach is not widening a check — the assertion got
// STRICTER (it now runs the shipped reader), and the plant in section 5 is the proof it can fail.
const plusOf = (key: string, src: string = deploy): string[] =>
  [...src.matchAll(new RegExp(`^\\s*${key}\\+=\\((.*)\\)$`, "gm"))]
    .flatMap((m) => m[1].trim().split(/\s+/)).filter((n) => n.length > 0);
const declaredOf = (armLiteral: string[], key: string, src: string = deploy): string[] =>
  [...new Set([...armLiteral, ...plusOf(key, src)])];
const GATES_ALL = declaredOf(GATES, "GATES");
const PHYSICAL = declaredOf(filesOf(tabichatCase, "PHYSICAL"), "PHYSICAL");
const PYGATES = declaredOf(filesOf(deploy, "PYGATES"), "PYGATES");
const SHGATES = declaredOf(filesOf(deploy, "SHGATES"), "SHGATES");
/** What a stage run executes: the .ts gates + the python gates + the shell gates. PHYSICAL is NOT in it —
 *  those members have their own executor (`deploy-tabichat.sh --physical`), which is the other half of
 *  why two correct lanes can print two correct numbers for one thing. */
const STAGE_EXECUTED = GATES_ALL.length + PYGATES.length + SHGATES.length;
/**
 * The tabichat-EFFECTIVE registered set: every name this arm ends up declaring, `PHYSICAL` included.
 * Both ends of this number were printed wrongly today, so the arithmetic is shown rather than asserted.
 * ALL FOUR `PHYSICAL` members sit in no stage array — not two, which is what the comment here used to
 * say, and the correction is D1's other half: the two names the `+=` at `deploy-tabichat.sh:78` adds are
 * no more in a stage array than the first pair, and they are NOT the same file as a stage gate that
 * differs by a stem (`test_tlsenv_paho.py` against `PYGATES`'s `test_tlsenv.py`, `test_ack_watch_broker.ts`
 * against `GATES`'s `test_broker.ts`), so the arrays do not overlap and the gap is the whole of `PHYSICAL`.
 * "In no stage array" is NOT "never run": `deploy-tabichat.sh --physical` runs all four, and leg 976
 * measured them rc 0 at 20 / 15 / 57 / 19 cells on a broker it stood up. Counting the fs-gate arm's
 * `test_fsgate.ts` is the opposite error (it belongs to that arm's own `GATES=(…)`, and this instrument
 * reads only the slice it took). The tabichat-effective figure is neither: it is the union below.
 */
const REGISTERED = [...new Set([...GATES_ALL, ...PYGATES, ...SHGATES, ...PHYSICAL])];
const ARRAY_SUM = GATES_ALL.length + PYGATES.length + SHGATES.length + PHYSICAL.length;

/**
 * THE GAP, AS ONE FUNCTION — the D1 fix, so that the sentence, the number and the instrument are one
 * object. The shipped form of this claim filtered a HAND-CARRIED list of two names, so its output could
 * never exceed 2: the reviewer planted a third never-executed `PHYSICAL` member, the union moved 43 -> 44,
 * and the cell printed its usual `ok` (leg 974, D1). A filter over names somebody copied out of an array
 * cannot report a name nobody copied. This takes the arrays and returns the members that are in `PHYSICAL`
 * and in no stage array; section 5 asserts its LENGTH against the gap the same arrays print.
 */
const physicalOnly = (gatesAll: string[], py: string[], sh: string[], physical: string[]): string[] =>
  physical.filter((n) => !gatesAll.includes(n) && !py.includes(n) && !sh.includes(n));
const PHYSICAL_ONLY = physicalOnly(GATES_ALL, PYGATES, SHGATES, PHYSICAL);
/** What a plain stage run EXECUTES, as a SET: a name in two stage arrays is still executed once, so the
 *  sum and the set are different objects and the gap is only honest if the reader says which one it used. */
const STAGE_SET = [...new Set([...GATES_ALL, ...PYGATES, ...SHGATES])];
const STAGE_OVERLAP = GATES_ALL.length + PYGATES.length + SHGATES.length - STAGE_SET.length;

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

// 5. THE COUNT IS DERIVED, AND IT CAN MOVE (iid 13 / leg 969 — a count that cannot change is decoration)
{
  // D2 (leg 974): this asserted `union == literal + appended`, which is only true when NO name is in
  // both forms — so the cell REFUSED the exact input the prose three lines below says it tolerates. The
  // honest claim is the containment, and the overlap is NAMED rather than rejected: a name in both forms
  // is a registration someone made twice, and the useful sentence says which one it is.
  const GATES_PLUS = plusOf("GATES");
  const BOTH_FORMS = GATES.filter((n) => GATES_PLUS.includes(n));
  check(`the reader sees every += registration: union ${GATES_ALL.length} holds the literal (${GATES.length}) and the appended (${GATES_PLUS.length}) together, at least as large as either alone`,
    [GATES_ALL.length >= GATES.length, GATES_ALL.length >= GATES_PLUS.length, GATES.every((n) => GATES_ALL.includes(n)), GATES_PLUS.every((n) => GATES_ALL.includes(n))],
    [true, true, true, true]);
  // The shipped comment here promised "a name registered twice is counted once" and then asserted an
  // arithmetic that only holds when NO name is registered twice. This is the same claim done so it stays
  // true EITHER way: the number of double-counted slots equals the number of names the two forms share,
  // which is exactly what `declaredOf`'s de-duplication owes. It reads 0 today, and a real duplicate
  // makes BOTH sides move together — so the overlap is NAMED and the cell keeps bite (it goes red if the
  // de-duplication stops happening, which the planted run in the leg report shows).
  printf_(`note  GATES forms overlap: ${BOTH_FORMS.length ? BOTH_FORMS.join(" ") : "none"} (${GATES.length} literal + ${GATES_PLUS.length} appended − ${GATES_ALL.length} union = ${GATES.length + GATES_PLUS.length - GATES_ALL.length} double-counted slot(s))\n`);
  check("...and the slots the union dropped equal the names both forms carry, so a duplicate is counted once AND named (0 today is a measurement, not a ceiling)",
    GATES.length + GATES_PLUS.length - GATES_ALL.length, BOTH_FORMS.length);
  // Deliberately NOT a pin on the exact list of appended names: this file's own comment records that a
  // check repeating a count has to be re-derived every merge, and a list pin would be the same trap in a
  // different dress — a legitimate new registration would turn this gate red. What is asserted instead is
  // the STRUCTURE: the union is larger than the literal, nothing from the other arm leaked in, and a name
  // registered twice is counted once.
  check(`...and the appended set is non-empty and stays inside the tabichat arm's own count (${plusOf("GATES").length} appended)`,
    plusOf("GATES").length > 0, true);
  check(`...and the union is the literal plus the genuinely new appended names (${GATES_PLUS.length - BOTH_FORMS.length} new of ${GATES_PLUS.length})`,
    GATES_ALL.length, GATES.length + GATES_PLUS.length - BOTH_FORMS.length);
  check("...and the union is exactly the set-union of the two forms, so no reader drifts from the other",
    GATES_ALL.slice().sort().join(","), [...new Set([...GATES, ...GATES_PLUS])].sort().join(","));
  // D2's other half: the shipped cell was `new Set(["x.ts", "x.ts", "y.ts"])` on two literals — it never
  // called `declaredOf`, never read a script, and could not go red. This calls the SHIPPED reader over a
  // synthetic two-form script in which `b.ts` is registered twice, and asks it to count once. The plant
  // below (a third name added to both forms) is what proves the cell can fail.
  /** A whole synthetic deploy script: the arm header `filesOf` slices on, plus the top-level `+=` forms. */
  const synthScript = (literal: string, ...plusForms: string[]): string =>
    `case "$EXT" in\n  tabichat)\n    FILES=(index.ts)\n    ${literal}\n    ;;\nesac\n${plusForms.map((p2) => `GATES+=(${p2})`).join("\n")}\n`;
  const synthArmOf = (src: string): string => (src.match(/\n\s*tabichat\)\n([\s\S]*?)\n\s*;;/) ?? [, ""])[1];
  const synthDup = synthScript("GATES=(a.ts b.ts)", "b.ts c.ts");
  const dupLit = filesOf(synthArmOf(synthDup), "GATES");
  const dupUnion = declaredOf(dupLit, "GATES", synthDup);
  check("...and a name registered in BOTH forms is counted once by declaredOf, read out of a script, not out of a literal",
    [dupLit.length, plusOf("GATES", synthDup).length, dupUnion.sort().join(",")], [2, 2, "a.ts,b.ts,c.ts"]);
  check("...and POSITIVE CONTROL: the same reader, on a script that adds a THIRD name to the appended form, says 4 — the count moves when the script moves",
    declaredOf(["a.ts", "b.ts"], "GATES", synthScript("GATES=(a.ts b.ts)", "b.ts c.ts d.ts")).sort().join(","),
    "a.ts,b.ts,c.ts,d.ts");
  const dupBoth = dupLit.filter((n) => plusOf("GATES", synthDup).includes(n));
  check("D2 CONTROL: on that synthetic script the overlap is NAMED (`b.ts`) — the old `literal + appended == union` form refused a registration like this one instead of reporting it",
    dupBoth, ["b.ts"]);
  check("NEGATIVE: the fs-gate arm's own `GATES=(test_fsgate.ts)` is NOT counted into the tabichat set",
    GATES_ALL.includes("test_fsgate.ts"), false);
  const synth = synthScript("GATES=(a.ts)", "b.ts c.ts", "d.ts");
  const lit = filesOf(synthArmOf(synth), "GATES");
  // The shipped cell built its own inline `matchAll` for the appended half — a second reader that could
  // drift from `plusOf` and still print 4. One reader now answers both halves, on the same synthetic text.
  check("CONTROL: on a synthetic script the same pair of readers yields 1 + 3 = 4, so it counts, not matches",
    [lit.length, plusOf("GATES", synth).length, declaredOf(lit, "GATES", synth).length], [1, 3, 4]);
  check("...and a script with no += form reads exactly its literal (the pair degenerates correctly)",
    declaredOf(["only.ts"], "NOTHING_APPENDS").length, 1);
  check(`the tabichat-effective union is the four arrays minus their overlaps (.ts ${GATES_ALL.length} + .py ${PYGATES.length} + .sh ${SHGATES.length} + PHYSICAL ${PHYSICAL.length} = ${ARRAY_SUM}; union ${REGISTERED.length}; overlap ${ARRAY_SUM - REGISTERED.length})`,
    REGISTERED.length <= ARRAY_SUM && REGISTERED.length >= GATES_ALL.length && STAGE_OVERLAP === 0, true);
  check(`...and every PHYSICAL member is IN the union — leaving them out is how ${STAGE_EXECUTED} gets printed for a registered set of ${REGISTERED.length}, and the difference is ${PHYSICAL_ONLY.length} names, not two`,
    PHYSICAL.every((n) => REGISTERED.includes(n)), true);
  // D1 (leg 974), THE CELL THE REVIEW RETURNED. It read
  //   ["test_broker_auth.ts","test_fixture_isolation.py"].filter(…).length, 2
  // — a filter over a HAND-CARRIED list of two names, so 2 was both its answer and its ceiling: the
  // reviewer's plant put a third never-executed member in PHYSICAL, the union moved 43 -> 44, and this
  // line still printed `ok`. `physicalOnly()` takes the ARRAYS, so the count belongs to the script and
  // not to whoever last edited this file. The right-hand side is the sum (`STAGE_EXECUTED`), not the set:
  // the equality is only automatic while no name sits in two stage arrays, and the control below plants
  // exactly that to show the cell can fail.
  check(`...and the ${PHYSICAL_ONLY.length} names that live in PHYSICAL and in no stage array ARE the gap the labels print (${REGISTERED.length} registered − ${STAGE_EXECUTED} stage slots) — NOT executed by an ordinary stage run, and NOT never-run: \`--physical\` has an executor`,
    PHYSICAL_ONLY.length === REGISTERED.length - STAGE_EXECUTED, true);
  says988("...and the derived list is named here so a reader can check it against the script, not against this cell's prose",
    PHYSICAL_ONLY.join(" "), "test_broker_auth.ts");
  check("...and those members DO have an executor — the script iterates PHYSICAL under `--physical`, which is why the sentence is `not run by a stage run` and never `never run`",
    [/for t in "\$\{PHYSICAL\[@]\}"; do/.test(deploy), /--physical\) want_physical=1/.test(deploy)], [true, true]);
  // PAIRED NEGATIVES for D1 — computed, so no reviewer has to take the note above on faith.
  // RELATIVE, not absolute: a control that hard-codes today's 4 is the same trap one level down — it
  // reddens on a legitimate registration and the reader cannot tell that from a broken instrument. Both
  // sides are asked to move together, by exactly one, from whatever the script says today.
  check(`D1 CONTROL: plant a never-executed PHYSICAL member and both sides move TOGETHER to ${PHYSICAL_ONLY.length + 1} (a hand-carried list of names could never have said it)`,
    (() => {
      const phys = [...PHYSICAL, "test_plant_one_more.py"];
      const reg = [...new Set([...GATES_ALL, ...PYGATES, ...SHGATES, ...phys])];
      return [physicalOnly(GATES_ALL, PYGATES, SHGATES, phys).length, reg.length - STAGE_EXECUTED];
    })(), [PHYSICAL_ONLY.length + 1, PHYSICAL_ONLY.length + 1]);
  // The same name in TWO stage arrays is executed once but counted twice by the sum, so `REGISTERED −
  // STAGE_EXECUTED` is one short of the derived list and the equality above is FALSE. This is the shape
  // that makes the D1 cell an instrument rather than an identity, and it is what plant 2 in the leg
  // report reproduces in a real run.
  check(`D1 CONTROL: plant a name in TWO stage arrays and the equality BREAKS — the list still says ${PHYSICAL_ONLY.length}, the sum's gap says ${PHYSICAL_ONLY.length - 1} — so the cell can fail`,
    (() => {
      const py = [...PYGATES, "test_laneadmin.ts"];
      const sum = GATES_ALL.length + py.length + SHGATES.length;
      const reg = [...new Set([...GATES_ALL, ...py, ...SHGATES, ...PHYSICAL])];
      return [physicalOnly(GATES_ALL, py, SHGATES, PHYSICAL).length === reg.length - sum, reg.length - sum];
    })(), [false, PHYSICAL_ONLY.length - 1]);
  check("NEGATIVE: the fs-gate arm's gate is not in the tabichat-effective set either (counting it is how 41 was printed)",
    REGISTERED.includes("test_fsgate.ts"), false);
  printf_("note  several true numbers describe one tabichat deploy, and this gate names the ones it printed: " +
    "(1) the arm-literal read alone sees " + GATES.length + " .ts names — that is what this file printed as `gates` " +
    "while the label implied a whole; (2) the tabichat arm registers " + GATES_ALL.length + " .ts and " +
    REGISTERED.length + " gate members in total, counting PHYSICAL, which is the set a merge changes; (3) a plain " +
    "stage run executes " + STAGE_EXECUTED + " of them and prints one build line besides, never reaching PHYSICAL. " +
    "A fourth count exists — the iid-13 census globs src/tools/ and reports files on disk — and it is deliberately " +
    "NOT printed, averaged or reconciled here: a gap between the registered set and the files on disk is that " +
    "census's finding, and closing it from this instrument would hide the thing it exists to catch.\n");
}

console.log(failed === 0
  ? `test_deploy_closure: ALL PASS (${REACHABLE.length} reachable modules, ${FILES.length} shipped in FILES, ${edges.length} order edges; gates: ${GATES.length} in the arm literal, ${GATES_ALL.length} .ts registered for the tabichat arm, ${REGISTERED.length} tabichat-effective members across GATES/PYGATES/SHGATES/PHYSICAL — declared-membership counts, not the ${STAGE_EXECUTED} a plain stage run executes and not the directory file count the iid-13 census prints)`
  : `test_deploy_closure: ${failed} FAILURE(S) — unshipped: ${JSON.stringify(unshipped)}`);
process.exitCode = failed ? 1 : 0;
