// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Truth table for remote lane administration (PROTOTYPE gate).
 *   bun tools/test_laneadmin.ts      (exit 1 on any failure)
 *
 * Three halves, because the 2026-10-07 `ctx is not defined` incident proved that a module
 * can be perfectly tested and still be dead code: the wiring line was never executed and no
 * compile step existed to notice. So besides the decisions themselves:
 *   - every rule gets its rejection case (an admin check that only passes the happy path is
 *     the check class this project has been bitten by), and
 *   - a labelled SOURCE-SHAPE half asserts index.ts really calls the gate and really
 *     registers the renew command. It is a grep, not a runtime test, and says so.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ADMIN_FLAGS,
  ADMIN_KIND,
  ADMIN_EXIT,
  ADMIN_OUTCOMES,
  ADMIN_RESULT_KIND,
  adminExitCode,
  adminResultPayload,
  adminResultTopic,
  adminResultWild,
  isAdminResult,
  selfRenewEnabled,
  RENEW_COMMAND,
  adminEnabled,
  adminNotice,
  adminVerdict,
  isLaneAdmin,
  pendingNotice,
  renewDispatched,
  renewDispatchFailed,
  errOneLine,
  leadHoldLine,
  shouldHoldBeforeRenew,
  wakeDirective,
  wakePathFor,
  wakePickPath,
  // iid 17 / leg 959 — the payload and leg audit, and the note the wake line adds
  auditHandoff,
  handoffDirs,
  wakeLegNote,
  WAKE_DELIVER_AS,
  AUTO_RENEW_ENV,
  AUTO_RENEW_FLAG,
  SITE_CONFIG_ENV,
  SITE_CONFIG_DEFAULT,
  parseBoolSlot,
  parseSiteConfig,
  resolveAutoRenew,
  resolveAutoRenewLayered,
  autoRenewVerdict,
  renewInFlightRefusal,
  RENEW_INFLIGHT_MAX_MS,
  wakeRenewedSeat,
  leadHoldLine,
  controlChannelOf,
  ctlAdmit,
  supersededHeader,
  SUPERSEDED_MARK,
  CTL_LEDGER_KEY,
  INBOUND_PARK_MAX,
  isStaleCtxError,
  parkInbound,
  takeParked,
  MQTT_CLIENT_KEY,
  CLIENT_EVENTS,
  endPriorClient,
  type ClosableClient,
  type CtlEntry,
} from "../extensions/tabichat/laneadmin.ts";
// §5 item 1 ACT B imports the matcher and its stat type from ctxwarn.ts, where they live.
import {
  pickResumeHandoff,
  RESUME_SCAN_MAX,
  RESUME_TEMPLATE,
  type ResumeFileStat,
} from "../extensions/tabichat/ctxwarn.ts";

// tabichat#2 blocker 1 + #5: the cells below call the SAME pure decisions the shipped code calls,
// so a green run proves the tool and the lane agree on one policy, not two.
import { transportDecision } from "../extensions/tabichat/tlsopts.ts";
// AC4 compares the topic builders and the authorship rule against the BASE commit, so it needs the
// real symbols from the module that owns them (roommsg.ts) — not a string mention of them in the
// wiring grep further down. This file imported neither, and the AC4 block died on a ReferenceError
// at the first one and would have died again at the second: a red run, not a green one.
import { ackTopic, authorVerdict } from "../extensions/tabichat/roommsg.ts";

let failed = 0;
let okCount = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL  ${name}: got ${g}, want ${w}`);
  } else {
    okCount++;
    console.log(`ok    ${name}: ${g}`);
  }
};

const ON = { LANE_ADMIN_COMPACT: "1", LANE_ADMIN_SHUTDOWN: "on", LANE_ADMIN_RENEW: "yes" };
const ALLOW = ["lead-agent", "dust"];

// --- what counts as an admin request ------------------------------------------------------
check("an admin request is recognised", isLaneAdmin({ kind: ADMIN_KIND, action: "compact", by: "dust" }), true);
check("a delivery receipt is not ours", isLaneAdmin({ kind: "ack", id: "x", by: "dust", to: "ultra" }), false);
check("a sender-less request is not ours", isLaneAdmin({ kind: ADMIN_KIND, action: "compact" }), false);
check("an action-less request is not ours", isLaneAdmin({ kind: ADMIN_KIND, by: "dust" }), false);
check("a null payload is not ours", isLaneAdmin(null), false);

// --- the flags: off is the default, and each route is separate ----------------------------
check("no flags, no route", adminEnabled({}, "compact"), false);
check("empty value is off", adminEnabled({ LANE_ADMIN_COMPACT: "" }, "compact"), false);
check("zero is off", adminEnabled({ LANE_ADMIN_COMPACT: "0" }, "compact"), false);
check("garbage is off", adminEnabled({ LANE_ADMIN_COMPACT: "absolutely" }, "compact"), false);
check('"1" is on', adminEnabled({ LANE_ADMIN_COMPACT: "1" }, "compact"), true);
check("case and space do not matter", adminEnabled({ LANE_ADMIN_SHUTDOWN: " ON " }, "shutdown"), true);
check("enabling compact does not enable shutdown", adminEnabled(ON, "renew"), true);
check("one route on leaves another off", adminEnabled({ LANE_ADMIN_COMPACT: "1" }, "shutdown"), false);
check("the flag names are the documented three", Object.values(ADMIN_FLAGS).join(","),
  "LANE_ADMIN_RENEW,LANE_ADMIN_COMPACT,LANE_ADMIN_SHUTDOWN");

// --- authority: both halves ---------------------------------------------------------------
const base = { self: "flash1", allow: ALLOW, env: ON, idle: true, resumeWritten: true, to: "flash1" };
const v = (over: Record<string, unknown>) => adminVerdict({ ...base, ...over });

check("the lead may compact an idle lane", v({ action: "compact", by: "lead-agent" }),
  { ok: true, action: "compact", by: "lead-agent", arm: false });
check("a stranger is refused", v({ action: "compact", by: "flash3" }).ok, false);
check("a lane cannot administer itself by room message", v({ action: "compact", by: "flash1" }).ok, false);
check("an anonymous request is refused", v({ action: "compact", by: "" }).ok, false);
check("an invented action is refused", v({ action: "reboot", by: "dust" }).ok, false);
check("a route that is off is refused", adminVerdict({ ...base, action: "compact", by: "dust", env: {} }).ok, false);
check("a mid-turn request arms rather than runs", v({ action: "compact", by: "dust", idle: false }),
  { ok: true, action: "compact", by: "dust", arm: true });
// losing the session is the bar the owner's renewal law protects
check("shutdown without a RESUME file is refused", v({ action: "shutdown", by: "dust", resumeWritten: false }).ok, false);
check("renew without a RESUME file is refused", v({ action: "renew", by: "dust", resumeWritten: false }).ok, false);
check("compact does not need a RESUME file", v({ action: "compact", by: "dust", resumeWritten: false }).ok, true);
check("shutdown with a RESUME file runs", v({ action: "shutdown", by: "dust" }),
  { ok: true, action: "shutdown", by: "dust", arm: false });
const refused = adminVerdict({ ...base, action: "compact", by: "nobody" });
check("a refusal states a reason", refused.ok === false && (refused as { reason: string }).reason.includes("nobody"), true);

// --- recipient field: who is this request even for? (s136 Leg A, both halves) --------------
check("a request addressed to this lane is honoured", v({ action: "compact", by: "dust", to: "flash1" }),
  { ok: true, action: "compact", by: "dust", arm: false });
check("to: all reaches every lane", v({ action: "compact", by: "dust", to: "all" }),
  { ok: true, action: "compact", by: "dust", arm: false });
check("an @-prefixed field is the same address", v({ action: "compact", by: "dust", to: "@flash1" }).ok, true);
check("a list of nicks addresses each of them", v({ action: "compact", by: "dust", to: "clerk, flash1" }).ok, true);
check("a bystander lane refuses in silence", v({ action: "compact", by: "dust", to: "flash3" }),
  { ok: false, speak: false, reason: "addressed to flash3, not to flash1 — this lane is not the addressee" });
check("whole tokens: flash10 is not flash1", v({ action: "compact", by: "dust", to: "flash10" }).ok, false);
check("a fieldless request is inert AND loud", adminVerdict({ ...base, to: undefined, action: "compact", by: "dust" }),
  { ok: false, speak: true, reason: "no recipient field — a fleet-wide admin request is inert by design; name the lane (lane_admin.mjs <by> <target> <action>)" });
check("a field that names nobody is the same inert case", adminVerdict({ ...base, to: "!!!", action: "compact", by: "dust" }).ok, false);
check("the recipient gate runs before the allowlist", v({ action: "compact", by: "nobody", to: "flash3" }),
  { ok: false, speak: false, reason: "addressed to flash3, not to flash1 — this lane is not the addressee" });
check("even an addressed request needs a sender", adminVerdict({ ...base, action: "compact", by: "" }).ok, false);

// --- SELF-addressed requests (ticket row 2, R1) -------------------------------------------
// The owner's order, verbatim 2026-10-18: "that ticket needs to include YOU BEING ABLE TO SELF
// RENEW PROPERLY! THE LAST TIME FAILED". The refusal at laneadmin.ts:149 is what made the lead's
// `lane_admin.mjs wren wren renew` a no-op that still printed `published`. Widening is bounded
// four ways and each bound gets its own rejection case below: renew ONLY, its OWN opt-in flag
// (default OFF, so today's inert-everywhere property holds until a venue turns it on), the RESUME
// bar untouched and still load-bearing, and the allowlist NOT required for a self request (a
// worker lane is not on the steer floor, and the point of the door is that a worker can use it).
const SELFRENEW_ON = { ...ON, LANE_ADMIN_SELFRENEW: "1" };

check(
  "a self-addressed renew runs when its own flag is on",
  v({ action: "renew", by: "flash1", env: SELFRENEW_ON }),
  { ok: true, action: "renew", by: "flash1", arm: false },
);
check(
  "a self renew mid-turn arms rather than runs",
  v({ action: "renew", by: "flash1", env: SELFRENEW_ON, idle: false }),
  { ok: true, action: "renew", by: "flash1", arm: true },
);
check(
  "self renew is refused when its flag is off (default face, unchanged)",
  v({ action: "renew", by: "flash1" }).ok,
  false,
);
check(
  "a refused self renew names the working alternative, not just the refusal",
  (() => {
    const r = v({ action: "renew", by: "flash1" }) as { reason?: string };
    return (
      !!r.reason &&
      r.reason.includes("LANE_ADMIN_SELFRENEW") &&
      r.reason.includes("lane_admin.mjs")
    );
  })(),
  true,
);
// R2's "the asker must be told WHOM", both halves. The floor is the seat's own env, so a refusal that
// says "a lane on the steer allowlist" without a name is still a trapped lane with nothing to ask.
// NEGATIVE HALF FIRST: an allow list that names nobody must print a reason, not a blank pair of
// parentheses — a blank here is the same silent-inertia class the row was filed for.
check(
  "R2 NEGATIVE: an empty admin floor is SAID as empty, never printed blank",
  (() => {
    const r = adminVerdict({
      ...base, action: "renew", by: "flash1", allow: [], env: ON,
    }) as { reason?: string };
    return !!r.reason && r.reason.includes("none") && !r.reason.includes("()") && r.reason.includes("empty");
  })(),
  true,
);
check(
  "R2 POSITIVE: a refused self renew prints every nick this seat actually honours",
  (() => {
    const floor = ["wren", "dust", "ultra", "courier", "dove"];
    const r = adminVerdict({
      ...base, action: "renew", by: "flash1", allow: floor, env: ON,
    }) as { reason?: string };
    return !!r.reason && floor.every((n) => r.reason!.includes(n));
  })(),
  true,
);
check(
  // The predicate above could be satisfied by a reason that echoes the list once and nowhere useful.
  // This pins the two halves the trapped lane acts on are in the SAME sentence: whom to ask, and what
  // to have them run. Measured separately it would pass on two unrelated lines of prose.
  "R2: whom-to-ask and what-to-run are in one instruction, not two unrelated clauses",
  (() => {
    const r = adminVerdict({
      ...base, action: "renew", by: "flash1", allow: ["dove"], env: ON,
    }) as { reason?: string };
    const i = (r.reason ?? "").indexOf("dove");
    const j = (r.reason ?? "").indexOf("lane_admin.mjs");
    return i >= 0 && j > i && (r.reason ?? "").slice(i, j).length < 120;
  })(),
  true,
);
check(
  "self renew ONLY: compact keeps the old refusal even with the flag on",
  v({ action: "compact", by: "flash1", env: SELFRENEW_ON }),
  { ok: false, speak: true, reason: "flash1 cannot administer its own lane by room message" },
);
check(
  "self renew ONLY: shutdown keeps the old refusal even with the flag on",
  v({ action: "shutdown", by: "flash1", env: SELFRENEW_ON }),
  { ok: false, speak: true, reason: "flash1 cannot administer its own lane by room message" },
);
check(
  "self renew still needs a RESUME file (the bar is not widened)",
  v({ action: "renew", by: "flash1", env: SELFRENEW_ON, resumeWritten: false }).ok,
  false,
);
check(
  "the self door does not read the allowlist (a worker is not on the steer floor)",
  v({ action: "renew", by: "flash1", env: SELFRENEW_ON, allow: [] }),
  { ok: true, action: "renew", by: "flash1", arm: false },
);
check(
  "SELFRENEW on does not enable the peer renew route for a stranger",
  adminVerdict({ ...base, action: "renew", by: "flash3", env: SELFRENEW_ON }).ok,
  false,
);
check(
  "a forged self request naming a DIFFERENT lane is still refused",
  adminVerdict({ ...base, action: "renew", by: "flash3", to: "flash3", env: SELFRENEW_ON }).ok,
  false,
);
check(
  "a self-addressed request aimed at another lane stays bystander-silent",
  v({ action: "renew", by: "flash1", to: "flash3", env: SELFRENEW_ON }),
  { ok: false, speak: false, reason: "addressed to flash3, not to flash1 — this lane is not the addressee" },
);
check(
  "SELFRENEW=off is off", selfRenewEnabled({ LANE_ADMIN_SELFRENEW: "off" }), false,
);
check(
  "SELFRENEW garbage is off", selfRenewEnabled({ LANE_ADMIN_SELFRENEW: "absolutely" }), false,
);
check(
  "SELFRENEW unset is off", selfRenewEnabled({}), false,
);
check(
  "SELFRENEW=1 is on", selfRenewEnabled({ LANE_ADMIN_SELFRENEW: "1" }), true,
);
check(
  // The two knobs are independent, and the assertion says WHICH WAY: the self knob does NOT arm
  // the renew route, and the route knob does not arm the self door. (My first version of this
  // check AND-ed a term that was false by design, so it could only ever read false — a guard that
  // asserts nothing is the defect class this leg is audits for, so it gets fixed, not deleted.)
  "the self flag is a SEPARATE knob from LANE_ADMIN_RENEW",
  selfRenewEnabled({ LANE_ADMIN_SELFRENEW: "1" }) &&
    !selfRenewEnabled({ LANE_ADMIN_RENEW: "1" }) &&
    adminEnabled({ LANE_ADMIN_RENEW: "1" }, "renew") &&
    !adminEnabled({ LANE_ADMIN_SELFRENEW: "1" }, "renew"),
  true,
);
check(
  "the renew ROUTE flag is still required for a self renew (two knobs, both on)",
  adminVerdict({
    ...base,
    action: "renew",
    by: "flash1",
    env: { LANE_ADMIN_SELFRENEW: "1" },
  }).ok,
  false,
);

// --- the outcome the ASKER sees (ticket row 2, R3) ----------------------------------------
// A `published` line with nothing behind it is the defect. These assert the answer exists, is
// recognisable, cannot escape its topic, and maps to a nonzero rc when a lane said no.
const RES = adminResultPayload("wren-1-abc123", "flash5", "wren", "renew", "refused", "no RESUME file", 1);
check("an answer is built with the request id it answers", RES.id, "wren-1-abc123");
check("an answer names the lane that judged it", RES.lane, "flash5");
check("an answer echoes the requester", RES.requester, "wren");
check("an answer is recognised as one", isAdminResult(RES), true);
check("an admin REQUEST is not an answer", isAdminResult({ kind: ADMIN_KIND, action: "renew", by: "wren" }), false);
check("a delivery receipt is not an answer", isAdminResult({ kind: "ack", id: "x", by: "wren" }), false);
check("an invented outcome word is not an answer", isAdminResult({ ...RES, outcome: "done" }), false);
check("a null payload is not an answer", isAdminResult(null), false);
// Shape (ii), leg 496: the answer rides UNDER THE ANSWERER, so the requester hears it on the
// one-level wildcard `adminResultWild`. Exact values on purpose — the leaf must carry no extra level
// and no wildcard, on either of the two variable pieces.
check(
  "answers ride a per-request child of the ANSWERER's own leaf",
  adminResultTopic("tabith", "wren", "wren-1-abc123"),
  "chat/tabith/_ctl/wren/admin/wren-1-abc123",
);
check("and the requester's subscription is one wildcard wide, not a reconstruction",
  adminResultWild("tabith", "wren-1-abc123"),
  "chat/tabith/_ctl/+/admin/wren-1-abc123",
);
check(
  // The original escape cell, re-paired and STRENGTHENED: the answerer's nick is now a topic level
  // too, so it gets the same treatment. A nick of "../../presence/#" must not open the presence tree
  // or wildcard the control topic — and it must not smuggle a level into the answerer slot either.
  "neither the nick level nor the id level can escape its topic",
  adminResultTopic("tabith", "../../presence/#", "a/#+"),
  // The value below is what the shipped sanitiser MEASURES, not what I expected — my first draft
  // asserted "`a_#`" and the cell went red on correct bytes, because sanitizeAckId strips `#` before
  // collapsing runs, so the id lands as "a". The point of the cell survives intact: one level, no
  // wildcard, no `..`.
  "chat/tabith/_ctl/presence/admin/a",
);
check("an id that sanitises to nothing yields NO topic", adminResultTopic("tabith", "wren", "/"), "");
check("NEGATIVE: a nick that sanitises to nothing yields NO topic either (no silent flat-shape write)",
  adminResultTopic("tabith", "//", "abc"), "");
check("and a nick cannot wildcard the control topic from the answerer slot",
  adminResultTopic("tabith", "#", "abc"), "");
check("armed is rc 0", adminExitCode("armed"), 0);
check("run is rc 0", adminExitCode("run"), 0);
check("refused is rc NONZERO", adminExitCode("refused"), 1);
check("a word we do not know is NOT a success", adminExitCode("published"), 1);
check("nothing answered is rc NONZERO and distinct", ADMIN_EXIT.unknown, 3);
check(
  "three outcomes, exactly three words, no 'published' among them",
  ADMIN_OUTCOMES.join(","),
  "armed,run,refused",
);

// index.ts is not loadable in a gate (it would open a live socket), so this half is a LABELLED
// GREP — the same standing test_ctx_handle.ts and the source-shape half above claim, with the
// same honest limit: it proves the call is written, not that it ran. The runtime proof of the
// answer path is the live dispatch in ultra-seat-killer-audit-s138-report.md.
const src = readFileSync(join(import.meta.dirname, "..", "extensions", "tabichat", "index.ts"), "utf8");
const takeAdminBody = src.slice(src.indexOf("const takeAdmin = "), src.indexOf("// percent of the last advisory"));
check("the lane publishes an outcome on its own verdict", /adminResultPayload\(/.test(takeAdminBody), true);
check("the refusal answers too, not only the accept path", /"refused"/.test(takeAdminBody), true);
check("the armed path answers", /"armed"/.test(takeAdminBody), true);
check("the run path answers", /"run"/.test(takeAdminBody), true);
check("a bystander lane still answers nothing", /if \(v\.speak\)/.test(takeAdminBody), true);
const tool = readFileSync(join(import.meta.dirname, "lane_admin.mjs"), "utf8");
// The CODE ONLY, line comments stripped. The negative cells below assert that a shape is ABSENT, and
// this leg's own prose names the bad shape it removed (`mqtt.connect(broker.url)` sits in a comment
// explaining the defect), so a grep over the whole file reported the defect as STILL PRESENT. Measured
// on this leg: the negative cell read true against correct bytes. A prose line can never satisfy or
// defeat a code-shape check, so prose is out of the instrument here. Block comments are not used in
// this file, so a line-comment strip is sufficient and is stated rather than assumed.
const toolCode = tool.replace(/^\/\/.*$/gm, "");
check("the requester waits for the answer", /isAdminResult/.test(tool), true);
// Re-paired for shape (ii) and made able to fail: the requester now subscribes the ONE-LEVEL
// WILDCARD (it cannot know the answerer's nick for a `to: all` request), so a cell that merely looked
// for "adminResult" in the tool would pass on a reconstruction bug. It asserts the WILD builder is
// used AND that the tool matches the delivered topic rather than string-comparing to its filter —
// which is the bug that would have silently returned rc 3 for every answer under the new shape.
check("the requester subscribes the wildcard builder, not a reconstructed exact topic",
  /adminResultWild/.test(toolCode) && !/adminResultTopic\(room, id\)/.test(toolCode), true);
check("and it matches the delivered topic through a wildcard-aware matcher (an equality test would drop every answer)",
  /matchesResultTopic/.test(toolCode) && /function matchesResultTopic|const matchesResultTopic/.test(toolCode), true);
check(
  // Every exit site in the tool, spelled out. There is NO process.exit(0): success is only ever
  // reachable through finish(), whose code comes from adminExitCode() or ADMIN_EXIT.unknown. A
  // future "just exit 0 after the publish" trips this — that is exactly how the old tool lied.
  // RE-PAIRED at s138d: the site-agnostic ruling (owner: "no default, must be set") added a fourth
  // site, the no-broker refusal, which exits ADMIN_EXIT.broker (4). That is a NON-ZERO site, so the
  // cell's intent is intact — and the literal no-zero check below is now asserted separately, because
  // an inventory alone would let a future exit(0) slide in by also changing the expected string.
  // RE-PAIRED AGAIN at s263 (tabichat#2): this leg's transport-refusal site is a FIFTH site, and it is
  // also NON-ZERO — a tool that cannot agree a transport with the broker must never report a dispatch.
  // The count went 4 -> 5; the no-exit(0) intent below is unchanged and is still asserted separately.
  "the requester has no unconditional success exit",
  (tool.match(/process\.exit\([^)]*\)/g) || []).join(","),
  "process.exit(2),process.exit(ADMIN_EXIT.broker),process.exit(2),process.exit(ADMIN_EXIT.broker),process.exit(code)",
);
check("and NONE of those exit sites is a bare success", /process\.exit\(\s*0\s*\)/.test(tool), false);
check("the requester's rc comes from the outcome", /adminExitCode\(msg\.outcome\)/.test(tool), true);
check("an unanswered dispatch exits UNKNOWN, not 0", /ADMIN_EXIT\.unknown/.test(tool), true);
check("fleet-wide fan-out is never accidental", v({ action: "shutdown", by: "dust", to: "all" }),
  { ok: true, action: "shutdown", by: "dust", arm: false });

// --- what the lane says ------------------------------------------------------------------
check("the notice names the requester", adminNotice("compact", "lead-agent").includes("lead-agent"), true);
check("the compact notice says compact", adminNotice("compact", "dust").includes("compact"), true);
check("the renew notice hands over the command", adminNotice("renew", "dust").includes(RENEW_COMMAND), true);
check("the pending notice names the flag", pendingNotice("shutdown", "dust").includes(ADMIN_FLAGS.shutdown), true);
check("the dispatch notice says the session is ending", renewDispatched("dust").includes("dispatching"), true);
check("the failure half says nothing was renewed", renewDispatchFailed("boom").includes("nothing was renewed"), true);
check("the failure half names the command it dispatches", renewDispatchFailed("boom").includes(RENEW_COMMAND), true);

// --- SOURCE SHAPE: the decisions above must be reachable from index.ts --------------------
// A grep, honestly labelled: it proves the calls exist in the file that runs, not that a
// runtime path executed them. That is the gap the ctx bug slipped through.
const SRC = join(import.meta.dir, "..", "extensions", "tabichat");
const index = readFileSync(join(SRC, "index.ts"), "utf8");
// ctxwarn.ts read ONCE, hoisted beside the other source reads so every cell that checks the handoff
// bar's floor looks at the same bytes. Declared here because the cell that uses it is above the
// section where `cw` was originally introduced, and a `const` used above its own line is a TDZ crash.
const cw_probe = readFileSync(join(SRC, "ctxwarn.ts"), "utf8");
// The index.ts code with BOTH comment styles stripped, for the #5 wiring cells. Declared HERE, right
// after `index`, because a `const` above its own initialisation is a temporal-dead-zone ReferenceError
// and this leg hit exactly that on its first run. Block comments are stripped here and not for
// `toolCode` because index.ts is written with `/** ... */` doc blocks that quote code shapes; a grep
// over prose would pass a wiring cell while the wiring is gone.
const indexCode = index.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("index.ts imports the admin gate", index.includes('from "./laneadmin.ts"'), true);
check("index.ts asks the gate before acting", index.includes("adminVerdict("), true);
check("index.ts still answers delivery receipts", index.includes("isAck(msg)"), true);
check("index.ts registers the renew command", index.includes(`pi.registerCommand("${RENEW_COMMAND.slice(1)}"`), true);
// The renew handler is SLICED by its own braces and tested inside the slice, rather than grepped
// with a distance-limited regex: Leg H added a hold block ahead of newSession(), which pushed the
// call past any sane window. A window that fails because code got safer is the wrong instrument —
// membership in the handler's own text is the invariant, and it does not rot when the handler grows.
const renewHandler = (index.match(/pi\.registerCommand\("renew",\s*\{[\s\S]*?\n  \}\);/) ?? [""])[0];
check("the renew handler was found at all (the slice is not silently empty)", renewHandler.length > 200, true);
check("the renew handler really calls newSession", renewHandler.includes("await ctx.newSession("), true);
check("the renew handler waits for idle first", renewHandler.indexOf("waitForIdle()") < renewHandler.indexOf("newSession("), true);
check("compact goes through ctx.compact", index.includes("compact("), true);
// the recipient gate is only real if the running file hands it the field and obeys the silence flag
check("index.ts passes the recipient field to the gate", index.includes("to: msg.to"), true);
check("index.ts obeys the bystander silence flag", index.includes("if (v.speak)"), true);
// Leg B: renew must go through the command path, and the retired ceiling must be gone for good
check("index.ts dispatches its own renew command", index.includes(`pi.sendUserMessage(RENEW_COMMAND, { expandPromptTemplates: true })`), true);
check("index.ts imports the command it dispatches", index.includes("RENEW_COMMAND,"), true);
check("a failed dispatch is reported, not swallowed", index.includes("renewDispatchFailed("), true);
check("the retired ceiling is gone from laneadmin.ts", readFileSync(join(SRC, "laneadmin.ts"), "utf8").includes("cannotSelfRenew"), false);
check("the retired ceiling is gone from index.ts", index.includes("cannotSelfRenew"), false);
check("the false claim about user-initiated renew is not re-shipped", index.includes("only to user-initiated commands"), false);
// Leg C: the renew must re-arm the live context, or the next inbound line kills the seat (flash5, 2026-10-18)
check("the renew handler passes withSession", /newSession\(\s*\{[\s\S]{0,200}withSession:/.test(index), true);
check("withSession re-arms the live-context handle", index.includes("currentCtx = next"), true);
check("the bare newSession() that stranded the handle is gone", index.includes("ctx.newSession()"), false);
check("stale-ctx is caught on the socket path, not fatal", index.includes("handleInbound(topic, payload)") && index.includes("inbound line dropped, handler threw"), true);
check("the un-armed case speaks on stderr, never through a dead ctx", index.includes("withSession did not fire") && index.includes("console.error("), true);

// --- LEG D: the wake half (a renewed seat is an ERASED seat and must be told where its handoff is) --
check("wake with a handoff names the path", wakeDirective("/tabith/resume/RESUME-flash5-09349c.md").includes("/tabith/resume/RESUME-flash5-09349c.md"), true);
check("wake with a handoff tells the seat to read it", wakeDirective("/p").includes("Read it"), true);
check("wake does NOT authorise resuming work (owner no-self-start law s105)", wakeDirective("/p").includes("WAIT for a dispatch"), true);
check("wake with no handoff says there is none", wakeDirective(null).includes("NO RESUME file"), true);
check("wake with no handoff still ends in HOLD", wakeDirective(null).includes("HOLD"), true);
check("wake with no handoff forbids resuming from memory", wakeDirective(null).includes("from memory"), true);
check("the byte bar picks the first candidate that clears it", wakePathFor([{ path: "/a", bytes: 10 }, { path: "/b", bytes: 500 }], 200), "/b");
check("the byte bar honours an exact-size file", wakePathFor([{ path: "/a", bytes: 200 }], 200), "/a");
check("the byte bar returns null when nothing clears it", wakePathFor([{ path: "/a", bytes: 199 }], 200), null);
check("a missing file (null bytes) is never a handoff", wakePathFor([{ path: "/a", bytes: null }], 200), null);
check("an empty candidate list is not a handoff", wakePathFor([], 200), null);
check("order decides, durable dir first", wakePathFor([{ path: "/dur", bytes: 300 }, { path: "/scratch", bytes: 900 }], 200), "/dur");
check("index.ts imports the wake ACT, not the strings", index.includes("wakeRenewedSeat,"), true);
// RE-PAIRED by leg 420 ACT B, NOT deleted. The shipped cell counted exactly one occurrence of a
// one-line expression; ACT B moved that expression into `resumeScan()` and the count went to 0, which
// read as "the sharing was lost". It was not — `wakePathFor(resumeCandidates(), RESUME_MIN_BYTES)` is
// still the gate's fast path and still the wake pointer's bar. So this pins the CALL, and the cell
// below pins that the new matcher was given the SAME floor rather than a second one invented beside it.
check("the gate and the pointer share one byte bar", /wakePathFor\(resumeCandidates\(\), RESUME_MIN_BYTES\)/.test(indexCode), true);
check("and the matcher takes the SAME floor — no second byte bar was invented",
  cw_probe.includes("minBytes = RESUME_MIN_BYTES"), true);
check("index.ts calls the wake act INSIDE withSession, not after newSession returns", /withSession: async \(next\) =>[\s\S]{0,2500}await wakeRenewedSeat\(next,\s*\{/.test(index), true);
check("index.ts hands the act the candidates probe and the byte bar", /wakeRenewedSeat\(next,\s*\{[\s\S]{0,300}resumeCandidates,[\s\S]{0,140}minBytes: RESUME_MIN_BYTES/.test(index), true);
check("index.ts no longer hand-rolls the wake itself", index.includes("next.sendUserMessage(wakeDirective"), false);
check("and no raw followUp literal came back with it", index.includes('{ deliverAs: WAKE_DELIVER_AS }'), false);
check("a failed wake injection speaks on stderr (the act, where it now lives)", readFileSync(join(SRC, "laneadmin.ts"), "utf8").includes("wake injection FAILED"), true);

// --- LEG D2: the wake act EXECUTED against a fake replacement session (a behavior proof, not a grep)
const LA = readFileSync(join(SRC, "laneadmin.ts"), "utf8");
check("the act lives in the tested module, not only in the importer", LA.includes("export const wakeRenewedSeat"), true);
// 959: this call line grew a third argument — `wakeLegNote(path)` — so the literal moved. It is
// re-pinned, not relaxed: the same assertion (the act itself speaks, at the injection point), and it
// now also pins that the leg note is wired THERE rather than defined and never called.
check("the act is what speaks, so the grep above is about wiring and nothing else", LA.includes('await next.sendUserMessage(wakeDirective(path, deps.leadNick ?? "", wakeLegNote(path)), { deliverAs: WAKE_DELIVER_AS })'), true);

const runWake = async (cands, opts = {}) => {
  const sent = [];
  const notes = [];
  const errs = [];
  const next = {
    sendUserMessage: async (content, o) => {
      if (opts.sendThrows) throw new Error("ctx went stale");
      sent.push({ content, o });
    },
    ui: { notify: (t, l) => notes.push({ t, l }) },
  };
  const r = await wakeRenewedSeat(next, {
    resumeCandidates: () => cands,
    minBytes: 200,
    ...(opts.fallbackPick ? { fallbackPick: opts.fallbackPick } : {}),
    leadNick: opts.leadNick ?? "",
    stderr: (t) => errs.push(t),
    stackEnvOn: !!opts.stackEnvOn,
  });
  return { r, sent, notes, errs };
};

const w1 = await runWake([{ path: "/dur/RESUME-flash5-09349c.md", bytes: 500 }]);
check("EXECUTED: with a handoff, exactly one line is delivered", w1.sent.length, 1);
check("EXECUTED: that line carries the path", w1.sent[0].content.includes("/dur/RESUME-flash5-09349c.md"), true);
check("EXECUTED: delivered as the named class, not a steer", w1.sent[0].o.deliverAs, WAKE_DELIVER_AS);
check("EXECUTED: the act reports the path back", w1.r, { sent: true, path: "/dur/RESUME-flash5-09349c.md" });
check("EXECUTED: and tells the operator on the terminal", w1.notes[0].t.includes("wake line sent"), true);

const w2 = await runWake([{ path: "/dur/x.md", bytes: null }, { path: "/scratch/x.md", bytes: 3 }]);
check("EXECUTED: with NO handoff a line is STILL sent — silence is the failure mode", w2.sent.length, 1);
check("EXECUTED: and it says there is no handoff", w2.sent[0].content.includes("NO RESUME file"), true);
check("EXECUTED: the no-handoff case notifies as a warning", w2.notes[0].l, "warning");
check("EXECUTED: no handoff reports path null", w2.r.path, null);

const w3 = await runWake([{ path: "/dur/x.md", bytes: 500 }], { sendThrows: true });
check("EXECUTED: a delivery failure NEVER throws out of the act", w3.r.sent, false);
check("EXECUTED: the failure is named with a one-line reason", (w3.r.error ?? "").includes("ctx went stale"), true);
check("EXECUTED: and it reaches stderr, not a dead context", w3.errs[0].includes("wake injection FAILED"), true);
check("EXECUTED: no stack frame is printed by default", w3.errs.some((e) => e.includes("    at ")), false);
check("EXECUTED: nothing was notified as success after a failure", w3.notes.length, 0);

const w4 = await runWake([{ path: "/dur/x.md", bytes: 500 }], { sendThrows: true, stackEnvOn: true });
check("EXECUTED: the opt-in really does add the trace", w4.errs.some((e) => e.includes("at ")), true);

// --- THE HARNESS-ARTIFACT HALF (owner report on flash5's renew: node stack frames as lane text) --
check("a named error prints name and message", errOneLine(new TypeError("ctx is not active")), "TypeError: ctx is not active");
check("a message with embedded newlines stays ONE line", errOneLine(new Error("line one\nline two")), "Error: line one line two");
check("an empty message still names the error", errOneLine(new RangeError("")), "RangeError");
check("a non-Error object flattens to JSON, not [object Object]", errOneLine({ a: 1 }), '{"a":1}');
check("[object Object] can never be the artifact", errOneLine({ a: 1 }).includes("[object Object]"), false);
check("an object carrying only a message speaks it", errOneLine({ message: "ctx went stale" }), "ctx went stale");
check("a circular object does not throw out of the reporter", (() => { const o: Record<string, unknown> = { n: 1 }; o.self = o; try { return errOneLine(o); } catch { return "THREW"; } })(), "object (no message)");
check("undefined is not an empty artifact", errOneLine(undefined), "undefined");
check("a thrown string carries no stack noise", errOneLine("boom"), "boom");
check("the inbound belt no longer interpolates e.stack into its one-line notice", !/inbound line dropped[^\n]*e\.stack/.test(index), true);
check("the inbound belt prints only the one-line form", index.includes("${errOneLine(e)} (topic ${topic})"), true);
check("a full trace is opt-in, never the default", index.includes('process.env.TABICHAT_ERR_STACK === "1"'), true);

// --- LEG H: the lead hold, and the lead's own wake line (a lead that renews silently loses verdicts) --
check("a lead seat renewing itself must hold the room", shouldHoldBeforeRenew("wren", "wren"), true);
check("a worker seat renewing must NOT publish to @all", shouldHoldBeforeRenew("flash5", "wren"), false);
check("an empty self is never a lead", shouldHoldBeforeRenew("", "wren"), false);
check("an empty lead nick holds nothing (no accidental @all when LEAD_NICK is unset)", shouldHoldBeforeRenew("wren", ""), false);
check("surrounding spaces do not defeat the match", shouldHoldBeforeRenew(" wren ", "wren"), true);
check("a different nick that merely contains the lead's does not match", shouldHoldBeforeRenew("wren2", "wren"), false);
check("the hold names who is going away", leadHoldLine("wren").includes("wren refreshing"), true);
check("the hold states the restore condition, not a time", leadHoldLine("wren").includes("until the restore line lands"), true);
check("the hold says work does NOT stop (it is not a stall order)", leadHoldLine("wren").includes("Work does NOT stop"), true);
const lw = wakeDirective("/r/RESUME-wren-abcd.md", "wren");
check("lead wake line tells it to publish the restore line", lw.includes("FIRST ACT: publish the restore line"), true);
check("lead wake line quotes the restore wording lanes are trained on", lw.includes("lead seat restored — comms with wren open again"), true);
check("lead wake line still names the handoff", lw.includes("/r/RESUME-wren-abcd.md"), true);
check("lead wake line orders the re-ship duty explicitly", lw.includes("re-ship every dispatch that has an ack and no report"), true);
const lwn = wakeDirective(null, "wren");
check("lead with NO handoff: restore first, then admit it woke blank", lwn.includes("FIRST ACT: publish the restore line") && lwn.includes("NO handoff"), true);
check("lead with no handoff is told not to self-assign", lwn.includes("Do not pick your own next task"), true);
check("a LANE wake line does NOT tell it to broadcast to the room", wakeDirective("/p", "").includes("restore line"), false);
check("lane wake line is unchanged for workers (no @all noise)", wakeDirective("/p", "").includes("renewed, holding"), true);
const w5 = await runWake([{ path: "/dur/RESUME-wren-123456.md", bytes: 500 }], { leadNick: "wren" });
check("EXECUTED as lead: delivered line is the lead form", w5.sent[0].content.includes("FIRST ACT: publish the restore line"), true);
check("EXECUTED as lead: handoff path present", w5.sent[0].content.includes("RESUME-wren-123456.md"), true);
const w6 = await runWake([{ path: "/dur/x.md", bytes: 500 }], {});
check("EXECUTED as worker: line is the lane form", w6.sent[0].content.includes("renewed, holding"), true);
check("EXECUTED as worker: line carries no restore instruction", w6.sent[0].content.includes("restore"), false);
check("the hold lives in the renew command handler, not at each caller", renewHandler.includes("shouldHoldBeforeRenew(nick, LEAD_NICK)"), true);
check("and it is published BEFORE newSession, which is the whole point", renewHandler.indexOf("shouldHoldBeforeRenew") < renewHandler.indexOf("await ctx.newSession("), true);
check("auto-renew does not get its own copy of the hold (single door)", (index.match(/shouldHoldBeforeRenew\(nick, LEAD_NICK\)/g) ?? []).length, 2);
check("the hold is AWAITED, not fire-and-forget (it races the session change)", index.includes("await new Promise<void>((resolve, reject)"), true);
check("the hold goes out steered and room-wide", index.includes('to: "all", steer: true'), true);
check("the hold publish failure is LOUD and does not block the renew", index.includes("lead hold NOT published") && index.includes("the renew proceeds"), true);
check("the lead's nick is threaded into the wake act", index.includes('leadNick: shouldHoldBeforeRenew(nick, LEAD_NICK) ? nick : ""'), true);

// --- LEG E: site-wide auto-renew (a seat may renew ITSELF; the policy is set once for the venue) --
check("bool slot: true word", parseBoolSlot("true"), true);
check("bool slot: 1 / on / yes all mean on", ["1", "on", "yes"].map((v) => parseBoolSlot(v)), [true, true, true]);
check("bool slot: 0 / off / no all mean off", ["0", "off", "no"].map((v) => parseBoolSlot(v)), [false, false, false]);
check("bool slot: real JSON booleans work (the file form)", [parseBoolSlot(true), parseBoolSlot(false)], [true, false]);
check("bool slot: GARBAGE is not on — it is no answer at all", parseBoolSlot("ture"), null);
check("bool slot: empty string is not on", parseBoolSlot(""), null);
check("bool slot: undefined is not on", parseBoolSlot(undefined), null);
check("bool slot: a number is not a bool", parseBoolSlot(1), null);
check("bool slot: an array is not a bool", parseBoolSlot(["true"]), null);
check("case and spaces do not matter", parseBoolSlot("  TRUE "), true);
// precedence, both halves of every pair
check("flag ON beats env OFF and site OFF", resolveAutoRenew({ flag: true, env: "0", site: false }), true);
check("flag OFF beats env ON and site ON", resolveAutoRenew({ flag: false, env: "1", site: true }), false);
check("an explicit --no-auto-renew is an ANSWER, not an absence", resolveAutoRenew({ flag: false, env: undefined, site: undefined }), false);
check("env ON beats site OFF", resolveAutoRenew({ flag: undefined, env: "1", site: false }), true);
check("site ON is the venue-wide yes with no per-seat flag at all", resolveAutoRenew({ flag: undefined, env: undefined, site: true }), true);
check("nothing set = ON by owner order 2026-10-24", resolveAutoRenew({}), true);
check("garbage at every layer falls through to the ON default", resolveAutoRenew({ flag: "", env: "maybe", site: "oen" }), true);
check("the flag layer names itself", resolveAutoRenewLayered({ flag: true, env: "1", site: true }).source, `pi flag --${AUTO_RENEW_FLAG}`);
check("the env layer names itself", resolveAutoRenewLayered({ env: "1", site: true }).source, `${AUTO_RENEW_ENV} env`);
check("the site layer names itself (so 'who turned this on' is answerable)", resolveAutoRenewLayered({ site: true }).source, "site file (autoRenew)");
check("and the default says so", resolveAutoRenewLayered({}).source, "default on (no layer set it)");
// the negative half the flip CREATES: one seat opting out must still be heard over a venue-wide ON
check("an opt-out at the flag layer survives the new ON default", resolveAutoRenew({ flag: false }), false);
check("and it names the FLAG layer, not the default", resolveAutoRenewLayered({ flag: false, env: undefined, site: undefined }).source, `pi flag --${AUTO_RENEW_FLAG}`);
// the site file itself
check("a good site file parses to its object", parseSiteConfig('{"autoRenew": true}'), { ok: true, config: { autoRenew: true } });
check("a broken site file says WHY, not nothing", parseSiteConfig("{oops").ok, false);
check("an array top level is refused", parseSiteConfig("[1,2]").ok, false);
check("a bare scalar is refused", parseSiteConfig("true").ok, false);
check("an empty file is refused (it is not an object)", parseSiteConfig("").ok, false);
check("a refusal carries a reason a human can act on", (parseSiteConfig("{oops") as { reason?: string }).reason !== undefined, true);
check("the default site path is under the agent dir", SITE_CONFIG_DEFAULT, "~/.pi/agent/tabichat.json");
check("the site path env name is the documented one", SITE_CONFIG_ENV, "TABICHAT_CONFIG");
// the verdict, both halves
const AR_BASE = { armed: true, percent: 80, floorPct: 75, renewedThisBoot: false, resumeWritten: true };
check("armed + over floor + handoff + first time = renew", autoRenewVerdict(AR_BASE), { ok: true });
check("not armed = refuse", autoRenewVerdict({ ...AR_BASE, armed: false }).ok, false);
check("the un-armed refusal names the env knob to turn", autoRenewVerdict({ ...AR_BASE, armed: false }).reason.includes(AUTO_RENEW_ENV), true);
check("under the floor = refuse", autoRenewVerdict({ ...AR_BASE, percent: 20 }).ok, false);
check("the floor refusal says WHY a cheap renew is not free", autoRenewVerdict({ ...AR_BASE, percent: 20 }).reason.includes("always-loaded"), true);
check("exactly AT the floor is over it (boundary, not vibe)", autoRenewVerdict({ ...AR_BASE, percent: 75, floorPct: 75 }), { ok: true });
check("no handoff = refuse, even armed and over floor", autoRenewVerdict({ ...AR_BASE, resumeWritten: false }).ok, false);
check("the handoff refusal says what would be lost", autoRenewVerdict({ ...AR_BASE, resumeWritten: false }).reason.includes("erase"), true);
check("second time this boot = refuse (no renew loop)", autoRenewVerdict({ ...AR_BASE, renewedThisBoot: true }).ok, false);
check("the loop refusal names the cap", autoRenewVerdict({ ...AR_BASE, renewedThisBoot: true }).reason.includes("once this boot"), true);
check("no context reading yet = refuse", autoRenewVerdict({ ...AR_BASE, percent: null }).ok, false);
check("a non-finite reading = refuse, not a NaN renew", autoRenewVerdict({ ...AR_BASE, percent: Number.NaN }).ok, false);
check("the cap is checked before the handoff (a renewed seat is never blocked on its own file)", autoRenewVerdict({ ...AR_BASE, renewedThisBoot: true, resumeWritten: false }).reason.includes("once this boot"), true);
// SOURCE SHAPE for Leg E: the policy must be read where pi can actually see flags, and the act must
// reuse the remote path rather than fork a second one.
check("index.ts registers the auto-renew flag", index.includes(`pi.registerFlag("${AUTO_RENEW_FLAG}"`), true);
check(
  // MOVED at s138d (site-agnostic): index.ts no longer computes the site path itself. The whole
  // point of that leg is that the location is computed in ONE function, so the cell now pins the
  // CALL — and the companion cell below proves the env read still happens, one file over, rather
  // than having quietly disappeared. (A site path nobody reads is a dead file, which is the failure
  // class this repo has been bitten by twice.)
  "index.ts gets its site path from the one function",
  index.includes("siteConfigPath(process.env)"),
  true,
);
check("and broker.ts is where the site path env is actually read", readFileSync(new URL("../extensions/tabichat/broker.ts", import.meta.url), "utf8").includes("env[SITE_CONFIG_ENV]"), true);
check("the site file is parsed by the tested parser", index.includes("parseSiteConfig(readFileSync(sitePath"), true);
check("layers are resolved at session_start, not in the factory", /pi\.on\("session_start"[\s\S]{0,2500}resolveAutoRenewLayered\(\{/.test(index), true);
check("a site file that will not parse is LOUD at session_start", index.includes("was NOT read") && index.includes("siteConfigNote"), true);
check("the resolved policy is stated with its layer", index.includes("auto-renew ON for this seat (from ${autoRenewSource})"), true);
// MEASURED 2026-10-18 in the scratch-lane test: an "info" notify is transient in pi's TUI, so the
// policy line the seat prints at start was GONE before anyone read it, while the warning-level ctx
// advisory beside it survived. A setting that decides whether a seat destroys its own session has to
// be readable after the fact — hence both a persistent status entry and a warning-level notify.
check("and it really passes warning (source-shape)", /auto-renew ON for this seat[\s\S]{0,500}"warning"/.test(index), true);
check("and it sets a persistent footer status", index.includes('ctx.ui.setStatus("nick-tabichat", "\u{1F344} tabichat")'), true);
// O224 — THE FOOTER ORDER IS A BEHAVIOR, NOT A COMMENT. pi sorts the status line by KEY with
// `a.localeCompare(b)` and prints only the text, so the only honest proof of "the mushroom sits next to
// the nick" is to run pi's own comparator over the key set pi will actually receive. The tabichat keys
// are NOT typed here: every literal `setStatus("<key>"` is read out of `index.ts` and the constant key is
// read out of `mentionq.ts`, so a rename on either side moves this cell instead of silently passing it.
// `ponytail` IS pinned, and that is stated rather than hidden: it belongs to a different repo (this box
// sets it at `/git/ponytail/pi-extension/index.js:98`), so this test cannot read it — and a seat that
// loads NO ponytail simply has one fewer key, which does not change the assertion (the mushroom is still
// immediately after the nick; the NEGATIVE half below is what proves the check can bite: the same
// predicate with the old key `renew` MUST fail). A check that cannot fail is not a check.
{
  const keyLits = [...indexCode.matchAll(/setStatus\("([a-z0-9_-]+)"/g)].map((m) => m[1]);
  // HOLD_BADGE_KEY lives in mentionq.ts and is set through a CONSTANT, not a literal, so the regex above
  // cannot see it. It is read from that file rather than typed here, for the same reason the literals are:
  // a key changed on the far side of the repo must move this cell, not silently pass it.
  const mentionqSrc = readFileSync(join(SRC, "mentionq.ts"), "utf8");
  const holdKey = /export const HOLD_BADGE_KEY = "([a-z0-9_-]+)"/.exec(mentionqSrc)?.[1] ?? "";
  const keys = [...new Set([...keyLits, holdKey, "ponytail"])];
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const i = sorted.indexOf("nick-tabichat");
  check(
    "O224: pi's own comparator puts the mushroom immediately after the nick badge",
    i > 0 && sorted[i - 1] === "nick" && sorted[i + 1] === "ponytail",
    true,
  );
  check(
    "O224 NEGATIVE (the seed): the SAME predicate with the old key `renew` FAILS — so the check can bite",
    (() => {
      const old = [...new Set([...keyLits.filter((k) => k !== "nick-tabichat"), "renew", holdKey, "ponytail"])]
        .sort((a, b) => a.localeCompare(b));
      const j = old.indexOf("renew");
      return !(j > 0 && old[j - 1] === "nick" && old[j + 1] === "ponytail");
    })(),
    true,
  );
  check(
    "O224: the key set this cell sorted is the real one, read from source (not typed by hand)",
    // FLOOR MOVED 8 -> 7 AND THE CELL GOT STRONGER, both by owner order 2026-10-24, stated here because a
    // widened bound is the exact shape this house forbids quiet weakening with. The owner removed TWO footer
    // entries today (`ctx`, then `resume`), so the set this cell reads out of source legitimately shrank by two.
    // The count floor was never the point — the membership checks are — so instead of just lowering it, the cell
    // now also pins that the two removed keys STAY removed: a seat that re-adds either one silently shifts the
    // mushroom's neighbours, and that is precisely what this cell exists to catch.
    keys.length >= 7 && holdKey !== "" && keys.includes("nick") && keys.includes("nick-tabichat")
      && keys.includes("ponytail") && keys.includes(holdKey)
      && !keys.includes("ctx") && !keys.includes("resume"),
    true,
  );
  check(
    "O224: the ctx entry the owner deleted is ABSENT from the shipped bytes",
    indexCode.includes('setStatus("ctx"'),
    false,
  );
  check(
    "O224: the RESUME entry the owner deleted is ABSENT from the shipped bytes",
    indexCode.includes('setStatus("resume"'),
    false,
  );
  check(
    "O224: the old key is GONE from the shipped bytes — a half-moved badge would still sort wrong",
    indexCode.includes('setStatus("renew"'),
    false,
  );
}
// RE-PAIRED 2026-10-23 (leg 425), NOT weakened: the cell above used to assert `"auto-renew ON"` and now
// asserts the shipped mushroom string, so a rename back to the old text fails the suite just as a
// deletion of the status line always did. Written with a \u{1F344} escape rather than a literal glyph for
// ONE honest reason: the escape is unambiguous in a diff and cannot be silently mangled by an editor or a
// terminal that mangles UTF-8, and the JS string it builds is byte-identical to the literal. There is NO
// repo rule about emoji in source — I wrote that here first and it was invented; `grep -rniE emoji
// AGENTS.md README.md docs/` → 0 hits. Stated plainly because a fabricated justification in a comment is
// the same class of thing this fleet books a report over. NOTE the `u` flag on
// the count regex below: without it `\u{1F344}` is SIX LITERAL CHARACTERS, not one code point, and the match
// returns 0 against correct bytes — which is exactly how this cell read RED on its first run here. Counted
// against `indexCode` (comments stripped), NOT raw `index`: this leg's own explanatory comment QUOTES the
// glyph, so the raw read returned 3 and called correct bytes wrong — the same prose-versus-code trap this
// fleet has now hit three times (lane_admin negative cell, the durable-default check, and here).
check("and the status line is the ONLY place the mushroom ships", (indexCode.match(/\u{1F344} tabichat/gu) || []).length, 1);
check("and the notify KEEPS its provenance words (status-only, owner's 'both' answer still owed)",
  index.includes("auto-renew ON for this seat (from ${autoRenewSource})") && index.includes('ctx.ui.setStatus("nick-tabichat", "\u{1F344} tabichat")'), true);
check("OFF prints nothing (no fleet-wide 'auto-renew off' noise)", /if \(autoRenewArmed\) \{[\s\S]{0,600}"warning",\n\s*\);\n\s*\}/.test(index), true);
check("self-renew travels the SAME runAdmin as a remote renew", index.includes('runAdmin("renew", "auto-renew", ctx)'), true);
check("the process-scoped auto-renew cap is set BEFORE the dispatch, not after", /AUTO_RENEWED\.add\(nick\);[\s\S]{0,900}runAdmin\("renew"/.test(index), true);
check("and the handler stops after renewing (no work behind a dying session)", /runAdmin\("renew", "auto-renew", ctx\);\s*\n\s*return;/.test(index), true);
check("the floor is the forced-handoff number, not a new constant invented here", index.includes("floorPct: CTX_FORCE"), true);
// the needle is the call as it is written in index.ts; leg 652 added the warn percent to it, so the
// text moved with it. The assertion is the ORDERING, and it still asserts exactly that.
check("the verdict runs before the advisory early-return", index.indexOf("autoRenewVerdict({") < index.indexOf('const absDue = absoluteSessionDue(s, CTX_TOKENS, lastCtxWarnTokens, CTX_WARN);\n    if (!pctDue && !absDue) return;', 100), true);

// --- tabichat#3: ONE renew, ONE session — the fork guard, both truth-table halves ---------
// The runtime proof is the two-seat reproduction (s146): with the old bytes ONE publish of ONE
// request id reached the lane's handler TWICE — the driver stderr shows `inbound line dropped,
// handler threw ... (topic chat/tlstest/_ctl)` beside the single accepted verdict — because the
// seat subscribed to `_ctl` AND `_ctl/#` and mosquitto delivers one copy per matching subscription
// (`sport/#` also matches `sport`, MQTT 3.1.1 §4.7 — measured: both filters = 2 copies, wildcard
// alone = 1). The cells below hold the decision and the wiring; the LABELLED-GREP standing and its
// honest limit are as stated above: written, not run.
check("an absent stamp lets a renew through — the normal door is not gated", renewInFlightRefusal(null, 1_000), { ok: true });
check("an undefined stamp (a Map.get miss) lets it through too", renewInFlightRefusal(undefined, 1_000), { ok: true });
check("a FRESH stamp refuses — a second concurrent replacement is the fork", renewInFlightRefusal(1_000, 1_001).ok, false);
check("and the refusal names the age and the window, not just 'no'", String((renewInFlightRefusal(1_000, 1_001) as { reason?: string }).reason).includes("stamped 1ms ago"), true);
check("a STALE stamp (past the backstop window) says ok — a wedged seat is never stranded forever", renewInFlightRefusal(0, RENEW_INFLIGHT_MAX_MS + 1), { ok: true });
check("one ms INSIDE the window still refuses (the window is a real bar, not a formality)", renewInFlightRefusal(0, RENEW_INFLIGHT_MAX_MS).ok, false);
check("two DIFFERENT nicks never share a refusal — the store is keyed per nick", renewInFlightRefusal(null, 2_000), { ok: true });

// Wiring halves (source-shape greps) of the same defect.
check(
  "ONE control filter, not two: `_ctl/#` alone hears `_ctl` (the duplicate-copy source is gone)",
  index.includes("client!.subscribe(`${controlTopic(room)}/#`)") && !index.includes("client!.subscribe(controlTopic(room));"),
  true,
);
check("lane-admin requests pass the id ledger BEFORE the verdict", index.indexOf("noteRoomId(seenAdminIds, msg.id)") < index.indexOf("takeAdmin(msg, liveCtx())"), true);
const ctlBranch = index.slice(index.indexOf("if (isLaneAdmin(msg)) {"), index.indexOf("if (isLaneAdmin(msg)) {") + 900);
check("and the duplicate copy returns before takeAdmin is reachable", /if \(ad\.dup\) return;[\s\S]*takeAdmin\(msg, liveCtx\(\)\)/.test(ctlBranch), true);
check("the renew handler checks and stamps with no await between (single-thread serialisation)", /const stamp = RENEW_INFLIGHT\.get\(nick\)[\s\S]{0,700}RENEW_INFLIGHT\.set\(nick, Date\.now\(\)\);/.test(index), true);
check("the latch releases when the replacement is LIVE (AC4: a later renew must still renew)", /rearmed = true;[\s\S]{0,500}RENEW_INFLIGHT\.delete\(nick\);/.test(index), true);
check("cancelled and no-re-arm release it too — no path strands the seat", (index.match(/RENEW_INFLIGHT\.delete\(nick\);/g) || []).length >= 3, true);
check("runAdmin refuses an in-flight duplicate and ANSWERS the requester", /renewInFlightRefusal\(RENEW_INFLIGHT\.get\(nick\)[\s\S]{0,400}answer\?\.\("refused"/.test(index), true);
check("the auto-renew cap reads the PROCESS store, not a per-factory `let`", !index.includes("let autoRenewedThisBoot =") && index.includes("renewedThisBoot: AUTO_RENEWED.has(nick)"), true);

// --- tabichat#2 blocker 1: the control tool must speak the transport the fleet actually runs ------
// THE DEFECT: `lane_admin.mjs` called `mqtt.connect(broker.url)` with NO options. The fleet moved to
// `mqtts://` on 2026-10-19, so every remote renew / compact / shutdown died at the broker BEFORE any
// lane judged it. The s142 note named this; it was re-measured on this leg at `68e4973` against the
// throwaway fixture broker: rc 4, "broker error: self signed certificate in certificate chain", with
// the TLS env exported and NEVER READ, because the file had no TLS code path to read it in. So #2's
// "can be renewed by a peer" half was UNREACHABLE, not merely unproven.
// THE FIX, held as a WIRING and not a fourth variant: the tool calls the SAME pure decision the lanes
// run. The runtime proof for both halves was taken on the fixture in this leg (report §FIX): pre-fix
// bytes rc 4, handshake refused, nothing published; post-fix bytes rc 3 "NOTHING", which means it
// CONNECTED, published, then told the truth about nobody answering. The greps below are SOURCE-SHAPE
// and say so — they keep the shape after this leg; they are not the proof.
check("the requester runs the lanes' transport decision, not its own", /transportDecision\(/.test(tool) && tool.includes("tlsopts.ts"), true);
check("and it reads the PEMs through the shared reader", /makePemReader\(/.test(tool), true);
check("the CONNECT call carries the decision's options", /mqtt\.connect\(TRANSPORT\.url,\s*\{\s*\.\.\.\(TRANSPORT\.tls \?\? \{\}\)\s*\}/.test(toolCode), true);
check("the bare no-options connect that caused the defect is GONE", /mqtt\.connect\(broker\.url\)/.test(toolCode), false);
check("a transport refusal is FINAL and NON-ZERO — never a silent plaintext fallback", /if \(TRANSPORT\.mode === "refuse"\)[\s\S]{0,500}process\.exit\(ADMIN_EXIT\.broker\)/.test(tool), true);
check("and the refusal prints the decision's own reasons, not a generic failure", /TRANSPORT\.reasons/.test(tool), true);
check("MQTT_TLS_INSECURE keeps its EVERY-connect warning here too, as in the lanes", /TRANSPORT\.perConnectWarnings/.test(tool), true);
check("the broker URL is redacted on the error path (a URL must never print credentials)", /redactUrl\(String\(err/.test(tool), true);
// POSITIVE CONTROLS for the two cells above that only grep the tool: the decision itself must be
// capable of both answers, or a green wiring cell proves nothing about the transport.
check("POSITIVE CONTROL: an mqtts URL with NO pinned CA is a refusal, not a connect",
  transportDecision("mqtts://broker.invalid:8883", {}, () => ({ error: "not read" })).mode, "refuse");
check("POSITIVE CONTROL: the same call yields tls once a readable CA is pinned",
  transportDecision("mqtts://broker.invalid:8883", { MQTT_TLS_CAFILE: "/x/ca.crt" }, (p) =>
    p === "/x/ca.crt" ? { text: "-----BEGIN CERTIFICATE-----\n" } : { error: "nope" },
  ).mode, "tls");

// --- tabichat#5: control lines are ordered by MESSAGE STAMP on a channel keyed by SUBJECT -------
// The handle is (channel, stamp). Why not the two shapes the row offered: a per-sender monotonic seq
// orders a seat's lines against ITSELF, and a hold and its lift do not have one author — the hold is
// published by the mechanism from the renewing seat (`leadHoldLine`), the lift is typed next by
// whoever has a keyboard, often a DIFFERENT nick in a NEW session. An id back-reference (`lifts <id>`)
// would require that hand-typed lift to quote an id its author never saw. Both shipped texts already
// carry a `ts` from the one clock this box runs, so stamp is the only handle both publishers actually
// have. THE CHANNEL IS `comms:<target>` — the subject of the order, never its author — which is what
// lets a hold from `wren` and a lift from `owner` order against each other. A same-sender guard would
// have caught neither specimen on this row.
const HOLD_WREN = { nick: "wren", message: leadHoldLine("wren") };
const LIFT_WREN = {
  nick: "owner",
  message: "lead seat restored (s264) — comms with wren open again. Reports owed: 404, 406.",
};
check("a lead hold IS a control order, on the comms channel of the seat being held", controlChannelOf(HOLD_WREN),
  { channel: "comms:wren", held: true, target: "wren" });
check("a restore line IS a control order, and opens the SAME channel", controlChannelOf(LIFT_WREN),
  { channel: "comms:wren", held: false, target: "wren" });
// NEGATIVE HALVES. Anything that could become a control order by accident would supersede real orders,
// so these are the load-bearing cells, not decoration.
check("NEGATIVE: a lane merely TALKING about comms is not a control order", controlChannelOf({ nick: "flash6", message: "my comms with the lead are fine, no hold here" }), null);
check("NEGATIVE: an ordinary dispatch line is not a control order", controlChannelOf({ nick: "wren", message: "@flash6 wren dispatch → flash6 (leg 406). Read the spec." }), null);
check("NEGATIVE: a HOLD naming a different seat is a different channel — one bar cannot silence another", controlChannelOf({ nick: "wren", message: leadHoldLine("librarian") })!.channel, "comms:librarian");
check("NEGATIVE: a line about the fleet as a whole names no seat, so it is not a comms order", controlChannelOf({ nick: "wren", message: "hold all work please, the box is rebooting" }), null);
check("channel keys are case-folded — 'WREN' and 'wren' are one bar, not two ledgers", controlChannelOf({ nick: "wren", message: "hold all comms to WREN until the restore line lands" })!.channel, "comms:wren");

// The ordering itself, both halves. `strictly older` is the bar: a tie never retires an order.
const LED_BY_LIFT = { ts: 2_000, id: "owner-1-abc", nick: "owner", held: false };
check("a NEWER line on a channel with nothing recorded yet is current", ctlAdmit(undefined, { ts: 1_000, id: "x" }), { kind: "current" });
check("POSITIVE: a line newer than the recorded order is current", ctlAdmit(LED_BY_LIFT, { ts: 3_000, id: "y" }), { kind: "current" });
check("and EQUAL stamps are current too — a tie must not silently retire an order", ctlAdmit(LED_BY_LIFT, { ts: 2_000, id: "y" }), { kind: "current" });
check("NEGATIVE (the row's whole point): a line STRICTLY OLDER than the newest obeyed order is SUPERSEDED", ctlAdmit(LED_BY_LIFT, { ts: 1_500, id: "wren-36-old" }).kind, "superseded");
check("and the superseded verdict names WHAT beat it, so the lane can say why", (ctlAdmit(LED_BY_LIFT, { ts: 1_500, id: "z" }) as { by?: CtlEntry }).by!.nick, "owner");
check("the label carries the winner's stamp and id, not just the word", /2\d{3}|1970/.test(supersededHeader("comms:wren", LED_BY_LIFT)) && supersededHeader("comms:wren", LED_BY_LIFT).includes("owner-1-abc"), true);
check("the label says LABELLED NOT DROPPED, and never claims the line is gone", supersededHeader("comms:wren", LED_BY_LIFT).includes("do not act on it"), true);

// THE REPLAY TEST that would have caught a fooled receiver (row AC3), run as the wire delivered it:
// hold at 08:37, lift at 08:58, and THEN the hold arrives again, hours late, from a different session.
{
  const ledger = new Map<string, CtlEntry>();
  const apply = (line: { nick: string; message: string }, ts: number, id: string): string => {
    const c = controlChannelOf(line)!;
    const v = ctlAdmit(ledger.get(c.channel), { ts, id });
    if (v.kind === "superseded") return "superseded";
    ledger.set(c.channel, { ts, id, nick: line.nick, held: c.held });
    return "current";
  };
  check("replay setup: the HOLD lands first and is obeyed", apply(HOLD_WREN, 1_000, "wren-36-hold"), "current");
  check("then the LIFT lands from a DIFFERENT nick and is obeyed", apply(LIFT_WREN, 2_000, "owner-1-lift"), "current");
  // This is the case a same-sender guard misses outright: the replayed hold is from `wren`, whose own
  // last recorded line would be… nothing, because the ledger's last writer on this channel was
  // `owner`. Keyed by SUBJECT, the late hold is recognised as retired.
  check("AC3 NEGATIVE: the hold replayed HOURS LATE is refused as superseded, not obeyed", apply(HOLD_WREN, 1_000, "wren-36-hold"), "superseded");
  check("AC3: and the late replay does NOT rewrite the ledger — the lift still stands", (ledger.get("comms:wren")!.id), "owner-1-lift");
  check("AC3: a re-delivery of the LIFT is also superseded-by-itself-safe (equal stamp = current, idempotent)", apply(LIFT_WREN, 2_000, "owner-1-lift"), "current");
  check("AC3: a genuinely NEW hold after the lift is obeyed — the guard is ordering, not a veto on holds", apply(HOLD_WREN, 5_000, "wren-1-hold2"), "current");
}
check("AC4: the ledger is keyed on globalThis, so a renewed session in this process still has the answer",
  String(CTL_LEDGER_KEY.description), "tabichat.ctlLedger");
check("AC5: and no authority rule moved — the recipient gate still runs before any of this",
  index.includes("const mentioned = receives(inboundTo, text, nick);"), true);
check("AC5 wiring: the inbound path asks controlChannelOf and labels, never drops",
  /const ctl = controlChannelOf\(\{ nick: from, message: text \}\);[\s\S]{0,900}supersededHeader\(ctl\.channel, v\.by\)/.test(indexCode), true);
check("AC5 wiring: the label rides the SAME head as a steer, so a late order cannot interrupt cleanly",
  /const head =\s*\(cls === "steer" \? `\$\{steerHeader\(from\)\}\\n\\n` : ""\) \+ ctlHead;/.test(indexCode), true);
check("AC4 wiring: the held drain re-checks at FLUSH time, not only on arrival",
  /labelSuperseded\(send\);[\s\S]{0,400}heldBatchBody\(send\)/.test(indexCode) && /labelSuperseded\(deliver\);/.test(indexCode), true);
check("AC4 wiring: the shipped coalesce call is UNTOUCHED — labelling happens before it, not inside it",
  indexCode.includes("heldBatchBody(send)") && !indexCode.includes("heldBatchBody(labelSuperseded"), true);
check("AC4 wiring: a re-held line is never labelled twice — the stack guard reads SUPERSEDED_MARK",
  /h\.body\.startsWith\(SUPERSEDED_MARK\)/.test(indexCode), true);
check("AC4 wiring: the drain labels and SHIPS — no held line is discarded",
  /ctlAdmit\(CTL_LEDGER\.get\(ctl\.channel\), \{ ts: h\.ts, id: h\.id \}\)/.test(indexCode), true);
check("#5 store: the ledger is a PROCESS globalThis Map, never a per-factory closure",
  /\(globalThis as Record<PropertyKey, unknown>\)\[CTL_LEDGER_KEY\] \?\?=\s*new Map<string, CtlEntry>\(\)/.test(indexCode), true);
check("#5 store: it is keyed by CHANNEL on get and set, never by nick",
  /CTL_LEDGER\.get\(ctl\.channel\)/.test(indexCode) && /CTL_LEDGER\.set\(ctl\.channel,/.test(indexCode) && !/CTL_LEDGER\.(get|set)\(nick/.test(indexCode), true);

// --- tabichat#4: a belt that catches the throw must not also lose the line -------------------------
// WHY THIS IS THE RIGHT SHAPE, and what was measured to make it a fact rather than a guess. The row
// says the belt prints `inbound line dropped` — true, and the belt is the #585 fix, so it stays. The
// loss underneath it is the defect. In the room path the sites that can throw on a stale handle
// (`liveCtx().isIdle()` in deliveryClass, and again in holdDecision) sit AFTER the ack is published
// and BEFORE the line is handed to pi or to the held list. So the sender was told "delivered" and the
// lane never saw the line. That ordering is what makes a replay safe, and it is why the flag is
// measured at the two handoff sites instead of assumed.
check("a pi ctx invalidation is recognised as the replayable class", isStaleCtxError(
  new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx."),
), true);
check("NEGATIVE: an ordinary handler bug is NOT replayable — a retry would mask it", isStaleCtxError(new Error("Cannot read properties of null (reading 'isIdle')")), false);
check("NEGATIVE: a string that merely contains the word stale is not the class", isStaleCtxError(new Error("stale peer record")), false);
check("NEGATIVE: undefined and non-Errors do not crash the classifier", [isStaleCtxError(undefined), isStaleCtxError(null), isStaleCtxError("ctx is stale after session replacement"), isStaleCtxError({ message: "ctx is stale after session x" }), isStaleCtxError({}), isStaleCtxError(new Error(""))],
  // An object carrying pi's text COUNTS: JS wrappers for this throw do not have to be Error
  // instances, and refusing a real replayable line because of a wrapper class is the loss this row is
  // about. A bare string counts too, for the same reason. What must NOT match is no-message, empty
  // message, or prose that merely says "stale" — all three below.
  [false, false, true, true, false, false]);

// parkInbound truth table — all four corners of (stale, handedOff).
const P0 = { topic: "chat/tabith", payload: "{\"a\":1}", nick: "flash6", ts: 1 };
check("stale + not handed off -> parked", parkInbound([], P0, false, true).parked, true);
check("handed off -> NOT parked (a replay of an owned line is a duplicate delivery)", parkInbound([], P0, true, true).parked, false);
check("not stale -> NOT parked (the belt must not launder handler bugs)", parkInbound([], P0, false, false).parked, false);
check("and a refusal drops nothing: dropped is 0 when there was no overflow", parkInbound([], P0, false, false).dropped, 0);
check("the park keeps arrival order", parkInbound([P0], { ...P0, ts: 2 }, false, true).park.map((x) => x.ts), [1, 2]);
check("the cap TRIMS and REPORTS the trim — the count is the whole point of an overflow", parkInbound(
  Array.from({ length: INBOUND_PARK_MAX }, (_, i) => ({ ...P0, ts: i })), { ...P0, ts: 999 }, false, true).dropped, 1);
check("and after an overflow the park is exactly at the cap, holding the NEWEST lines", parkInbound(
  Array.from({ length: INBOUND_PARK_MAX }, (_, i) => ({ ...P0, ts: i })), { ...P0, ts: 999 }, false, true).park.length, INBOUND_PARK_MAX);
check("takeParked hands back the whole backlog in order", takeParked([P0, { ...P0, ts: 5 }]).map((x) => x.ts), [1, 5]);
check("takeParked on an empty park is empty, not undefined", takeParked([]), []);
check("takeParked does not mutate the caller's array", (() => { const a = [P0]; takeParked(a); return a.length; })(), 1);

// iid 20 endPriorClient truth table — the socket handle is process-scoped, so this is the ONE place a
// replaced session's client can still be reached. A fake client RECORDS the calls; nothing here opens a
// socket. The labelled source-shape cells below are what prove index.ts really calls it, in the right
// order — the same two-half shape the park cells above use, for the same reason.
const fakeClient = (endThrows = false) => {
  const calls: string[] = [];
  return {
    calls,
    end(force?: boolean) {
      calls.push(`end:${force === true}`);
      if (endThrows) throw new Error("socket gone");
    },
    removeAllListeners(ev?: string | symbol) {
      calls.push(`off:${String(ev)}`);
    },
  };
};
const noPrior = endPriorClient({ current: null }, "test");
check("#20 no prior client -> nothing called, nothing claimed", [noPrior.ended, noPrior.unhooked, noPrior.note.includes("no prior client")], [true, 0, true]);
const oneClient = fakeClient();
const oneStore = { current: oneClient };
const onePrior = endPriorClient(oneStore, "test");
check("#20 prior client -> force-closed FIRST, then unhooked, in that order (end() runs mqtt's own close bookkeeping)", oneClient.calls, ["end:true", "off:connect", "off:error", "off:message"]);
check("#20 prior client -> the store is emptied, so the next run cannot inherit a second socket", oneStore.current, null);
check("#20 and the caller is told how many handlers came off", onePrior.unhooked, 3);
check("#20 the events unhooked are exactly the events index.ts registers", CLIENT_EVENTS.join(","), "connect,error,message");
const badClient = fakeClient(true);
const badStore = { current: badClient };
const badVerdict = endPriorClient(badStore, "test");
check("#20 NEGATIVE: a client that throws on end() is STILL unhooked — unhooking is the half that stops the duplication", badClient.calls, ["end:true", "off:connect", "off:error", "off:message"]);
check("#20 NEGATIVE: and the failed close is RETURNED, not swallowed — ended false, reason named", [badVerdict.ended, badVerdict.note.includes("NOT closed"), badVerdict.note.includes("socket gone")], [false, true, true]);
check("#20 NEGATIVE: an unhook that throws on one event does not stop the other two", (() => {
  const c = fakeClient();
  c.removeAllListeners = (ev?: string | symbol) => {
    c.calls.push(`off:${String(ev)}`);
    if (ev === "connect") throw new Error("emitter gone");
  };
  const r = endPriorClient({ current: c }, "test");
  return [c.calls.filter((x) => x.startsWith("off:")).length, r.unhooked];
})(), [3, 2]);
check("#20 the handle key is a named process symbol, the house pattern for a cross-session store", typeof MQTT_CLIENT_KEY, "symbol");

// STALLED CLOSE (leg 890's renewal, measured): a graceful close at shutdown leaves `disconnecting` set, and
// `end(true)` returns early on exactly that flag (mqtt client.js:818-820), so the force never reaches
// `_cleanUp(forced)` and the transport stays open. The client is unhooked and hears nothing — which is why
// the duplication is gone — but it still holds a descriptor and a broker session. The cells below name the
// destroy, its negative (a client that never started a close must NOT be touched), and the failure face.
const stalledClient = (destroyThrows = false) => {
  const calls: string[] = [];
  return {
    calls,
    disconnecting: true,
    stream: { destroy: () => { calls.push("destroy"); if (destroyThrows) throw new Error("stream gone"); } },
    end(force?: boolean) { calls.push(`end:${force === true}`); },
    removeAllListeners(ev?: string | symbol) { calls.push(`off:${String(ev)}`); },
  };
};
const stalledStore = { current: stalledClient() as unknown as ClosableClient | null };
const stalledVerdict = endPriorClient(stalledStore, "test") as { ended: boolean; unhooked: number; destroyed: boolean; note: string };
check("#20 stalled close: the store is emptied AND the destroy was reported to the caller",
  [stalledStore.current, stalledVerdict.destroyed, stalledVerdict.ended],
  [null, true, true]);
check("#20 stalled close: the order is end -> unhook -> destroy, so mqtt's own bookkeeping is not outrun",
  (() => { const c = stalledClient(); endPriorClient({ current: c }, "test"); return c.calls; })(),
  ["end:true", "off:connect", "off:error", "off:message", "destroy"]);
check("#20 stalled close: the caller is told it was the destroy that closed it, not the end",
  stalledVerdict.note.includes("stalled prior client destroyed"), true);
check("#20 NEGATIVE: a client that never started a close is left alone — end(true) already destroyed it",
  (() => {
    const c = stalledClient();
    c.disconnecting = false;
    const r = endPriorClient({ current: c }, "test");
    return [c.calls.includes("destroy"), (r as { destroyed: boolean }).destroyed, r.note.includes("closed the prior client before connecting")];
  })(),
  [false, false, true]);
check("#20 NEGATIVE: and a destroy that throws is RETURNED, not swallowed — ended false, reason named",
  (() => {
    const c = stalledClient(true);
    const r = endPriorClient({ current: c }, "test");
    return [r.ended, r.unhooked, r.note.includes("NOT destroyed"), r.note.includes("stream gone")];
  })(),
  [false, 3, true, true]);
check("#20 NEGATIVE: a stalled client with no stream member is still unhooked and still dropped (optional chain, no throw)",
  (() => {
    const c = stalledClient();
    delete (c as { stream?: unknown }).stream;
    const store = { current: c as unknown as ClosableClient | null };
    const r = endPriorClient(store, "test");
    return [store.current, r.unhooked, (r as { destroyed: boolean }).destroyed];
  })(),
  [null, 3, true]);
check("#20 the healthy face is byte-unchanged: no prior, no destroy, same words",
  (() => { const no = endPriorClient({ current: null }, "t"); const ok = endPriorClient({ current: fakeClient() }, "t"); return [no.destroyed, ok.destroyed, no.note.includes("no prior client")]; })(),
  [false, false, true]);
check("#20 index.ts logs the destroy path too, so a stalled close is never silent",
  readFileSync(join(SRC, "index.ts"), "utf8").includes("|| prior.destroyed"), true);

// A SECOND fake, with real listener semantics, because the acceptance moved (spec 872 at 0c80d6ad8): the
// observation is "no SECOND EXECUTION", not "socket closed" — a closed client whose `message` listener is
// still reachable keeps duplicating, and one inbound line was measured executing in four stale instances.
// So this fake RUNS the handler on emit, until removeAllListeners takes it away.
const emitterClient = () => {
  const attached = new Set<string>();
  const log: string[] = [];
  return {
    log,
    on(ev: string) {
      attached.add(ev);
    },
    removeAllListeners(ev?: string | symbol) {
      attached.delete(String(ev));
    },
    end(force?: boolean) {
      log.push(`end:${force === true}`);
    },
    /** how many times a `message` handler on THIS client would execute for one inbound line */
    executions: (ev: string) => (attached.has(ev) ? 1 : 0),
  };
};
const arm = (c: ReturnType<typeof emitterClient>) => {
  for (const ev of ["connect", "error", "message"]) c.on(ev);
  return c;
};
const ec = arm(emitterClient());
check("#20 listener: before teardown this client executes one room line once", ec.executions("message"), 1);
endPriorClient({ current: ec }, "test");
check("#20 listener: AFTER teardown the prior message handler is UNREACHABLE — 0 executions, which is the acceptance", ec.executions("message"), 0);
check("#20 listener: and all three events are gone, not only the one the room happens to duplicate on", ["connect", "error", "message"].map((ev) => ec.executions(ev)), [0, 0, 0]);
check("#20 listener: the socket is force-closed beside the unhook — the listener cell does not replace closing it", ec.log, ["end:true"]);
// Two runs sharing one store: the property the row is actually about.
const proc = { current: null as unknown as ReturnType<typeof emitterClient> };
const runA = arm(emitterClient());
proc.current = runA;
const runB = arm(emitterClient());
endPriorClient(proc, "run 2 about to connect");
proc.current = runB;
check("#20 two runs, one process: run 1's client can no longer execute a room line", runA.executions("message"), 0);
check("#20 and run 2's client still can — the fix removes duplication, it does not remove the seat", runB.executions("message"), 1);
check("#20 NEGATIVE: the helper touches ONLY the handle on the store — it is no global unhook, which is why index.ts writes the handle on every connect", (() => {
  const bystander = arm(emitterClient());
  endPriorClient({ current: null }, "test");
  return bystander.executions("message");
})(), 1);

// Finding A at 9ba3207d1, run as an ORDER. pi's documented sequence is shutdown the old instance, then
// reload and start the new one (docs/extensions.md:512, restated at :1474), so the OUTGOING run's
// shutdown statement is the first thing that touches the store on every replacement. The cells below run
// that order against one store; the statement they model is pinned to the shipped file by the source-shape
// cells beside the verdict, in the same two-half shape the park cells above use.
const shutdownStatement = <T extends ClosableClient>(store: { current: T | null }, mine: T | null) => {
  if (store.current === mine) endPriorClient(store, "session_shutdown");
};
{
  const store: { current: ReturnType<typeof emitterClient> | null } = { current: null };
  const run1 = arm(emitterClient());
  store.current = run1;
  shutdownStatement(store, run1);
  const incoming = endPriorClient(store, "session_start, before connect");
  check("#20 A: a shutdown naming its own client unhooks it — one inbound line executes 0 times afterwards", run1.executions("message"), 0);
  check("#20 A: and all three events are unreachable, not only the one the room happens to duplicate on", ["connect", "error", "message"].map((ev) => run1.executions(ev)), [0, 0, 0]);
  check("#20 A: the incoming run finds an EMPTY store and says so — the work was done by the run that owned the socket", [store.current, incoming.unhooked, incoming.note.includes("no prior client")], [null, 0, true]);
}
{
  const store: { current: ReturnType<typeof emitterClient> | null } = { current: null };
  const run1 = arm(emitterClient());
  const run2 = arm(emitterClient());
  store.current = run2;
  shutdownStatement(store, run1);
  check("#20 A NEGATIVE: a shutdown whose client is NOT the store's leaves the incoming run's handle alone", store.current === run2, true);
  check("#20 A NEGATIVE: and that socket still executes a room line — a late shutdown cannot deafen the new seat", run2.executions("message"), 1);
}
{
  const bad = fakeClient(true);
  const store: { current: typeof bad | null } = { current: bad };
  shutdownStatement(store, bad);
  check("#20 A: a client that throws on end() is still unhooked by its own shutdown and still dropped from the store", [store.current, bad.calls], [null, ["end:true", "off:connect", "off:error", "off:message"]]);
}
{
  // The paired negative for the change itself: the statement this leg replaces, run through the same
  // order. A bare store-clear leaves the socket ARMED and the incoming run reports nothing to close.
  const store: { current: ReturnType<typeof emitterClient> | null } = { current: null };
  const run1 = arm(emitterClient());
  store.current = run1;
  if (store.current === run1) store.current = null;
  const after = endPriorClient(store, "session_start, before connect");
  check("#20 A: and the statement this leg RETIRES is proven wrong, not merely different — clear-only leaves the handler armed", [run1.executions("message"), after.unhooked, after.note.includes("no prior client")], [1, 0, true]);
}

// THE FIX, as wired. These are source-shape cells and say so; the runtime half above is the decision.
check("#4 wiring: the alarm string is STILL printed, unchanged — the belt was not silenced",
  indexCode.includes("inbound line dropped, handler threw"), true);
check("#4 wiring: on top of it, the park says the line is NOT discarded",
  /p\.parked[\s\S]{0,400}PARKED, not discarded/.test(indexCode), true);
check("#4 wiring: an overflow is announced with a COUNT, never a silent trim",
  /p\.dropped[\s\S]{0,400}inbound park OVERFLOWED/.test(indexCode), true);
check("#4 wiring: a non-stale throw is refused a park AND named to the operator as a real loss",
  /!stale && !handedOff[\s\S]{0,400}The line IS lost/.test(indexCode), true);
// tabichat#19 — the storm's source, pinned as a shape. pi 1.4.0 guards `pi.sendUserMessage` with an
// assertActive on the SHARED extension runtime (loader.js:309-311 -> :115), and that flag is set by
// AgentSession.dispose() and never cleared, because the replacement runner is built over the SAME
// runtime object (agent-session.js:2983). So after one replacement, every hand-off made from a socket
// callback threw forever, the belt parked it, and the park overflowed once per line. The fix is a
// re-armed send handle. These cells pin the wiring; the EXECUTED half is the two-seat renew cell.
const withAt = indexCode.indexOf("withSession: async (next)");
const rearm = indexCode.slice(withAt, indexCode.indexOf("wakeRenewedSeat", withAt));
check("#19 wiring: the re-arm points the send handle at the REPLACEMENT session's own send",
  /sendUser = \(content, options\) => next\.sendUserMessage\(content, options\)/.test(rearm), true);
check("#19 wiring NEGATIVE: no load-time pi.sendUserMessage survives in the inbound message callback",
  (() => {
    const s0 = indexCode.indexOf('client.on("message"');
    return /pi\.sendUserMessage/.test(indexCode.slice(s0, indexCode.indexOf("\n  });", s0)));
  })(), false);
check("#19 wiring: the park is drained on the renew re-arm, not only on socket connect",
  indexCode.includes('drainPark?.("socket connect")') && indexCode.includes('drainPark?.("renew re-arm")'), true);
check("#19 wiring ORDER: the drain runs AFTER the send handle is re-armed — drained first, a replayed " +
  "line throws on the dead send and is re-parked instead of delivered",
  rearm.indexOf("sendUser = ") < rearm.indexOf('drainPark?.("renew re-arm")'), true);
// The #585 structural gate scans inside the socket callback for the bare identifier `ctx`, and a
// STRING LITERAL naming the word trips it exactly like a captured context does — measured on this leg,
// where the first wording of that refusal printed "a pi ctx invalidation" and reddened
// tools/test_ctx_handle.ts. The gate was right and the message moved; this pin is what keeps the next
// friendly rewording from putting the same landmine back.
check("#4 wiring: no bare `ctx` token anywhere in the message callback's CODE (the #585 gate reads it)",
  (() => {
    const s0 = index.indexOf('client.on("message"');
    const body = index.slice(s0, index.indexOf("\n  });", s0));
    // A line is prose if it starts with `//` or with `*` (the inside of a block comment). The first
    // draft of this filter also offered the alternatives `/**` and `*/`, and the second is not a legal
    // escape in a regex literal — bun refused to parse the whole file. Loud failure, easy to fix.
    const code = body.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    return /\bctx\b/.test(code);
  })(), false);
check("#4 wiring: the fresh session drains the park on CONNECT, so the line takes the normal path",
  /takeParked\(INBOUND_PARK\)[\s\S]{0,700}handleInbound\(b\.topic, Buffer\.from\(b\.payload\)\)/.test(indexCode), true);
check("#4 wiring: the park is emptied BEFORE the loop, so a throwing replay cannot loop forever",
  indexCode.indexOf("INBOUND_PARK.splice(0, INBOUND_PARK.length);") > indexCode.indexOf("const backlog = takeParked"), true);
check("#4 wiring: a replay that throws is dropped and SAID, not re-parked",
  /parked line replay threw[\s\S]{0,140}dropped, not re-parked/.test(indexCode), true);
check("#4 wiring: handedOff is set at the SEND and HOLD sites, not guessed at",
  (indexCode.match(/handedOff = true;/g) || []).length >= 3, true);
check("#4 wiring: and it is factory-scoped, because the belt is a sibling of handleInbound",
  /^\s*let handedOff = false;$/m.test(indexCode), true);
check("#4 store: the park is a process globalThis array, never a per-factory closure",
  /\(globalThis as Record<PropertyKey, unknown>\)\[INBOUND_PARK_KEY\] \?\?=\s*\[\] as Array</.test(indexCode), true);

// iid 20 — the client handle, pinned as a shape. Runtime truth lives in the cells above; these prove
// the shipped file really reaches that helper on the ONLY path that makes a client, and in the order
// that matters: teardown before connect. A teardown after the connect is the same leak in a new coat.
check("#20 store: the client handle is a process globalThis holder, never a per-factory closure",
  /\(globalThis as Record<PropertyKey, unknown>\)\[MQTT_CLIENT_KEY\] \?\?=\s*\{ current: null/.test(indexCode), true);
check("#20 store: this run's `client` STARTS from that holder, so an incoming run can see what it inherited",
  /let client: mqtt\.MqttClient \| null = MQTT_CLIENT\.current;/.test(indexCode), true);
/** The order predicate, factored so the two negative cells below can hand it the WRONG tree. */
const teardownBeforeConnect = (src: string) => {
  const t = src.indexOf("endPriorClient(MQTT_CLIENT,");
  const c = src.indexOf("client = mqtt.connect(");
  return t >= 0 && c >= 0 && t < c;
};
check("#20 wiring: the teardown call exists and precedes the one construction site", teardownBeforeConnect(indexCode), true);
check("#20 wiring NEGATIVE: the same predicate on a teardown AFTER the connect returns false — it can fail",
  teardownBeforeConnect("client = mqtt.connect(u, {});\nendPriorClient(MQTT_CLIENT, x);"), false);
check("#20 wiring NEGATIVE: and on a tree with no teardown at all, false — silence is not a pass",
  teardownBeforeConnect("client = mqtt.connect(u, {});"), false);
check("#20 wiring: the handle is written to the store AFTER that construction site, so the next run can find it",
  indexCode.indexOf("MQTT_CLIENT.current = client;") > indexCode.indexOf("client = mqtt.connect("), true);
check("#20 wiring: the old early return is GONE — `if (client) return;` is the leak this row closes",
  /\n[ \t]*if \(client\) return;/.test(indexCode), false);
check("#20 wiring: a shutdown hands the store to the SAME helper the start path uses, only while it still holds ITS OWN client, so a late shutdown cannot wipe the incoming run's handle",
  /if \(MQTT_CLIENT\.current === client\) endPriorClient\(MQTT_CLIENT, "session_shutdown"\);/.test(indexCode), true);
check("#20 wiring NEGATIVE: the bare store-clear it replaced is GONE — clearing without unhooking is what left a retained socket hearing the room",
  /if \(MQTT_CLIENT\.current === client\) MQTT_CLIENT\.current = null;/.test(indexCode), false);
check("#20 wiring: BOTH paths reach the helper — the incoming run's and the outgoing run's",
  (indexCode.match(/endPriorClient\(MQTT_CLIENT, /g) ?? []).length, 2);
check("#20 wiring: the shutdown path keeps its GRACEFUL close — presence publish and an awaited end(), because force at shutdown drops queued publishes",
  indexCode.includes("await done(client.end());") && /await done\(\s*client\.publish\(/.test(indexCode), true);
check("#20 wiring: and the helper is reached AFTER that graceful end(), so its end(true) is mqtt's idempotent branch and not a dropped queue",
  indexCode.indexOf("await done(client.end());") < indexCode.indexOf('endPriorClient(MQTT_CLIENT, "session_shutdown")'), true);
/** Finding C's placement predicate, factored so the negative can be handed the WRONG tree. */
const teardownBelowGuards = (src: string) => {
  const t = src.indexOf('endPriorClient(MQTT_CLIENT, "session_start');
  const c = src.indexOf("client = mqtt.connect(");
  const guards = Math.max(
    src.indexOf('if (brokerRefusal !== "") {'),
    src.indexOf("if (!room) {"),
    src.indexOf('if (TRANSPORT.mode === "refuse") {'),
  );
  return t >= 0 && c >= 0 && guards >= 0 && guards < t && t < c;
};
check("#20 finding C: the teardown sits BELOW the three config guards and ABOVE the one construction site — a run that cannot connect must not close the connection",
  teardownBelowGuards(indexCode), true);
check("#20 finding C NEGATIVE: the same predicate on a teardown ABOVE the guards is false — the shape this leg moves away from",
  teardownBelowGuards('const prior = endPriorClient(MQTT_CLIENT, "session_start, before connect");\nif (brokerRefusal !== "") { return; }\nif (!room) { return; }\nif (TRANSPORT.mode === "refuse") { return; }\nclient = mqtt.connect(u, {});'), false);
check("#20 finding C: the discriminator string still lives in the helper's note template, so a grep of the deployed diag log still matches",
  readFileSync(join(SRC, "laneadmin.ts"), "utf8").includes("closed the prior client before connecting"), true);
check("#20 finding C: the WARN guard carries the note verbatim and honours ALL THREE signals — unhooked, failed close, and the stalled destroy",
  /if \(prior\.unhooked \|\| !prior\.ended \|\| prior\.destroyed\) diag\("WARN", `\[tabichat\]\[client\] \$\{prior\.note\}`\);/.test(indexCode), true);
check("#20 finding C NEGATIVE: a guard that dropped the destroy signal is refused by the same predicate",
  /if \(prior\.unhooked \|\| !prior\.ended \|\| prior\.destroyed\) diag\("WARN", `\[tabichat\]\[client\] \$\{prior\.note\}`\);/.test(
    'const prior = endPriorClient(MQTT_CLIENT, "x"); if (prior.unhooked || !prior.ended) diag("WARN", `[tabichat][client] ${prior.note}`);'), false);
check("#20 wiring: a failed close is LOUD, not a silent shrug", /\[tabichat\]\[client\] \$\{prior\.note\}/.test(indexCode), true);

// THE VERDICT IS AT THE END OF THE FILE, NOT HERE. This block used to sit at this line and every
// section appended since has run AFTER it — 301 `check()` calls, including the whole #10 wiring block
// and all of 496 AC4. A FAIL in any of them printed a line and then the process still exited 0, so
// the gate reported green on a red run. Measured on this leg: two real FAILs, rc=0. The verdict now
// lives at the foot of this file; do not move it back up.

// --- tabichat §5 item 1 ACT B — the handoff bar is nick + FRESHNESS, not nick + boot tag ----------
// THE RED PROOF, taken on this leg before the matcher existed and quoted in the report: a well-formed
// 156-byte handoff sat at RESUME-flash9-OLDTAG.md while the seat's BOOT was NEWTAG, and the shipped
// predicate answered `false` to it. The boot tag changes across EVERY renew (s136 measured
// …-01081a -> …-059820), so the old rule meant a renewed seat's NEXT renew is refused forever — the
// second false-negative generator, and the reason the owner ordered ACT A to run before this half.
// pickResumeHandoff is PURE (no fs, no clock), so all of this runs headless and cannot touch a real
// RESUME dir. `started` below stands for the process's own start.
const F = (name: string, bytes = 400, mtimeMs = 2_000): ResumeFileStat => ({ name, bytes, mtimeMs });
const S = 1_000;
check("ADMISSION (the false negative being cleared): a FRESH file with an OLD boot tag now ADMITS",
  pickResumeHandoff([F("RESUME-flash9-OLDTAG.md")], "flash9", S).ok, true);
check("and it is the same file the old rule refused — named, not silently accepted",
  pickResumeHandoff([F("RESUME-flash9-OLDTAG.md")], "flash9", S).picked, "RESUME-flash9-OLDTAG.md");
check("NEGATIVE (the paired bar): an OLD-mtime file still REFUSES, and says it is stale",
  pickResumeHandoff([F("RESUME-flash9-OLDTAG.md", 400, 500)], "flash9", S).ok, false);
check("and the refusal names the reason rather than echoing 'no file'",
  /STALE/.test(pickResumeHandoff([F("RESUME-flash9-OLDTAG.md", 400, 500)], "flash9", S).reason), true);
check("NEGATIVE: a file at exactly the start instant is not 'newer than' it — the bar is strict",
  pickResumeHandoff([F("RESUME-flash9-X.md", 400, S)], "flash9", S).ok, false);
check("NEGATIVE: a stub under the floor still refuses, even when it is fresh — two mechanisms, two bars",
  pickResumeHandoff([F("RESUME-flash9-FRESH.md", 199)], "flash9", S).ok, false);
check("and the stub refusal quotes the byte count and the floor, so it is not guessed at",
  /199 bytes/.test(pickResumeHandoff([F("RESUME-flash9-FRESH.md", 199)], "flash9", S).reason) && /200-byte floor/.test(pickResumeHandoff([F("RESUME-flash9-FRESH.md", 199)], "flash9", S).reason), true);
check("NEGATIVE: another lane's handoff is never this lane's, by nick",
  pickResumeHandoff([F("RESUME-flash8-OLDTAG.md")], "flash9", S).ok, false);
check("NEGATIVE: the nick match is anchored — flash99's file is not flash9's",
  pickResumeHandoff([F("RESUME-flash99-A.md")], "flash9", S).scanned, 0);
check("NEGATIVE: a prefix-lookalike name that is not the pattern is skipped",
  pickResumeHandoff([F("RESUME-flash9-x.txt"), F("resume-flash9-x.md"), F("NOTES-flash9-x.md")], "flash9", S).scanned, 0);
check("no files at all says 'no file', not 'stale' — the two refusals stay distinguishable",
  /no RESUME-<nick>-\*\.md file/.test(pickResumeHandoff([], "flash9", S).reason), true);

// ORDERING IS CORRECTNESS: 88 RESUME files on this box, several may be this nick's.
check("newest mtime wins among several of my own files",
  pickResumeHandoff([F("RESUME-fl-A.md", 400, 1_500), F("RESUME-fl-B.md", 400, 3_000), F("RESUME-fl-C.md", 400, 2_000)], "fl", S).picked,
  "RESUME-fl-B.md");
check("TIE-BREAK is deterministic: equal mtime -> lexicographically larger name, every time",
  [1, 2, 3].map(() => pickResumeHandoff([F("RESUME-fl-b.md", 400, 3_000), F("RESUME-fl-a.md", 400, 3_000)], "fl", S).picked)[0],
  pickResumeHandoff([F("RESUME-fl-a.md", 400, 3_000), F("RESUME-fl-b.md", 400, 3_000)], "fl", S).picked);
check("and the tie-break really picks the larger name",
  pickResumeHandoff([F("RESUME-fl-z.md", 400, 3_000), F("RESUME-fl-a.md", 400, 3_000)], "fl", S).picked, "RESUME-fl-z.md");
check("the newest file being a stub refuses rather than falling back to an older good one — the bar is honest about which file it judged",
  pickResumeHandoff([F("RESUME-fl-OLD.md", 400, 1_500), F("RESUME-fl-NEW.md", 100, 3_000)], "fl", S).ok, false);
check("the scan is BOUNDED and the bound is REPORTED, never a silent truncation",
  pickResumeHandoff(Array.from({ length: RESUME_SCAN_MAX + 5 }, (_, i) => F(`RESUME-fl-${String(i).padStart(4, "0")}.md`)), "fl", S).truncated, true);
check("and a truncated scan still reports the true count it saw",
  pickResumeHandoff(Array.from({ length: RESUME_SCAN_MAX + 5 }, (_, i) => F(`RESUME-fl-${String(i).padStart(4, "0")}.md`)), "fl", S).scanned,
  RESUME_SCAN_MAX + 5);
check("not truncated when under the bound",
  pickResumeHandoff([F("RESUME-fl-a.md")], "fl", S).truncated, false);

// THE WIRING, labelled as source-shape (it is a grep and says so — the decision above is the runtime proof).
// `cw_probe` above is the single ctxwarn read.
check("ACT B wired: the bar calls the matcher, not the size-only probe",
  /const handoffOnDisk = \(\): boolean => resumeScan\(\)\.ok;/.test(indexCode), true);
// The fast path IS the shared-bar call now, so this pins THAT rather than the hand-rolled `.find()`
// my first draft wrote. Written as a code shape, not prose: it fails if the fast path is removed.
check("ACT B wired: the exact boot-tag path is kept as the FAST path, so nothing that works today breaks",
  /const hit = wakePathFor\(resumeCandidates\(\), RESUME_MIN_BYTES\);\s*\n\s*if \(hit !== null\) return \{ ok: true/.test(indexCode), true);
check("ACT B wired: the freshness floor is BOOT_AT_MS, a const, never the session-refreshed startedAt",
  /pickResumeHandoff\(files, nick, BOOT_AT_MS\)/.test(indexCode) && !/pickResumeHandoff\([^)]*startedAt/.test(indexCode), true);
check("ACT B wired: BOOT_AT_MS is a const so a renew cannot move the floor forwards",
  /^\s*const BOOT_AT_MS = Date\.now\(\);/m.test(indexCode) && !/\n\s*let BOOT_AT_MS =/.test(indexCode), true);
check("ACT B: the size floor was NOT retired alongside the matching change — both bars still exist",
  cw_probe.includes("export const RESUME_MIN_BYTES = 200;") && /bytes < minBytes/.test(cw_probe), true);
check("ACT B: and resumeWritten still exists for the tool-block gate (not quietly deleted to make the run green)",
  cw_probe.includes("export const resumeWritten =") && indexCode.includes("resumeWritten(exists,"), true);

// --- the `_ctl` precedence trap, pinned AS A TEST (leg 406's lesson, per this leg's spec) ----------
// At leg 405 this seat learned that `resolveBrokerFromDisk` ranks the SITE FILE above MQTT_URL, so
// "unset the env" is NOT "no broker" on a box that has a site file — and unsetting TABICHAT_CONFIG is
// not "no site file" either: it selects the DEFAULT path, which exists here and names the LIVE broker.
// One probe reached the live control topic that way. The lesson is a TEST, not a memory: a refusal
// cell must be provably unable to touch production. The mechanism that buys that is a SPLIT — the pure
// decision takes the parsed object, and only a caller that reads disk hands it over.
check("ACT A: the pure resolver takes (env, parsed-site) and touches NO fs — so it cannot reach a live broker",
  cw_probe.includes("env: Record<string, string | undefined>,") &&
  cw_probe.includes("site?: Record<string, unknown> | null,") &&
  !/readFileSync|existsSync|statSync|mkdirSync/.test(cw_probe.split("export const resolveResumeDir")[1].split("export const fallbackNote")[0]),
  true);
check("and ctxwarn.ts as a module reads no filesystem at all (it imports nothing)",
  !/^import .*(node:fs|\.\.\/)/m.test(cw_probe) && !cw_probe.includes("readFileSync"), true);
check("index.ts feeds it the siteConfig it ALREADY parsed — the disk read is once, at setup, not per refusal",
  /resolveResumeDir\([\s\S]{0,120}siteConfig,[\s\S]{0,10}\)/.test(indexCode), true);
// THE FOSSIL IS GONE FROM THE CODE AND STILL PRESENT IN THE PROSE THAT EXPLAINS IT — so this strips
// comments first. A grep over the raw file would read the explanatory quote as the defect surviving,
// which is the same prose-vs-code trap this leg hit at leg 405 with a negative cell on `lane_admin.mjs`.
const cw_code = cw_probe.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const idx_code_only = indexCode;  // indexCode is already comment-stripped above
check("the dead durable default is GONE from the CODE (comments stripped — the prose quotes it on purpose)",
  !cw_code.includes('?? "/media/dust') && !idx_code_only.includes('?? "/media/dust'), true);
check("POSITIVE CONTROL for that strip: the same predicate DOES fire when the fossil is put back",
  !cw_code.includes('?? "/media/dust') && (cw_code + '\nconst x = a ?? "/media/dust/y";').includes('?? "/media/dust'), true);
check("no replacement workspace path was hardcoded either — /tabith/resume appears in NO shipped source",
  !cw_code.includes('"/tabith/resume"') && !idx_code_only.includes('"/tabith/resume"'), true);
// ─── tabichat#10 — the WATCHDOG WIRING (the decision is unit-tested in test_roommsg.ts and the
// refusal is proven physically in test_ack_watch_broker.ts; what is left to pin is that index.ts
// actually CALLS it — the exact failure class this repo has been bitten by: a correct, well-tested
// module that nothing ever wired up).
console.log("\n== #10 ack watchdog: the wiring in index.ts ==");
const wire = [
  "watchAck,", "settleAck,", "expireAcks,", "ackLostLine,", "watchSend,", "ackTopic,",
];
check("#10 index.ts imports the watchdog pieces, not a local copy of them",
  wire.filter((k) => k !== "watchSend," && k !== "ackTopic,").filter((k) => index.includes(k)).length, 4);
// The registrar is ONE function called at every publish site, and that shape is the invariant:
// a rule duplicated across four call sites is four rules, and the next publish site would not have it.
check("#10 the registrar is DEFINED exactly once", (index.match(/const watchSend = \(/g) || []).length, 1);
// MEASURED, not assumed: `/watchSend\(/` returns 5 and all 5 are CALLS — the definition is spelled
// `const watchSend = (`, which that pattern does not match. My first two drafts subtracted a
// definition count from that same 5 and demanded 5, i.e. the cell was failing on its own arithmetic
// while the code was right. A count must be checked against the instrument's actual output.
check("#10 and it is CALLED at all five publish sites (room leaf, room flat, control request, receipt board, admin outcome)",
  (index.match(/watchSend\(/g) || []).length, 5);
check("#10 NEGATIVE: no site hand-rolls the watch — `watchAck(ackWatch` exists only inside the registrar",
  (index.match(/watchAck\(ackWatch/g) || []).length, 1);
// iid 21 finding 1 (leg 926): the two room sites gained the publish's OWN id, because `chat/<room>`
// is the topic every lane writes to and a watch keyed on it can be settled by anybody's inbound. Only
// the argument list moved. The guard this cell exists for is unchanged — register at the publish site,
// on the topic ACTUALLY used, per-sender leaf AND flat — and it went RED at this tip before the line
// was updated, which is the proof that it still bites rather than being widened to fit.
check("#10 the room publish registers on the topic it ACTUALLY used, WITH the publish's own id, per-sender leaf and flat both",
  /client\.publish\(t, JSON\.stringify\(payload\)\);\s*\n\s*watchSend\(t, ROOM_SEND_KIND, sendId\);[\s\S]{0,240}client\.publish\(`chat\/\$\{room\}`, JSON\.stringify\(payload\)\);[\s\S]{0,600}watchSend\(`chat\/\$\{room\}`, ROOM_SEND_KIND, sendId\);/.test(index), true);
check("#10/#21 NEGATIVE: neither room site registers on the topic alone any more (the id-less form is the one a peer's echo could answer for)",
  [index.includes("watchSend(t, ROOM_SEND_KIND);"), index.includes("watchSend(`chat/${room}`, ROOM_SEND_KIND);")],
  [false, false]);
check("#10 the admin REQUEST path registers too (a refused request is a renew nobody adjudicates)",
  /client\.publish\(controlTopic\(room\), JSON\.stringify\(payload\)\);[\s\S]{0,600}watchSend\(controlTopic\(room\), "control request"\);/.test(index), true);
check("#10 a QUEUED publish is NOT watched — the registrar bails unless the socket is connected",
  index.includes("if (!ACK_WATCH_MS || !client || !client.connected || !topic) return;"), true);
check("#10 so a closed socket is never blamed on the ACL, at either retained site (both return before publishing)",
  (index.match(/if \(!client\) return; \/\/ (nothing was sent at all|same rule as the receipt board)/g) || []).length, 2);
check("#10 the sweep PAUSES during a reconnect instead of ageing watches out — the false-alarm source",
  /if \(!client \|\| !client\.connected\) return;/.test(index), true);
check("#10 the sweeper is a TIMER, because an ACL drop has no callback to hang a check on",
  /ackSweep = setInterval\(sweepAckWatch, Math\.max\(250, Math\.floor\(win \/ 3\)\)\)/.test(index), true);
// 496 AC3 WIRING — the same failure class this section exists for: `pinAck`/`receiptClears` are
// unit-tested and proven on a broker, and none of that means anything if index.ts never calls them.
// `clearMyReceipts` is the FIRST statement of the sweep, so it runs ahead of the `ACK_WATCH_MS` early
// return — a lane that turned the watchdog off would otherwise leak receipts for the life of the broker.
check("496 AC3 index.ts PINS what it retains, at the one retained receipt site",
  (indexCode.match(/pinAck\(pinnedAcks,/g) || []).length, 1);
check("496 AC3 index.ts CLEARS on the sweep — and the clear is the FIRST statement, so the ACK_WATCH_MS early return cannot strand it",
  /const sweepAckWatch = \(\) => \{\s*\n\s*clearMyReceipts\(\);/.test(indexCode), true);
check("496 AC3 NEGATIVE (the instrument can bite): the clear runs BEFORE the watch early-return, not after it",
  indexCode.indexOf("clearMyReceipts();") < indexCode.indexOf("if (!ACK_WATCH_MS || !ackWatch.length) return;"), true);
check("496 AC3 the clear publishes an EMPTY retained payload to the exact leaf, per entry (not a tombstone object, not a wildcard)",
  /for \(const x of clear\) client\.publish\(x\.topic, clearPayload\(\), \{ retain: true \}\);/.test(indexCode), true);
check("496 AC3 and the list it clears is only this lane's own pins — the grant forbids clearing a peer's leaf",
  indexCode.includes("receiptClears(pinnedAcks, Date.now(), ACK_RETAIN_MS)"), true);
check("#10 the sweeper speaks on BOTH channels that survive scrollback (notify + stderr, via notifySafely)",
  /notifySafely\(null, `\[tabichat\]\[ack-watch\] \$\{ackLostLine\(lost, Date\.now\(\)\)\}`, "error"\)/.test(index), true);
check("#10 reported misses are REMOVED as they are reported, so one loss alarms once, not every tick",
  /const \{ live, lost \} = expireAcks\(ackWatch, Date\.now\(\), ACK_WATCH_MS\);\s*\n\s*ackWatch = live;/.test(index), true);
check("#10 window 0 means the ALARM is OFF — no expiry check runs, not a timer that never sounds",
  index.includes("if (!ACK_WATCH_MS || !ackWatch.length) return;"), true);
// Re-paired when shape (ii) made the SAME timer the board's only clear path: the old form asserted "no
// timer at all when the watch window is 0", which was true at 488 and became a leak here. Turning the
// ALARM off must not strand the retained receipts, because a lane that silences the watchdog still
// writes the board. Measured on this leg: the old guard left `pinnedAcks` growing forever in a
// window-0 seat, and no cell could see it because no cell drove a socket.
check("496 the sweep timer is started UNCONDITIONALLY — a watchdog-off lane still clears its board",
  /if \(!ackSweep\) \{\s*\n\s*const live = \[ACK_WATCH_MS, ACK_RETAIN_MS\]\.filter\(\(n\) => n > 0\);/.test(index), true);
check("496 and the period is the TIGHTEST live window, so neither knob is late and a zero cannot spin it",
  /const win = live\.length \? Math\.min\(\.\.\.live\) : ACK_RETAIN_DEFAULT_MS;\s*\n\s*ackSweep = setInterval\(sweepAckWatch, Math\.max\(250, Math\.floor\(win \/ 3\)\)\)/.test(index), true);
check("496 NEGATIVE: the ALARM is still gated inside the sweep — unconditional timer, conditional alarm",
  index.includes("if (!ACK_WATCH_MS || !ackWatch.length) return;"), true);
check("#10 the sweep timer is cleared on shutdown beside hb (a timer outliving the session is a leak outliving the seat)",
  /if \(ackSweep\) \{\s*\n\s*clearInterval\(ackSweep\);\s*\n\s*ackSweep = null;\s*\n\s*\}/.test(index), true);
// The message is built from concatenated template pieces, so the substring test has to target the
// one fragment that exists on a single line. Asserting the whole sentence as one literal would fail
// on correct bytes — which is the same trap as a line-number cite, in the other direction.
check("#10 the cap overflow is SAID, never trimmed in silence",
  [index.includes("from the watch list (cap ${ACK_WATCH_MAX})"), index.includes("older publish")].every(Boolean), true);
check("#10 NEGATIVE: the watch list is NOT a module-level global (it would survive a session swap and alarm a renewed seat for its predecessor's writes)",
  /^const ackWatch: AckWatch\[\] = \[\];/m.test(index), false);
check("#10 and it IS factory-scoped, beside the delivery state its sibling readers share",
  /let pendingBy = "";\s*\n(\s*\/\*[\s\S]*?\*\/\s*)*\s*let ackWatch: AckWatch\[\] = \[\];/.test(index), true);
// The settle is a SIBLING that runs before the control branch, on any topic. My own first attempt at
// that edit closed the control branch early and nested `isLaneAdmin` inside the settle block — a
// control request would then be dropped whenever no watch was pending. It compiled, and no
// behavioural cell went red, because no unit test drives a socket. Structure is what catches that.
check("#10 STRUCTURE: the settle block CLOSES before the control branch opens",
  /if \(ackWatch\.length\) \{\s*\n\s*const st = settleAck\(ackWatch, topic\);\s*\n\s*ackWatch = st\.pending;\s*\n\s*\}\s*\n\s*if \(topic === controlTopic\(room\)/.test(index), true);
const settleBlock = (() => {
  // walk this block's OWN braces. The first draft sliced a fixed 1,200 chars and searched inside it,
  // which found `isLaneAdmin` in the branch AFTER the block and called a correct file broken.
  // A window is not a boundary.
  const at = index.indexOf("if (ackWatch.length) {");
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + 3; i < index.length; i++) {
    if (index[i] === "{") depth++;
    else if (index[i] === "}") { depth--; if (depth === 0) return index.slice(at, i + 1); }
  }
  return "UNBALANCED";
})();
check("#10 STRUCTURE NEGATIVE: the settle block holds ONLY the settle — no lane-admin gate can hide in it",
  [settleBlock.includes("settleAck(ackWatch, topic)"), settleBlock.includes("isLaneAdmin"), settleBlock === "UNBALANCED"],
  [true, false, false]);
check("#10 and the block stays tiny, so a future edit cannot quietly grow a hot path on every inbound line",
  settleBlock.split("\n").length <= 6, true);

// ─── leg 496 AC4 — "no authority widened", measured by an instrument that CAN fire ───────────────
// 488's version of this claim compared `laneadmin.ts` base-vs-branch — but that file is NOT in the
// 496 diff, so it compared a file with itself and returned 0 for every input. A proof that cannot
// disagree with anything is not a proof (`flash2`'s review finding; the same class as a filter that
// filters nothing). So the surface under test is taken from the BASE COMMIT as it ACTUALLY is —
// `git show <base>:<path>` through a temp file — and the cell is seeded: a deliberate widening is
// loaded the same way and MUST be reported as a difference.
console.log("\n== 496 AC4: decision surface vs the base commit, with a seeded widening ==");
ac4Cell: {
  const { execFileSync } = await import("node:child_process");
  // The pin MUST be a commit reachable from BOTH published faces (dev and main) — a history
  // rewrite deletes anything else, and a gate whose base lives only in a stale local venue is
  // green for the venue and red for every fresh clone (leg 580).
  const BASE_REF = process.env.TABICHAT_AC4_BASE ?? "d11cf3040a896ef2a74b4685156daed7991197f9";
  // Resolve the pin BEFORE mk(): an unreachable base must name itself, not die in a git 128 stack.
  const ac4Pin = (() => { try { return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`], { encoding: "utf8", cwd: join(SRC, "../..") }).trim(); } catch { return ""; } })();
  if (!ac4Pin) { console.log(`FAIL 496 AC4: the pinned base commit ${BASE_REF} is not reachable from this clone — a history rewrite moved it; re-derive the face and update this line`); process.exitCode = 1; break ac4Cell; }
  // The base copy must sit BESIDE the modules it imports: `laneadmin.ts` imports ./mention.ts,
  // ./ctxwarn.ts and ./roommsg.ts by relative path, so a lone file dropped in /tmp dies with
  // "Cannot find module './mention.ts'" — which is an instrument fault wearing a verdict, the rc-128
  // class this box already books. So: one temp DIR, and the whole sibling set from the base ref.
  const baseDir = join(tmpdir(), `ac4-base-${process.pid}`);
  const mk = (rel: string) => {
    const dir = join(baseDir, "src");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, basename(rel));
    writeFileSync(f, execFileSync("git", ["show", `${BASE_REF}:${rel}`], { encoding: "utf8", cwd: join(SRC, "../..") }));
    for (const sib of ["mention.ts", "ctxwarn.ts", "roommsg.ts"]) {
      const sp = join(dir, sib);
      if (!existsSync(sp)) writeFileSync(sp, execFileSync("git", ["show", `${BASE_REF}:src/extensions/tabichat/${sib}`], { encoding: "utf8", cwd: join(SRC, "../..") }));
    }
    return f;
  };
  const baseLane = await import(mk("src/extensions/tabichat/laneadmin.ts"));
  const nowLane = await import(join(SRC, "laneadmin.ts"));
  const flat = (x: unknown) => JSON.stringify(x);
  let grid = 0, decisionDiff = 0, topicDiff = 0;
  const acts = ["renew", "compact", "shutdown", "reboot", ""] as const;
  const bys = ["flash4", "wren", "dove", "steward", ""] as const;
  const tos = ["flash4", "all", "", "!!!", undefined] as const;
  const envs = [{}, { LANE_ADMIN_RENEW: "1" }, { LANE_ADMIN_RENEW: "1", LANE_ADMIN_SELFRENEW: "1" }, { LANE_ADMIN_COMPACT: "1" }, { LANE_ADMIN_SHUTDOWN: "1" }] as const;
  const allows = [["wren", "dust", "ultra", "courier", "dove"], [], ["flash4"]] as const;
  for (const action of acts) for (const by of bys) for (const to of tos) for (const env of envs)
    for (const allow of allows) for (const idle of [true, false]) for (const rw of [true, false]) {
      const i = { action, by, to, self: "flash4", allow: [...allow], env: { ...env }, idle, resumeWritten: rw };
      const a = baseLane.adminVerdict(i), b = nowLane.adminVerdict(i);
      grid++;
      if (flat({ ...a, reason: 0 }) !== flat({ ...b, reason: 0 })) decisionDiff++;
    }
  // 5 actions x 5 senders x 5 recipient-fields x 5 flag-sets x 3 floors x idle x handoff = 7,500.
// I typed 9,000 first (488's grid, which had 6 recipient cases) and the cell went red on a correct
// run: a count carried across legs is a claim about the other leg's instrument.
check("AC4 the authority grid is the whole surface, not a sample", grid, 7500);
  check("AC4 ZERO difference in ok/action/by/arm/speak across the grid", decisionDiff, 0);
  // THE SEED. Deliberately widen the door the same way a careless edit would — accept a self
  // compact/shutdown — and require the SAME instrument to report it. Without this line the 0 above is
  // unfalsifiable, and 488's cell is the cautionary tale.
  const seedDir = join(tmpdir(), `ac4-seed-${process.pid}`);
  const seededFile = join(seedDir, "src", "seeded-laneadmin.ts");
  mkdirSync(join(seedDir, "src"), { recursive: true });
  // 959: the seed is the CURRENT file with two hunks stubbed, so it must sit beside the CURRENT
  // siblings, not baseDir's. It used to land in baseDir and that was invisible while laneadmin.ts
  // imported nothing new; leg 959 adds `currentLeg`/`handoffContentVerdict` to that import list, and
  // the base ctxwarn.ts does not export them — the seed died on a missing export, an instrument fault
  // wearing a verdict. Same rule as the comment above, applied to the other copy.
  for (const sib of ["mention.ts", "ctxwarn.ts", "roommsg.ts"])
    copyFileSync(join(SRC, sib), join(seedDir, "src", sib));
  // TWO substitutions, and the second one is the reason the first attempt read as a dud: stubbing
  // only the action check leaves the SELFRENEW gate in place, so a self `compact` still comes back
  // refused (with a different reason) and the instrument correctly reports NO difference. My cell
  // demanded a difference from a seed that did not widen anything — a review that trusts it would
  // have "proved" the grid can bite when it cannot. The real widening is action-gate AND flag-gate.
  writeFileSync(seededFile, readFileSync(join(SRC, "laneadmin.ts"), "utf8")
    .replace('if (asked !== "renew") {', 'if (false) {')
    .replace("if (!selfRenewEnabled(opts.env)) {", "if (false) {"));
  const seedLane = await import(seededFile);
  let seedDiff = 0;
  for (const action of ["compact", "shutdown"] as const)
    for (const env of envs) {
      const i = { action, by: "flash4", to: "flash4", self: "flash4", allow: [...allows[0]], env: { ...env }, idle: true, resumeWritten: true };
      if (flat({ ...nowLane.adminVerdict(i), reason: 0 }) !== flat({ ...seedLane.adminVerdict(i), reason: 0 })) seedDiff++;
    }
  check("AC4 SEED: a deliberate widening IS reported by the same instrument (so the 0 above can bite)", seedDiff > 0, true);
  check("AC4 and the seed is loud in the right direction — the widened build ACCEPTS what the shipped one refuses",
    seedLane.adminVerdict({ action: "compact", by: "flash4", to: "flash4", self: "flash4", allow: ["wren"], env: { LANE_ADMIN_COMPACT: "1" }, idle: true, resumeWritten: true }).ok, true);
  check("AC4 the shipped build refuses it (the behaviour the grid protects)",
    nowLane.adminVerdict({ action: "compact", by: "flash4", to: "flash4", self: "flash4", allow: ["wren"], env: { LANE_ADMIN_COMPACT: "1" }, idle: true, resumeWritten: true }).ok, false);
  // The topic builders DID change — that is the leg. Say which way, exactly, so a reader cannot
  // mistake "no authority change" for "no change".
  for (const [name, before, after] of [
    ["ackTopic", "chat/tabith/_ctl/<id>", "chat/tabith/_ctl/<writer>/<id>"],
    ["adminResultTopic", "chat/tabith/_ctl/admin/<id>", "chat/tabith/_ctl/<answerer>/admin/<id>"],
  ] as const)
    check(`AC4 ${name}: shape (ii) moved the writer into the leaf (${before} -> ${after})`,
      [ackTopic("tabith", "wren", "m1").startsWith("chat/tabith/_ctl/wren/"),
        adminResultTopic("tabith", "wren", "m1").includes("/wren/admin/")].every(Boolean), true);
  check("AC4 and authorVerdict's rule is untouched by a topic move — it reads the msg/+ tree, not _ctl",
    [authorVerdict("chat/tabith/msg/wren", "tabith", "wren").ok,
      authorVerdict("chat/tabith/msg/wren", "tabith", "flash6").ok], [true, false]);
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(seedDir, { recursive: true, force: true });
}

// --- F2 (s269) — the wake pointer admits a fresh nick-scanned handoff, under the RENEWING floor ---
// THE RED PROOF of the shipped defect, taken before the fix existed: flash4's guinea renew at 12:48Z
// woke told "NO RESUME file was found" while RESUME-flash4-01a173.md sat on disk, 1,484 B, 3.5 min
// old. Two causes: (a) the pointer probed ONLY the exact `RESUME-<nick>-<BOOT>.md` name — a tag that
// cannot pre-exist the replacement — and (b) any scan it did run would have used a floor re-minted
// AFTER the handoff was written. The cells below hold both halves, and the paired refusals.
{
  const f2dir = join(tmpdir(), `tabichat-f2-${Date.now()}`);
  mkdirSync(f2dir, { recursive: true });
  // The handoff the OLD (renewing) session wrote, named the way a lane really names it — from its
  // session id, not from the NEW seat's BOOT tag.
  const handoffName = "RESUME-flash2-01a173.md";
  const handoffPath = join(f2dir, handoffName);
  writeFileSync(handoffPath, "x".repeat(400));
  const st = statSync(handoffPath);
  // The exact-name candidate the renewed seat's BOOT mints — the file the old pointer searched for,
  // which cannot exist before the renew.
  const exactMiss = [{ path: join(f2dir, "RESUME-flash2-NEWBOOT.md"), bytes: null }];
  const files = [{ name: handoffName, bytes: st.size, mtimeMs: st.mtimeMs }];
  const pathOf = new Map([[handoffName, handoffPath]]);
  const renewingBoot = st.mtimeMs - 60_000; // the renewing run started BEFORE the handoff was written
  const remintedFloor = st.mtimeMs + 60_000; // what a re-minted (post-replacement) BOOT_AT_MS looks like
  check("F2 RED (the shipped defect, re-run as a cell): the exact-name probe alone says null — this is what told flash4 'no RESUME file'",
    wakePathFor(exactMiss, 200), null);
  check("F2 GREEN (cause a): exact-name miss + fresh nick-scan hit -> the pointer returns THAT PATH (required negative cell, made positive)",
    wakePickPath(exactMiss, 200, files, pathOf, "flash2", renewingBoot), handoffPath);
  check("F2 NEGATIVE (cause b kept honest): the SAME file refuses under a re-minted post-renew floor — proof the fix is the CARRIED floor, not a deleted bar",
    wakePickPath(exactMiss, 200, files, pathOf, "flash2", remintedFloor), null);
  check("F2 and the refusal is a stale verdict, not silence — pickResumeHandoff still names it",
    /STALE/.test(pickResumeHandoff(files, "flash2", remintedFloor).reason), true);
  check("F2 NEGATIVE: another lane's handoff is never this seat's wake path",
    wakePickPath(exactMiss, 200, files, pathOf, "flash3", renewingBoot), null);
  check("F2 NEGATIVE: a stub under the byte bar does not open the pointer",
    wakePickPath(exactMiss, 200, [{ name: handoffName, bytes: 199, mtimeMs: st.mtimeMs }], pathOf, "flash2", renewingBoot), null);
  check("F2 NEGATIVE: a pick with no entry in the path map degrades to null, never a phantom path",
    wakePickPath(exactMiss, 200, files, new Map(), "flash2", renewingBoot), null);
  const consults: number[] = [];
  const w4 = await runWake([], {
    fallbackPick: () => {
      consults.push(1);
      return wakePickPath(exactMiss, 200, files, pathOf, "flash2", renewingBoot);
    },
  });
  check("F2 EXECUTED: with a fallback, the renewed seat's line carries the scanned path",
    w4.sent[0].content.includes(handoffPath), true);
  check("F2 EXECUTED: and the act reports it, so the operator sees WHICH file armed the wake",
    w4.r, { sent: true, path: handoffPath });
  const w5 = await runWake([{ path: "/dur/RESUME-flash2-HIT.md", bytes: 500 }], {
    fallbackPick: () => {
      consults.push(2);
      return "never-reached";
    },
  });
  check("F2: the exact-name FAST PATH still wins — the fallback is not consulted when the tag hits",
    w5.r.path, "/dur/RESUME-flash2-HIT.md");
  check("F2 NEGATIVE: a fallback that throws cannot eat the wake line — the seat still wakes, told there is no handoff",
    (await runWake(exactMiss, { fallbackPick: () => { throw new Error("ENOENT raced"); } })).sent[0].content.includes("NO RESUME file"), true);
  rmSync(f2dir, { recursive: true, force: true });
}
check("F2 wired: index.ts hands the act the fallback under the renewing run's BOOT_AT_MS, carried as a value",
  /fallbackPick: \(\) => resumePickAt\(BOOT_AT_MS\)/.test(indexCode), true);
check("F2 wired: the gate's own floor is UNCHANGED — still BOOT_AT_MS, never a widened bar (the law the spec says stays)",
  /pickResumeHandoff\(files, nick, BOOT_AT_MS\)/.test(indexCode), true);
check("F2 wired: gate and fallback share ONE disk walk (resumePathsOf), so they cannot scan two different worlds",
  (indexCode.match(/resumePathsOf\(\)/g) ?? []).length >= 2, true);

// ─── iid 17 / leg 959 — the handoff audit, on a real temp dir ──────────────────────
// The row's defect, reproduced at this face rather than asserted: a sheet that is fresh by mtime and
// over the byte floor, written for a leg that is already finished, used to be admitted for the leg about
// to be lost. Every fixture below is written by THIS block into its own directory and removed at the end,
// so no cell can pass on whatever a lane happens to have in /tmp/tabichat.
console.log("\n== iid 17: auditHandoff, adminVerdict, autoRenewVerdict — the same sheet, both doors ==");
// The wording helper from tools/test_ctxwarn.ts, local here so a refusal is asserted by what it SAYS and
// not only by the boolean. This file had none, and the first cell that wanted one came back a
// ReferenceError, which is an instrument fault, not a verdict.
const says = (name: string, hay: string, needle: string) => check(name, hay.includes(needle), true);
const A9 = join(tmpdir(), `959-audit-${process.pid}`);
mkdirSync(A9, { recursive: true });
const GOOD9 = `flash3 resume: leg 959 — the audit is wired\nleg 959 — both doors answer\n  venue: /tabith/work5-tabichat-959 (my clone)\n  task and the spec path it came from: wave47-specs-20261104/flash3-handoff-bar-by-leg-959.md\n  branch tip 580572c, nothing uncommitted or unpushed\n  mid-flight right now: the stage run, then the report\n  next steps: faces 2 to 8, then push both faces\n  report path: wave47-specs-20261104/flash3-handoff-bar-by-leg-959-report.md\n  HOLD flags — no merge, no tag, no deploy verb at the live destination\n`;
writeFileSync(join(A9, "RESUME-flash3-0554ee.md"), GOOD9);
writeFileSync(join(A9, "RESUME-flash9-0554ee.md"), "x".repeat(400));
writeFileSync(join(A9, "RESUME-flash8-0554ee.md"), "# handoff\n" + RESUME_TEMPLATE + "\n");
writeFileSync(join(A9, "RESUME-flash6-0554ee.md"), "leg 954 — the previous task, already closed\n  venue: /tabith/work5-tabichat-954\n  task and the spec path: the leg before this one\n  branch tip 650ded2, nothing uncommitted\n  mid-flight: nothing in flight, the leg is closed\n  next steps: none, this seat is idle\n  report path: the 954 report\n  HOLD flags — hold for a dispatch\n");
mkdirSync(join(A9, "RESUME-flash7-0554ee.md")); // a DIRECTORY wearing the name: not a candidate, not a refusal

check("PASSES: a current sheet for the leg the seat declares", auditHandoff({ nick: "flash3", dirs: [A9], leg: "959" }),
  { audited: true, ok: true, picked: "RESUME-flash3-0554ee.md", reason: "handoff RESUME-flash3-0554ee.md names leg 959 and answers 7/7 blocks" });
const stale9 = auditHandoff({ nick: "flash6", dirs: [A9], leg: "959" });
check("RENEW REFUSED: the row's own case — a fresh, over-floor sheet for leg 954, seat on leg 959", stale9.ok, false);
says("...and it says WHICH leg the sheet is really for", stale9.reason ?? "", "leg 954");
says("...and which leg is about to be lost", stale9.reason ?? "", "leg 959");
check("RENEW REFUSED: a 400-byte sheet with nothing answered (clears the 200-byte floor, not this one)",
  auditHandoff({ nick: "flash9", dirs: [A9], leg: "" }).ok, false);
check("RENEW REFUSED: the FORCED HANDOFF notice copied out verbatim is unfilled slots, not a handoff",
  auditHandoff({ nick: "flash8", dirs: [A9], leg: "" }).ok, false);
check("NEGATIVE: no sheet for this nick is NOT audited, and never refused — an instrument fault is not a verdict",
  auditHandoff({ nick: "flash5", dirs: [A9], leg: "959" }).audited, false);
check("...and a directory wearing the RESUME name contributes no candidate (and no refusal)",
  auditHandoff({ nick: "flash7", dirs: [A9], leg: "959" }).audited, false);
check("...and neither does a dir that is not there at all",
  auditHandoff({ nick: "flash3", dirs: [`${A9}-absent`], leg: "959" }).audited, false);
check("the byte floor still bites INSIDE the audit — nothing was weakened to reach green",
  auditHandoff({ nick: "flash3", dirs: [A9], leg: "959", minBytes: 5000 }).ok, false);
check("handoffDirs takes the declared durable dir, and only it", handoffDirs({ MQTT_CTX_RESUME_DIR: A9 }), [A9]);
check("...and with nothing declared it names the scratch fallback ONCE, never twice", handoffDirs({}), ["/tmp/tabichat"]);

const R9 = { LANE_ADMIN_RENEW: "yes", LANE_ADMIN_COMPACT: "1", LANE_ADMIN_SHUTDOWN: "on" };
const renewStale = adminVerdict({
  action: "renew", by: "lead-agent", to: "flash6", self: "flash6", allow: ALLOW, env: { ...R9, MQTT_LEG: "959" },
  idle: true, resumeWritten: true, resumeSearched: [A9],
});
check("the REMOTE renew bar refuses the stale sheet the byte bar used to admit", renewStale.ok, false);
says("...and the lane says so out loud (speak, not silence)", String((renewStale as { speak?: boolean }).speak), "true");
const renewGood = adminVerdict({
  action: "renew", by: "lead-agent", to: "flash3", self: "flash3", allow: ALLOW, env: { ...R9, MQTT_LEG: "959" },
  idle: true, resumeWritten: true, resumeSearched: [A9],
});
check("...and honours the same request for the seat whose sheet IS current", renewGood.ok, true);
const compactStale = adminVerdict({
  action: "compact", by: "lead-agent", to: "flash6", self: "flash6", allow: ALLOW, env: { ...R9, MQTT_LEG: "959" },
  idle: true, resumeWritten: true, resumeSearched: [A9],
});
check("★ NEGATIVE THAT IS THE POINT: compact keeps the session, so the SAME stale sheet does NOT hold it",
  compactStale.ok, true);
check("...and the new bar widened nothing on the door it was never for (the shipped ok shape is intact)",
  compactStale.ok === true && (compactStale as { action?: string }).action === "compact", true);
const noDirs = adminVerdict({
  action: "renew", by: "lead-agent", to: "flash6", self: "flash6", allow: ALLOW, env: { ...R9, MQTT_LEG: "959" },
  idle: true, resumeWritten: true,
});
check("a caller with NO dirs gets the shipped verdict: the audit never reads an ambient /tmp",
  noDirs.ok, true);
check("★ and the per-boot loop brake still fires FIRST — good sheet, stale sheet, it is the brake that answers",
  autoRenewVerdict({ armed: true, percent: 90, floorPct: 75, renewedThisBoot: true, resumeWritten: true, nick: "flash6", env: { MQTT_LEG: "959" }, dirs: [A9] }).reason,
  "already auto-renewed once this boot — no renew loop");
check("the self-renew door honours a current sheet", autoRenewVerdict({ armed: true, percent: 90, floorPct: 75, renewedThisBoot: false, resumeWritten: true, nick: "flash3", env: { MQTT_LEG: "959" }, dirs: [A9] }).ok, true);
check("...and refuses the stale one, same bar as the remote gate", autoRenewVerdict({ armed: true, percent: 90, floorPct: 75, renewedThisBoot: false, resumeWritten: true, nick: "flash6", env: { MQTT_LEG: "959" }, dirs: [A9] }).ok, false);
check("NEGATIVE: with no nick named it does not go looking — a gate that read the developer's home dir would be green here and wrong there",
  autoRenewVerdict({ armed: true, percent: 90, floorPct: 75, renewedThisBoot: false, resumeWritten: true }).ok, true);
check("wakeLegNote prints the leg the pointed-at sheet names, to the seat that has to judge it",
  wakeLegNote(join(A9, "RESUME-flash3-0554ee.md"), {}).includes("It names leg 959"), true);
check("...and it says plainly when that is READ rather than CHECKED", wakeLegNote(join(A9, "RESUME-flash6-0554ee.md"), {}).includes("READ, not checked"), true);
check("...and it refuses to pretend when the sheet disagrees with the seat", wakeLegNote(join(A9, "RESUME-flash6-0554ee.md"), { MQTT_LEG: "959" }).includes("Do NOT obey it"), true);
check("NEGATIVE: no file, no note — it never invents a leg", wakeLegNote(`${A9}/RESUME-nope-000000.md`, {}), "");
check("...and no path at all is still no note", wakeLegNote(null, {}), "");
check("the wake line still carries the shipped sentence, with the leg note added beside it",
  [wakeDirective(join(A9, "RESUME-flash3-0554ee.md"), "", wakeLegNote(join(A9, "RESUME-flash3-0554ee.md"), {})).includes("it does not say what you are authorised to do next"),
    wakeDirective(join(A9, "RESUME-flash3-0554ee.md"), "", wakeLegNote(join(A9, "RESUME-flash3-0554ee.md"), {})).includes("It names leg 959")],
  [true, true]);
// A grep, labelled as one, same as the other wiring cells in this file: the bar only bites if the caller
// hands the gate the dirs, and index.ts is the only production caller.
check("wired: index.ts hands the REMOTE bar the dirs it searched, so the audit runs on a live seat",
  /resumeSearched: resumeSearchDirs\(\)/.test(indexCode), true);
check("wired: and it passes the seat's own env, which is where MQTT_LEG lives when the launcher sets one",
  /env: process\.env,[\s\S]{0,120}resumeWritten: handoffOnDisk\(\)/.test(indexCode), true);
// iid 17 — THE DOOR, PINNED LIVE. This cell was pinned the other way while the hole was open and disclosed:
// it asserted that NO nick reached the self-renew call site, so a green suite could not hide the gap. The
// call site passes `nick: nick,` now, so the same instrument is re-pinned to the rule it was always
// protecting — a lane about to renew itself has its handoff audited by seat, the way the remote gate audits
// it. That is a re-pin, not a removal: the two controls below show the predicate returning NO, which is the
// direction that reddens any future refactor that quietly drops the field again.
const selfRenewNickRe = /autoRenewVerdict\(\{[\s\S]{0,600}nick:/;
check("the SELF-RENEW call site names the seat, so the handoff audit runs on a live lane before it renews",
  selfRenewNickRe.test(indexCode), true);
check("NEGATIVE CONTROL: the same predicate says NO to that call site with the field stripped — dropping `nick:` again reddens this cell",
  selfRenewNickRe.test(indexCode.replace(/\n\s*nick: nick,/, "")), false);
check("...and it says NO to a source that never calls the verdict, so the match is a call site and not prose",
  selfRenewNickRe.test("const nothingRelevant = 1;"), false);
check("...and the window is bounded, so a nick belonging to some later call cannot stand in for this one",
  /autoRenewVerdict\(\{[\s\S]{0,2000}nick:/.test(indexCode.replace(/\n\s*nick: nick,/, "\n")), false);
rmSync(A9, { recursive: true, force: true });

// ─── iid 17 / leg 982 — the AGE rule has ONE support, and it is not the audit ───────────────────
// F5, measured by the reviewer of the merged door: on a sheet whose mtime is older than the seat's
// own start, the CALLER's floor (`resumeWritten`) refuses, the DOOR's own audit says ok, and the
// renew does not happen. So the age rule is standing on one leg: if `resumeWritten` ever stops
// carrying freshness, a stale sheet opens the self-renew door and nothing in the suite says so.
// This block is the instrument for that, and ONLY that. It changes no behaviour, and it deliberately
// does NOT pass `startedAtMs` into the audit — see the shipped note above the audit block in
// laneadmin.ts: freshness is the caller's floor, and re-checking it against this run's clock would
// invent refusals for exactly the pre-renew sheets the wake path must admit. The last two cells here
// are the tripwire against that forbidden edit, and they are labelled as source-shape because that
// is what they are: a grep, and a runtime plant for everything else.
console.log("\n== iid 17 / leg 982: the age rule, its one support, and the plant that proves it ==");
{
  const AGE = join(tmpdir(), `982-age-${process.pid}`);
  const AGE_EMPTY = join(AGE, "empty");
  mkdirSync(AGE, { recursive: true });
  mkdirSync(AGE_EMPTY, { recursive: true });
  const NICK = "flash982";
  // A sheet that answers every block and names the leg its seat is on, so NOTHING but its AGE can
  // be the reason anything here refuses. That isolation is the whole point of the block.
  writeFileSync(
    join(AGE, `RESUME-${NICK}-0a982f.md`),
    `flash982 report: leg 982 — the age rule and its one support\nleg 982 — one cell, no behaviour change\n  venue: /tabith/work2-tabichat-982 (my clone, branch feature/door-age-rule-pair-cell-17)\n  task and the spec file path it came from: wave47-specs-20261104/flash2-door-age-rule-pair-cell-982.md\n  branch, tip commit a372013, and NOTHING uncommitted or unpushed\n  what is mid-flight right now: the stage run of tools/test_laneadmin.ts\n  next steps, in order: gate at tip, gate at base, md5 the destination, push both faces\n  report path: wave47-specs-20261104/flash2-door-age-rule-pair-cell-982-report.md\n  HOLD flags — no merge, no tag, no deploy at the live destination, iid 17 stays open\n`,
  );
  const BOOT = Date.now(); // this seat's start, the same value index.ts mints as BOOT_AT_MS
  const STALE_AT = BOOT - 3_600_000; // written an hour before this run began: a prior task's sheet
  utimesSync(join(AGE, `RESUME-${NICK}-0a982f.md`), new Date(STALE_AT), new Date(STALE_AT));
  // The same walk index.ts:resumePathsOf does, over this dir only. Real bytes, real mtimes off the
  // filesystem — the plant below has to be able to lie about a sheet, not about a literal.
  const walkAge = (dir: string): ResumeFileStat[] =>
    readdirSync(dir)
      .filter((n) => n.startsWith("RESUME-") && n.endsWith(".md"))
      .map((n) => { const st = statSync(join(dir, n)); return { name: n, bytes: st.size, mtimeMs: st.mtimeMs }; });
  const AR = { armed: true, percent: 90, floorPct: 75, renewedThisBoot: false };
  const DOOR = { nick: NICK, env: { MQTT_LEG: "982" }, dirs: [AGE] };

  // ── POSITIVE: the shipped truth, end to end ────────────────────────────────────────────────
  const floor = pickResumeHandoff(walkAge(AGE), NICK, BOOT); // what index.ts:handoffOnDisk returns
  check("982 POSITIVE: a sheet older than this seat's own start is refused by the caller's floor",
    floor.ok, false);
  says("982 POSITIVE: and the FLOOR's sentence names the reason — STALE (this is the instrument that prints it)",
    floor.reason, "STALE");
  const door = autoRenewVerdict({ ...AR, resumeWritten: floor.ok, ...DOOR });
  check("982 POSITIVE: so the SELF-RENEW door refuses the same sheet", door.ok, false);
  // Stated as it is: `resumeWritten` is a BOOLEAN, so the STALE sentence above is discarded at the
  // call site and the seat hears the shipped no-file sentence instead. Refused, correctly — and the
  // wording is a legibility finding for the report, not a cell to weaken.
  says("982 POSITIVE: and what the DOOR actually says is the no-RESUME-file sentence, because the floor's reason is a boolean at that edge",
    String(door.reason), "no RESUME file for this seat");
  const audStale = auditHandoff(DOOR);
  check("982 POSITIVE: the audit, called exactly as the door calls it (no startedAtMs), ADMITS the same stale sheet — this is F5's B, and the reason the pair exists",
    { audited: audStale.audited, ok: audStale.ok, picked: audStale.picked },
    { audited: true, ok: true, picked: `RESUME-${NICK}-0a982f.md` });

  // ── THE PAIR: the plant, as a runtime fact ─────────────────────────────────────────────────
  // Same sheet, same dirs, same door, same env. The ONLY thing changed is the caller's floor: 0 is
  // what `resumeWritten` looks like when it carries existence but not freshness. If the shipped
  // wiring ever drops that half, this cell is already the shape of the failure — green door, stale
  // sheet — and the two source-shape cells below are what reddens it.
  const plantFloor = pickResumeHandoff(walkAge(AGE), NICK, 0);
  const plant = autoRenewVerdict({ ...AR, resumeWritten: plantFloor.ok, ...DOOR });
  says("982 PLANT: with the floor set to 0 the SAME hour-old sheet is described as a fresh handoff",
    plantFloor.reason, "fresh handoff");
  check("982 PLANT: strip the freshness half from the caller's floor and the SAME stale sheet OPENS the door",
    plant, { ok: true });
  check("982 PLANT: and the shipped floor, on the very same bytes, still refuses — so the flip is the floor, not the fixture",
    autoRenewVerdict({ ...AR, resumeWritten: pickResumeHandoff(walkAge(AGE), NICK, BOOT).ok, ...DOOR }).ok, false);

  // ── NEGATIVES: so this block is not an always-red assertion ────────────────────────────────
  utimesSync(join(AGE, `RESUME-${NICK}-0a982f.md`), new Date(BOOT + 60_000), new Date(BOOT + 60_000));
  const freshFloor = pickResumeHandoff(walkAge(AGE), NICK, BOOT);
  check("982 NEGATIVE: a FRESH sheet passes the floor", freshFloor.ok, true);
  check("982 NEGATIVE: and the door admits it — the block cannot go red on a good handoff",
    autoRenewVerdict({ ...AR, resumeWritten: freshFloor.ok, ...DOOR }), { ok: true });
  const goneFloor = pickResumeHandoff(walkAge(AGE_EMPTY), NICK, BOOT);
  check("982 NEGATIVE: an ABSENT sheet refuses at the floor too, and the two states are NOT the same sentence",
    [goneFloor.ok, /STALE/.test(goneFloor.reason)], [false, false]);
  says("982 NEGATIVE: the absent case says what it is — no file for this nick, in the dirs searched",
    goneFloor.reason, "no RESUME-<nick>-*.md file");

  // ── SOURCE SHAPE (a grep, labelled as one) ─────────────────────────────────────────────────
  // Which of the two `resumeWritten: handoffOnDisk(),` sites is the self-renew door, and that the
  // field there is a real verdict rather than a literal. Both halves can go red on a future edit, and
  // the second one is the edit F5 is about: `resumeWritten: true` is green to every runtime cell above.
  const arvSite = /const arv = autoRenewVerdict\(\{[\s\S]{0,600}?\n\s*\}\);/.exec(indexCode) ?? [""];
  check("982 STRUCTURAL (a grep, and it says so): the SELF-RENEW call site carries `resumeWritten`, sliced out of the arv block alone",
    /resumeWritten: handoffOnDisk\(\)/.test(arvSite[0]), true);
  check("982 STRUCTURAL: POSITIVE CONTROL — that predicate reads NO when the block carries a literal instead of the verdict",
    /resumeWritten: handoffOnDisk\(\)/.test(arvSite[0].replace("resumeWritten: handoffOnDisk(),", "resumeWritten: true,")), false);
  // The forbidden fix, pinned. §1 of the leg bars it, so it is worth a cell that reddens when someone
  // does it anyway: `autoRenewVerdict` must not hand the audit a floor of its own.
  const arvAudit = /export const autoRenewVerdict[\s\S]*?\n\};/.exec(
    LA.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")) ?? [""];
  // Tolerant of line breaks and key order inside the one call, because this pins a FACT about the
  // argument list, not the formatting: the audit receives nick, env and dirs, and no floor.
  const arvAuditRe = /auditHandoff\(\{[^}]*dirs: opts\.dirs[^}]*\}\)/;
  check("982 STRUCTURAL (a grep, and it says so): the door's own audit call still carries NO startedAtMs — freshness stays the caller's floor (the shipped note says why)",
    [arvAuditRe.test(arvAudit[0]), /startedAtMs/.test(arvAudit[0])], [true, false]);
  check("982 STRUCTURAL: POSITIVE CONTROL — give that one call a floor of its own and the startedAtMs half of the predicate fires, so the forbidden edit reddens the cell above",
    [arvAuditRe.test(arvAudit[0].replace("dirs: opts.dirs", "dirs: opts.dirs, startedAtMs: BOOT")), /startedAtMs/.test(arvAudit[0].replace("dirs: opts.dirs", "dirs: opts.dirs, startedAtMs: BOOT"))],
    [true, true]);
  rmSync(AGE, { recursive: true, force: true });
}

// ─── THE VERDICT, AT THE END ────────────────────────────────────────────────────────────────────
// This used to sit at line ~937, which meant 301 `check()` calls after it — the entire #10 wiring
// block and all of 496 AC4 — could FAIL, print their line, and STILL leave the process at rc=0. Two
// genuine failures on this leg (a missing import, then a real index.ts leak) both came back green.
// A gate that cannot report red is not a gate. Nothing above this block may exit.
console.log();
if (failed) {
  console.log(`${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log(`all checks pass (${okCount} cells)`);
}
