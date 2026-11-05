// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * tabichat iid 28 (second half), leg 995 — the gate must REFUSE an entry-mounting cell whose sinks
 * are unset, so the protection is a check and not a memory.
 *   bun tools/test_sink_guard.ts        (exit 1 on any refusal)
 *
 * WHY A GATE AND NOT A COMMENT. A cell that mounts the shipped entry (`src/extensions/tabichat/
 * index.ts`) with `MQTT_DIAG_LOG` and `MQTT_EXIT_LOG` unset does not get "off" — it gets the BOX
 * DEFAULTS, and the box defaults are shared files every seat writes to:
 *   `diaglog.ts:33`   `export const DIAG_DEFAULT_SUBPATH = ".pi/agent/tabichat-diag.log";`  — resolved
 *                     under the real `HOME` (`resolveDiagTarget`: `if (v === "") continue;`, then the
 *                     default branch), so an empty assignment is an ABSENCE, not a value; and
 *   `exitlog.ts:30`   `export const EXIT_LOG_DEFAULT = "/tmp/tabichat/lane-exits.log";` — read at
 *                     `index.ts:872` as `process.env.MQTT_EXIT_LOG || EXIT_LOG_DEFAULT`, an absolute
 *                     path, so a scratch `cwd` does not redirect it either.
 * Both files are mode `0664` on a box where every seat runs as the same user. A later seat greps them
 * for lane traffic and reads a cell's line as something a lane said. Leg 991 pointed the mounters at
 * scratch; that is the memory half. This file is the check: a new arm written into either sink lands on
 * the box file only if this gate is silently skipped.
 *
 * HOW THE MOUNT SET IS DERIVED (the method leg 991 recorded — reused, not reinvented). The predicate is
 * **"a dynamic import whose argument resolves to the entry"**, never a literal-path grep. A grep for
 * `tabichat/index.ts` names `test_broker.ts` (which `readFileSync`s the entry's BYTES to assert on their
 * shape) and `test_fsgate.ts` (which holds the path inside a `classify()` fixture string), and MISSES
 * every real mounter, because a mounter builds the path with
 * `join(import.meta.dirname, "..", "extensions", "tabichat", "index.ts")` and imports the identifier.
 * Writing `process.env.MQTT_DIAG_LOG = …` into those two files would satisfy such a grep and protect
 * nothing — that is making a check pass by fitting the code to a bad instrument. Cells 2 and 3 below
 * keep both directions pinned, so the wrong instrument reddens THIS file rather than shipping quiet.
 *
 * NAMED LIMITS, stated because a gate that hides its own blind spot is a rumour. (1) The text arm reads
 * the literal env names; a cell that sets a sink through a computed key (`process.env[DIAG_ENV]`)
 * escapes it — cell 4 is the behavioural net for exactly that case. (2) A mount through a path assembled
 * some other way (a variable holding the whole directory, or a child process that loads the extension)
 * escapes the predicate too, and leg 991 says so of its own census; this gate inherits that limit rather
 * than claiming past it. (3) Cell 4 spawns the mounters, so it measures what a run does today; the text
 * arms are what catch a cell that has not been run yet.
 *
 * ONE MORE LIMIT, and it fails the safe way. Cell 4 compares BYTE SIZE of a shared box file before and
 * after one mounter run, and every seat on this box appends to that same log. A peer's line landing
 * inside that window therefore reads as growth and the cell goes RED against an innocent mounter — a
 * false alarm, never a false pass. If it recurs on a re-run, read the newest line's nick field: a nick
 * that is not the mounter's own is the box's traffic, not a defect in the cell.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DIAG_DEFAULT_SUBPATH, DIAG_ENV } from "../extensions/tabichat/diaglog.ts";
import { EXIT_LOG_DEFAULT } from "../extensions/tabichat/exitlog.ts";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else console.log(`ok    ${name}: ${g}`);
};

const TOOLS = import.meta.dirname;
const SRC = join(TOOLS, "..");
const ENTRY = join(SRC, "extensions", "tabichat", "index.ts");
const SINKS = [DIAG_ENV, "MQTT_EXIT_LOG"];

/** Byte offsets of every `await import(` whose argument resolves to the entry. See the header. */
const MOUNT_ARG = /await import\(\s*(`[^`]*`|"[^"]*"|[A-Za-z_]\w*)/g;
const ENTRY_SHAPE = /extensions[/"]+,?\s*"?tabichat[/"]+,?\s*"?index\.ts|"extensions",\s*"tabichat",\s*"index\.ts"/;
const mountOffsets = (src: string): number[] => {
  const hits: number[] = [];
  for (const m of src.matchAll(MOUNT_ARG)) {
    const arg = m[1];
    if (arg[0] === "`" || arg[0] === '"') {
      if (ENTRY_SHAPE.test(arg)) hits.push(m.index as number);
    } else {
      const decl = new RegExp(`(const|let)\\s+${arg}\\s*=\\s*.*`).exec(src);
      if (decl && ENTRY_SHAPE.test(decl[0])) hits.push(m.index as number);
    }
  }
  return hits;
};

/** An ASSIGNMENT of a sink to a non-empty value: the literal name, `=`, and a right-hand side that is
 *  neither empty nor `""`. `delete process.env.X` has no `=` and is correctly not an assignment. */
const assignOffsets = (src: string, name: string): number[] => {
  const re = new RegExp(
    `process\\.env\\.${name}\\s*=\\s*([^;\\n]+)|process\\.env\\[\\s*"${name}"\\s*\\]\\s*=\\s*([^;\\n]+)`,
    "g",
  );
  const hits: number[] = [];
  for (const m of src.matchAll(re)) {
    const rhs = (m[1] ?? m[2] ?? "").trim();
    if (rhs === "" || rhs === '""' || rhs === "''" || rhs === "undefined") continue;
    hits.push(m.index as number);
  }
  return hits;
};

const files: string[] = readdirSync(TOOLS).filter((f) => f.endsWith(".ts")).sort();

// ─── 1 — the surface this gate reads must exist, or a zero means the predicate lost its target ───
check("G1 the entry the census resolves against is present", existsSync(ENTRY), true);
// Vacuity guard for the whole file: if TOOLS pointed at the wrong place the list would be empty and
// every arm below would pass on nothing. The guard asserts its OWN presence, which only holds when
// `import.meta.dirname` is the real src/tools directory.
check(`G1b the census read a real tools directory (${files.length} .ts files, this file among them)`,
  files.includes("test_sink_guard.ts"), true);
const mounts = files
  .map((f) => ({ file: f, offsets: mountOffsets(readFileSync(join(TOOLS, f), "utf8")) }))
  .filter((m) => m.offsets.length > 0);
check(`G1c the census finds mounters at all (positive control: ${mounts.map((m) => m.file).join(", ")})`,
  mounts.length > 0, true);

// ─── 2 — the WRONG instrument, pinned: a literal-path grep names non-mounters ───────────────────
// These two files contain the literal `tabichat/index.ts` and must NOT be classed as mounters. If a
// later edit makes this gate's predicate a substring test, this cell is where it goes red.
const LITERAL = "tabichat/index.ts";
for (const read of ["test_broker.ts", "test_fsgate.ts"]) {
  const src = readFileSync(join(TOOLS, read), "utf8");
  check(`G2 ${read} carries the literal path a grep would hit (${src.includes(LITERAL)}), so a grep is not a mount test`,
    src.includes(LITERAL), true);
  check(`G2b and this census does NOT call ${read} a mounter (it reads bytes / holds a fixture string)`,
    mounts.some((m) => m.file === read), false);
}

// ─── 3 — the sink arms: every mounter assigns BOTH sinks BEFORE its first mount ──────────────────
for (const m of mounts) {
  const src = readFileSync(join(TOOLS, m.file), "utf8");
  const first = Math.min(...m.offsets);
  for (const s of SINKS) {
    const offs = assignOffsets(src, s);
    const before = offs.filter((o) => o < first);
    check(`G3 ${m.file} assigns ${s} before the mount (assignments ${offs.length}, first mount at byte ${first})`,
      before.length > 0, true);
  }
}
check("G3c the mount set the refusal arms judged is the set the census printed", mounts.length > 0, true);

// ─── 4 — the behavioural arm: a mounter run with both vars scrubbed adds NO byte to a box file ───
const HOME = process.env.HOME ?? "";
const BOX: Record<string, string> = {
  diag: HOME ? join(HOME, DIAG_DEFAULT_SUBPATH) : "",
  exit: EXIT_LOG_DEFAULT,
};
/** Byte size, or -1 for absent — a file that appears during a run is growth, not a missing baseline. */
const sizeOf = (p: string): number => (p && existsSync(p) ? statSync(p).size : -1);
const grow = (p: string, run: () => void): { before: number; after: number; delta: number } => {
  const before = sizeOf(p);
  run();
  const after = sizeOf(p);
  return { before, after, delta: (after < 0 ? 0 : after) - (before < 0 ? 0 : before) };
};

// CONTROL FIRST, on a scratch file, because a +0 from an instrument that cannot see a byte is silence
// and the box file is shared: this box's diag log has live writers, so the instrument is proved here
// and never mutated on the box's own bytes.
const CONTROL = join(mkdtempSync(join(tmpdir(), "iid28-sinkguard-")), "control.log");
const planted = "iid28 control line — instrument check, not a lane\n";
const ctl = grow(CONTROL, () => appendFileSync(CONTROL, planted));
check(`G4a CONTROL the delta instrument sees a planted write on the same object (${Buffer.byteLength(planted)} bytes)`,
  ctl.delta, Buffer.byteLength(planted));

for (const m of mounts) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const s of SINKS) delete env[s]; // the run must rely on the CELL's own assignment, not the shell's
  const before: Record<string, number> = {};
  for (const [label, path] of Object.entries(BOX)) before[label] = sizeOf(path);
  const res = spawnSync(process.execPath, [`tools/${m.file}`], { cwd: SRC, env, encoding: "utf8" });
  check(`G4 ${m.file} runs rc 0 with both sink variables absent from its environment`, res.status, 0);
  for (const [label, path] of Object.entries(BOX)) {
    const after = sizeOf(path);
    const delta = (after < 0 ? 0 : after) - (before[label] < 0 ? 0 : before[label]);
    check(`G4b ${m.file} adds 0 bytes to the ${label} box file (${path}: ${before[label]} -> ${after})`, delta, 0);
  }
}

console.log(failed ? `REFUSED: ${failed} check(s) failed — a mounter would write the box's shared logs` : `all checks pass`);
if (failed) process.exitCode = 1;
