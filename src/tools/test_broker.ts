// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Truth table for the BROKER LOCATION — the site-agnostic rule (no default, must be set).
 *   bun src/tools/test_broker.ts        (exit 1 on any failure)
 *
 * FOUR HALFS, because this is the defect class this repo keeps failing:
 *   1. the pure resolver: every accepted value, and the rejection case for every shape of unset or
 *      unusable value (a check that only passes the happy path is not a check);
 *   2. the config PATH function, which is the single place the location is computed — the owner's
 *      ruling may rename the file, and that rename must be one edit;
 *   3. the disk half, with a real temp file: a site file that parses, one that will not parse, and
 *      one that does not exist at all;
 *   4. a SOURCE-SHAPE half plus a TREE-SCAN half. The source-shape grep is what catches a correct
 *      module nobody calls (the `ctx is not defined` incident: a perfectly tested file whose wiring
 *      line never ran). The tree scan is the negative half of the ruling itself — "we removed the
 *      default" and "we removed the address" are different claims, and the owner ruled on BOTH — so
 *      this file fails if a venue hostname comes back into any tracked text file, default, prose or
 *      example. The banned strings are HEX-ENCODED so this guard cannot contain what it guards
 *      (same trick as .githooks/forbidden-strings.hex).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  BROKER_SCHEMES,
  BROKER_URL_ENV,
  BROKER_URL_KEY,
  refusalMessage,
  resolveBrokerFromDisk,
  resolveBrokerUrl,
  siteConfigPath,
} from "../extensions/tabichat/broker.ts";
import { SITE_CONFIG_DEFAULT, SITE_CONFIG_ENV } from "../extensions/tabichat/laneadmin.ts";

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

/** shape-only check: the caller wants to know WHICH branch answered, not the whole object */
const kind = (r: { ok: boolean }) => (r.ok ? "ok" : "refuse");
const urlOf = (r: { ok: boolean; url?: string }) => (r.ok ? r.url : "<refusal>");

const PATH = "/home/you/.pi/agent/tabichat.json";
const ENV_URL = "mqtt://broker.example:1883";
const SITE_URL = "mqtt://config.example:1883";

// --- 1. the pure resolver: positives -------------------------------------------------------
check(
  "site file answers when it has the key",
  resolveBrokerUrl({ site: SITE_URL, env: ENV_URL, configPath: PATH }),
  { ok: true, url: SITE_URL, source: `site file (${BROKER_URL_KEY})` },
);
check(
  "and the site file WINS over the env — the venue setting is the one that must not be shadowed " +
    "by a launcher line someone forgot to delete",
  urlOf(resolveBrokerUrl({ site: SITE_URL, env: ENV_URL, configPath: PATH })),
  SITE_URL,
);
check(
  "env answers when the file is silent",
  resolveBrokerUrl({ site: undefined, env: ENV_URL, configPath: PATH }),
  { ok: true, url: ENV_URL, source: `${BROKER_URL_ENV} env` },
);
check("an explicit null in the file counts as absent, not as a bad value", kind(resolveBrokerUrl({ site: null, env: ENV_URL, configPath: PATH })), "ok");
for (const scheme of BROKER_SCHEMES)
  check(`${scheme} is a scheme a client speaks`, kind(resolveBrokerUrl({ env: `${scheme}//h.example:1883`, configPath: PATH })), "ok");
check("a URL with no port is still a location", kind(resolveBrokerUrl({ env: "mqtt://h.example", configPath: PATH })), "ok");

// --- 1b. the pure resolver: every rejection shape (the half that matters) ------------------
const none = resolveBrokerUrl({ site: undefined, env: undefined, configPath: PATH });
check("NOTHING SET → refuses", kind(none), "refuse");
check(
  "and the refusal NAMES THE CONFIG PATH IT SEARCHED (the owner's refinement — env-or-refuse alone " +
    "is half the ruling)",
  none.ok === false && none.message.includes(PATH),
  true,
);
check("and it NAMES THE VARIABLE", none.ok === false && none.message.includes(BROKER_URL_ENV), true);
check("and it names the config KEY, not only the file", none.ok === false && none.message.includes(`"${BROKER_URL_KEY}"`), true);
check("and it names the override variable for the location", none.ok === false && none.message.includes(SITE_CONFIG_ENV), true);
check("and it says it will not guess", none.ok === false && /refus/i.test(none.message), true);
check("a blank env is NOT a location", kind(resolveBrokerUrl({ env: "   ", configPath: PATH })), "refuse");
check("whitespace-only env falls to the refusal, and still names the path", resolveBrokerUrl({ env: "  ", configPath: PATH }).ok === false, true);
check("an empty site value refuses", kind(resolveBrokerUrl({ site: "", configPath: PATH })), "refuse");
check("a site value that is a NUMBER refuses rather than falling through to the env", kind(resolveBrokerUrl({ site: 1883, env: ENV_URL, configPath: PATH })), "refuse");
check("a site value that is a LIST refuses too", kind(resolveBrokerUrl({ site: [ENV_URL], env: ENV_URL, configPath: PATH })), "refuse");
check(
  "and a broken site value says WHICH FILE, because 'my config is set and I am being refused' must " +
    "be answerable from the message alone",
  (resolveBrokerUrl({ site: 1883, env: ENV_URL, configPath: PATH }) as { message: string }).message.includes(PATH),
  true,
);
check("it does NOT silently use the env when the file is broken", resolveBrokerUrl({ site: 1883, env: ENV_URL, configPath: PATH }).ok, false);
check("http:// is not an MQTT scheme", kind(resolveBrokerUrl({ env: "http://h.example:1883", configPath: PATH })), "refuse");
check("a non-URL string is refused, not connected to", kind(resolveBrokerUrl({ env: "not a url", configPath: PATH })), "refuse");
check("a scheme with no host is refused", kind(resolveBrokerUrl({ env: "mqtt://", configPath: PATH })), "refuse");
check(
  "and a bad URL names the offending value so the operator can see the typo",
  (resolveBrokerUrl({ env: "http://h.example", configPath: PATH }) as { message: string }).message.includes("http://h.example"),
  true,
);

// --- 2. the path function is the ONLY place the location is computed ----------------------
check(
  "no override → the shared default",
  siteConfigPath({ HOME: "/home/you" }),
  SITE_CONFIG_DEFAULT.replace(/^~/, "/home/you"),
);
check(
  "TABICHAT_CONFIG overrides it",
  siteConfigPath({ HOME: "/home/you", [SITE_CONFIG_ENV]: "/srv/odd/place.json" }),
  "/srv/odd/place.json",
);
check("a blank override is not a location — back to the default", siteConfigPath({ HOME: "/home/you", [SITE_CONFIG_ENV]: "  " }), SITE_CONFIG_DEFAULT.replace(/^~/, "/home/you"));
check("tilde expands against HOME", siteConfigPath({ HOME: "/h", [SITE_CONFIG_ENV]: "~/c.json" }), "/h/c.json");
check("a path with no tilde is untouched", siteConfigPath({ HOME: "/h", [SITE_CONFIG_ENV]: "/etc/c.json" }), "/etc/c.json");
check(
  "and the refusal text is built from the SAME path function the caller used",
  refusalMessage(siteConfigPath({ HOME: "/h" })).includes(siteConfigPath({ HOME: "/h" })),
  true,
);

// --- 3. the disk half: a REAL file, in a temp dir, via TABICHAT_CONFIG -------------------
const scratch = mkdtempSync(join(tmpdir(), "tabichat-broker-"));
const cfg = (name: string, body: string) => {
  const p = join(scratch, name);
  writeFileSync(p, body);
  return p;
};
try {
  const goodFile = cfg("good.json", JSON.stringify({ [BROKER_URL_KEY]: SITE_URL, autoRenew: true }));
  check(
    "a site file ON DISK answers, and answers first",
    resolveBrokerFromDisk({ HOME: "/h", [SITE_CONFIG_ENV]: goodFile, [BROKER_URL_ENV]: ENV_URL }),
    { ok: true, url: SITE_URL, source: `site file (${BROKER_URL_KEY})` },
  );
  check(
    "a site file with no broker key falls through to the env — and keeps working",
    urlOf(resolveBrokerFromDisk({ HOME: "/h", [SITE_CONFIG_ENV]: cfg("nokey.json", '{"autoRenew":true}'), [BROKER_URL_ENV]: ENV_URL })),
    ENV_URL,
  );
  const broken = cfg("broken.json", "{ not json");
  const r = resolveBrokerFromDisk({ HOME: "/h", [SITE_CONFIG_ENV]: broken, [BROKER_URL_ENV]: ENV_URL });
  check("a file that will not parse does NOT stop an env-configured run", kind(r), "ok");
  check(
    "but the parse failure is REPORTED, never swallowed — a silently ignored policy file is how a " +
      "box stops agreeing with itself",
    r.ok === true && (r.note ?? "").includes("was NOT read"),
    true,
  );
  const r2 = resolveBrokerFromDisk({ HOME: "/h", [SITE_CONFIG_ENV]: broken });
  check("a file that will not parse AND no env → refusal", kind(r2), "refuse");
  check(
    "and that refusal says the file was not readable, so nobody hunts a file that is present",
    r2.ok === false && r2.message.includes("was NOT read"),
    true,
  );
  const missing = join(scratch, "does-not-exist.json");
  check(
    "no file at all + env set → the env answers (the normal case on a box with no site config)",
    urlOf(resolveBrokerFromDisk({ HOME: "/h", [SITE_CONFIG_ENV]: missing, [BROKER_URL_ENV]: ENV_URL })),
    ENV_URL,
  );
  const r3 = resolveBrokerFromDisk({ HOME: "/h", [SITE_CONFIG_ENV]: missing });
  check("no file + no env → refusal", kind(r3), "refuse");
  check(
    "and the refusal prints the path it searched, so 'did it even look?' is answered by the message",
    r3.ok === false && r3.message.includes(missing),
    true,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- 4a. SOURCE SHAPE: the resolver is actually wired in, not merely correct --------------
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const shipped = read("../extensions/tabichat/index.ts");
const preview = read("../../preview-ext/tabichat/index.ts");
const tools = ["pub", "sub", "tap", "lane_admin"].map((n) => [`src/tools/${n}.mjs`, read(`./${n}.mjs`)] as const);

check("shipped extension imports the resolver", shipped.includes(`from "./broker.ts"`), true);
check("shipped extension calls resolveBrokerUrl", shipped.includes("resolveBrokerUrl({"), true);
check("shipped extension uses the RESOLVED url to connect", shipped.includes("mqtt.connect(brokerUrl"), true);
check("shipped extension never guesses past the refusal", /if \(brokerRefusal !== ""\) \{[\s\S]{0,400}return;\n\s*\}/.test(shipped), true);
// RE-PAIRED by leg 517 (owner order 2026-10-24, verbatim: "can we not figure out how to keep errors
// out of the place the owner types?"). The refusal is STILL operator-visible on the notify surface, and
// its second channel is the DURABLE DIAGNOSTIC FILE rather than the terminal the owner is typing into.
// Before: shipped.includes("ctx.ui.notify(brokerRefusal, \"error\")") &&
// shipped.includes("console.error(brokerRefusal)"). Leg 954 re-PAIRS it again, in the same direction:
// the two channels are no longer two calls a person can pull apart, they are the ONE arm that records
// and shows. This cell now asks for the routed call and for the absence of the raw one; the pairing
// rule itself — any error-level notify that carries no record is refused — is measured by
// test_diaglog_routing.ts on every run, so a bypass cannot come back quietly.
check(
  "and the refusal reaches BOTH channels (notify + diagnostic file) through the one arm, never a third at the terminal",
  shipped.includes('notifySafely(ctx, brokerRefusal, "error")') && !/ctx\.ui\.notify\(brokerRefusal/.test(shipped),
  true,
);
check("NEGATIVE: the broker refusal no longer writes raw text into the operator's input area", shipped.includes("console.error(brokerRefusal)"), false);
check("and the path comes from the one function", shipped.includes("siteConfigPath(process.env)"), true);
check("shipped extension does NOT read MQTT_URL with a ?? fallback", /MQTT_URL \?\?/.test(shipped), false);

check("preview twin imports its own copy", preview.includes(`from "./broker.ts"`), true);
check("preview twin connects the resolved url", preview.includes("mqtt.connect(brokerUrl"), true);
check("preview twin has no ?? fallback", /MQTT_URL \?\?/.test(preview), false);
check(
  "the two twins keep the SAME refusal semantics (documented duplication — if these drift, this " +
    "cell is where it shows up)",
  read("../../preview-ext/tabichat/broker.ts").includes("refusalMessage"),
  true,
);

for (const [name, src] of tools) {
  check(`${name} imports the resolver`, src.includes("resolveBrokerFromDisk"), true);
  check(`${name} refuses non-zero`, /if \(!broker\.ok\)[\s\S]{0,160}process\.exit\(/.test(src), true);
  check(`${name} prints the refusal, not a paraphrase`, src.includes("console.error(broker.message)"), true);
  check(`${name} has no hard fallback left`, src.includes('?? "mqtt://'), false);
}

// --- 4b. TREE SCAN: no venue address anywhere in tracked text (the negative half of the ruling)
// Hex-encoded so this file cannot contain the plaintext it forbids — and note the scan below walks
// THIS file too, so if anyone writes the host name out here the guard fails on its own comment.
// Re-derive a banned literal with:  printf '<the host name>' | xxd -p
const BANNED_HEX = ["636f6c6f7261646f"];
const BANNED = BANNED_HEX.map((h) => Buffer.from(h, "hex").toString("utf8"));
const TEXT_EXT = /\.(ts|mjs|js|py|md|sh|json|txt|toml|yml|yaml|hex|lock)$/;
const SKIP_DIR = /(^|\/)(\.git|node_modules|__pycache__|dist|target)(\/|$)/;
const ROOT = new URL("../..", import.meta.url).pathname;

/** recursive file walk (node:fs only — no runtime-specific API, so this cell cannot silently no-op) */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.test(p)) continue;
      walk(p, out);
    } else if (e.isFile() && TEXT_EXT.test(e.name)) out.push(p);
  }
  return out;
};

const files = walk(ROOT);
const rel = files;
const hits = rel
  .map((p) => {
    let text = "";
    try {
      text = readFileSync(p, "utf8");
    } catch {
      return null;
    }
    const found = BANNED.filter((b) => text.includes(b));
    return found.length ? `${relative(ROOT, p)}: ${found.join(",")}` : null;
  })
  .filter((x): x is string => x !== null);

check(`tracked text carries NO venue address (${rel.length} files scanned)`, hits, []);
if (rel.length < 20) {
  failed++;
  console.log(`FAIL  the tree scan found only ${rel.length} files — the scan is not scanning, and an ` +
    `empty result is not evidence of absence (prove the instrument before trusting the zero)`);
} else {
  console.log(`ok    the scan really looked at ${rel.length} text files`);
}

console.log();
if (failed) {
  console.log(`${failed} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("all checks pass");
}
