// Copyright (c) 2026 Tabith LLC.
// Licensed under the Business Source License 1.1 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at the LICENSE
// file in the repository root. SPDX-License-Identifier: BUSL-1.1
// Truth table for the meta-only 400 instrument.
//   bun src/tools/test_400_meta_capture.ts      (exit 1 on any failure)
// Mocked pi events only — no provider call, no live lane, no pi session.
// Positive AND negative halves are required: an instrument that also fires on a
// clean or interrupted turn is worse than none, and the whole point of this build
// is that it writes NO payload bytes, so that is asserted as a check, not a comment.
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const META_DIR = mkdtempSync(join(tmpdir(), "400meta-test-"));
process.env.PI400_META_DIR = META_DIR;

const mod = await import("../extensions/pi-400-meta-capture.ts");
const {
	requestStats,
	isErrorStreamData,
	streamErrorText,
	upstreamFailureFromEnd,
	sanitizeErrorText,
	writeRequestMeta,
	writeErrorMeta,
	appendRevival,
	MAX_ERROR_EVENTS,
	MAX_REQUEST_LINES,
	ERROR_TEXT_MAX,
	default: install,
} = mod;

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

const EVENTS = join(META_DIR, "events.jsonl");
const REQUESTS = join(META_DIR, "requests.log");
const REVIVALS = join(META_DIR, "revivals.log");
const ALL_ARTIFACTS = [EVENTS, REQUESTS, REVIVALS];
const lines = (p: string) =>
	existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l)) : [];
const raw = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// A marker string that exists ONLY inside the fake payload. If it turns up in any
// file under META_DIR, the payload-exclusion rule is broken and this suite must go red.
const SECRET = "ZZ-PAYLOAD-CONTENT-MUST-NEVER-BE-WRITTEN-ZZ";
const fakePayload = {
	messages: [
		{ role: "user", content: [{ type: "text", text: SECRET }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		{ role: "toolResult", content: [{ type: "text", text: SECRET }] },
		{ role: "user", content: [{ type: "text", text: SECRET }] },
	],
	system: "still secret",
};

// --- pure detectors: positive half (the shapes we expect from a real refusal) ---
const sse400 = "400 event: error\ndata: {}\n\n";
check("frame object with type error", isErrorStreamData({ type: "error", error: { code: "rate_limit_error" } }), true);
check("frame object with nested error", isErrorStreamData({ error: { message: "boom" } }), true);
check("frame object with event error", isErrorStreamData({ event: "error" }), true);
check("frame string with SSE error", isErrorStreamData(sse400), true);

// --- pure detectors: negative half (content frames must never look like faults) ---
check("content delta is not an error", isErrorStreamData({ type: "content_block_delta", delta: { text: "hi" } }), false);
check("message_start is not an error", isErrorStreamData({ type: "message_start" }), false);
check("null data is not an error", isErrorStreamData(null), false);
check("number data is not an error", isErrorStreamData(42), false);
check("empty object is not an error", isErrorStreamData({}), false);

// --- agent_end reading, the event the live notice provably uses ---
check(
	"error ending yields code and text",
	upstreamFailureFromEnd([{ role: "assistant", stopReason: "error", errorMessage: sse400 }]),
	{ error_message: sse400, code: 400 },
);
check("clean stop is not a fault", upstreamFailureFromEnd([{ role: "assistant", stopReason: "stop" }]), null);
check("human abort is not a fault", upstreamFailureFromEnd([{ role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" }]), null);
check("tool use mid-flight is not a fault", upstreamFailureFromEnd([{ role: "assistant", stopReason: "toolUse" }]), null);
check("no assistant message is not a fault", upstreamFailureFromEnd([{ role: "user" }]), null);
check("non-error text still counted when code absent", upstreamFailureFromEnd([{ role: "assistant", stopReason: "error", errorMessage: "Connection reset" }])?.code, null);

// --- error-text redaction: the one text field we keep, scrubbed before it lands ---
check(
	"bearer token redacted from error text",
	(sanitizeErrorText("400 invalid api_key: Bearer abcdef.12345-secret") ?? "").includes("abcdef.12345"),
	false,
);
// Regression for the redaction ORDER rule: a generic key=<value> pass run first eats the
// word "Bearer" and strands the token value in the clear — and that field is the one
// text this instrument keeps. The tail of the token must be gone too.
check(
	"a key name before a token strands no part of it",
	(sanitizeErrorText("400 invalid api_key: Bearer abcdef.12345-secret") ?? "").includes("12345"),
	false,
);
check("credential shape counted, not kept", countHitsProbe(), true);
function countHitsProbe() {
	const t = sanitizeErrorText("password=hunter2 authorization: Bearer abc.def.ghi") ?? "";
	return !t.includes("hunter2") && !t.includes("abc.def.ghi");
}
check("whitespace collapsed to one line", sanitizeErrorText("a\n\n b\n c"), "a b c");
check("long text capped", (sanitizeErrorText("x".repeat(900)) ?? "").length <= ERROR_TEXT_MAX, true);
check("null error text stays null", sanitizeErrorText(null), null);
check("frame text is short and redacted", streamErrorText({ type: "error", error: { code: "overloaded", message: "server busy" } }), "error overloaded server busy");

// --- structural stats: sizes and counts only ---
const stats = requestStats(fakePayload);
check("message count read structurally", stats.message_count, 4);
check("tool result count", stats.tool_result_count, 1);
check("last role", stats.last_message_role, "user");
check("content part count", stats.content_part_count, 4);
check("request bytes are a size, not content", stats.request_bytes > 0 && stats.request_bytes < 1000, true);
check("token proxy is labelled an estimate", typeof stats.est_tokens, "number");
check("stats object carries no payload text", JSON.stringify(stats).includes(SECRET), false);

// --- write path: meta sidecar, no payload artifact, dir mode ---
writeRequestMeta({ sessionId: "s-test", seq: 1, payload: fakePayload, gapSincePrevRequestS: null, gapSincePrevResponseS: null, prevTurnDurationS: null, nowMs: 1_700_000_000_000 });
const req0 = lines(REQUESTS)[0];
check("request line written", req0?.session_id, "s-test");
check("request line has density fields", typeof req0?.gap_s_since_prev_request === "object" && typeof req0?.request_bytes === "number", true);
check("request line kept the structural counts", req0?.message_count, 4);
check("dir is 0700", (statSync(META_DIR).mode & 0o777).toString(8), "700");
check("no payload file exists anywhere", readdirSync(META_DIR).some((f) => f.includes("payload")), false);
check("request log holds no payload text", raw(REQUESTS).includes(SECRET), false);

const ev = writeErrorMeta({
	sessionId: "s-test",
	kind: "stream-error",
	sourceEvent: "agent_end",
	status: 400,
	httpStatusSeen: 200,
	headerCount: 7,
	errorText: sse400,
	seq: 1,
	streamFrames: 12,
	reqStats: stats,
	prevTurnDurationS: 3.2,
	gapSincePrevRequestS: 1.1,
	gapSincePrevResponseS: 0.4,
	nowMs: 1_700_000_001_000,
});
check("event class tagged", ev?.class, "stream-error");
check("http status seen is recorded (the 200 that hid the refusal)", ev?.http_status_seen, 200);
check("provider error text kept, sanitized", ev?.error_text, "400 event: error data: {}");
check("event file is 0600", (statSync(EVENTS).mode & 0o777).toString(8), "600");
check("event log holds no payload text", raw(EVENTS).includes(SECRET), false);

// --- caps and rolling ---
writeFileSync(EVENTS, Array.from({ length: MAX_ERROR_EVENTS }, (_, i) => JSON.stringify({ seq: i })).join("\n") + "\n");
check("event cap stops writing, no error", writeErrorMeta({ sessionId: "s", kind: "http", sourceEvent: "after_provider_response", status: 500, httpStatusSeen: 500, headerCount: 0, errorText: null, seq: 999, streamFrames: 0, reqStats: null, prevTurnDurationS: null, gapSincePrevRequestS: null, gapSincePrevResponseS: null }), null);
writeFileSync(REQUESTS, Array.from({ length: MAX_REQUEST_LINES + 25 }, (_, i) => JSON.stringify({ seq: i })).join("\n") + "\n");
writeRequestMeta({ sessionId: "s-roll", seq: 1, payload: { messages: [] }, gapSincePrevRequestS: null, gapSincePrevResponseS: null, prevTurnDurationS: null });
check("request log rolls to the cap", lines(REQUESTS).length, MAX_REQUEST_LINES);
check("rolling keeps the newest line", lines(REQUESTS)[MAX_REQUEST_LINES - 1]?.session_id, "s-roll");

// --- end-to-end through the real pi.on() surface, mocked events only ---
type Handler = (event: any, ctx: any) => void;
const makePi = () => {
	const handlers = new Map<string, Handler[]>();
	return {
		handlers,
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		async fire(event: string, payload: unknown, ctx: unknown) {
			for (const h of handlers.get(event) ?? []) await h(payload, ctx);
		},
	};
};
const ctx = { sessionManager: { getSessionId: () => "s-e2e" } };
const reset = () => {
	for (const p of ALL_ARTIFACTS) if (existsSync(p)) writeFileSync(p, "");
};

// CASE A: the death class we are chasing — HTTP 200, then a refusal mid-stream.
reset();
{
	const pi = makePi();
	install(pi as any);
	await pi.fire("turn_start", {}, ctx);
	await pi.fire("before_provider_request", { type: "before_provider_request", payload: fakePayload }, ctx);
	await pi.fire("after_provider_response", { type: "after_provider_response", status: 200, headers: { "x-request-id": "r1" } }, ctx);
	await pi.fire("provider_stream_event", { type: "provider_stream_event", provider: "opencode", api: "openai-completions", model: "m", data: { type: "error", error: { code: "rate_limit" } } }, ctx);
	await pi.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: sse400 }] }, ctx);
	await pi.fire("turn_end", {}, ctx);
	const evs = lines(EVENTS);
	check("A: exactly one event per failed turn (no double-write)", evs.length, 1);
	check("A: earliest signal wins", evs[0]?.class, "stream-frame");
	check("A: the HTTP layer never saw a refusal", evs[0]?.http_status_seen, 200);
	check("A: frame position recorded", evs[0]?.stream_frames_at_error, 1);
	check("A: density series has the request", lines(REQUESTS).length, 1);
	check("A: nothing on disk carries payload text", readdirSync(META_DIR).map((f) => raw(join(META_DIR, f))).join("").includes(SECRET), false);
}

// CASE B: no error frame surfaced — agent_end alone must still capture (the proven path).
reset();
{
	const pi = makePi();
	install(pi as any);
	await pi.fire("turn_start", {}, ctx);
	await pi.fire("before_provider_request", { type: "before_provider_request", payload: fakePayload }, ctx);
	await pi.fire("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	await pi.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: sse400 }] }, ctx);
	const evs = lines(EVENTS);
	check("B: agent_end captures on its own", evs.length, 1);
	check("B: class is stream-error", evs[0]?.class, "stream-error");
	check("B: source event is agent_end", evs[0]?.source_event, "agent_end");
	check("B: status code read from the provider's text", evs[0]?.status, 400);
	check("B: last_request counts came through", evs[0]?.last_request?.message_count, 4);
}

// CASE C: the HTTP class the old harness could already see, unchanged.
reset();
{
	const pi = makePi();
	install(pi as any);
	await pi.fire("turn_start", {}, ctx);
	await pi.fire("before_provider_request", { type: "before_provider_request", payload: fakePayload }, ctx);
	await pi.fire("after_provider_response", { type: "after_provider_response", status: 429, headers: { a: "1", b: "2" } }, ctx);
	const evs = lines(EVENTS);
	check("C: HTTP refusal captured", evs.length, 1);
	check("C: class is http", evs[0]?.class, "http");
	check("C: status is the HTTP status", evs[0]?.status, 429);
	check("C: header count, not header values", evs[0]?.header_count, 2);
	check("C: no header value written", raw(EVENTS).includes('"a"'), false);
}

// CASE D: the negative half — a healthy turn must produce NO event line.
reset();
{
	const pi = makePi();
	install(pi as any);
	await pi.fire("turn_start", {}, ctx);
	await pi.fire("before_provider_request", { type: "before_provider_request", payload: fakePayload }, ctx);
	await pi.fire("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	await pi.fire("provider_stream_event", { type: "provider_stream_event", provider: "p", api: "a", model: "m", data: { type: "text_delta", text: "fine" } }, ctx);
	await pi.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	await pi.fire("turn_end", {}, ctx);
	check("D: clean turn writes no event", lines(EVENTS).length, 0);
	check("D: clean turn still samples density", lines(REQUESTS).length, 1);
}

// CASE E: a human interrupt is not an upstream fault.
reset();
{
	const pi = makePi();
	install(pi as any);
	await pi.fire("turn_start", {}, ctx);
	await pi.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" }] }, ctx);
	check("E: interrupt writes no event", lines(EVENTS).length, 0);
}

// CASE F: revival line after failures, and silent-fail on a malformed ctx.
reset();
{
	const pi = makePi();
	install(pi as any);
	await pi.fire("turn_start", {}, ctx);
	await pi.fire("after_provider_response", { type: "after_provider_response", status: 500, headers: {} }, ctx);
	await pi.fire("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	check("F: revival recorded after a captured failure", existsSync(REVIVALS) && raw(REVIVALS).includes("s-e2e revived"), true);
	const beforeMalformed = lines(EVENTS).length;
	let threw = false;
	try {
		await pi.fire("before_provider_request", { type: "before_provider_request", payload: fakePayload }, {});
		await pi.fire("agent_end", { type: "agent_end", messages: "not-an-array" }, ctx);
		await pi.fire("agent_end", { type: "agent_end" }, ctx);
		await pi.fire("provider_stream_event", { data: null }, undefined);
		await pi.fire("after_provider_response", { type: "after_provider_response", status: 200, headers: null }, ctx);
	} catch {
		threw = true;
	}
	check("F: missing ctx never throws out of a lane", threw, false);
	// The one line already there is CASE F's own deliberate HTTP 500. Nothing malformed may add to it:
	// the only later write is the stream-frame error that the last, well-shaped fire SHOULD produce.
	check("F: malformed events wrote nothing", lines(EVENTS).length, beforeMalformed);
	check("F: only event so far is the HTTP one", lines(EVENTS).every((e) => e.class === "http"), true);
}

appendRevival("s-direct", 2);
check("revival line is id + count only", raw(REVIVALS).includes("s-direct revived") && !raw(REVIVALS).includes(SECRET), true);

console.log(failed === 0 ? "\nall checks pass" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
