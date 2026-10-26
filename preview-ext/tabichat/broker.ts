/**
 * BROKER LOCATION — PREVIEW TWIN of `src/extensions/tabichat/broker.ts`. Read that header first;
 * the three steps, the refusal text and the "no fourth step that guesses a host" rule are all there.
 *
 * WHY THIS FILE IS A COPY AND NOT AN IMPORT: `preview-ext/tabichat/` is a self-contained snapshot
 * meant to be dropped onto a box as one directory — it carries its own copies of mention.ts,
 * roommsg.ts, steer.ts, ctxwarn.ts, errnote.ts and exitlog.ts for exactly that reason, and it has
 * no laneadmin.ts to take the site-config constants from. So the two constants below are DUPLICATED
 * on purpose and are the only duplication in the resolution: if the owner rules a different config
 * location, `siteConfigPath()` in the src twin is the one edit, and this file's two lines are the
 * sync. The shipped extension is `src/extensions/tabichat/`; this preview is not what the fleet runs.
 *
 * Site-agnostic by design (the requirement, verbatim): "tabichat repo needs to be made site agnostic. 1. no
 * default, must be set." and its refinement: "the code needs to be updated so the mqtt url can be set in a config,
 * not hardcoded. 1. ok"
 */
import { readFileSync } from "node:fs";

/** The site-config door, with the same names the shipped extension uses (laneadmin.ts). */
export const SITE_CONFIG_ENV = "TABICHAT_CONFIG";
export const SITE_CONFIG_DEFAULT = "~/.pi/agent/tabichat.json";

/** The one environment variable that can carry a broker location. */
export const BROKER_URL_ENV = "MQTT_URL";
/** The one key inside the site config file that can carry it. */
export const BROKER_URL_KEY = "mqttUrl";
/** Schemes mqtt tooling accepts. Anything else is a typo, not a location. */
export const BROKER_SCHEMES = ["mqtt:", "mqtts:", "ws:", "wss:"];

export type BrokerResolution =
  | { ok: true; url: string; source: string }
  | { ok: false; message: string };

/**
 * THE ONE FUNCTION THAT KNOWS WHERE THE SITE CONFIG LIVES — see the src twin for why a rename must
 * be one edit. `TABICHAT_CONFIG` overrides; tilde expands against HOME.
 */
export const siteConfigPath = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const raw = (env[SITE_CONFIG_ENV] ?? "").trim() || SITE_CONFIG_DEFAULT;
  return raw.replace(/^~(?=\/|$)/, env.HOME ?? "~");
};

export const refusalMessage = (configPath: string): string =>
  `[tabichat] no broker configured — refusing to guess one. Set "${BROKER_URL_KEY}" in the site ` +
  `config I searched at ${configPath} (override its location with ${SITE_CONFIG_ENV}), or export ` +
  `${BROKER_URL_ENV}=mqtt://<your-broker-host>:1883. tabichat ships no broker address: it is a chat ` +
  `client, not an MQTT service, so the address is yours to configure.`;

export const checkBrokerUrl = (
  raw: string,
  where: string,
): { ok: true; url: string } | { ok: false; reason: string } => {
  const url = raw.trim();
  if (url === "")
    return { ok: false, reason: `${where} is set but blank — a blank location is not a location` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      reason:
        `${where} = "${url}" is not a URL I can parse; expected ${BROKER_SCHEMES.join(", ")} ` +
        `followed by host[:port]`,
    };
  }
  if (!BROKER_SCHEMES.includes(parsed.protocol))
    return {
      ok: false,
      reason:
        `${where} = "${url}" uses scheme "${parsed.protocol}", which no MQTT client speaks; ` +
        `expected one of ${BROKER_SCHEMES.join(", ")}`,
    };
  if (parsed.hostname === "")
    return { ok: false, reason: `${where} = "${url}" carries no host name` };
  return { ok: true, url };
};

/** Site file → env → refuse. PURE — see the src twin for the full rule set. */
export const resolveBrokerUrl = (layers: {
  site?: unknown;
  env?: string | undefined;
  configPath: string;
}): BrokerResolution => {
  const { site, configPath } = layers;
  const envVal = layers.env;
  if (site !== undefined && site !== null) {
    if (typeof site !== "string")
      return {
        ok: false,
        message:
          `[tabichat] refusing to connect: "${BROKER_URL_KEY}" in the site config ${configPath} is ` +
          `a ${Array.isArray(site) ? "list" : typeof site}, not a URL string. Fix the file or delete ` +
          `the key; I will not fall through to another layer while my own config is broken. ` +
          refusalMessage(configPath),
      };
    const checked = checkBrokerUrl(site, `site config ${configPath} → "${BROKER_URL_KEY}"`);
    if (!checked.ok) return { ok: false, message: `[tabichat] refusing to connect: ${checked.reason}` };
    return { ok: true, url: checked.url, source: `site file (${BROKER_URL_KEY})` };
  }
  if (typeof envVal === "string" && envVal.trim() !== "") {
    const checked = checkBrokerUrl(envVal, `${BROKER_URL_ENV} env`);
    if (!checked.ok) return { ok: false, message: `[tabichat] refusing to connect: ${checked.reason}` };
    return { ok: true, url: checked.url, source: `${BROKER_URL_ENV} env` };
  }
  return { ok: false, message: refusalMessage(configPath) };
};

/** A site config that will not parse is a POLICY FAILURE and must be loud, never a silent skip. */
export const parseSiteConfig = (
  text: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; reason: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not valid JSON (${String(e).split("\n")[0]})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, reason: "top level is not a JSON object" };
  return { ok: true, config: parsed as Record<string, unknown> };
};

/** Read the site file and resolve in one call — for processes that own no parsed config yet. */
export const resolveBrokerFromDisk = (
  env: Record<string, string | undefined> = process.env,
): BrokerResolution & { note?: string } => {
  const configPath = siteConfigPath(env);
  let site: unknown;
  let note: string | undefined;
  try {
    const parsed = parseSiteConfig(readFileSync(configPath, "utf8"));
    if (parsed.ok) site = parsed.config[BROKER_URL_KEY];
    else note = `site config ${configPath} was NOT read (${parsed.reason})`;
  } catch {
    // no file at all: silent, and the env layer still answers.
  }
  const r = resolveBrokerUrl({ site, env: env[BROKER_URL_ENV], configPath });
  // A site file that will not parse is a policy failure and must be said out loud WHETHER OR NOT
  // another layer saved the run.
  if (!r.ok && note) return { ...r, message: `${note}. ${r.message}` };
  return note ? { ...r, note } : r;
};
