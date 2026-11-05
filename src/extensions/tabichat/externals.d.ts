// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * Ambient stubs for the SCOPED typecheck gate (tools/typecheck_ext.ts).
 *
 * The three package externals and `node:fs` are exactly what `bun build --external` declares at
 * the shipped build gate — this repo does not vendor their types, so the environment says
 * "Cannot find module" for reasons unrelated to the code. An untyped import is `any`, and `any`
 * would HIDE tonight's defect class: it did not — the failing thing is the FRESH OBJECT LITERAL
 * passed to `makeRoomLogIo`, and a literal is checked member-by-member against the declared
 * parameter type regardless of where each identifier's type came from. `TS2741: Property
 * 'appendFileSync' is missing` is what this file exists to let surface, at the one call site that
 * matters. mqtt and the pi SDK are typed explicitly because index.ts uses their NAMED TYPES
 * (`mqtt.MqttClient`, `ExtensionAPI`, `ExtensionContext`) at type positions, and a shorthand stub
 * makes those "namespace has no exported member" — noise, not signal.
 */
declare module "node:fs" {
  export function readFileSync(p: string, enc?: string): string;
  export function appendFileSync(p: string, data: string): void;
  export function writeFileSync(p: string, data: string, opts?: { mode?: number }): void;
  export function mkdirSync(p: string, o?: { recursive?: boolean; mode?: number }): void;
  export function chmodSync(p: string, mode: number): void;
  export function existsSync(p: string): boolean;
  export function renameSync(a: string, b: string): void;
  export function readdirSync(p: string): string[];
  export function statSync(p: string): { size: number; isDirectory(): boolean };
  export function rmSync(p: string, o?: { recursive?: boolean; force?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
}
declare module "mqtt" {
  namespace mqtt {
    type MqttClient = any;
    function connect(url: string | URL, opts?: any): MqttClient;
  }
  export = mqtt;
}
declare module "@earendil-works/pi-ai" {
  export const Type: any;
}
declare module "@earendil-works/pi-coding-agent" {
  export const defineTool: any;
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export type ExtensionCommandContext = any;
}
declare var process: any;
declare var Buffer: any;
// `payload: Buffer` is a TYPE position (handleInbound); the var declaration above is only the value.
interface Buffer {
  toString(enc?: string): string;
  [k: string]: any;
}
