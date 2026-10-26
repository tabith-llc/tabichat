// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * fs-gate — ask the owner before a lane touches anything outside its working directory.
 *
 * pi 1.0.3 has no built-in approval prompt: docs/security.md states that pi
 * "does not ask for approval before every tool call", and that the working
 * folder "does not prevent commands from accessing other paths available to
 * the Pi process". The `tool_call` event is the seam — it can block a call
 * before the tool runs, with a reason the model reads.
 *
 * Scope, stated plainly:
 * - read/write/edit/grep/find/ls name a path, so those calls are gated on the
 *   resolved path (symlinks resolved, `..` folded).
 * - bash/powershell carry a command string. Tokens that look like paths are
 *   gated. That is a DETECTOR: `python -c 'open(...)'` and any program opening
 *   a file itself never names it on the command line, so it stays unseen. For
 *   a hard wall around commands use OS sandboxing (see pi's
 *   examples/extensions/sandbox), not this file.
 *
 * Config (all optional): ~/.pi/agent/fs-gate.json
 *   { "enabled": true, "scope": "all" | "writes", "unattended": "block" | "allow",
 *     "allow": ["~/notes"], "deny": [], "alwaysAsk": [] }
 * Remembered subtrees: ~/.pi/agent/fs-gate-state.json
 * Decision log:        ~/.pi/agent/fs-gate-audit.jsonl (paths only, never contents)
 * Escape hatch:        FS_GATE=off
 */

import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	COMMAND_TOOLS,
	READ_TOOLS,
	WRITE_TOOLS,
	canonicalize,
	classify,
	classifyUnresolved,
	commandPaths,
	contains,
	defaultConfig,
	grantDir,
	memoryCovers,
	mergeConfig,
	toolPaths,
	type FsGateConfig,
	type PathArg,
	type RuleHit,
} from "./fsrules.ts";

const HOME = homedir();
const CONFIG_PATH = `${HOME}/.pi/agent/fs-gate.json`;
const STATE_PATH = `${HOME}/.pi/agent/fs-gate-state.json`;
const AUDIT_PATH = `${HOME}/.pi/agent/fs-gate-audit.jsonl`;

const ONCE = "Allow once";
const DENY = "No — block it";
// Labels name the directory they grant: a prompt that never said what it granted is how "/" got
// approved by accident. Built per-prompt in grantLabels().
const sessionLabel = (dirs: string[]) => `Allow this directory (this session): ${dirs.join(", ")}`;
const alwaysLabel = (dirs: string[]) => `Always allow this subtree: ${dirs.join(", ")}`;
// The exact-path, in-memory answer. The directory answers are withheld on confirm-only and
// unresolved prompts, which left the owner with Allow-once or block and prompted the report
// (verbatim): "there used to be an option 'allow this session', it is STILL MISSING".
const exactLabel = (paths: string[]) => `Allow this path (this session): ${paths.join(", ")}`;

function readJson(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let cfg: FsGateConfig = defaultConfig(HOME);
	let remembered: string[] = [];
	const sessionDirs = new Set<string>();
	// exact paths approved for THIS process only (owner, 2026-10-07): nothing is written to disk,
	// a restart clears it, and it can never make a deny yield
	const sessionExact = new Set<string>();
	let disabled = process.env.FS_GATE === "off";

	const auditMaxBytes = 5_000_000; // patch 6: unbounded append was a known gap
	const audit = (e: Record<string, unknown>) => {
		try {
			// pid attribution: the log is shared by every pi process on montana and had no lane
			// field — this morning's 38 `"/"` grants could not be attributed from evidence
			try {
				const size = existsSync(AUDIT_PATH) ? statSync(AUDIT_PATH).size : 0;
				if (size > auditMaxBytes) renameSync(AUDIT_PATH, `${AUDIT_PATH}.1`); // keep one previous file
			} catch {
				/* rotation is best-effort; a log must never break a lane */
			}
			appendFileSync(AUDIT_PATH, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...e })}\n`);
		} catch {
			/* a log must never break a lane */
		}
	};

	const load = () => {
		cfg = mergeConfig(defaultConfig(HOME), readJson(CONFIG_PATH));
		if (disabled) cfg.enabled = false;
		const state = readJson(STATE_PATH);
		remembered = Array.isArray(state?.remembered) ? (state!.remembered as unknown[]).filter((p): p is string => typeof p === "string") : [];
	};

	/** A subtree the owner already approved, this session or on disk. */
	const knownAllowed = (p: string): string | undefined => {
		for (const root of [...sessionDirs, ...remembered]) if (contains(root, p)) return root;
		return undefined;
	};

	// Patch 1 (STRICT): owner memory covers ONLY the plain
	// outside-working-directory ask. Deny and confirm-only never yield to it.
	type Verdict = { arg: PathArg; path: string; hit: RuleHit };
	const covered = (v: Verdict): string | undefined =>
		v.hit.decision === "ask" && sessionExact.has(v.path)
			? v.path
			: memoryCovers(v.hit)
				? knownAllowed(v.path)
				: undefined;

	const remember = (dir: string, notify: (m: string, t?: "info" | "warning" | "error") => void) => {
		// whole-tree grants are refused outright — belt over the same braces as grantDir()
		if (dir === "/" || dir === HOME.replace(/\/+$/, "") || dir === "/home") {
			notify(`fs-gate: refusing always-allow for ${dir} — whole-tree grants are not offered`, "warning");
			return;
		}
		if (remembered.includes(dir)) return;
		remembered.push(dir);
		try {
			writeFileSync(STATE_PATH, `${JSON.stringify({ remembered }, null, 2)}\n`);
			notify(`fs-gate: always-allow added for ${dir}`, "info");
		} catch {
			notify(`fs-gate: could not save ${STATE_PATH}`, "warning");
		}
	};

	pi.registerFlag("no-fs-gate", {
		description: "Disable the filesystem permission gate for this run",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", (_event, ctx) => {
		load();
		if (pi.getFlag("no-fs-gate") === true) {
			disabled = true;
			cfg.enabled = false;
		}
		ctx.ui.setStatus("fs-gate", cfg.enabled ? `gate: ${cfg.scope}` : "gate: off");
		if (!cfg.enabled) ctx.ui.notify("fs-gate is OFF — no prompts outside the working directory", "warning");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!cfg.enabled) return undefined;
		try {
			const cwd = ctx.cwd;
			const tool = event.toolName;
			const isPathTool = WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool);
			const isCommandTool = COMMAND_TOOLS.has(tool);
			if (!isPathTool && !isCommandTool) return undefined;
			if (cfg.scope === "writes" && READ_TOOLS.has(tool)) return undefined;

			const rawInput = event.input as Record<string, unknown>;
			const args: PathArg[] = isCommandTool
				? commandPaths(typeof rawInput.command === "string" ? rawInput.command : "", cwd, HOME)
				: toolPaths(tool, rawInput, cwd, HOME);
			if (args.length === 0) return undefined;
			// a blocked command is worthless in the log without the command: the paths
			// alone cannot show WHICH token of a chained command produced them
			const cmd = isCommandTool && typeof rawInput.command === "string" ? rawInput.command.slice(0, 500) : undefined;

			const cwdReal = canonicalize(cwd, cwd, HOME, (p) => realpathSync(p));
			const verdicts = args.map((a) => ({
				arg: a,
				path: a.unresolved ? a.abs : canonicalize(a.abs, cwd, HOME, (p) => realpathSync(p)),
				// an expression we cannot expand is READ, not automatically questioned (owner friction
				// 2026-10-07): the literal pieces go against the rulebook, and only an unknown root or a
				// hidden file type still comes to the owner
				hit: a.unresolved ? classifyUnresolved(a.abs, cwdReal, cfg, HOME) : classify(canonicalize(a.abs, cwd, HOME, (p) => realpathSync(p)), cwdReal, cfg, HOME),
			}));

			// Static rulebook first, owner memory only where the rules allow it (patch 1):
			// a previously-approved early return applies ONLY to plain outside-directory asks.
			// Deny is absolute — it no longer consults knownAllowed at all.
			for (const v of verdicts) {
				if (v.hit.decision === "deny") {
					audit({ decision: "deny", tool, path: v.path, rule: v.hit.rule, cmd, cwd });
					ctx.ui.notify(`fs-gate blocked ${tool}: ${v.hit.rule}`, "warning");
					return { block: true, reason: `fs-gate: ${v.arg.raw} is refused (${v.hit.rule}) and is not available to this lane.` };
				}
			}

			const pending = verdicts.filter((v) => v.hit.decision === "ask" && covered(v) === undefined);
			if (pending.length === 0) {
				for (const v of verdicts) {
					const root = covered(v);
					if (root !== undefined) audit({ decision: "allow", by: "previously approved", tool, path: v.path, root, cwd });
				}
				return undefined;
			}

			const list = pending
				.slice(0, 4)
				.map((v) => `  ${tool}  ${v.arg.raw}\n     -> ${v.path}  (${v.hit.rule})`)
				.join("\n");
			const tail = pending.length > 4 ? `\n  and ${pending.length - 4} more` : "";

			if (!ctx.hasUI) {
				const reason = cfg.unattended === "block" ? "blocked: no UI to ask" : "allowed: unattended policy";
				audit({ decision: cfg.unattended, tool, paths: pending.map((v) => v.path), by: reason, cmd });
				if (cfg.unattended === "block") {
					return {
						block: true,
						reason: `fs-gate needs the owner's answer and this run has no UI (mode ${ctx.mode}).${list}${tail}\nRe-run interactively, have the owner add the path to ~/.pi/agent/fs-gate.json, or set FS_GATE=off if this lane is trusted.`,
					};
				}
				return undefined;
			}

			// Patch 2: compute what a directory answer WOULD grant, and withhold the two directory
			// choices when any pending path resolves to a whole-tree shape ("/", /home, home).
			const grants = pending.map((v) => grantDir(v.path, HOME));
			const dirs = Array.from(new Set(grants.filter((d): d is string => d !== undefined)));
			const canGrantDirs = grants.every((d) => d !== undefined);
			const dirLabels = canGrantDirs && pending.every((v) => v.hit.remember) ? [sessionLabel(dirs), alwaysLabel(dirs)] : [];
			const exacts = pending.map((v) => v.path);
			const safeExacts = exacts.every((p) => p !== "/" && p !== "/home" && p !== HOME.replace(/\/+$/, ""));
			const labels = [...dirLabels, ...(safeExacts ? [exactLabel(exacts)] : [])];

			const choice = await ctx.ui.select(`Allow this? cwd is ${cwd}\n\n${list}${tail}\n\nfs-gate only sees paths named in the tool call.`, [
				ONCE,
				...labels,
				DENY,
			]);

			if (choice === ONCE) {
				audit({ decision: "allow", by: "owner once", tool, paths: pending.map((v) => v.path), cwd });
				return undefined;
			}
			if (safeExacts && choice === exactLabel(exacts)) {
				for (const v of pending) sessionExact.add(v.path);
				audit({ decision: "allow", by: "owner session-path", tool, paths: exacts, cwd });
				return undefined;
			}
			if (choice === sessionLabel(dirs)) {
				for (const v of pending) sessionDirs.add(grantDir(v.path, HOME)!);
				audit({ decision: "allow", by: "owner session-dir", tool, paths: pending.map((v) => grantDir(v.path, HOME)), cwd });
				return undefined;
			}
			if (choice === alwaysLabel(dirs)) {
				for (const v of pending) {
					const d = grantDir(v.path, HOME)!;
					sessionDirs.add(d);
					remember(d, (m, t) => ctx.ui.notify(m, t));
				}
				audit({ decision: "allow", by: "owner always", tool, paths: pending.map((v) => grantDir(v.path, HOME)), cwd });
				return undefined;
			}

			audit({ decision: "deny", by: choice === DENY ? "owner denied" : "no answer", tool, paths: pending.map((v) => v.path), cmd, cwd });
			return {
				block: true,
				reason: `fs-gate: the owner did not approve this access. Stay inside the working directory (${cwd}) or ask the owner for the path. Blocked:${list}${tail}`,
			};
		} catch (err) {
			// fail closed and say so, rather than silently gating nothing
			const why = err instanceof Error ? err.message : String(err);
			audit({ decision: "deny", by: "fs-gate error", tool: event.toolName, error: why });
			ctx.ui.notify(`fs-gate error, call blocked: ${why}`, "error");
			return { block: true, reason: `fs-gate could not evaluate this call (${why}) and blocked it. Set FS_GATE=off to bypass the gate.` };
		}
	});

	pi.registerCommand("fsgate", {
		description: "Show gate state; subcommands: `sessions clear`, `config reload`",
		handler: async (args, ctx) => {
			const sub = String(args ?? "").trim();
			// Patch 5: the lever this morning lacked — session grants live in the extension
			// runtime's closure; clearing them here revokes them without a process restart.
			if (sub === "sessions clear") {
				const n = sessionDirs.size + sessionExact.size;
				sessionDirs.clear();
				sessionExact.clear();
				audit({ decision: "ops", by: "fsgate sessions clear", removed: n });
				ctx.ui.notify(`fs-gate: cleared ${n} session grant(s) (directories and exact paths). Always-allowed subtrees on disk are untouched.`, "info");
				return;
			}
			if (sub === "config reload") {
				load();
				ctx.ui.setStatus("fs-gate", cfg.enabled ? `gate: ${cfg.scope}` : "gate: off");
				audit({ decision: "ops", by: "fsgate config reload" });
				ctx.ui.notify("fs-gate: re-read fs-gate.json and fs-gate-state.json", "info");
				return;
			}
			load();
			const lines = [
				`fs-gate: ${cfg.enabled ? `on (scope ${cfg.scope}, unattended ${cfg.unattended})` : "OFF"}`,
				`cwd: ${ctx.cwd}`,
				`allow extra: ${cfg.allow.filter((p) => !p.startsWith("/usr") && !p.startsWith("/etc")).join(", ") || "(none)"}`,
				`deny: ${cfg.deny.join(", ")}`,
				`confirm-only: ${cfg.alwaysAsk.join(", ")}`,
				`session-allowed: ${[...sessionDirs].join(", ") || "(none)"}`,
				`session-paths (in memory, gone at restart): ${[...sessionExact].join(", ") || "(none)"}`,
				`always-allowed: ${remembered.join(", ") || "(none)"}`,
				`log: ${AUDIT_PATH}`,
				`note: bash is checked by path-looking tokens only; OS sandbox is the hard boundary.`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
