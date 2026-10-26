// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
/**
 * pi-400-meta-capture.ts — passive provider-failure METADATA instrument.
 *
 * Part of the 400-lane-death investigation. This is the meta-only rebuild of the
 * s22 harness (`work5/pi-400-capture.ts`), retargeted on the owner's word
 * (2026-10-12): the old tool wrote the RAW request payload — the whole conversation
 * — to disk, and the owner declined that trade ("delete it"). No request bytes are
 * written here, in any form, ever. What remains is the measurable part of the
 * question: does request DENSITY (bytes and requests per minute) predict a death,
 * and what does the provider's own error text say when one happens.
 *
 * Why a second event path: the s22 instrument never fired. Its only trigger was
 * `after_provider_response` with `status >= 400` — an HTTP-level signal. If a
 * refusal arrives MID-STREAM, that handler is presented a 2xx status and sees
 * nothing. `agent_end` is provably the event that does see them: the live tabichat
 * extension renders its upstream notice
 * ("[tabichat] UPSTREAM 400 provider error — turn ended, not retried; pi shows the provider's
 * message.") from `event.messages` in its own `agent_end` handler — `upstreamErrorNote(msgs)` in
 * `src/extensions/tabichat/index.ts`, whose text comes from `buildNote` in
 * `src/extensions/tabichat/errnote.ts`, which reads `stopReason === "error"` and `errorMessage`.
 * This module reads the same two
 * fields off the same event, so it fires exactly where the notice fires.
 * `provider_stream_event` is added as an EARLY, opportunistic path: if pi hands the
 * error frame through it before the turn ends, we record the frame position, which
 * is what tells us the failure was mid-stream rather than at the HTTP layer.
 *
 * ARTIFACTS (all metadata; all 0600 inside a 0700 dir):
 *   <META_DIR>/requests.log   one JSONL line per provider request (density series)
 *   <META_DIR>/events.jsonl   one JSONL line per captured failure, with class
 *   <META_DIR>/revivals.log   one line when a session that failed then succeeded
 *
 * SURVIVAL RULES BAKED INTO THIS CODE (inherited from the s22 harness, unchanged):
 *  - NOTHING is ever echoed to stdout or to any other channel. Silent by design.
 *  - No request payload, message text, header value, or credential is written.
 *    Only counts, sizes, timings, and the provider's own error text.
 *  - `credential_shape_hits` counts regex matches only — matched text is never
 *    retained anywhere, including in the error-text field, which is redacted
 *    through the same patterns before it is written.
 *  - Every handler body is wrapped in try/catch that swallows silently: a capture
 *    failure must NEVER break or kill a live lane.
 *  - Hard caps: the event log stops at MAX_ERROR_EVENTS lines, the request log
 *    rolls at MAX_REQUEST_LINES. Stop writing, never error.
 *
 * Load (per lane, without touching ~/.pi/agent/**):
 *   pi --extension "$REPO/src/extensions/pi-400-meta-capture.ts"   # $REPO = this repo's root
 */

import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EndMessage } from "./tabichat/errnote.ts";

/** Meta-only output root. Override with PI400_META_DIR (the unit test does). */
const META_DIR = process.env.PI400_META_DIR || "/tmp/tabichat/400meta";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Stop writing failures past this many captured events. */
export const MAX_ERROR_EVENTS = 200;
/** Roll the density series past this many request lines. */
export const MAX_REQUEST_LINES = 5000;
/** Provider error text is short; cap it anyway so a dump cannot become a blob. */
export const ERROR_TEXT_MAX = 300;

const REQUESTS_LOG = "requests.log";
const EVENTS_LOG = "events.jsonl";
const REVIVALS_LOG = "revivals.log";

// Count-only credential-shape scan. We NEVER retain or display matched text.
const CREDENTIAL_PATTERNS: RegExp[] = [
	/api[_-]?key/gi,
	/secret/gi,
	/password/gi,
	/\bbearer\s+[a-z0-9._~+/-]+={0,2}/gi,
	/AKIA[0-9A-Z]{16}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
	/-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
	/authorization/gi,
	/x-api-key/gi,
];

/**
 * Value-bearing shapes: here the MATCH INCLUDES the secret, so redaction strips the
 * value rather than only the word that flagged it. Used for the one text field we
 * keep; the count above still uses CREDENTIAL_PATTERNS.
 * ORDER MATTERS: specific token shapes run first — a generic `key=<value>` rule run
 * first swallows the word `Bearer` and leaves the token itself naked behind it.
 */
const CREDENTIAL_VALUE_PATTERNS: RegExp[] = [
	/\bbearer\s+[a-z0-9._~+/-]+={0,2}/gi,
	/AKIA[0-9A-Z]{16}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
	/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
	/\b(password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)\b\s*[=:]\s*[^\s,;"']+/gi,
];

export function countCredentialHits(text: string): number {
	let total = 0;
	for (const pattern of CREDENTIAL_PATTERNS) {
		pattern.lastIndex = 0;
		let m = pattern.exec(text);
		while (m !== null) {
			total += 1;
			m = pattern.exec(text);
		}
	}
	return total;
}

/**
 * Redact credential shapes out of the provider's own error text, then collapse to
 * one line and cap it. The SSE frame is provider output, not lane content, so it
 * is the one text field kept — but it passes the same filter as everything else.
 */
export function sanitizeErrorText(text: string | null): string | null {
	if (text === null) return null;
	let out = text;
	for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
		pattern.lastIndex = 0;
		out = out.replace(pattern, "<credential-shape>");
	}
	out = out.replace(/\s+/g, " ").trim();
	if (out.length > ERROR_TEXT_MAX) out = `${out.slice(0, ERROR_TEXT_MAX - 1)}…`;
	return out;
}

function safeSerialize(payload: unknown): string {
	try {
		const s = JSON.stringify(payload);
		return typeof s === "string" ? s : String(payload);
	} catch {
		return "";
	}
}

/**
 * Structural counts only. Reads array length, role strings, and content part types;
 * never reads or retains any text body. `bytes` is a SIZE, computed in memory and
 * thrown away — the serialized payload is never written anywhere.
 */
export function requestStats(payload: unknown): {
	request_bytes: number;
	message_count: number | null;
	last_message_role: string | null;
	tool_result_count: number | null;
	content_part_count: number | null;
	est_tokens: number | null;
} {
	const serialized = safeSerialize(payload);
	const bytes = serialized.length;
	const out = {
		request_bytes: bytes,
		message_count: null as number | null,
		last_message_role: null as string | null,
		tool_result_count: null as number | null,
		content_part_count: null as number | null,
		// Rough size proxy for a throughput theory. Explicitly an estimate.
		est_tokens: bytes > 0 ? Math.round(bytes / 4) : null,
	};
	try {
		if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).messages)) {
			const msgs = (payload as Record<string, unknown>).messages as Record<string, unknown>[];
			out.message_count = msgs.length;
			const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
			out.last_message_role = last && typeof last.role === "string" ? last.role : null;
			let toolResults = 0;
			let parts = 0;
			for (const m of msgs) {
				if (m && (m.role === "toolResult" || m.role === "tool_result" || m.role === "tool")) toolResults += 1;
				if (Array.isArray(m?.content)) parts += (m.content as unknown[]).length;
			}
			out.tool_result_count = toolResults;
			out.content_part_count = parts;
		}
	} catch {
		/* structural read failed — keep the nulls, never throw out of a lane */
	}
	return out;
}

/**
 * The last assistant message decides how a turn ended — same rule as the notice.
 * `aborted` is a human interrupt, not an upstream fault, so it yields null here too.
 */
export function upstreamFailureFromEnd(
	messages: readonly EndMessage[],
): { error_message: string | null; code: number | null } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const reason = String(m.stopReason ?? "").trim().toLowerCase();
		if (reason !== "error") return null;
		const text = typeof m.errorMessage === "string" ? m.errorMessage : null;
		const code = text ? Number(/^\D*(\d{3})\b/.exec(text)?.[1] ?? NaN) : NaN;
		return { error_message: text, code: Number.isFinite(code) ? code : null };
	}
	return null;
}

/**
 * Does a parsed stream frame look like a provider error rather than content?
 * Positive half: `{"type":"error",...}`, `{"error":{...}}`, an SSE-ish string with
 * `event: error`. Negative half (returns false): content deltas, message markers,
 * null, numbers, empty objects.
 */
export function isErrorStreamData(data: unknown): boolean {
	if (typeof data === "string") return /event:\s*error/i.test(data);
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	const type = typeof d.type === "string" ? d.type.toLowerCase() : "";
	if (type === "error") return true;
	if (d.error && typeof d.error === "object") return true;
	const event = typeof d.event === "string" ? d.event.toLowerCase() : "";
	return event === "error";
}

/** Extract a compact, redacted description of an error frame. */
export function streamErrorText(data: unknown): string {
	if (typeof data === "string") return sanitizeErrorText(data) ?? "";
	try {
		const d = data as Record<string, unknown>;
		const inner = (d?.error ?? {}) as Record<string, unknown>;
		const parts: string[] = [];
		const outerType = typeof d?.type === "string" ? d.type : "";
		const innerType = typeof inner.type === "string" ? inner.type : "";
		if (outerType) parts.push(outerType);
		if (innerType && innerType !== outerType) parts.push(innerType);
		if (typeof inner.code === "string") parts.push(inner.code);
		if (typeof inner.message === "string") parts.push(inner.message);
		const joined = parts.filter(Boolean).join(" ");
		return sanitizeErrorText(joined || "error frame") ?? "";
	} catch {
		return "error frame";
	}
}

function ensureMetaDir(): void {
	if (!existsSync(META_DIR)) {
		mkdirSync(META_DIR, { mode: DIR_MODE });
	}
	try {
		// mkdirSync mode is umask-filtered, and the dir may predate this run: assert it.
		if ((statSync(META_DIR).mode & 0o777) !== DIR_MODE) chmodSync(META_DIR, DIR_MODE);
	} catch {
		/* chmod is best-effort; never break a lane over it */
	}
}

function logPath(name: string): string {
	return join(META_DIR, name);
}

function countLines(path: string): number {
	try {
		return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).length;
	} catch {
		return 0;
	}
}

function appendMeta(path: string, obj: unknown): void {
	ensureMetaDir();
	const line = `${JSON.stringify(obj)}\n`;
	try {
		if (existsSync(path)) {
			chmodSync(path, FILE_MODE);
		}
		appendFileSync(path, line, { mode: FILE_MODE });
	} catch {
		/* a disk we cannot write is a disk we do not care about */
	}
}

/** Roll the request series down to the newest MAX_REQUEST_LINES lines. */
function rollRequestsLog(): void {
	const path = logPath(REQUESTS_LOG);
	if (countLines(path) <= MAX_REQUEST_LINES) return;
	try {
		const kept = readFileSync(path, "utf8")
			.split("\n")
			.filter((l) => l.length > 0)
			.slice(-MAX_REQUEST_LINES)
			.join("\n");
		writeFileSync(path, `${kept}\n`, { mode: FILE_MODE });
	} catch {
		/* swallow */
	}
}

export interface RequestMetaInput {
	sessionId: string;
	seq: number;
	payload: unknown;
	gapSincePrevRequestS: number | null;
	gapSincePrevResponseS: number | null;
	prevTurnDurationS: number | null;
	provider?: string | null;
	model?: string | null;
	nowMs?: number;
}

/**
 * One density sample. Exported so the unit test exercises the real write path with
 * a synthetic, inert payload (no provider needed).
 */
export function writeRequestMeta(args: RequestMetaInput): Record<string, unknown> {
	const now = args.nowMs ?? Date.now();
	const stats = requestStats(args.payload);
	const meta = {
		ts_utc: new Date(now).toISOString(),
		session_id: args.sessionId,
		seq: args.seq,
		provider: args.provider ?? null,
		model: args.model ?? null,
		gap_s_since_prev_request: args.gapSincePrevRequestS,
		gap_s_since_prev_response: args.gapSincePrevResponseS,
		prev_turn_duration_s: args.prevTurnDurationS,
		...stats,
		credential_shape_hits: 0, // counts only; see writeErrorMeta for the failure-side scan
	};
	appendMeta(logPath(REQUESTS_LOG), meta);
	rollRequestsLog();
	return meta;
}

export interface ErrorMetaInput {
	sessionId: string;
	/** "http" = status>=400 at the HTTP layer; "stream-error" = agent_end fault;
	 *  "stream-frame" = provider_stream_event error frame (earliest signal). */
	kind: "http" | "stream-error" | "stream-frame";
	sourceEvent: string;
	status: number | null;
	httpStatusSeen: number | null;
	headerCount: number | null;
	errorText: string | null;
	seq: number;
	streamFrames: number;
	reqStats: ReturnType<typeof requestStats> | null;
	prevTurnDurationS: number | null;
	gapSincePrevRequestS: number | null;
	gapSincePrevResponseS: number | null;
	nowMs?: number;
}

/**
 * One failure sample. Returns null when the event cap is reached. Writes NO payload:
 * the request-side numbers are the counts that were already derived in memory.
 */
export function writeErrorMeta(args: ErrorMetaInput): Record<string, unknown> | null {
	ensureMetaDir();
	const path = logPath(EVENTS_LOG);
	if (countLines(path) >= MAX_ERROR_EVENTS) return null;
	const now = args.nowMs ?? Date.now();
	const text = sanitizeErrorText(args.errorText);
	const meta = {
		ts_utc: new Date(now).toISOString(),
		session_id: args.sessionId,
		class: args.kind,
		source_event: args.sourceEvent,
		status: args.status,
		http_status_seen: args.httpStatusSeen,
		header_count: args.headerCount,
		error_text: text,
		credential_shape_hits: text ? countCredentialHits(text) : 0,
		seq: args.seq,
		stream_frames_at_error: args.streamFrames,
		prev_turn_duration_s: args.prevTurnDurationS,
		gap_s_since_prev_request: args.gapSincePrevRequestS,
		gap_s_since_prev_response: args.gapSincePrevResponseS,
		last_request: args.reqStats,
	};
	appendMeta(path, meta);
	return meta;
}

/** Append one revival line: session id and a count, nothing else. */
export function appendRevival(sessionId: string, capturedFailures: number): void {
	ensureMetaDir();
	const line = `${sessionId} revived ${new Date().toISOString()} after ${capturedFailures} captured failures\n`;
	try {
		const path = logPath(REVIVALS_LOG);
		if (existsSync(path)) chmodSync(path, FILE_MODE);
		appendFileSync(path, line, { mode: FILE_MODE });
	} catch {
		/* swallow */
	}
}

interface SessionState {
	seq: number;
	lastPayloadStats: ReturnType<typeof requestStats> | null;
	lastRequestAt: number | null;
	lastResponseAt: number | null;
	lastResponseStatus: number | null;
	lastResponseHeaderCount: number | null;
	turnStartAt: number | null;
	prevTurnDurationS: number | null;
	streamFrames: number;
	capturedThisTurn: boolean;
	capturedFailures: number;
}

function newState(): SessionState {
	return {
		seq: 0,
		lastPayloadStats: null,
		lastRequestAt: null,
		lastResponseAt: null,
		lastResponseStatus: null,
		lastResponseHeaderCount: null,
		turnStartAt: null,
		prevTurnDurationS: null,
		streamFrames: 0,
		capturedThisTurn: false,
		capturedFailures: 0,
	};
}

export default function (pi: ExtensionAPI) {
	const sessions = new Map<string, SessionState>();

	const stateFor = (id: string): SessionState => {
		let s = sessions.get(id);
		if (!s) {
			s = newState();
			sessions.set(id, s);
		}
		return s;
	};

	const sessionIdOf = (ctx: unknown): string | null => {
		try {
			const sm = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
			return typeof sm?.getSessionId === "function" ? sm.getSessionId() : null;
		} catch {
			return null;
		}
	};

	/** Record one failure of any class, at most once per turn, then count it. */
	const capture = (s: SessionState, id: string, args: Omit<ErrorMetaInput, "sessionId" | "seq" | "reqStats" | "prevTurnDurationS" | "gapSincePrevRequestS" | "gapSincePrevResponseS">): void => {
		const now = Date.now();
		const wrote = writeErrorMeta({
			sessionId: id,
			seq: s.seq,
			reqStats: s.lastPayloadStats,
			prevTurnDurationS: s.prevTurnDurationS,
			gapSincePrevRequestS: s.lastRequestAt !== null ? (now - s.lastRequestAt) / 1000 : null,
			gapSincePrevResponseS: s.lastResponseAt !== null ? (now - s.lastResponseAt) / 1000 : null,
			nowMs: now,
			...args,
		});
		if (wrote) {
			s.capturedFailures += 1;
			s.capturedThisTurn = true;
		}
	};

	pi.on("turn_start", (_event, ctx) => {
		try {
			const id = sessionIdOf(ctx);
			if (!id) return;
			const s = stateFor(id);
			s.turnStartAt = Date.now();
			s.capturedThisTurn = false;
			s.streamFrames = 0;
		} catch {
			/* swallow — never break a lane */
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		try {
			const id = sessionIdOf(ctx);
			if (!id) return;
			const s = stateFor(id);
			const now = Date.now();
			s.seq += 1;
			s.lastPayloadStats = requestStats(event.payload);
			const gapReq = s.lastRequestAt !== null ? (now - s.lastRequestAt) / 1000 : null;
			const gapResp = s.lastResponseAt !== null ? (now - s.lastResponseAt) / 1000 : null;
			writeRequestMeta({
				sessionId: id,
				seq: s.seq,
				payload: event.payload,
				gapSincePrevRequestS: gapReq,
				gapSincePrevResponseS: gapResp,
				prevTurnDurationS: s.prevTurnDurationS,
				nowMs: now,
			});
			s.lastRequestAt = now;
		} catch {
			/* swallow */
		}
	});

	pi.on("after_provider_response", (event, ctx) => {
		try {
			const id = sessionIdOf(ctx);
			if (!id) return;
			const s = stateFor(id);
			const now = Date.now();
			const gap = s.lastResponseAt !== null ? (now - s.lastResponseAt) / 1000 : null;
			s.lastResponseAt = now;
			s.lastResponseStatus = event.status;
			s.lastResponseHeaderCount = Object.keys(event.headers ?? {}).length;

			if (event.status >= 400) {
				// HTTP-layer refusal. Kept: it is the class the old harness could see.
				capture(s, id, {
					kind: "http",
					sourceEvent: "after_provider_response",
					status: event.status,
					httpStatusSeen: event.status,
					headerCount: s.lastResponseHeaderCount,
					errorText: null,
					streamFrames: s.streamFrames,
				});
			} else if (s.capturedFailures > 0) {
				// Success after captured failures in this session: record the revival.
				appendRevival(id, s.capturedFailures);
				s.capturedFailures = 0;
			}
		} catch {
			/* swallow */
		}
	});

	// Earliest possible signal: a parsed stream frame that says error. Opportunistic —
	// if pi does not surface the refusal as a frame, agent_end still catches it.
	pi.on("provider_stream_event", (event, ctx) => {
		try {
			const id = sessionIdOf(ctx);
			if (!id) return;
			const s = stateFor(id);
			s.streamFrames += 1;
			if (s.capturedThisTurn) return;
			if (!isErrorStreamData(event.data)) return;
			capture(s, id, {
				kind: "stream-frame",
				sourceEvent: "provider_stream_event",
				status: null,
				httpStatusSeen: s.lastResponseStatus,
				headerCount: s.lastResponseHeaderCount,
				errorText: streamErrorText(event.data),
				streamFrames: s.streamFrames,
			});
		} catch {
			/* swallow */
		}
	});

	// The proven path: this is the event the live upstream notice reads. A refusal
	// that arrives mid-stream ends the turn with an assistant message whose
	// stopReason is "error" and whose errorMessage is the SSE frame.
	pi.on("agent_end", (event, ctx) => {
		try {
			const id = sessionIdOf(ctx);
			if (!id) return;
			const s = stateFor(id);
			const msgs = ((event as { messages?: unknown }).messages ?? []) as EndMessage[];
			const fault = upstreamFailureFromEnd(msgs);
			if (!fault) return;
			if (s.capturedThisTurn) return;
			capture(s, id, {
				kind: "stream-error",
				sourceEvent: "agent_end",
				status: fault.code,
				httpStatusSeen: s.lastResponseStatus,
				headerCount: s.lastResponseHeaderCount,
				errorText: fault.error_message,
				streamFrames: s.streamFrames,
			});
		} catch {
			/* swallow */
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		try {
			const id = sessionIdOf(ctx);
			if (!id) return;
			const s = stateFor(id);
			const now = Date.now();
			if (s.turnStartAt !== null) {
				s.prevTurnDurationS = (now - s.turnStartAt) / 1000;
				s.turnStartAt = null;
			}
		} catch {
			/* swallow */
		}
	});
}
