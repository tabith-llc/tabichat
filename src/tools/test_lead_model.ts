// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the tabith/* virtual-model router and its <ROLE>_THINKING knob.
//   bun src/tools/test_lead_model.ts   (exit 1 on any failure)
// Runs the real extension against a stub ExtensionAPI: no pi, no network.
// Both halves required: the knob working, and the pinned defaults surviving
// untouched when no knob is set.
import register from "../extensions/tabichat-lead-model/index.ts";

type Reg = {
	id: string;
	thinkingLevels: string[];
	contextWindow: number;
	route: (r: unknown, c: unknown) => { model: unknown; thinkingLevel: string };
};

// Start a seat: clear every knob, set the given env, capture what registers.
function seat(env: Record<string, string>) {
	for (const k of Object.keys(process.env)) if (/_THINKING$/.test(k)) delete process.env[k];
	Object.assign(process.env, env);
	const regs: Reg[] = [];
	const ctx = { modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) } };
	(register as unknown as (pi: unknown) => void)({
		registerVirtualModel: (d: Reg) => regs.push(d),
	});
	return {
		ctx,
		regs,
		offered: (id: string) => regs.find((r) => r.id === id)!.thinkingLevels.join(","),
		dispatched: (id: string) => {
			try {
				return regs.find((r) => r.id === id)!.route({}, ctx).thinkingLevel;
			} catch (e) {
				return `THREW: ${(e as Error).message}`;
			}
		},
	};
}

const BASE = {
	LEAD_MODEL: "opencode/qwen3.8-flash",
	WORKER_V1_MODEL: "opencode/qwen3.8-flash",
	WORKER_V2_MODEL: "openrouter/qwen/qwen3.8-flash",
	ULTRA_MODEL: "oregon/Qwen3.8-Flash-Next-Dynamic-oQ5e-BF16-PLE-mtp",
	AJAX_MODEL: "oregon/Qwen3.8-Flash-Next-Dynamic-oQ5e-BF16-PLE-mtp",
	AJAX_CTX_WINDOW: "131072",
};

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
	const ok = String(got) === String(want);
	if (!ok) fails++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: got=${got} want=${want}`);
}

// No knob set: every role keeps the level pinned in the extension.
let s = seat(BASE);
check("no knob: lead offered", s.offered("lead-xhigh"), "xhigh");
check("no knob: lead dispatched", s.dispatched("lead-xhigh"), "xhigh");
// THE LEGACY ALIAS HALF (rename 2026-10-09): `tabith/lead-agent` must STILL resolve, at the same
// level, off the same env stem -- so no alias, seat or hand-typed launch that still carries the old
// name strands mid-rename. Dropping the old id is a deliberate later step, never an accident.
check("legacy alias offered", s.offered("lead-agent"), "xhigh");
check("legacy alias dispatched", s.dispatched("lead-agent"), "xhigh");
check("no knob: ultra offered", s.offered("ultra"), "off");
check("no knob: ultra dispatched", s.dispatched("ultra"), "off");
check("no knob: worker-v1 dispatched", s.dispatched("worker-v1"), "medium");
check("no knob: worker-v2 dispatched", s.dispatched("worker-v2"), "high");
check("no knob: ajax dispatched", s.dispatched("ajax"), "medium");
check("ajax ctx override still read", s.regs.find((r) => r.id === "ajax")!.contextWindow, 131072);
check("ultra ctx default", s.regs.find((r) => r.id === "ultra")!.contextWindow, 262144);
check(
	"ultra routes to its model",
	JSON.stringify(s.regs.find((r) => r.id === "ultra")!.route({}, s.ctx).model),
	JSON.stringify({ provider: "oregon", id: "Qwen3.8-Flash-Next-Dynamic-oQ5e-BF16-PLE-mtp" }),
);

// Knob set: that role moves, no other role does.
s = seat({ ...BASE, ULTRA_THINKING: "high" });
check("ULTRA_THINKING offered", s.offered("ultra"), "high");
check("ULTRA_THINKING dispatched", s.dispatched("ultra"), "high");
check("lead untouched by another role's knob", s.dispatched("lead-xhigh"), "xhigh");
check("ajax untouched by another role's knob", s.dispatched("ajax"), "medium");
s = seat({ ...BASE, LEAD_THINKING: "low", WORKER_V1_THINKING: "max" });
check("LEAD_THINKING dispatched", s.dispatched("lead-xhigh"), "low");
check("WORKER_V1_THINKING dispatched", s.dispatched("worker-v1"), "max");
check("ultra still pinned while others move", s.dispatched("ultra"), "off");

// A value outside the list stops that role and names the variable.
s = seat({ ...BASE, ULTRA_THINKING: "sideways" });
check("bad value: offered stays the pin", s.offered("ultra"), "off");
check(
	"bad value: requests stop with a named variable",
	/^THREW: tabith\/ultra: ULTRA_THINKING="sideways" is not a thinking level/.test(s.dispatched("ultra")),
	true,
);
check("bad value in one role does not stop another", s.dispatched("lead-xhigh"), "xhigh");

// Empty is treated as unset, and a bad model id still errors as before.
s = seat({ ...BASE, ULTRA_THINKING: "" });
check("empty knob falls back to the pin", s.dispatched("ultra"), "off");
s = seat({ ...BASE, ULTRA_MODEL: "not-a-provider-model" });
check("bad model id still throws", /^THREW: tabith\/ultra: ULTRA_MODEL=/.test(s.dispatched("ultra")), true);

console.log(fails === 0 ? "ALL GREEN" : `${fails} FAILURES`);
process.exitCode = fails === 0 ? 0 : 1;
