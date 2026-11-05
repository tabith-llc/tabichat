// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the filesystem gate rules.
//   bun tools/test_fsgate.ts       (exit 1 on any failure)
// Positive and negative halves both required for every rule.
import {
	classify,
	classifyUnresolved,
	commandPaths,
	contains,
	canonicalize,
	defaultConfig,
	dirOf,
	expandHome,
	grantDir,
	lexical,
	matches,
	memoryCovers,
	mergeConfig,
	toolPaths,
	type FsGateConfig,
} from "../extensions/fs-gate/fsrules.ts";

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

const HOME = "/home/test";
const CWD = "/work/venue1";
const cfg: FsGateConfig = defaultConfig(HOME);

// --- containment (the sibling-prefix trap is the one that bites) ---
check("contains inside", contains(CWD, "/work/venue1/a/b.ts"), true);
check("contains equal", contains(CWD, CWD), true);
check("contains sibling prefix is false", contains("/work/ven", "/work/venue1"), false);
check("contains parent is false", contains(CWD, "/work"), false);
check("contains root allows all", contains("/", "/anything"), true);
check("contains trailing slash ok", contains(`${CWD}/`, "/work/venue1/x"), true);

// --- lexical path folding, no filesystem ---
check("lexical relative", lexical("a/b", CWD, HOME), "/work/venue1/a/b");
check("lexical absolute", lexical("/etc/hosts", CWD, HOME), "/etc/hosts");
check("lexical tilde", lexical("~/.pi/agent", CWD, HOME), "/home/test/.pi/agent");
check("lexical dotdot escapes cwd", lexical("../../etc/shadow", CWD, HOME), "/etc/shadow");
check("lexical dot inside cwd", lexical("./x", CWD, HOME), "/work/venue1/x");
check("expandHome bare tilde", expandHome("~", HOME), "/home/test");

// --- symlink resolution (a link inside cwd must not read as inside cwd) ---
const links: Record<string, string> = { "/work/venue1/escape": "/home/test/.ssh" };
const exists = new Set(["/work", "/work/venue1", "/work/venue1/escape", "/home", "/home/test"]);
const real = (p: string): string => {
	if (!exists.has(p)) throw new Error("ENOENT");
	let cur = p;
	for (let i = 0; i < 8 && links[cur]; i++) cur = links[cur];
	return cur;
};
check("canonicalize resolves symlink out of cwd", canonicalize("escape/id_rsa", CWD, HOME, real), "/home/test/.ssh/id_rsa");
check("canonicalize keeps missing tail", canonicalize("sub/new/file.ts", CWD, HOME, real), "/work/venue1/sub/new/file.ts");
check("canonicalize plain path", canonicalize("a.txt", CWD, HOME, real), "/work/venue1/a.txt");

// --- pattern matching ---
check("matches prefix dir", matches([`${HOME}/.ssh`], `${HOME}/.ssh/id_ed25519`, HOME), `${HOME}/.ssh`);
check("matches prefix dir negative", matches([`${HOME}/.ssh`], `${HOME}/.sshx/key`, HOME), undefined);
check("matches glob basename anywhere", matches(["**/models.json"], `${HOME}/.pi/agent/models.json`, HOME), "**/models.json");
check("matches glob basename negative", matches(["**/models.json"], `${HOME}/.pi/agent/models.json.bak`, HOME), undefined);
check("matches ext glob", matches(["**/*.pem"], "/srv/tls/server.pem", HOME), "**/*.pem");
check("matches ext glob negative", matches(["**/*.pem"], "/srv/tls/server.pub", HOME), undefined);

// --- the rule, as of the DEFAULT-ALLOW change (option 2: "allow all directory access
// that isn't explicitly prohibited"; denylist absolute; key-shaped confirm-only still prompts) ---
check("inside cwd is allowed", classify("/work/venue1/src/a.py", CWD, cfg, HOME).decision, "allow");
check("tmp is allowed silently", classify("/tmp/opencode/x.out", CWD, cfg, HOME).decision, "allow");
check("outside cwd is allowed by default now", classify("/media/u/other/repo/f.py", CWD, cfg, HOME).decision, "allow");
check("default allow names its policy", classify("/media/u/other/repo/f.py", CWD, cfg, HOME).rule, "default allow (outside the working directory, not on the deny or confirm-only list)");
check("default allow is not rememberable (nothing to remember)", classify("/media/u/other/repo/f.py", CWD, cfg, HOME).remember, false);
check("bare root is allowed by default (the old false-prompt class)", classify("/", CWD, cfg, HOME).decision, "allow");
check("ssh keys are refused, not asked", classify(`${HOME}/.ssh/id_ed25519`, CWD, cfg, HOME).decision, "deny");
check("deny is absolute even where the old allowlist covered it", classify(`${HOME}/.ssh/config`, CWD, cfg, HOME).decision, "deny");
check("models.json always asks", classify(`${HOME}/.pi/agent/models.json`, CWD, cfg, HOME).decision, "ask");
check("models.json is not rememberable", classify(`${HOME}/.pi/agent/models.json`, CWD, cfg, HOME).remember, false);
check("models.json rule beats allowlist", matches([`${HOME}/.pi`], `${HOME}/.pi/agent/models.json`, HOME) !== undefined, true);
// The live extension directory is a confirm-free subtree by history; under default allow the whole
// ~/.pi tree is ordinary access EXCEPT the confirm-only files — settings.json/models.json still ask.
check("live extension dir is allowed", classify(`${HOME}/.pi/agent/extensions/tabichat/index.ts`, CWD, cfg, HOME).decision, "allow");
check("the allowance is a subtree, not all of ~/.pi", classify(`${HOME}/.pi/agent/settings.json`, CWD, cfg, HOME).decision, "ask");
check("the allowance does not outrank models.json always-ask", classify(`${HOME}/.pi/agent/extensions/tabichat/../../../agent/models.json`, CWD, cfg, HOME).decision, "ask");
check("deny beats always-ask", classify(`${HOME}/.ssh/models.json`, CWD, cfg, HOME).decision, "deny");
check("project models.json also asks", classify("/work/venue1/config/models.json", CWD, cfg, HOME).decision, "allow"); // inside cwd = no prompt
check("other venue models.json asks", classify("/work/venue2/models.json", CWD, cfg, HOME).decision, "ask");

// --- config merge ---
const merged = mergeConfig(cfg, { enabled: false, scope: "writes", unattended: "allow", allow: ["~/notes"], deny: ["/srv/secret"], alwaysAsk: 7 as unknown as string[] });
check("merge honours enabled", merged.enabled, false);
check("merge honours scope", merged.scope, "writes");
check("merge honours unattended", merged.unattended, "allow");
check("merge appends allow as written", merged.allow.includes("~/notes"), true);
check("tilde pattern still matches", classify(`${HOME}/notes/a.txt`, CWD, merged, HOME).decision, "allow");
check("merge keeps default allow", merged.allow.includes("/tmp"), true);
check("merge appends deny", merged.deny.includes("/srv/secret"), true);
check("merge ignores bad alwaysAsk type", merged.alwaysAsk.length, cfg.alwaysAsk.length);
check("merge with null is identity", mergeConfig(cfg, null) === cfg, true);
const junk = mergeConfig(cfg, { scope: "everything", unattended: "ask", allow: "/tmp/nope" });
check("merge rejects bad scope", junk.scope, cfg.scope);
check("merge rejects bad unattended", junk.unattended, cfg.unattended);
check("merge rejects non-array allow", junk.allow.length, cfg.allow.length);

// --- path tools ---
check("toolPaths read", toolPaths("read", { path: "../secrets.txt" }, CWD, HOME)[0].abs, "/work/secrets.txt");
check("toolPaths missing path defaults to cwd", toolPaths("ls", {}, CWD, HOME)[0].abs, CWD);
check("toolPaths flags expansion", toolPaths("read", { path: "$HOME/.ssh/id_rsa" }, CWD, HOME)[0].unresolved, true);
check("toolPaths plain path unflagged", toolPaths("read", { path: "/etc/hosts" }, CWD, HOME)[0].unresolved, false);

// --- command detector (a detector, not a boundary) ---
const toks = (c: string) => commandPaths(c, CWD, HOME).map((p) => p.abs);
check("detector absolute outside", toks("cat /etc/shadow"), ["/etc/shadow"]);
check("detector tilde", toks("cat ~/.ssh/id_ed25519"), ["/home/test/.ssh/id_ed25519"]);
check("detector dotdot", toks("cat ../../keys/id"), ["/keys/id"]);
check("detector redirect target", toks("make > /tmp/out.log 2>~/err.txt"), ["/tmp/out.log", "/home/test/err.txt"]);
check("detector relative inside cwd is not a path token", toks("ls packages/core"), []);
check("detector dot is not a path token", toks("cd . && git status"), []);
check("detector dedupes", toks("diff /srv/a /srv/a"), ["/srv/a"]);
check("detector strips trailing punctuation", toks("cat /srv/a; ls"), ["/srv/a"]);
check("detector flags unresolvable expansion", commandPaths("cat $HOME/private/x", CWD, HOME)[0].unresolved, true);
check("detector keeps mid-path dotdot", toks("rm /work/venue1/../venue2/f"), ["/work/venue2/f"]);
check("detector sees nothing in an interpreter one-liner (known limit)", toks("python3 -c open('/etc/shadow').read()"), []);

// Regression from a real lane report: a lane got a prompt naming a bare `/` after commands like
// these. Reproduced here so the claim is testable — none of
// them may yield an outside-cwd path, so none of them can legitimately prompt.
const f1 = "ls -l --time-style=+%m-%d_%H:%M:%S /tmp/tabichat/a.md; md5sum /tmp/tabichat/a.md; grep -n '431\\|dep-cadence' /tmp/tabichat/a.md";
const f2 = "cd /media/u/data/tabith && ls info/ 2>/dev/null; grep -rn 'LASTEXITCODE' info/ *.md 2>/dev/null";
const f3 = "awk 'NR>=84 && NR<=90 {printf \"%d\\t%s\\n\", NR, $0}' /tmp/tabichat/a.md";
check("regression: redirect + time-format + grep alternation yields only /tmp", toks(f1), ["/tmp/tabichat/a.md", "/tmp/tabichat/a.md"].slice(0, 1));
check("regression: cd into cwd plus two redirects yields cwd and /dev/null", toks(f2), ["/media/u/data/tabith", "/dev/null"]);
check("regression: awk printf format does not become a path", toks(f3), ["/tmp/tabichat/a.md"]);
check("regression: a quoted slash pattern is not an operand", toks("grep -c 'a/b' file.txt"), []);
// --- the false bare-`/` operand class is retired (sed / delimiter residue).
// Owner, verbatim: "the agent isn't really trying to access /, it's just a sed command shows a bare /
// so the whole thing gets [broken]". This REPLACES the older pair of cells that asserted `tr : /` still
// yielded "/" - deliberate, with the reason recorded here and in the commandPaths doc comment, and the
// negative halves below keep the real-path detections pinned.
check("slash-only operand is not a path (tr delimiter)", toks("echo a:b | tr : /"), []);
check("slash-only operand is not a path (cut -d/ + awk -F/)", toks("cut -d/ -f1 p.txt | awk -F/ '{print $2}'"), []);
check("slash-only operand is not a path (bare root operands)", toks("ls / ; du -sh /"), []);
check("documented trade-off: chmod of root names no operand", toks("chmod 777 /"), []);
check("documented trade-off: a redirect into root names no operand", toks("echo x >/"), []);
check("sed residue after an escaped space is not a path", toks("sed -e s/a\\ /b/ notes.md"), []);
check("an escaped-space path stays ONE operand", toks("cat /home/test/my\\ file.txt"), ["/home/test/my file.txt"]);
check("negative half: a real file under root is still detected", toks("cat /etc/passwd"), ["/etc/passwd"]);
check("negative half: a directory with a trailing slash is still detected", toks("ls /etc/"), ["/etc"]);
check("root still classifies as a default allow when a tool names it directly", classify("/", CWD, cfg, HOME).decision, "allow");
check("redirects never prompt", toks("ls info/ 2>/dev/null; cat a >/dev/null; tail -f f 2>>/tmp/x.log"), ["/dev/null", "/tmp/x.log"]);
check("quoted awk programs are not path operands", toks("awk '{print $1/2}' f.md"), []);
check("quoted printf formats are not path operands", toks("awk '{printf \"%d\\t%s\\n\", NR, $0}' f.md"), []);
check("time formats are not path operands", toks("date +%Y/%m/%d; ls --time-style=+%m/%d/%Y"), []);

// --- patch 1: memory covered ONLY the plain outside ask. The default-allow change later
// removed that hit from classify(); memoryCovers keeps its semantics for any ask that DOES carry
// remember:true, and stays false for every deny / confirm-only / allow shape. ---
check("memoryCovers: synthetic rememberable ask is covered", memoryCovers({ decision: "ask", rule: "outside working directory", remember: true }), true);
check("memoryCovers: plain outside (now default allow)", memoryCovers(classify("/media/u/other/repo/f.py", CWD, cfg, HOME)), false);
check("memoryCovers: deny never", memoryCovers(classify(`${HOME}/.ssh/id_ed25519`, CWD, cfg, HOME)), false);
check("memoryCovers: confirm-only never (STRICT ruling)", memoryCovers(classify(`${HOME}/.pi/agent/models.json`, CWD, cfg, HOME)), false);
check("memoryCovers: allowlist hit (an allow, not an ask)", memoryCovers(classify("/tmp/x", CWD, cfg, HOME)), false);
check("memoryCovers: cwd-internal hit", memoryCovers(classify("/work/venue1/a.py", CWD, cfg, HOME)), false);
check("memoryCovers: pem inside a granted subtree still asks", memoryCovers(classify("/srv/tls/server.pem", CWD, cfg, HOME)), false);

// --- patch 2: grantDir — what an "allow this directory" answer would actually grant ---
check("grantDir: /etc/shadow grants /etc", grantDir("/etc/shadow", HOME), "/etc");
check("grantDir: root is withheld", grantDir("/", HOME), undefined);
check("grantDir: home dir is withheld", grantDir(`${HOME}/x`, HOME), undefined);
check("grantDir: /home is withheld", grantDir("/home", HOME), undefined);
check("grantDir: deep path gives its parent", grantDir("/opt/venya/.venv/bin/x", HOME), "/opt/venya/.venv/bin");
check("grantDir: trailing-slash home still withheld", grantDir("/home/test2/x", "/home/test2/"), undefined);
check("dirOf plain", dirOf("/a/b"), "/a");
check("dirOf root stays root", dirOf("/"), "/");

// --- patch 4 retained cells: quoted echo labels are prose, not operands ---
check("quoted echo label with slash yields nothing", toks('echo "=== FS GATE / STATE ==="'), []);
check("single-quoted label with slash yields nothing", toks("echo 'section / next'"), []);

// --- unresolved path expressions. A prompt on `/tmp/tabichat/note-$N.md` stopped a lane mid-task and
// nobody could answer it, because nothing knows where `$N` resolves. The expression is read as far as
// it can be: the rulebook is applied to the literal pieces, and only an unknowable root, a hidden file
// type, or a shape the rulebook names still asks the human.
const un = (raw: string) => classifyUnresolved(raw, CWD, cfg, HOME);
check("unresolved: the owner's own shape is silent", un("/tmp/tabichat/note-$N.md").decision, "allow");
check("...and it is the policy rule, not a hole", un("/tmp/tabichat/note-$N.md").rule, "default allow (unresolved expression; literal parts outside the working directory, not on the deny or confirm-only list)");
check("unresolved: a script name outside cwd is silent", un("/tmp/tabichat/run-$N.sh").decision, "allow");
check("unresolved: a variable that opens the path still asks", un("$DIR/notes.md").decision, "ask");
check("...and says the root is unknown", un("$DIR/notes.md").rule, "unresolved path expression (unknown root)");
check("unresolved: a command-substitution root still asks", un("$(hostname)/x/out.md").rule, "unresolved path expression (unknown root)");
check("unresolved: a hidden file type still asks", un("/srv/tls/$F").decision, "ask");
check("...and says the type is not visible", un("/srv/tls/$F").rule, "unresolved path expression (file type not visible)");
check("unresolved: a hidden extension asks", un("/srv/tls/key.$EXT").rule, "unresolved path expression (file type not visible)");
check("NEGATIVE HALF - denylist wins over an expression", un(`${HOME}/.ssh/id_$K`).decision, "deny");
check("...and names the denylist rule", un(`${HOME}/.ssh/id_$K`).rule, `denylist ${HOME}/.ssh`);
check("NEGATIVE HALF - denylist wins with the id partly visible", un(`${HOME}/.ssh/id_ed25519$K`).decision, "deny");
check("NEGATIVE HALF - confirm-only wins over an expression", un(`${HOME}/secrets/server.pem`).rule, "confirm-only **/*.pem");
check("NEGATIVE HALF - models.json is known even behind $HOME", un("$HOME/.pi/agent/models.json").rule, "confirm-only **/models.json");
check("unresolved: a relative operand stays in the working directory", un("notes/$N.md").rule, "working directory");
check("unresolved: $HOME is expanded, so a plain home path is silent", un("$HOME/scratch/out.md").decision, "allow");
check("unresolved: detection still flags the token", commandPaths("cat > /tmp/tabichat/note-$N.md", CWD, HOME)[0].unresolved, true);
check("...and that token now ends in an allow, not a prompt", un(commandPaths("cat > /tmp/tabichat/note-$N.md", CWD, HOME)[0].abs).decision, "allow");

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks pass");
process.exitCode = failed ? 1 : 0;
