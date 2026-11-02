// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for steered delivery.
//   bun tools/test_steer.ts      (exit 1 on any failure)
//
// The rule: an @-mention that lands while the addressee is mid-run queues behind its WHOLE run
// (the shipped behaviour, and still the DEFAULT). A sender who is adding something that changes
// what that lane should be doing may ask for it to steer instead — enter at the lane's next
// tool-result boundary. Honour is limited to the lead and the owner, and a lane that is idle has
// nothing to interrupt.
//
// Every rule below gets the case that must pass AND the case that must be rejected: an
// implementation that always answered "steer", or always "followUp", fails here rather than
// shipping a lane that misses its addenda (or one that gets yanked out of every task).
import { readFileSync } from "node:fs";
import { join } from "node:path";

// TEST-ENV SENTRY (leg 540). These checks assert the DEFAULT lead nick, but `LEAD_NICK` is computed
// once at module load in ctxwarn.ts, so a seat whose shell exports MQTT_LEAD_NICK (every lead launch
// line does) made 9 honest checks read RED with nothing wrong in the product. A static `import` is
// hoisted above every statement in this file, so deleting the vars in the body cannot help — the
// module-under-test is imported dynamically BELOW the scrub instead. No respawn and no process.exit:
// `bun test` runs files in one process, and an exit here silently deletes the later file from the run.
delete process.env.MQTT_LEAD_NICK;
delete process.env.MQTT_OWNER_NICK;
const {
  deliveryClass,
  parseSteerNicks,
  steerHeader,
  steerNote,
  STEER_NICKS_ENV,
  STEER_TAG,
  wantsSteer,
} = await import("../extensions/tabichat/steer.ts");

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
const says = (name: string, hay: string, needle: string) =>
  check(name, hay.includes(needle), true);
const never = (name: string, hay: string, needle: string) =>
  check(name, hay.includes(needle), false);

// --- who may interrupt ----------------------------------------------------------------------
check("env var name is the documented one", STEER_NICKS_ENV, "MQTT_STEER_NICKS");
check("floor is lead + owner", parseSteerNicks(undefined, "owner"), ["lead-agent", "owner"]);
check("owner nick is taken as given", parseSteerNicks(undefined, "ops"), ["lead-agent", "ops"]);
check("configured list ADDS, it does not replace", parseSteerNicks("flash1, flash2", "owner"),
  ["lead-agent", "owner", "flash1", "flash2"]);
check("a configured list cannot drop the lead", parseSteerNicks("flash1", "owner").includes("lead-agent"), true);
check("space-separated works", parseSteerNicks("flash1 flash2", "owner"), ["lead-agent", "owner", "flash1", "flash2"]);
check("duplicates collapse", parseSteerNicks("lead-agent owner lead-agent", "owner"), ["lead-agent", "owner"]);
check("blanks are dropped", parseSteerNicks(" , ,, ", "owner"), ["lead-agent", "owner"]);
check("null env is not a crash", parseSteerNicks(null, "owner"), ["lead-agent", "owner"]);
check("a blank owner nick leaves the lead alone", parseSteerNicks(undefined, "  "), ["lead-agent"]);

// --- the flag itself: only a true true is a request -----------------------------------------
check("steer true asks", wantsSteer({ steer: true }), true);
check("steer false does not ask", wantsSteer({ steer: false }), false);
check("absent flag does not ask", wantsSteer({}), false);
check('a string "true" does NOT buy an interrupt', wantsSteer({ steer: "true" }), false);
check("1 does NOT buy an interrupt", wantsSteer({ steer: 1 }), false);
check("null payload is not a crash", wantsSteer(null), false);
check("undefined payload is not a crash", wantsSteer(undefined), false);

// --- the decision table ---------------------------------------------------------------------
const ALLOW = ["lead-agent", "owner"];
// the half that protects the default: everything except the exact combination queues
check("idle + flag = a normal turn (nothing to interrupt)",
  deliveryClass({ idle: true, sender: "lead-agent", flag: true, allow: ALLOW }), "turn");
check("idle + no flag = a normal turn",
  deliveryClass({ idle: true, sender: "lead-agent", flag: false, allow: ALLOW }), "turn");
check("busy + flag + lead = steer",
  deliveryClass({ idle: false, sender: "lead-agent", flag: true, allow: ALLOW }), "steer");
check("busy + flag + owner = steer",
  deliveryClass({ idle: false, sender: "owner", flag: true, allow: ALLOW }), "steer");
check("busy + flag + a worker = follow-up",
  deliveryClass({ idle: false, sender: "flash1", flag: true, allow: ALLOW }), "followUp");
check("busy + NO flag + lead = follow-up (the default is untouched)",
  deliveryClass({ idle: false, sender: "lead-agent", flag: false, allow: ALLOW }), "followUp");
check("busy + flag + empty allowlist = follow-up",
  deliveryClass({ idle: false, sender: "lead-agent", flag: true, allow: [] }), "followUp");
check("an allowlist entry must match exactly",
  deliveryClass({ idle: false, sender: "Lead-Agent", flag: true, allow: ALLOW }), "followUp");
check("an added nick is honoured",
  deliveryClass({ idle: false, sender: "flash1", flag: true, allow: parseSteerNicks("flash1", "owner") }), "steer");

// --- what the interrupted lane is told ------------------------------------------------------
const head = steerHeader("lead-agent");
check("header carries the compounded tag first", head.startsWith(STEER_TAG), true);
check("tag is product-first", STEER_TAG, "[tabichat][steer]");
says("header names the sender", head, "lead-agent");
says("header tells the lane to re-plan", head, "re-plan");
never("header never claims the lane already changed course", head, "has stopped");
never("retired transport tag never appears", head, "[mqtt]");

// --- what the sender is told ----------------------------------------------------------------
check("no request, no note", steerNote({ requested: false, honoured: false, allow: ALLOW }), "");
const honouredNote = steerNote({ requested: true, honoured: true, allow: ALLOW });
says("honoured note states the request", honouredNote, "steer requested");
never("honoured note never claims delivery", honouredNote, "was delivered");
says("honoured note states the boundary", honouredNote, "tool-result");
const refusedNote = steerNote({ requested: true, honoured: false, allow: ALLOW });
says("refused note says it was not honoured", refusedNote, "NOT honoured");
says("refused note names who may", refusedNote, "lead-agent");
says("refused note says it queues", refusedNote, "queues");

// --- LEAD_NICK: the environment path, both halves (2026-10-09) ------------------------------------
// Why this section exists: one constant decides BOTH who receives a lane's context alarm and who is
// allowed to interrupt a busy lane. It used to be a hard-coded literal, so a venue that renamed its lead
// got a silent double failure — alarms addressed to a nick no seat publishes, and the real lead's
// `steer: true` lines degraded to queued-behind-the-whole-run with no error anywhere. Mutation check:
// replacing `process.env.MQTT_LEAD_NICK ?? "lead-agent"` with a literal fails the second line below.
// The value is computed at module import, so each case needs its own process.
const leadCase = (env: Record<string, string | undefined>) => {
  const r = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const c = await import(${JSON.stringify(join(import.meta.dir, "..", "extensions", "tabichat", "ctxwarn.ts"))});
       const s = await import(${JSON.stringify(join(import.meta.dir, "..", "extensions", "tabichat", "steer.ts"))});
       console.log(JSON.stringify([c.LEAD_NICK, s.parseSteerNicks(undefined, "owner")]));`,
    ],
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: "pipe",
  });
  return JSON.parse(r.stdout.toString());
};
check(
  "no env => the documented default, and the floor built from it",
  leadCase({ MQTT_LEAD_NICK: undefined }),
  ["lead-agent", ["lead-agent", "owner"]],
);
check(
  "MQTT_LEAD_NICK retargets the lead AND the honoured floor together",
  leadCase({ MQTT_LEAD_NICK: "wren" }),
  ["wren", ["wren", "owner"]],
);
// NEGATIVE HALF: a blank value in a launch line must NOT leave the lead out of the floor. Measured
// against the plain `?? "lead-agent"` form, `MQTT_LEAD_NICK=` produced LEAD_NICK "" and a floor of
// ["owner"] — no lead, no alarm target, no steering, nothing printed. The fallback is the fix.
check(
  "a renamed lead drops the old name from the floor",
  leadCase({ MQTT_LEAD_NICK: "wren" })[1].includes("lead-agent"),
  false,
);
check(
  "MQTT_LEAD_NICK= (blank launch-line typo) falls back to the default",
  leadCase({ MQTT_LEAD_NICK: "" }),
  ["lead-agent", ["lead-agent", "owner"]],
);
check(
  "MQTT_LEAD_NICK='   ' (whitespace typo) falls back too",
  leadCase({ MQTT_LEAD_NICK: "   " }),
  ["lead-agent", ["lead-agent", "owner"]],
);

// --- the wiring in index.ts (static, greppable facts) ---------------------------------------
const DIR = join(import.meta.dir, "..", "extensions", "tabichat");
const index = readFileSync(join(DIR, "index.ts"), "utf8");
// RE-PAIRED 2026-10-18 (lead pen, owner word "fix it"), NOT weakened. The recipient-field leg
// (feature/structured-recipient-field-routing-s127 @ 7560af8) moved the steer literal OUT of
// index.ts into `roomPayload()` in roommsg.ts, so the flag now has ONE builder and one home. Two
// of the cells below used to grep index.ts for that literal and read 0 while the behaviour was
// intact -- proven intact by calling the moved function: roomPayload's output is byte-identical to
// the old inline spread for steer=true, for steer=false, and for the fieldless case. The invariant
// the old cells were reaching for is "the flag goes on the wire in exactly one place", and the
// move makes that statable ACROSS FILES, which is TIGHTER than one-file-only ever was: index.ts may
// no longer build the literal itself, and exactly one occurrence may exist in the whole deployed
// set. A second publisher -- in either file -- fails here rather than shipping.
const roommsg = readFileSync(join(DIR, "roommsg.ts"), "utf8");
says("chat_post declares the steer parameter", index, "steer: Type.Optional(");
says("the parameter is a boolean", index, "Type.Boolean({");
says("the tool description teaches the option", index, "set steer true");
says("the description names the cost", index, "queues behind its whole");
// the ask still reaches the wire from the chat_post handler -- by handing it to the ONE builder.
says("chat_post hands its steer ask to roomPayload", index, "publishRoom(roomPayload({ nick, message: text, id, ts: Date.now(), to, steer: asked })");
says("the payload builder still puts the flag on the wire", roommsg, "...(o.steer === true ? { steer: true } : {})");
says("the receiver reads the flag", index, "wantsSteer(msg)");
says("the receiver asks the decision function", index, "deliveryClass({");
says("a steered line carries the header", index, "steerHeader(from)");
says("the sender gets the honesty note", index, "steerNote({");
says("the allowlist is built once at setup", index, "parseSteerNicks(");
// the shipped behaviour must not be reachable by an UNCONDITIONAL literal any more: the class
// decides the main delivery path. RE-PAIRED 2026-10-09 (option B), not weakened: the old check
// said "zero occurrences anywhere", which is now false for one good reason — mentionq.ts keeps
// exactly ONE deliberate follow-up literal, the session_shutdown safety valve, and it exists so a
// held mention can never be discarded when a seat dies. The HOLD_MAX overflow needs NO literal:
// `holdDecision` refuses to answer "hold" at the cap, so overflow rides the class-decided path.
// Stated as an exact count, therefore: the valve is the only literal, it is labelled, and the main
// path stays class-decided. A second literal appearing later fails here rather than shipping.
const followUpLiterals = index.split('deliverAs: "followUp"').length - 1;
check(
  "exactly one intentional option-B follow-up literal survives (the shutdown valve)",
  followUpLiterals,
  1,
);
says(
  "the main delivery path is still class-decided",
  index,
  // tabichat#19: the send moved from the load-time `pi` API to the re-armed `sendUser` handle, so
  // the pinned shape names the handle now. The class still decides it — that is what this pins.
  "sendUser(plan.body, { deliverAs: cls })",
);
says(
  "the cap is enforced in the DECISION, so overflow needs no second literal",
  index,
  "alreadyHeld: heldCount()",
);
says("the shutdown valve is labelled as a valve", index, "returning them to the normal queue");
check("the unconditional isIdle branch is gone", index.includes("if (ctx.isIdle()) pi.sendUserMessage(body);"), false);
// ruling: this is a lead mechanism, not a human command — /say stays as it was
check("no /steer command was registered", /registerCommand\(\s*"steer"/.test(index), false);
// ACROSS THE WHOLE DEPLOYED SET now, not inside one file: exactly one publisher of the flag.
const WIRE_SET = [
  "mention.ts", "ctxwarn.ts", "errnote.ts", "exitlog.ts", "roommsg.ts",
  "mentionq.ts", "laneadmin.ts", "steer.ts", "index.ts",
];
const steerLiteralTotal = WIRE_SET
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .reduce((n, src) => n + (src.split("{ steer: true }").length - 1), 0);
check("the flag is built in exactly one place across the deployed set", steerLiteralTotal, 1);
// NEGATIVE HALF: index.ts must not build it a second time -- it delegates to roomPayload.
check("index.ts builds no steer literal itself (single builder holds)",
  index.split("{ steer: true }").length - 1, 0);
const sayBlock = index.slice(index.indexOf('registerCommand("say"'), index.indexOf('registerCommand("room"'));
check("/say publishes no steer flag", sayBlock.includes("steer"), false);

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nall checks pass");
}
