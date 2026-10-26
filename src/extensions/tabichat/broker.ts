// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * BROKER LOCATION — tabichat is SITE-AGNOSTIC by design: no default, must be set.
 *
 * The two requirements this closes, stated as the rules they are:
 *   "tabichat repo needs to be made site agnostic. 1. no default, must be set."
 * and its refinement — the config door, not a hardcoded address:
 *   "the code needs to be updated so the mqtt url can be set in a config, not hardcoded. 1. ok"
 *
 * THREE STEPS, AND NO FOURTH THAT GUESSES A HOST:
 *   1. the site config file   key `mqttUrl`   (path from ONE function: siteConfigPath)
 *   2. the environment        MQTT_URL
 *   3. REFUSE — loudly, and non-zero in every standalone tool, naming BOTH the config path it
 *      searched and the variable it wanted. Nothing in this repo ships a broker address any more:
 *      not as a default, not in prose, not as an example.
 *
 * WHY THE CONFIG COMES FIRST. A box with many seats has many launcher lines, and a broker address
 * repeated per seat is a address that can disagree with itself. The site file is set ONCE for the
 * venue (the same door s136 Leg E opened for auto-renew, and the same precedence shape that row
 * documents); the env stays as the per-seat override a launcher or a docker `-e` can set.
 *
 * WHY A BAD VALUE IS A REFUSAL AND NOT A FALL-THROUGH. A site file that sets `mqttUrl` to an empty
 * string or a number is a mistake someone made on purpose-configured ground. Silently ignoring it
 * and using the env instead leaves the box disagreeing with its own file — the failure class the
 * existing `siteConfigNote` line in index.ts already names. So a present-but-unusable slot refuses
 * and says which file and which key.
 */
import { readFileSync } from "node:fs";
import { SITE_CONFIG_DEFAULT, SITE_CONFIG_ENV, parseSiteConfig } from "./laneadmin.ts";

/** The one environment variable that can carry a broker location. */
export const BROKER_URL_ENV = "MQTT_URL";
/** The one key inside the site config file that can carry it. */
export const BROKER_URL_KEY = "mqttUrl";
/** Schemes mqtt tooling accepts. Anything else is a typo, not a location. */
export const BROKER_SCHEMES = ["mqtt:", "mqtts:", "ws:", "wss:"];

/**
 * THE ONE FUNCTION THAT KNOWS WHERE THE SITE CONFIG LIVES.
 * `TABICHAT_CONFIG` overrides; otherwise the shared default from laneadmin.ts. Tilde is expanded
 * against HOME, matching how index.ts already resolves the same path for the renew policy. If the
 * owner rules a different location, this function plus that constant is the whole change — no call
 * site repeats the arithmetic.
 */
export const siteConfigPath = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const raw = (env[SITE_CONFIG_ENV] ?? "").trim() || SITE_CONFIG_DEFAULT;
  return raw.replace(/^~(?=\/|$)/, env.HOME ?? "~");
};

export type BrokerResolution =
  | { ok: true; url: string; source: string }
  | { ok: false; message: string };

/**
 * The refusal, in one sentence, naming BOTH doors the operator can open. Every caller prints this
 * verbatim, so a customer who forgot the setting is never left with a mystery refusal.
 */
export const refusalMessage = (configPath: string): string =>
  `[tabichat] no broker configured — refusing to guess one. Set "${BROKER_URL_KEY}" in the site ` +
  `config I searched at ${configPath} (override its location with ${SITE_CONFIG_ENV}), or export ` +
  `${BROKER_URL_ENV}=mqtt://<your-broker-host>:1883. tabichat ships no broker address: it is a chat ` +
  `client, not an MQTT service, so the address is yours to configure.`;

/** A usable broker URL, or the reason it is not one. Never a silent pass. */
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
      reason: `${where} = "${url}" is not a URL I can parse; expected ${BROKER_SCHEMES.join(", ")} ` +
        `followed by host[:port]`,
    };
  }
  if (!BROKER_SCHEMES.includes(parsed.protocol))
    return {
      ok: false,
      reason: `${where} = "${url}" uses scheme "${parsed.protocol}", which no MQTT client speaks; ` +
        `expected one of ${BROKER_SCHEMES.join(", ")}`,
    };
  if (parsed.hostname === "")
    return { ok: false, reason: `${where} = "${url}" carries no host name` };
  return { ok: true, url };
};

/**
 * The resolution itself — PURE: it takes the two layers and the path it is supposed to have
 * searched, and decides. No fs, no env, so both halves of its truth table hold in a test without a
 * broker, a terminal, or a home directory.
 */
export const resolveBrokerUrl = (layers: {
  site?: unknown;
  env?: string | undefined;
  configPath: string;
}): BrokerResolution => {
  const { site, configPath } = layers;
  const envVal = layers.env;

  // 1. the site file, when it has the key at all
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

  // 2. the environment — a blank string counts as unset here, the way MQTT_ROOM already behaves
  if (typeof envVal === "string" && envVal.trim() !== "") {
    const checked = checkBrokerUrl(envVal, `${BROKER_URL_ENV} env`);
    if (!checked.ok) return { ok: false, message: `[tabichat] refusing to connect: ${checked.reason}` };
    return { ok: true, url: checked.url, source: `${BROKER_URL_ENV} env` };
  }

  // 3. refuse, naming both doors
  return { ok: false, message: refusalMessage(configPath) };
};

/**
 * Convenience for processes that own no parsed config yet (the one-shot tools in `src/tools/`):
 * read the site file and resolve in one call. A missing file is the normal case on a box that never
 * configured one, so it is NOT an error here — the refusal comes from having no layer at all.
 * A file that exists and will not parse is reported through `note`, exactly as index.ts reports it.
 */
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
  // another layer saved the run: on its own it is a warning beside a working connection, and on
  // top of a refusal it explains why the refusal named a file that looks like it exists.
  if (!r.ok && note) return { ...r, message: `${note}. ${r.message}` };
  return note ? { ...r, note } : r;
};
