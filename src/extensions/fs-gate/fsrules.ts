// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * fs-gate rules — pure logic, no UI, no pi types.
 *
 * Anything outside the working directory is ALLOWED unless it is explicitly prohibited. Three outcomes
 * remain: refused silently (denylist), always asked (confirm-only: key-shaped files and the gate's own
 * state), allowed silently (everything else). index.ts does the asking.
 */

/** Tools that name a path directly. */
export const WRITE_TOOLS = new Set(["write", "edit"]);
export const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Tools whose argument is a shell command rather than a path. */
export const COMMAND_TOOLS = new Set(["bash", "powershell"]);

export type Decision = "allow" | "deny" | "ask";

export interface FsGateConfig {
	enabled: boolean;
	/** "all" gates reads and writes; "writes" gates only writes and commands. */
	scope: "all" | "writes";
	/** What to do when no dialog-capable UI exists (print/JSON, or RPC with no client answering). */
	unattended: "block" | "allow";
	/** Silently permitted, in addition to the working directory. */
	allow: string[];
	/** Refused without asking. Credential stores live here. */
	deny: string[];
	/** Always asked, never remembered ("always allow" is withheld). */
	alwaysAsk: string[];
}

export function defaultConfig(home: string): FsGateConfig {
	return {
		enabled: true,
		scope: "all",
		unattended: "block",
		allow: [
			"/tmp",
			"/var/tmp",
			"/dev",
			"/usr",
			"/bin",
			"/sbin",
			"/lib",
			"/lib64",
			"/etc",
			"/proc",
			"/sys",
			`${home}/.cache`,
			`${home}/.bun/install`,
			// Lanes may reach the live extension directory (deploy
			// previews, byte-comparison against what actually loads). Sibling of the tabichat
			// repo's source, so a lane can tell "what I edited" from "what is running".
			`${home}/.pi/agent/extensions`,
		],
		deny: [
			`${home}/.ssh`,
			`${home}/.aws`,
			`${home}/.gnupg`,
			`${home}/.azure`,
			`${home}/.config/glab-cli`,
			`${home}/.config/gh`,
			`${home}/.netrc`,
			`${home}/.npmrc`,
			`${home}/.git-credentials`,
			`${home}/.docker/config.json`,
		],
		alwaysAsk: [
			"**/models.json",
			"**/.env",
			"**/.env.*",
			"**/*.pem",
			"**/*.key",
			"**/id_rsa*",
			"**/id_ed25519*",
			"**/credentials*",
			`${home}/.pi/agent/settings.json`,
			`${home}/.pi/agent/trust.json`,
			`${home}/.pi/agent/fs-gate.json`,
			`${home}/.pi/agent/fs-gate-state.json`,
		],
	};
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []);

export function mergeConfig(base: FsGateConfig, user: Record<string, unknown> | null): FsGateConfig {
	if (!user) return base;
	const out: FsGateConfig = { ...base, allow: [...base.allow], deny: [...base.deny], alwaysAsk: [...base.alwaysAsk] };
	if (typeof user.enabled === "boolean") out.enabled = user.enabled;
	if (user.scope === "all" || user.scope === "writes") out.scope = user.scope;
	if (user.unattended === "block" || user.unattended === "allow") out.unattended = user.unattended;
	if (Array.isArray(user.allow)) out.allow = out.allow.concat(strings(user.allow));
	if (Array.isArray(user.deny)) out.deny = out.deny.concat(strings(user.deny));
	if (Array.isArray(user.alwaysAsk)) out.alwaysAsk = out.alwaysAsk.concat(strings(user.alwaysAsk));
	return out;
}

export function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
	return p;
}

/** Lexical absolute path: no filesystem access, no symlink resolution. */
export function lexical(p: string, cwd: string, home: string): string {
	let s = expandHome(p, home);
	if (!s.startsWith("/")) s = `${cwd.replace(/\/+$/, "")}/${s}`;
	const out: string[] = [];
	for (const part of s.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

/**
 * Resolve as far as the filesystem allows, so a symlink cannot hop out of a
 * permitted tree. The nearest existing ancestor is resolved and the missing
 * tail is appended, which is what creating a new file actually targets.
 */
export function canonicalize(p: string, cwd: string, home: string, realpath: (p: string) => string): string {
	const abs = lexical(p, cwd, home);
	let cur = abs;
	const missing: string[] = [];
	for (let i = 0; i < 128; i++) {
		let resolved: string | undefined;
		try {
			resolved = realpath(cur);
		} catch {
			resolved = undefined;
		}
		if (resolved !== undefined) {
			const base = resolved.replace(/\/+$/, "") || "/";
			if (missing.length === 0) return base;
			return `${base === "/" ? "" : base}/${missing.join("/")}`;
		}
		const cut = cur.lastIndexOf("/");
		if (cut <= 0) break;
		missing.unshift(cur.slice(cut + 1));
		cur = cur.slice(0, cut);
	}
	return abs;
}

/** Is `p` inside `root` (or equal to it)? `/a/bc` is not inside `/a/b`. */
export function contains(root: string, p: string): boolean {
	const r = root.replace(/\/+$/, "") || "/";
	if (r === "/") return p === "/" || p.startsWith("//") || p.startsWith("/");
	return p === r || p.startsWith(`${r}/`);
}

function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				re += ".*";
				i++;
				if (pattern[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if ("\\^$.|+?()[]{}".includes(c)) re += `\\${c}`;
		else re += c;
	}
	return new RegExp(`^${re}$`);
}

/** A pattern matches when the path is inside it, or a glob in it matches the path. */
export function matches(list: string[], path: string, home: string): string | undefined {
	for (const raw of list) {
		const pattern = expandHome(raw, home);
		if (raw.includes("*")) {
			if (globToRegExp(pattern).test(path)) return raw;
		} else if (pattern === path || contains(pattern, path)) {
			return raw;
		}
	}
	return undefined;
}

export interface RuleHit {
	decision: Decision;
	rule: string;
	/** True when an "always allow this subtree" answer may be offered. */
	remember: boolean;
}

/** Static rules only: working-directory containment, deny, confirm-only, default allow. No memory.
 *
 *  THE DEFAULT IS ALLOW, NOT ASK — allow all directory access that isn't explicitly prohibited,
 *  because a gate that prompts on everything becomes the thing slowing the human down. So:
 *  outside the working directory is ALLOWED by default. The denylist stays absolute (that IS the
 *  explicit prohibition), and the confirm-only list still prompts one last time for key-shaped files
 *  (.env, *.pem, *.key, credentials*, models.json, the gate's own files) — that half is a deliberate
 *  narrowing, not an agent softening a check. */
export function classify(path: string, cwd: string, cfg: FsGateConfig, home: string): RuleHit {
	if (contains(cwd, path)) return { decision: "allow", rule: "working directory", remember: false };
	const denied = matches(cfg.deny, path, home);
	if (denied) return { decision: "deny", rule: `denylist ${denied}`, remember: false };
	const asked = matches(cfg.alwaysAsk, path, home);
	if (asked) return { decision: "ask", rule: `confirm-only ${asked}`, remember: false };
	return { decision: "allow", rule: "default allow (outside the working directory, not on the deny or confirm-only list)", remember: false };
}

/**
 * A path the shell would expand and we cannot, like `/tmp/tabichat/note-$N.md`. The old rule asked on
 * every unresolvable token no matter where it pointed, which contradicts the policy this file
 * implements: allow everything that is not explicitly prohibited. A prompt the human cannot answer —
 * because nobody knows where the token resolves — is friction with no protection behind it.
 *
 * So the expression is read as far as it can be. The literal pieces are matched against the
 * rulebook with each variable replaced by a single-character placeholder, which keeps both
 * protections that actually matter: a visible credential shape (`$HOME/.ssh/id_$K`) still lands on
 * the denylist, and a key-shaped file still lands on the confirm-only list. Two cases keep asking,
 * honestly, because nothing is knowable about them: the expression can start the path, so the root
 * is unknown (`$DIR/notes.md`, `$(hostname)/x`), or the variable hides the file type
 * (`/srv/tls/$F`, `key.$EXT`) — the shapes we are asked to protect are exactly the extension-shaped
 * ones. Everything else outside the working directory is allowed silently, as policy now says.
 */
const EXP_SPLIT = /(\$\{?\w+\}?|\$\([^)]*\)|`[^`]*`)/;

export function classifyUnresolved(raw: string, cwd: string, cfg: FsGateConfig, home: string): RuleHit {
	// the home directory IS knowable, so expand it before anything else
	const s = raw.split("${HOME}").join(home).split("$HOME").join(home);
	const pieces = s.split(EXP_SPLIT);
	// "@" marks a variable: globs still match it, but it never looks like a file extension
	const probe = pieces.map((x, i) => (i % 2 === 1 ? "@" : x)).join("");
	const head = pieces[0];
	const denied = matches(cfg.deny, probe, home);
	if (denied) return { decision: "deny", rule: `denylist ${denied}`, remember: false };
	const asked = matches(cfg.alwaysAsk, probe, home);
	if (asked) return { decision: "ask", rule: `confirm-only ${asked}`, remember: false };
	// an expression that OPENS the path is unknowable (`$DIR/x`, `$(hostname)/x`); a relative
	// operand is not — it belongs to the working directory like any other relative path
	if (head === "")
		return { decision: "ask", rule: "unresolved path expression (unknown root)", remember: false };
	const lastSeg = probe.slice(probe.lastIndexOf("/") + 1);
	if (!/\.[A-Za-z][A-Za-z0-9]*$/.test(lastSeg))
		return { decision: "ask", rule: "unresolved path expression (file type not visible)", remember: false };
	const dir = lexical(head.replace(/\/[^/]*$/, ""), cwd, home);
	if (contains(cwd, dir)) return { decision: "allow", rule: "working directory", remember: false };
	return { decision: "allow", rule: "default allow (unresolved expression; literal parts outside the working directory, not on the deny or confirm-only list)", remember: false };
}

/** Owner memory (session/always grants) covers ONLY the plain outside-working-directory ask. Deny and
 *  confirm-only never yield to it: a grant that lands on `/` or the home directory must not open a
 *  credential store. STRICT by design — self-protection (confirm-only) is absolute. */
export function memoryCovers(hit: RuleHit): boolean {
	return hit.decision === "ask" && hit.remember;
}

/** Parent directory of a resolved path; "/" stays "/". */
export function dirOf(p: string): string {
	return p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/";
}

/** The directory an "allow this directory" answer would grant, or undefined when no such answer is safe
 *  to offer — `/`, `/home`, and the home directory cover the tree. A prompt whose labels do not name
 *  the grant is one where `/` can be approved by accident, so the labels must name it. */
export function grantDir(p: string, home: string): string | undefined {
	const d = dirOf(p);
	const h = home.replace(/\/+$/, "") || "/";
	return d === "/" || d === "/home" || d === h ? undefined : d;
}

export interface PathArg {
	/** Path as the model wrote it. */
	raw: string;
	/** Lexical absolute path (no symlink walk). */
	abs: string;
	/** True when the argument cannot be resolved (for example `$HOME/...`). */
	unresolved: boolean;
}

const EXPANSION = /\$\{?\w|\$\(|`/;

/** Path arguments for read/write/edit/grep/find/ls. A missing path means the tool defaults to cwd. */
export function toolPaths(tool: string, input: Record<string, unknown>, cwd: string, home: string): PathArg[] {
	const raw = typeof input.path === "string" ? input.path : undefined;
	if (raw === undefined) return [{ raw: ".", abs: cwd, unresolved: false }];
	return [{ raw, abs: lexical(raw, cwd, home), unresolved: EXPANSION.test(raw) }];
}

const HOME_EXPR = /\$\{?(?:HOME|USERPROFILE)\}?/;
// Note on scope: an earlier form also flagged any `$`-token containing a slash, which
// made `awk '{print $1/2}'` look like a path outside the workspace. A positional or
// field parameter is not a path; only an explicit home expansion is. Fuzzed over 25
// shell fragments to find exactly this class.
const LEAD = /^(?:[0-9]*[<>]|&)+/;
const TRAIL = /[,;:)\]}"']+$/;

/**
 * Path-looking tokens from a shell command. This is a detector, not a
 * boundary: a program that opens a file itself never names it on the command
 * line, so what it reads stays invisible here.
 *
 * Quoted spans are stripped BEFORE tokenizing, because the
 * audit log showed all its denies coming from a slash inside a quoted echo
 * label (`echo "=== X / Y ==="`) — a quoted literal is prose, not a path the
 * shell opens. Accepted trade-off, and the same detector-not-boundary caveat
 * applies: `cat "/etc/shadow"` (the path fully quoted) is now unseen too.
 * Retained cells: `awk '{print $1/2}'`, `grep -c 'a/b' file.txt`,
 * `date +%Y/%m/%d` yield nothing; `cat /etc/shadow` still yields the path.
 *
 * Two more false-operand classes were retired the same way, after a `sed` expression produced yet
 * another bare-`/` prompt: the agent is not trying to access `/`, the command merely shows a bare `/`
 * and the whole call gets broken:
 *
 * - **Backslash-escaped whitespace stays inside its token.** The shell does not split there; the old
 *   splitter did. `sed -e s/a\ /b/` became `s/a\` plus `/b/`, and that second half begins with a
 *   slash, so it was reported as an attempt to open `/b/`. The same fix keeps `cat ./my\ file.txt`
 *   as one operand instead of a fragment plus an unrelated word.
 * - **A token of nothing but slashes is a delimiter, not a destination.** `tr : /`, `cut -d/`,
 *   `awk -F/` and `s/../../` residue name a field separator; none of them is a filesystem read.
 *
 * Accepted trade-off, stated plainly: a slash-only operand is now invisible to this detector, so
 * `chmod 777 /` and `echo x >/` name no path and prompt nothing. Nothing is given up against the
 * policy in force here, which already classifies a bare `/` outside the
 * working directory as `default allow`. The protections that remain - the absolute denylist and the
 * key-shaped confirm-only list - match on path SHAPES and are untouched by either change.
 */
const QUOTED_SPAN = /'[^']*'|"[^"]*"/g;

/** A backslash escapes the whitespace after it, so that whitespace must not end the token. */
const ESC_SPACE = /\\[ \t]/g;
/** Sentinel that holds an escaped space across the whitespace split. */
const HOLD = "\u0000";
/** Slash-only tokens (`/`, `//`) are field separators, not paths. */
const SLASH_ONLY = /^\/+$/;

export function commandPaths(command: string, cwd: string, home: string): PathArg[] {
	const out: PathArg[] = [];
	const seen = new Set<string>();
	const pieces = command.replace(QUOTED_SPAN, " ").replace(ESC_SPACE, HOLD).split(/\s+/);
	for (const piece of pieces) {
		let token = piece.split(HOLD).join(" ");
		token = token.replace(LEAD, "");
		token = token.replace(TRAIL, "");
		if (token.length === 0) continue;
		if (SLASH_ONLY.test(token)) continue;
		const looksLikePath =
			token.startsWith("/") ||
			token.startsWith("~/") ||
			token === "~" ||
			token.startsWith("../") ||
			token === ".." ||
			token.includes("/../") ||
			HOME_EXPR.test(token);
		if (!looksLikePath) continue;
		const unresolved = EXPANSION.test(token);
		const abs = unresolved ? token : lexical(token, cwd, home);
		if (seen.has(abs)) continue;
		seen.add(abs);
		out.push({ raw: token, abs, unresolved });
	}
	return out;
}
