// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Virtual models under tabith/*: each always runs the physical model named
// in its env var ("provider/model-id", see pi --list-models) at a fixed
// thinking level. Set the env vars in ~/.bashrc, e.g.
//   export LEAD_MODEL=opencode/qwen3.8-flash
//   export WORKER_V1_MODEL=opencode/qwen3.8-flash
//   export WORKER_V2_MODEL=openrouter/qwen/qwen3.8-flash
//   export ULTRA_MODEL=oregon/Qwen3.8-Flash-Next-Dynamic-oQ5e-BF16-PLE-mtp
// THINKING LEVEL: the level pinned in VIRTUALS below is the default, and it
// is what route() dispatches. Override it per role with <ROLE>_THINKING (the
// same stem as that role's model var), e.g.
//   export ULTRA_THINKING=medium     # off|minimal|low|medium|high|xhigh|max
// Like every env var here it is read at seat start, so a running seat keeps
// the level it started with; a fresh seat picks up a change. A value outside
// the list above is not ignored quietly: that role's requests stop with an
// error naming the variable, and /model keeps showing the pinned default.
// A virtual model declares no context window unless told one, so a fresh
// seat shows "limits unknown" (and the tabichat ctx advisory prints its
// startup warning) until the first response routes to a physical model.
// DEFAULT_CTX_WINDOW is the declared pre-first-response window; a per-role
// override is <ROLE>_CTX_WINDOW, e.g. AJAX_CTX_WINDOW=131072 — set it to the
// window of the physical model the role routes to.
const DEFAULT_CTX_WINDOW = 262144;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof LEVELS)[number];
const VIRTUALS = [
  // CANONICAL lead tier. Renamed 2026-10-09 (owner ok) from `lead-agent`, because that id collided
  // with the tabichat extension's fallback lead NICK of the same spelling -- four surfaces, one
  // string, and a seat told to "fix the dead nick" could edit this tier instead and break nothing
  // loudly. See TERMS.md in the tabith workspace, which is not in this repo. The id carries the
  // which is the honest thing for a name to say.
  { id: "lead-xhigh", env: "LEAD_MODEL", level: "xhigh" },
  // LEGACY alias, kept WORKING so no seat, alias or hand-typed launch that still says
  // `tabith/lead-agent` strands -- a rename that bricks a running fleet is worse than a duplicate
  // /model row. Same env stem, so LEAD_THINKING / LEAD_CTX_WINDOW behave identically here.
  // Remove only once nothing launches it any more (grep ~/.bashrc, tabichat-aliases.sh, seat
  // contracts; the collision-check script reports surface (2) each run).
  { id: "lead-agent", env: "LEAD_MODEL", level: "xhigh" },
  { id: "worker-v1", env: "WORKER_V1_MODEL", level: "medium" },
  { id: "worker-v2", env: "WORKER_V2_MODEL", level: "high" },
  { id: "ultra", env: "ULTRA_MODEL", level: "off" },
  { id: "ajax", env: "AJAX_MODEL", level: "medium" },
] as const;

// One role's thinking level: <ROLE>_THINKING when set and recognised, the
// pinned level otherwise. `bad` carries a rejected value so route() can fail
// loudly instead of quietly dispatching the default.
function levelFor(env: string, pinned: ThinkingLevel) {
  const name = `${env.replace(/_MODEL$/, "")}_THINKING`;
  const raw = process.env[name];
  if (raw === undefined || raw === "") return { level: pinned, bad: "", name };
  if ((LEVELS as readonly string[]).includes(raw))
    return { level: raw as ThinkingLevel, bad: "", name };
  return { level: pinned, bad: raw, name };
}

export default function (pi: ExtensionAPI) {
  for (const v of VIRTUALS) {
    const { level, bad, name } = levelFor(v.env, v.level);
    pi.registerVirtualModel({
      provider: "tabith",
      id: v.id,
      name: v.id,
      thinkingLevels: [level],
      contextWindow:
        Number(process.env[`${v.env.replace(/_MODEL$/, "")}_CTX_WINDOW`]) ||
        Number(process.env.DEFAULT_CTX_WINDOW) ||
        DEFAULT_CTX_WINDOW,
      route(_request, ctx) {
        if (bad)
          throw new Error(
            `tabith/${v.id}: ${name}="${bad}" is not a thinking level — use ${LEVELS.join("|")}, or unset ${name} to use "${level}"`,
          );
        const target = process.env[v.env] ?? "";
        const slash = target.indexOf("/");
        const model =
          slash > 0
            ? ctx.modelRegistry.find(target.slice(0, slash), target.slice(slash + 1))
            : undefined;
        if (!model)
          throw new Error(
            `tabith/${v.id}: ${v.env}="${target}" not found — set it to provider/model-id (see pi --list-models)`,
          );
        return { model, thinkingLevel: level };
      },
    });
  }
}
