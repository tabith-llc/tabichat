// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the upstream-error notice.
//   bun tools/test_errnote.ts      (exit 1 on any failure)
// Positive and negative halves both required: a notice that also fires on a clean
// or interrupted turn is worse than no notice.
//
// adds the BOUNDARY half, and it is in this file rather than a new one on
// purpose: this name is already registered in deploy-tabichat.sh's GATES array, and
// owns that file. A new gate file would need a registration this leg cannot
// make, and a gate nobody runs is decoration.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";
import { buildNote, upstreamErrorNote, type EndMessage } from "../extensions/tabichat/errnote.ts";

// The contract, which resolves the earlier no-echo reading:
// a tabichat-originated system message carries the product tag AT THE FRONT, names UPSTREAM as
// the cause, states the EFFECT on tabichat, and does NOT restate the provider's payload — pi
// already prints that. TAG_LEAD / CAUSE_TOKEN / EFFECT are the three load-bearing halves, stated
// here as values so a regression is caught by a check and not by a reviewer's memory.
//
// CHANGES EFFECT, in the open, and the reason is the defect: it used to read
// "turn ended, not retried", a retry outcome asserted at `agent_end`, which pi documents as NOT
// final ("Pi may still auto-retry, auto-compact and retry, or continue with queued follow-up
// messages") and which `AgentEndEvent` cannot even answer — it has no `willRetry` field, and pi
// schedules the retry after this emit returns. EFFECT now states only what `agent_settled`
// guarantees. TAG_LEAD, CAUSE_TOKEN and every no-provider-prose cell below are untouched: they
// stayed true through the move.
const TAG_LEAD = "[tabichat] ";
const CAUSE_TOKEN = "UPSTREAM";
const EFFECT = "no automatic retry is coming";

/** The whole notice, for the exact-equality cells: tag first, then cause, then effect. */
const noticeFor = (code: string | null) =>
  `${TAG_LEAD}${code ? `UPSTREAM ${code} provider error` : "UPSTREAM provider error"} \u2014 ${EFFECT}; pi shows the provider's message.`;

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

const asst = (stopReason: string, errorMessage?: string): EndMessage => ({
  role: "assistant",
  stopReason,
  errorMessage,
});

// --- negative half: nothing may be shown when nothing is wrong ---
check("no messages at all", upstreamErrorNote([]), null);
check("clean stop", upstreamErrorNote([asst("stop")]), null);
check("tool use still working", upstreamErrorNote([asst("toolUse")]), null);
check("human interrupt is not an upstream fault", upstreamErrorNote([asst("aborted", "Operation aborted")]), null);
check("no assistant message", upstreamErrorNote([{ role: "user" }]), null);
check("missing stopReason", upstreamErrorNote([{ role: "assistant" }]), null);
check("clean turn after an earlier error", upstreamErrorNote([asst("error", "400 boom"), asst("stop")]), null);

// --- positive half: the shape this lane saw physically on ---
const sse = "400 event: error\ndata: {}\n\n";
const hit = upstreamErrorNote([{ role: "user" }, asst("toolUse"), asst("error", sse)]);
check("detects the provider 400", typeof hit, "string");
check("names the status code", (hit ?? "").includes("UPSTREAM 400 "), true);
check("states the effect on tabichat", (hit ?? "").includes(EFFECT), true);
// the retired assertion must be GONE, not merely unused. On the pre-fix string this
// cell reddens ("turn ended, not retried" contains "not retried"), which is why it is pinned
// here rather than left to a reviewer's memory.
check("claims no retry OUTCOME the boundary cannot observe", (hit ?? "").includes("not retried"), false);
// The current rule REVERSES two cells that an earlier leg wrote to the older reading, and both
// reversals are required by the rule rather than chosen to go green:
//   "says what to do" ("retry needed") is gone, because the notice now states what HAPPENED;
//   "opens by naming upstream" and "does not open with the product name" both flip, because the
//   product tag must now come FIRST. The no-echo ruling is unchanged and stays locked below.
check("carries NO provider prose (the old echo is gone)", (hit ?? "").includes("event: error"), false);
check("opens with the product tag", (hit ?? "").startsWith(TAG_LEAD), true);
check("does NOT open with the cause (tag is first now)", (hit ?? "").startsWith(CAUSE_TOKEN), false);
check("names upstream as the cause, after the tag", (hit ?? "").includes(CAUSE_TOKEN), true);
check("the notice is the ruled string exactly", hit, noticeFor("400"));
check("notice is one line", (hit ?? "").includes("\n"), false);
check("collapsed the blank line from the SSE frame", (hit ?? "").includes("  "), false);
check("still detected when a tool result follows", upstreamErrorNote([asst("error", sse), { role: "toolResult" }]) !== null, true);

// --- a prior leg D1: the shipped sentence, held as a LITERAL ---
// Every exact-equality cell above rebuilds its expectation from TAG_LEAD / CAUSE_TOKEN / EFFECT — the same
// parts `buildNote` composes — so an edit that moves `buildNote` and `EFFECT` together keeps them all green
// while changing the line an operator reads. That is not a hypothesis: a prior leg is the edit that moved both.
// So the gate holds the customer-facing sentence quoted out in full, in BOTH branches of the `code` ternary
// at errnote.ts:78. These are the cells that cannot be satisfied by a shared constant, and the tie pin below
// says out loud why a literal is needed: recomposition tracks the product, which is exactly the property a
// lock must not have.
const SHIPPED_400 =
  "[tabichat] UPSTREAM 400 provider error \u2014 no automatic retry is coming; pi shows the provider's message.";
const SHIPPED_NO_CODE =
  "[tabichat] UPSTREAM provider error \u2014 no automatic retry is coming; pi shows the provider's message.";
check("LITERAL the shipped 400 notice, quoted in full and not composed", hit, SHIPPED_400);
check("LITERAL the shipped notice with no status code, quoted in full", buildNote("Connection reset"), SHIPPED_NO_CODE);
check("and the recomposing cell agrees with the literal today", noticeFor("400") === SHIPPED_400, true);

// --- the text builder, both halves ---
check("no code in the text", buildNote("Connection reset"), noticeFor(null));
check("empty error text", buildNote(""), noticeFor(null));
check("missing error text", buildNote(undefined), noticeFor(null));
check("401 is named", buildNote('401 {"type":"error"}').includes("UPSTREAM 401 "), true);
check("429 is named", buildNote("429: provider returned error").includes("UPSTREAM 429 "), true);
const long = buildNote("400 " + "x".repeat(300));
// Replaces "detail is capped" / "capped detail is marked": there is no provider detail to cap
// any more, so the bound is total — the same input that used to be truncated to 60 chars of
// prose now contributes nothing but its status code. Stronger half, same intent (one short line).
check("a 300-char provider text contributes no prose", long.includes("xxx"), false);
check("the line is the ruled string, whatever the provider said", long, noticeFor("400"));
check("a number late in the text is not read as a code", buildNote("no code here 2026"), noticeFor(null));

// ─── a prior leg · the BOUNDARY half ─────────────────────────────────────────────────────────────
// The cells above decide what the line says. These decide WHEN it is said, and that is the
// reported defect: the notice fired at `agent_end`, which pi documents as NOT final
// ("Pi may still auto-retry, auto-compact and retry, or continue with queued follow-up
// messages"), while the retry is scheduled afterwards in `_handlePostAgentRun()`. So every
// retryable 429 announced itself as un-retried before pi had decided anything.
//
// WHAT IS REAL: the shipped `index.ts` factory body, the observation handler, the reporting
// handler, and the state that travels between them.
// WHAT IS FAKED: the ExtensionAPI (a recorder, the `test_laneadmin.ts` idiom — it stores what
// the factory registers and invents nothing) and `ctx.ui` (a call log, so "silent at agent_end"
// is a measured zero and not an absence of evidence). The three package externals are rewritten
// at LOAD time exactly as `test_renewal_realm.ts` does, because this venue has no node_modules
// and creating one would move `typecheck_ext.ts` off the stub face the gates are quoted at.
// `mqtt.connect` is asserted never called: no socket, no broker, no deploy, no lane restart.
const stubDir = mkdtempSync(join(tmpdir(), "errnote-"));
writeFileSync(
  join(stubDir, "mqtt.ts"),
  `export default { connect() {\n  globalThis.__907_connect_calls = (globalThis.__907_connect_calls ?? 0) + 1;\n  return { on() {}, publish() {}, subscribe() {}, end() {}, removeAllListeners() {}, connected: false };\n} };\n`,
);
writeFileSync(join(stubDir, "pi-ai.ts"), `const T = new Proxy(function () {}, { get: () => T, apply: () => ({ type: "object" }) });\nexport const Type = T;\n`);
writeFileSync(join(stubDir, "pi-ca.ts"), `export const defineTool = (t) => t;\n`);

plugin({
  name: "leg907-errnote-externals",
  setup(b) {
    // Only the ENTRY module's three bare specifiers are rewritten; every relative import inside it
    // (errnote.ts, laneadmin.ts, …) resolves for real from its own directory.
    b.onLoad({ filter: /[/\\]extensions[/\\]tabichat[/\\]index\.ts$/ }, (a) => ({
      loader: "ts",
      contents: readFileSync(a.path, "utf8")
        .replace(`from "mqtt"`, `from "${join(stubDir, "mqtt.ts")}"`)
        .replace(`from "@earendil-works/pi-ai"`, `from "${join(stubDir, "pi-ai.ts")}"`)
        .replace(`from "@earendil-works/pi-coding-agent"`, `from "${join(stubDir, "pi-ca.ts")}"`),
    }));
  },
});

type UiCall = { kind: "setStatus" | "notify"; key: string; text: unknown };
const uiCalls: UiCall[] = [];
const makePi = () => {
  const handlers: { ev: string; fn: (...a: never[]) => unknown }[] = [];
  const other = new Map<string, number>();
  const flags: Record<string, unknown> = { tabichat: true, room: "errnote-room" };
  const base: Record<string, unknown> = {
    on: (ev: string, fn: (...a: never[]) => unknown) => void handlers.push({ ev, fn }),
    getFlag: (name: string) => flags[name],
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    sendUserMessage: () => undefined,
  };
  // Anything the factory touches that this file has not named is RECORDED, not silently no-opped:
  // a hidden call site is how a measured PASS turns into a fake one, so the count is printed.
  const pi = new Proxy(base, {
    get(t, p: string) {
      if (p in t) return t[p];
      other.set(p, (other.get(p) ?? 0) + 1);
      return () => undefined;
    },
  });
  return { pi, handlers, other };
};
const EXT_INDEX = join(import.meta.dirname, "..", "extensions", "tabichat", "index.ts");
const INDEX_SRC = readFileSync(EXT_INDEX, "utf8");
const registered = (ev: string) => (INDEX_SRC.match(new RegExp(`^\\s*pi\\.on\\("${ev}"`, "gm") ?? []).length);

// iid 28: both sinks go into this cell's own scratch dir BEFORE the entry is mounted. Unset is not
// off — with no env they resolve to the box-level files the live seats write (diaglog.ts's
// `DIAG_DEFAULT_SUBPATH` under $HOME, exitlog.ts's absolute `EXIT_LOG_DEFAULT`).
process.env.MQTT_DIAG_LOG = join(stubDir, "diag.log");
process.env.MQTT_EXIT_LOG = join(stubDir, "lane-exits.log");

const { pi: fakePi, handlers: reg, other: otherCalls } = makePi();
((await import(EXT_INDEX)) as { default: (pi: unknown) => void }).default(fakePi);
const err429 = asst("error", "429 too many requests");
const quota429 = asst("error", "429 insufficient_quota: your organization's usage limit reached");
const ok = asst("stop");
const evEnd = (messages: EndMessage[]) => ({ type: "agent_end", messages });
const evSettled = (aborted: boolean) => ({ type: "agent_settled", aborted });

// Selected by their own source text, never by an index into a handler list — and BASE-LENIENT on
// purpose: at 4f97ada6 the agent_end handler is the one that PRINTS, so a selector that matched
// only the post-fix shape would find nothing to run, and the pre-fix RED would be an absence of
// measurement rather than a measured lie.
const OBSERVE_OR_PRINT = /pendingUpstreamNote = upstreamErrorNote\(msgs\)|setStatus\("upstream"/;
const endHandlers = reg.filter((h) => h.ev === "agent_end" && OBSERVE_OR_PRINT.test(String(h.fn)));
const settleHandlers = reg.filter((h) => h.ev === "agent_settled" && /setStatus\("upstream"/.test(String(h.fn)));
const observer = reg.filter((h) => h.ev === "agent_end" && /pendingUpstreamNote = upstreamErrorNote\(msgs\)/.test(String(h.fn)));
const reporter = reg.filter((h) => h.ev === "agent_settled" && /ctx\.ui\.setStatus\("upstream", note\)/.test(String(h.fn)));
const ctx = { ui: {
  setStatus: (key: string, text?: unknown) => void uiCalls.push({ kind: "setStatus", key, text }),
  notify: (text: string, level?: string) => void uiCalls.push({ kind: "notify", key: String(level ?? ""), text }),
} };
/** any surface that would put the upstream notice in front of the human: footer text or toast. */
const notices = () => uiCalls.filter((c) => (c.kind === "setStatus" && c.key === "upstream" && c.text !== undefined) || (c.kind === "notify" && String(c.text).startsWith(TAG_LEAD + CAUSE_TOKEN)));
/** the footer-clear calls specifically, so a clear is not mistaken for a notice. */
const clears = () => uiCalls.filter((c) => c.kind === "setStatus" && c.key === "upstream" && c.text === undefined);
const reset = () => { uiCalls.length = 0; };
const runObserver = async (messages: EndMessage[]) => { for (const h of endHandlers) await h.fn(evEnd(messages) as never, ctx as never); };
const runReporter = async (aborted: boolean) => { for (const h of settleHandlers) await h.fn(evSettled(aborted) as never, ctx as never); };

// ── wiring control first: the two handlers exist, and they are on the boundaries this leg says ──
check(`907 the factory registered every agent_end the file names (source ${registered("agent_end")})`, reg.filter((h) => h.ev === "agent_end").length, registered("agent_end"));
check(`907 the factory registered every agent_settled the file names (source ${registered("agent_settled")})`, reg.filter((h) => h.ev === "agent_settled").length, registered("agent_settled"));
check("907 exactly one agent_end handler owns the upstream surface (so a zero there is measured)", endHandlers.length, 1);
check("907 exactly one agent_settled handler prints the upstream notice", settleHandlers.length, 1);
check("907 that settle handler is the one that reads the note variable", reporter.length, 1);
check("907 the observe-then-report handoff exists (the pending note is written at agent_end)", observer.length, 1);
// CONTROL, so every `notices() === 0` below means "nothing printed" and not "nothing ran".
check("907 CONTROL no MQTT connection was opened by this run", (globalThis as Record<string, number>).__907_connect_calls ?? 0, 0);

// ── 1. the discriminating sequence: a retryable error ends a run, pi retries, the retry is clean ──
reset();
await runObserver([err429]);
check("907 nothing is shown at agent_end — the boundary cannot know the retry outcome", notices().length, 0);
check("907 and no footer write of any kind happens at agent_end", uiCalls.filter((c) => c.key === "upstream").length, 0);
reset();
await runObserver([ok]); // pi retried; the retry run ended cleanly, overwriting the observation
await runReporter(false);
check("907 a clean retry then a clean settle prints NO notice", notices().length, 0);
check("907 and the footer is cleared on that clean settle", clears().length, 1);

// ── 2. the same error, and pi does NOT retry: settle is where the line is earned ──
// Measured as a DELTA across the two boundaries, so neither half can pass by the other's work: at
// 4f97ada6 the two surfaces below are printed by agent_end, and the settle step prints nothing.
reset();
await runObserver([err429]);
const shownAtEnd = notices().length;
await runReporter(false);
const shownAtSettle = notices().length - shownAtEnd;
check("907 agent_end prints nothing at all", shownAtEnd, 0);
check("907 settle shows the notice, once on each surface", shownAtSettle, 2);
check("907 the footer text is the ruled string for a 429", String(notices()[0]?.text ?? "<NO NOTICE>"), noticeFor("429"));
check("907 the toast is the SAME string from the SAME function (no drift)", String(notices()[1]?.text ?? "<NO NOTICE>"), String(notices()[0]?.text ?? "<NO NOTICE>"));
check("907 the toast level is warning", String(notices()[1]?.key ?? "<NO NOTICE>"), "warning");
reset();
await runReporter(false);
check("907 the observation is consumed, not re-announced at the next settle", notices().length, 0);
check("907 and a second settle only clears, once", clears().length, 1);

// ── 3. clean settle, and an aborted settle: neither is an upstream fault ──
reset();
await runObserver([ok]);
await runReporter(false);
check("907 clean settle clears the footer and toasts nothing", [clears().length, notices().length], [1, 0]);
reset();
await runObserver([err429]);
await runReporter(true); // a human interrupt is not an upstream fault — that half survived the move
check("907 aborted settle prints no upstream notice", notices().length, 0);
check("907 and it clears the footer instead", clears().length, 1);
check("907 upstreamErrorNote itself still returns null for an aborted stopReason", upstreamErrorNote([asst("aborted", "Operation aborted")]), null);

// ── 4. paired negative on the CAUSE half: the two 429 classes pi treats differently ──
// pi-ai checks NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN first, so a quota 429 never retries
// while a transient 429 does. The notice may not claim which class it saw — it is not handed
// that answer — so BOTH must produce the identical honest line.
reset();
await runObserver([err429]);
await runReporter(false);
const transientLine = String(notices()[0]?.text ?? "<NO NOTICE>");
reset();
await runObserver([quota429]);
await runReporter(false);
const quotaLine = String(notices()[0]?.text ?? "<NO NOTICE>");
check("907 a transient 429 and a quota 429 produce the same shape, and a shape exists", [transientLine === quotaLine, transientLine.startsWith(TAG_LEAD + CAUSE_TOKEN)], [true, true]);
check("907 that shape is the ruled string, code included", transientLine, noticeFor("429"));
check("907 neither line names a retry outcome", transientLine.includes("retried"), false);
check("907 neither line carries provider prose (the no-echo ruling)", /quota|too many|limit reached|requests/i.test(transientLine + quotaLine), false);
check("907 one line, no newline", transientLine.includes("\n"), false);

check("907 CONTROL the factory reached no unlisted ExtensionAPI surface", [...otherCalls.keys()].sort(), []);
rmSync(stubDir, { recursive: true, force: true });

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks pass");
process.exitCode = failed ? 1 : 0;
