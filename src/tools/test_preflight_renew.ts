// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Truth table for src/extensions/tabichat/preflight_renew.ts — and the acceptance test is AGREEMENT
 * with the shipped gate, not a green row.
 *   bun tools/test_preflight_renew.ts        (exit 1 on any failure)
 *
 * WHY IT IS SHAPED THIS WAY. The tool exists because a hand-written copy of this bar disagreed with
 * the bar in both directions on the same day: a real handoff read as answering nothing where the
 * shipped gate reads it as answering everything, and a sheet of headings with nothing under it read as
 * complete where the same gate refuses it. A harness that only asked the tool "did you print
 * ADMISSIBLE?" would have blessed both of those. So every case runs the tool AND the gate's own
 * exports over the SAME sheet in the SAME process and compares the verdicts, field by field. A tool
 * that drifts from the gate fails here even when its own answer looks reasonable, and a tool that
 * stops calling the gate at all fails because the strings it prints are the gate's.
 *
 * WHAT IS ALSO PROVED, because "read-only" is a claim a file can print and a file can break: every
 * scratch directory is fingerprinted (names, sizes and mtimes) before and after each run, so a tool
 * that wrote, tidied or fabricated a sheet would refuse this harness rather than answer the question.
 *
 * NO HOME DIRECTORY IS READ. Each case builds its own scratch RESUME dir under this run's tmpdir and
 * points `MQTT_CTX_RESUME_DIR` at it; where a case wants the site-config path, it writes its own file
 * and points `TABICHAT_CONFIG` at it. Nothing here depends on the box that runs it, and no case can
 * touch a real handoff — which is the same rule the tool follows, since it is the tool that has to run
 * on a machine where none of this was ever staged.
 *
 * ENV IS SCRUBBED BEFORE THE MODULE IS LOADED, in the shape tools/test_ctxwarn.ts established: a
 * launcher's `MQTT_LEG` or `MQTT_NICK` would otherwise answer the questions these cells are asking,
 * and the dynamic import below is what keeps the scrub above the load.
 */
delete process.env.MQTT_LEG;
delete process.env.MQTT_NICK;
delete process.env.MQTT_CTX_RESUME_DIR;
delete process.env.TABICHAT_CONFIG;

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const {
  handoffContentVerdict,
  pickResumeHandoff,
  resolveResumeDir,
  resumeBarRefusal,
  resumeFileRe,
  RESUME_LEG_SCAN_LINES,
} = await import("../extensions/tabichat/ctxwarn.ts");

const TOOL = join(import.meta.dir, "..", "extensions", "tabichat", "preflight_renew.ts");
const NICK = "laneq"; // a name this run invents; no real seat is judged by these cells

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

const SCR = mkdtempSync(join(tmpdir(), "preflight-renew-"));
const cleanup = () => { try { rmSync(SCR, { recursive: true, force: true }); } catch { /* already gone */ } };
const dirOf = (n: string) => {
  const d = join(SCR, n);
  mkdirSync(d, { recursive: true });
  return d;
};

// A site config with no `resumeDir` slot: the env knob must be what resolves the dir, and a tool that
// quietly invented a default would show up as a resolved path this file never set.
const SITE_PLAIN = join(SCR, "site-plain.json");
writeFileSync(SITE_PLAIN, JSON.stringify({ note: "a site file that names no resumeDir" }));

/** A sheet at a controlled mtime, so "newer than the start" is a value this run picked. */
const sheet = (dir: string, name: string, text: string, mtimeSec: number) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
};

/** names + sizes + mtimes of everything in a dir — the read-only fingerprint */
const fingerprint = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((n) => {
      const st = statSync(join(dir, n));
      return `${n}:${st.size}:${Math.round(st.mtimeMs)}`;
    })
    .join("|");

/** Run the tool as a child. Verdict fields are read out of what it printed. */
const run = (dir: string | null, args: string[] = [], env: Record<string, string> = {}) => {
  const before = dir ? fingerprint(dir) : "";
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TABICHAT_CONFIG: SITE_PLAIN,
      MQTT_NICK: NICK,
      ...(dir ? { MQTT_CTX_RESUME_DIR: dir } : {}),
      ...env,
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const field = (label: string) => {
    const m = new RegExp(`${label}=([^ \\n·]+)`).exec(out);
    return m ? m[1] : null;
  };
  return {
    rc: r.status,
    out,
    pick: field("pick"),
    content: field("content"),
    sheetName: field("sheet"),
    wrote: dir ? fingerprint(dir) !== before : false,
  };
};

/** The gate's own answer for the same dir, computed in THIS process from the same exports. */
const gate = (dir: string, startedAtMs: number, leg: string) => {
  const files = readdirSync(dir)
    .filter((n) => resumeFileRe(NICK).test(n))
    .map((n) => {
      const st = statSync(join(dir, n));
      return { name: n, bytes: st.size, mtimeMs: st.mtimeMs };
    });
  const pick = pickResumeHandoff(files, NICK, startedAtMs);
  if (pick.picked === null)
    return { pickOk: pick.ok, contentOk: null as boolean | null, scanned: pick.scanned, reason: pick.reason };
  const head = readFileSync(join(dir, pick.picked), "utf8")
    .split("\n")
    .slice(0, RESUME_LEG_SCAN_LINES)
    .join("\n");
  const v = handoffContentVerdict(pick.picked, head, leg);
  return { pickOk: pick.ok, contentOk: v.ok, scanned: pick.scanned, reason: v.reason };
};

// Every block the template lists, answered in prose — the shape the copy read as answering nothing.
const COMPLETE = `leg 1183 — verdict: the durable preflight agrees with the gate on every sheet here
venue: the scratch directory this harness created, and no other
task and the spec file path it came from: the dispatch page that opened this leg
branch, tip commit, and ANYTHING uncommitted or unpushed: the leg branch, and everything is pushed
what is mid-flight right now (the exact next command you would have run): the harness you are reading
next steps, in order: hand the field command to the office, then hold for the field leg
report path: the report this leg's dispatch names
HOLD flags — any "do not do X / do not tell Y" instruction still in force: no merge, no tag, no cut
`;

// The shape the copy blessed: every template heading present, nothing said under any of them.
const SKELETON = `leg 1183 — verdict
venue
task and the spec
branch, tip commit
what is mid-flight right now
next steps, in order
report path
HOLD flags
`;

// A sheet for a DIFFERENT leg: fresh, complete, and the wrong task — the currency rule, not the boot rule.
const WRONGLEG = COMPLETE.replace("leg 1183 — verdict", "leg 9999 — verdict");

const STARTED = Date.now() - 1_800_000; // "this seat began half an hour ago"
const FRESH_SEC = STARTED / 1000 + 60;
const STALE_SEC = STARTED / 1000 - 600;

console.log("\n== CASE 1 — a complete, fresh sheet: the tool and the gate answer the same way ==");
{
  const d = dirOf("one");
  sheet(d, `RESUME-${NICK}-one11.md`, COMPLETE, FRESH_SEC);
  const g = gate(d, STARTED, "1183");
  const t = run(d, ["--since", String(STARTED), "--leg", "1183"]);
  check("the gate admits it", [g.pickOk, g.contentOk], [true, true]);
  check("and the tool prints the same two verdicts", [t.pick, t.content], ["ADMITTED", "COMPLETE"]);
  check("and they name the same sheet", [t.sheetName, g.reason.includes("RESUME-")], [`RESUME-${NICK}-one11.md`, true]);
  check("and it exits 0 where the gate admits", t.rc, 0);
  check("NEGATIVE GUARD: the run wrote nothing into the dir", t.wrote, false);
}

console.log("\n== CASE 2 — the echo-only skeleton: refused, never blessed ==");
{
  const d = dirOf("two");
  // big enough to clear the byte floor, so what refuses it is the content bar and not a file size
  const padded = `${SKELETON}\n${"— filled with nothing but the shape of a handoff ".repeat(6)}\n`;
  sheet(d, `RESUME-${NICK}-two22.md`, padded, FRESH_SEC);
  check("and the sheet really is over the byte floor", padded.length > 200, true);
  const g = gate(d, STARTED, "1183");
  const t = run(d, ["--since", String(STARTED), "--leg", "1183"]);
  check("the gate refuses it on content", [g.pickOk, g.contentOk], [true, false]);
  check("and the tool refuses it too — this is the sheet a copy called complete", [t.pick, t.content], ["ADMITTED", "REFUSED"]);
  check("and it exits 1, because blessing this sheet is the defect this leg exists to close", t.rc, 1);
  check("and the refusal names the blocks that are missing", /missing:/.test(t.out), true);
}

console.log("\n== CASE 3 — a sheet older than the start must FAIL, not WARN ==");
{
  const d = dirOf("three");
  sheet(d, `RESUME-${NICK}-thre33.md`, COMPLETE, STALE_SEC);
  const g = gate(d, STARTED, "1183");
  const t = run(d, ["--since", String(STARTED), "--leg", "1183"]);
  check("the gate refuses it on age", g.pickOk, false);
  check("and the tool's pick line says REFUSED", t.pick, "REFUSED");
  check("and the exit code is a refusal, not a warning", t.rc, 1);
  check("and it says STALE in the gate's own words", /STALE/.test(t.out), true);
  check("NEGATIVE: the age refusal is not softened by the content half passing", [g.pickOk, g.contentOk], [false, true]);
}

console.log("\n== CASE 4 — leg currency: a fresh sheet for another leg ==");
{
  const d = dirOf("four");
  sheet(d, `RESUME-${NICK}-four44.md`, WRONGLEG, FRESH_SEC);
  const g = gate(d, STARTED, "1183");
  const t = run(d, ["--since", String(STARTED), "--leg", "1183"]);
  check("the gate refuses it: fresh by BOOT is the wrong key", [g.pickOk, g.contentOk], [true, false]);
  check("and the tool refuses it the same way", [t.pick, t.content, t.rc], ["ADMITTED", "REFUSED", 1]);
  check("and the same sheet, judged as the leg it describes, admits", run(d, ["--since", String(STARTED), "--leg", "9999"]).content, "COMPLETE");
}

console.log("\n== CASE 5 — the knobs are the whole configuration: nothing is guessed ==");
{
  const d = dirOf("five");
  sheet(d, `RESUME-${NICK}-five55.md`, COMPLETE, FRESH_SEC);
  const noDir = run(null, ["--leg", "1183"]);
  check("no durable dir and no site key → exit 2, not a silent scratch read", noDir.rc, 2);
  check("and the refusal names BOTH knobs", [noDir.out.includes("MQTT_CTX_RESUME_DIR"), noDir.out.includes("resumeDir")], [true, true]);
  // the site-config face, which is the one a copy refused to see: env absent, key present
  const siteFile = join(SCR, "site-dir.json");
  writeFileSync(siteFile, JSON.stringify({ resumeDir: d }));
  const r = spawnSync(process.execPath, [TOOL, "--since", String(STARTED), "--leg", "1183"], {
    encoding: "utf8",
    env: { ...process.env, TABICHAT_CONFIG: siteFile, MQTT_NICK: NICK },
  });
  const viaSite = `${r.stdout}${r.stderr}`;
  check("the site-config `resumeDir` resolves on its own — an install that configures only the file is NOT bricked", [r.status, /source=site config/.test(viaSite)], [0, true]);
  const noNick = run(d, ["--leg", "1183"], { MQTT_NICK: "" });
  check("no nick to judge → exit 2, naming the knob", noNick.rc, 2);
  check("and it never invents a seat to read", /no nick/.test(noNick.out), true);
  const junk = run(d, ["--leg", "not-a-leg"]);
  check("a non-numeric --leg is usage, not a guess", junk.rc, 2);
  const badSince = run(d, ["--since", "yesterday"]);
  check("and a non-epoch --since is usage too", badSince.rc, 2);
  const extra = run(d, ["--leg", "1183", "surprise"]);
  check("an argument this tool does not know is refused rather than ignored", extra.rc, 2);
}

console.log("\n== CASE 6 — the dir the gate resolves is the dir the tool reads ==");
{
  const d = dirOf("six");
  sheet(d, `RESUME-${NICK}-six66.md`, COMPLETE, FRESH_SEC);
  const res = resolveResumeDir({ MQTT_CTX_RESUME_DIR: d }, null) as { ok: boolean; dir?: string; source?: string };
  const t = run(d, ["--since", String(STARTED), "--leg", "1183"]);
  check("the gate resolves this run's scratch dir", [res.ok, res.dir], [true, d]);
  check("and the tool prints that same dir and that same source", [t.out.includes(`dir=${d}`), /source=MQTT_CTX_RESUME_DIR env/.test(t.out)], [true, true]);
  const other = dirOf("other");
  sheet(other, `RESUME-${NICK}-other7.md`, COMPLETE, FRESH_SEC);
  const t2 = run(other, ["--since", String(STARTED), "--leg", "1183"]);
  check("NEGATIVE: it reads the dir it was pointed at, and no other", [t2.sheetName, other.split("/").pop()], [`RESUME-${NICK}-other7.md`, "other"]);
}

console.log("\n== CASE 7 — no sheet at all: the gate's own refusal, not a bare no ==");
{
  const d = dirOf("empty");
  const g = gate(d, STARTED, "1183");
  const t = run(d, ["--since", String(STARTED), "--leg", "1183"]);
  check("the gate picks nothing", [g.pickOk, g.scanned], [false, 0]);
  check("and the tool exits 1 rather than reporting an all-clear", t.rc, 1);
  check("and it prints resumeBarRefusal's own sentence, naming the dir it searched", t.out.includes(resumeBarRefusal([d])), true);
  check("and it does not fabricate a sheet to answer with", fingerprint(d), "");
}

console.log("\n== CASE 8 — the strings come from the gate, so a rewrite that stops calling it shows up ==");
{
  const src = readFileSync(TOOL, "utf8");
  check("it imports the bar rather than restating it", /from "\.\/ctxwarn\.ts"/.test(src), true);
  check("and it calls pickResumeHandoff", /pickResumeHandoff\(/.test(src), true);
  check("and handoffContentVerdict", /handoffContentVerdict\(/.test(src), true);
  check("and resolveResumeDir", /resolveResumeDir\(/.test(src), true);
  check("and resumeBarRefusal", /resumeBarRefusal\(/.test(src), true);
  check("NEGATIVE GUARD: no byte floor is restated in the tool", /(?:^|[^A-Z_])200\b/.test(src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")), false);
  check("NEGATIVE GUARD: no section count is restated either", /\b4\b\s*(?:blocks|of 7|sections)/.test(src), false);
  check("NEGATIVE GUARD: it never writes — no write call in the file", /writeFileSync|appendFileSync|mkdirSync|utimesSync|unlinkSync|rmSync/.test(src), false);
  check("NEGATIVE GUARD: it never opens a broker — no mqtt import, no socket", /from "mqtt"|createConnection|connect\(/.test(src), false);
  check("and the harness that runs it lives where the census will find it", /test_preflight_renew\.ts/.test(readFileSync(join(import.meta.dir, "deploy-tabichat.sh"), "utf8")), true);
}

console.log("\n== POSITIVE CONTROL — these cells can fail, and here is the proof ==");
{
  // The control is the tool pointed at a sheet the gate refuses, with the verdict read back: an
  // instrument that cannot return 1 about a bad sheet is decoration, so this asserts the SAME tool
  // returns DIFFERENT answers to the SAME arguments on two different trees.
  const good = dirOf("ctrl-good");
  const bad = dirOf("ctrl-bad");
  sheet(good, `RESUME-${NICK}-ctrl1.md`, COMPLETE, FRESH_SEC);
  sheet(bad, `RESUME-${NICK}-ctrl2.md`, SKELETON, FRESH_SEC);
  const a = run(good, ["--since", String(STARTED), "--leg", "1183"]);
  const b = run(bad, ["--since", String(STARTED), "--leg", "1183"]);
  check(`the same command answers 0 and 1 on two trees (got ${a.rc}/${b.rc})`, [a.rc, b.rc], [0, 1]);
  const none = run(dirOf("ctrl-none"), ["--since", String(STARTED), "--leg", "1183"]);
  check("and 1 when there is no sheet to read at all", none.rc, 1);
  check("never 0 on an empty dir — that is the false-blessing this control exists for", none.rc === 0, false);
}

console.log("\n== READ-ONLY IS A PROPERTY, CHECKED AFTER EVERY CASE ==");
{
  // Nothing in this run's scratch tree gained a file it did not create, and no case left a tool that
  // could tidy or fabricate a sheet. The dirs are the harness's own; the claim is per-dir.
  const created = readdirSync(SCR).filter((n) => n.startsWith("RESUME-"));
  check("the tool never wrote a sheet into a dir it was pointed at", created.length, 0);
  check("and the real home config was never read or written by these cells", statSync(SITE_PLAIN).size > 0, true);
}

cleanup();
console.log(`\n${failed > 0 ? `${failed} FAILED — the preflight does not agree with the gate it imports` : "all cases pass — the preflight answers exactly as the shipped gate answers, on the sheet, the dir, and the knobs"}`);
// SET the status, never call process.exit at the top level: `test_exit_class.ts` exists because a gate that
// exits kills the bun process the other gates are running in, which turns one red file into a silent short
// list. The shipped tool under test DOES exit by name — it is a command an operator runs, not a gate loaded
// into a shared process, and its exit code is the answer.
process.exitCode = failed ? 1 : 0;
