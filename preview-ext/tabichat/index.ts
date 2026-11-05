import { existsSync, mkdirSync, statSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, } from "@earendil-works/pi-coding-agent";
import mqtt from "mqtt";
import { mentions } from "./mention.ts";
import { resolveBrokerFromDisk } from "./broker.ts";
import {
  absoluteSessionDue,
  ctxDeclarationLine,
  ctxModelLabel,
  ctxStatusText,
  ctxWarnLine,
  ctxWarnTargets,
  ctxWarnThreshold,
  ctxForceThreshold,
  ctxTokenThreshold,
  bashAllowedWhileForced,
  forceBlockNote,
  forceDue,
  forceRoomLine,
  giveUpLine,
  giveUpNow,
  rearmForce,
  RESUME_TEMPLATE,
  resumePath,
  resumeWritten,
  READ_TOOLS_SELF,
  WRITE_TOOLS_SELF,
  DEFAULT_OWNER_NICK,
  LEAD_NICK,
  freshSessionDue,
  type CtxSample,
  type CtxTrigger,
} from "./ctxwarn.ts";
import { upstreamErrorNote, type EndMessage } from "./errnote.ts";
import { appendExitLine, endStateOf, exitLine, EXIT_LOG_DEFAULT, type EndState } from "./exitlog.ts";
import {
  deliveryClass,
  parseSteerNicks,
  steerHeader,
  steerNote,
  STEER_NICKS_ENV,
  wantsSteer,
} from "./steer.ts";
import {
  ackPayload,
  ackTopic,
  bootTag,
  controlTopic,
  expandMe,
  foldToOneLine,
  HEARTBEAT_MS_DEFAULT,
  isAck,
  inboxTally,
  legacyPresenceTopic,
  msgId,
  planInbound,
  postLengthVerdict,
  postMax,
  postTooLongNote,
  presenceTopic,
  presenceWild,
  peerRecordWins,
  queryAcks,
  recordAck,
  renderAck,
  renderInbound,
  renderLine,
  renderPeers,
  noteRoomId,
  takeUnseen,
  type Ack,
  type PeerSeen,
  type RoomLine,
} from "./roommsg.ts";

// v3 (PLAN steps 3-5): connect to the chat broker, expose /mqtt-status, /say
// and /room, clean shutdown. @-mentions inject a live turn via
// pi.sendUserMessage(). A line that does not address this lane is kept in the buffer for
// chat_read only — it is NEVER injected (the rule lives in roommsg.ts:planInbound), so
// a mention arrives alone, with its own provenance tag.
// A mention that arrives while the lane is mid-run queues as a follow-up by default; the
// optional `steer` flag (steer.ts, lead + owner only) delivers it as an interrupt instead.
//
// PUBLISHING IS EXPLICIT: nothing the lane
// prints to its own terminal ever enters the room. Room text leaves this
// extension only through chat_post (or a human's /say). The former agent_end
// auto-publish is removed: it put terminal prose in front of the room against
// the lane's stated intent, and a lane that believes it is silent must be silent.
// Opt-in: the whole extension is inert unless pi runs with --tabichat.
export default function (pi: ExtensionAPI) {
  // declared first: the tool descriptions below are built at setup time
  const BUFFER_MAX = 50;
  const nick = process.env.MQTT_NICK ?? "bot";
  let room = ""; // set at session_start from --room / MQTT_ROOM
  // THE BROKER LOCATION is resolved, never guessed (site-agnostic by design: "tabichat repo
  // needs to be made site agnostic. 1. no default, must be set" + "the mqtt url can be set in a
  // config, not hardcoded"). Site file `mqttUrl` → MQTT_URL → loud refusal naming both. The rule
  // lives in ./broker.ts, the twin of the shipped src/extensions/tabichat/broker.ts.
  const broker = resolveBrokerFromDisk(process.env);
  const brokerUrl = broker.ok ? broker.url : "";
  const brokerRefusal = broker.ok ? "" : broker.message;
  /** The honest reason there is no room: no broker, or no room named — never both blamed at once. */
  const offlineReason = (who: string) =>
    brokerRefusal !== ""
      ? `${who}: ${brokerRefusal}`
      : `${who}: not in a room — start pi with --tabichat --room <name>`;
  // fresh-session advisory: warn at this percent of the context window
  const CTX_WARN = ctxWarnThreshold(process.env.MQTT_CTX_WARN);
  // absolute token tripwire (0 = off): fires on tokens whatever the declared window says
  const CTX_TOKENS = ctxTokenThreshold(process.env.MQTT_CTX_TOKENS);
  const OWNER_NICK = process.env.MQTT_OWNER_NICK ?? DEFAULT_OWNER_NICK;
  // forced handoff threshold — 75 percent of the declared window (raised from the 70 first
  // discussed). At this percent the
  // lane must write a RESUME file before it may keep using its tools; MQTT_CTX_FORCE overrides, and it
  // is never below the warn threshold
  const CTX_FORCE = ctxForceThreshold(process.env.MQTT_CTX_FORCE, CTX_WARN);
  // KNOWN DIVERGENCE from the shipped copy, and it is CODE not wording: src/ resolves this
  // (env -> site-config "resumeDir" -> REFUSE naming both knobs, ctxwarn.ts:resolveResumeDir); this
  // preview twin carries no durable default at all. Porting the resolver here is a code change
  // with its own gate.
  // durable RESUME location (/tmp is temporary). MQTT_CTX_RESUME_DIR is the only durable source;
  // with it unset or uncreatable the lane falls back to /tmp/tabichat rather than failing
  const RESUME_DIR = process.env.MQTT_CTX_RESUME_DIR ?? "";
  const RESUME_FALLBACK = "/tmp/tabichat";
  // room-post length cap — the owner's own posts are exempt; agents are
  // capped at 2500 (raised from 1500; refusal behavior unchanged) — MQTT_POST_MAX overrides per lane, 0 or less turns it off
  const POST_MAX = postMax(process.env.MQTT_POST_MAX);
  // who may interrupt a running lane with a steered mention (steer.ts): the lead and the owner,
  // plus anything the operator adds via MQTT_STEER_NICKS — additive, never subtractive
  const STEER_NICKS = parseSteerNicks(process.env[STEER_NICKS_ENV], OWNER_NICK);
  // percent of the last advisory; -1 = none yet, reset by a compaction
  let lastCtxWarn = -1;
  // same anti-noise discipline for the absolute rule: the token count it last fired on, -1 = none
  let lastCtxWarnTokens = -1;
  // Lane breadcrumb state: how the newest turn ended, and when this session started.
  let lastTurn: EndState = "unknown";
  let startedAt = 0;
  const EXIT_LOG = process.env.MQTT_EXIT_LOG || EXIT_LOG_DEFAULT;
  // The `ask_owner` tool is deliberately absent here. An owner ask is plain text typed in the
  // lane's own terminal, not a registered tool. Nothing registers that tool name any more, and no other file in this extension uses
  // the "[ask_owner]" notice tag.

  // Model-facing room access. /say and /room are human-typed slash commands,
  // which an agent cannot invoke; these tools are the agent's path to the room.
  pi.registerTool(
    defineTool({
      name: "chat_post",
      label: "Chat post",
      description:
        `Publish a message to the tabichat room right now, from any turn. This session's room `
        + `nick is "${nick}"; write the token {me} wherever your own nick belongs — it is `
        + `replaced with the real nick before publishing, so never type a nick yourself. `
        + `Set "to" to address someone: the message is then prefixed with "@<to> ". Use it for `
        + `short verdicts and pointers to a task file. This tool is the `
        + `ONLY way anything reaches the room: your terminal reply, your tool output and your `
        + `turn prose are never published, so anything the room must see has to be sent here by `
        + `name. Room text is public and human-readable; never put credentials or ceremony text `
        + `in it. A line sent to a lane that is ALREADY working normally queues behind its whole `
        + `run and lands after it has posted its verdict; when you are adding something that `
        + `changes what that lane should be doing, set steer true so the addressee sees it at its `
        + `next tool-result boundary, mid-task. That is an interrupt: reserve it for a `
        + `lane-changing addendum, never for status chatter, and only the lead and the owner `
        + `nicks are honoured.`,
      parameters: Type.Object({
        message: Type.String({
          description: "text to publish; {me} expands to this session's room nick",
        }),
        to: Type.Optional(Type.String({ description: `nick to address, e.g. ${LEAD_NICK}` })),
        steer: Type.Optional(
          Type.Boolean({
            description:
              "true = deliver as an interrupt: an addressee already working sees this at its next "
              + "tool-result boundary instead of after it finishes its whole run. Only a "
              + "lane-changing addendum justifies it. Honoured only from the lead and the owner "
              + "nicks (MQTT_STEER_NICKS adds more); from anyone else it queues as normal.",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        // ctx is USED here, not spare: the over-cap refusal below calls ctx.ui.notify.
        // Naming this param _ctx made that line a ReferenceError and swallowed the refusal.
        if (!client || !room)
          return {
            content: [
              { type: "text", text: offlineReason("chat_post") },
            ],
          };
        let text = expandMe(params.message, nick);
        if (params.to && !text.startsWith(`@${params.to}`)) text = `@${params.to} ${text}`;
        if (!text) {
          return {
            content: [
              {
                type: "text",
                text: "chat_post: refused — nothing left after trimming; the room wants one real line, not blank space (nothing was published)",
              },
            ],
          };
        }
        // measured before anything goes on the wire: a post over the cap is refused outright, so
        // the room never carries a worklog and the lane is told where that text belongs
        const fit = postLengthVerdict(text, nick, OWNER_NICK, POST_MAX);
        if (!fit.ok) {
          const note = postTooLongNote(fit.len, fit.max);
          ctx.ui.notify(`[tabichat] ${note}`, "warning");
          return { content: [{ type: "text", text: note }] };
        }
        const id = msgId(nick, ++msgSeq, BOOT);
        // the flag rides on the payload as one extra field, so a receiver that predates it keeps
        // working unchanged; when it is absent nothing new goes on the wire at all
        const asked = params.steer === true;
        const honoured = asked && STEER_NICKS.includes(nick);
        publishRoom({ nick, message: text, id, ts: Date.now(), ...(asked ? { steer: true } : {}) });
        return {
          content: [
            {
              type: "text",
              text: `posted as ${nick} to ${room}: ${text} (id ${id})${steerNote({ requested: asked, honoured, allow: STEER_NICKS })}`,
            },
          ],
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "chat_read",
      label: "Chat read",
      description:
        `Read the tabichat room. scope "room" (default) gives recent lines newest last, each `
        + `stamped [HH:MM:SS chat:<nick>]; pass unseen_only true to get ONLY the lines this `
        + `session has not been shown yet (the cursor advances, so a line is handed over once `
        + `and replayed history never reads as news). scope "inbox" lists the mentions THIS lane `
        + `actually received — each with its message id and arrival stamp, plus a per-sender tally. `
        + `Only a line that addresses you (@<your-nick> or @all) is ever injected into your context, so an `
        + `inbox that does not hold a message means it never arrived at this lane: before you say `
        + `anyone re-sent, ignored or lost anything, quote this scope. scope "acks" shows delivery receipts from `
        + `the control topic — proof a named lane RECEIVED a given message id, which is how you `
        + `tell "ignored" from "never arrived"; receipts are also retained per message id, so a lane that starts later still sees the ones that flew before it woke up, and id= (optionally <id>|<nick>) plus since_min= ask about one dispatch. scope "peers" lists who is live: online, stale `
        + `(no presence beat lately) or offline. Read-only: publishes nothing.`,
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({ description: "'room' (default), 'inbox', 'acks', or 'peers'" }),
        ),
        limit: Type.Optional(Type.Number({ description: "how many lines, default 10 (not used with unseen_only)" })),
        unseen_only: Type.Optional(Type.Boolean({ description: "true = only lines not yet shown to this session" })),
        id: Type.Optional(
          Type.String({
            description:
              "with scope=acks: the message id to look up, or <message id>|<nick> for one lane's receipt; "
              + "with scope=inbox: show only the mentions this lane received under that message id",
          }),
        ),
        since_min: Type.Optional(Type.Number({ description: "with scope=acks: only receipts newer than this many minutes" })),
      }),
      async execute(_id, params, _signal, _onUpdate, _ctx) {
        if (!room)
          return {
            content: [{ type: "text", text: offlineReason("chat_read") }],
          };
        const scope = String(params.scope ?? "room").toLowerCase();
        if (scope === "peers") {
          const rows = renderPeers([...peers.entries()], Date.now(), nick);
          return {
            content: [
              { type: "text", text: rows.length ? rows.join("\n") : `no other peer heard of in ${room}` },
            ],
          };
        }
        if (scope === "acks") {
          const rows = queryAcks(acks, {
            id: params.id ? String(params.id) : undefined,
            sinceMin: typeof params.since_min === "number" ? params.since_min : undefined,
            limit: params.limit,
            cap: BUFFER_MAX,
          }).map(renderAck);
          const asked = params.id ? ` for ${params.id}` : "";
          const none = `no delivery receipts${asked} in this lane's ${BUFFER_MAX}-receipt window; retained boards under ${controlTopic(room)}/ still hold older ones`;
          return {
            content: [{ type: "text", text: rows.length ? rows.join("\n") : none }],
          };
        }
        if (scope === "inbox") {
          // the one-call refutation of "I got that six times": what THIS lane was addressed, counted
          // from the wire, not from the lane's memory of the run
          const want = params.id ? String(params.id).trim() : "";
          const rows = want ? inbox.filter((r) => r.id === want) : inbox;
          const n = Math.min(Math.max(params.limit ?? 10, 1), BUFFER_MAX);
          const shown = rows.slice(-n).map(renderInbound);
          const tally = inboxTally(rows);
          if (shown.length) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `${shown.join("\n")}\ninbox: ${rows.length} mention(s) received by ${nick}` +
                    `${want ? ` with id ${want}` : ""} since this lane started — ${tally}` +
                    `${rows.length > shown.length ? ` (${shown.length} shown)` : ""}` +
                    " — this list, not your memory, is the record of what reached this lane",
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `inbox: this lane (${nick}) has received NO mention` +
                  `${want ? ` with id ${want}` : ""} since it started, out of ${buffer.length} room line(s) heard. ` +
                  `Only a line that addresses this lane is ever injected, so if it is not in this list it never ` +
                  `arrived here — say that plainly instead of accusing a sender.`,
              },
            ],
          };
        }
        if (params.unseen_only) {
          const got = takeUnseen(buffer, readCursor);
          readCursor = got.cursor;
          return {
            content: [
              {
                type: "text",
                text: got.lines.length
                  ? got.lines.map(renderLine).join("\n")
                  : `no unseen room lines in ${room} (${readCursor} line(s) seen since start)`,
              },
            ],
          };
        }
        const want = params.limit ?? 10;
        const n = Math.min(Math.max(want, 1), BUFFER_MAX);
        const lines = buffer.slice(-n);
        // showing them here counts as having seen them, so a later unseen_only
        // read does not hand the same lines over twice
        readCursor = buffer.length;
        return {
          content: [
            {
              type: "text",
              text: lines.length
                ? lines.map(renderLine).join("\n")
                : `no room lines heard yet in ${room}`,
            },
          ],
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "context_usage",
      label: "Context usage",
      description:
        `Report THIS session's context-window usage from pi's own estimate: tokens used, ` +
        `window size, percent, which model the window belongs to, and whether a fresh session is ` +
        `due (advisory threshold ${CTX_WARN}%` +
        (CTX_TOKENS > 0 ? `, or ${CTX_TOKENS} tokens absolute` : ", no absolute tripwire set") +
        `). The window is a DECLARATION in pi's model config, not a measurement of the serving ` +
        `host — if the two disagree, the percentage is wrong, so quote the model and window with ` +
        `any usage claim. Publishes nothing — say it in the room with chat_post if the task calls ` +
        `for it. Returns "unknown" when the model declares no contextWindow or no response has ` +
        `been measured yet.`,
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return { content: [{ type: "text", text: ctxReport(ctx) }] };
      },
    }),
  );

  pi.registerFlag("tabichat", {
    description: "join the tabichat MQTT room (env: MQTT_NICK/MQTT_ROOM/MQTT_URL)",
    type: "boolean",
  });
  pi.registerFlag("room", {
    description: "tabichat room name (overrides MQTT_ROOM; no built-in default)",
    type: "string",
  });

  let client: mqtt.MqttClient | null = null;
  // every room line we have heard, newest last — the agent's only view of the room
  const buffer: RoomLine[] = [];
  // the mentions this lane actually received (@nick or @all), newest last. This is the answer to
  // "did that message arrive / how many times did it arrive", which a lane otherwise asserts from
  // memory — and a fresh lane once asserted six re-dispatches that never reached the wire.
  const inbox: RoomLine[] = [];
  // delivery receipts heard on the control topic (P2): who got what, and when
  const acks: Ack[] = [];
  // who we believe is in the room, per-nick presence record, from beats + LWTs (P5)
  const peers = new Map<string, PeerSeen>();
  // forced-handoff state: fires once per crossing, lifts when the file exists, and gives
  // up loudly rather than hanging a lane
  let forced = false;
  let gaveUp = false;
  let blockRefusals = 0;
  let resumeFile = "";
  let resumeDirLive = RESUME_DIR;
  // how far chat_read has already shown the buffer (P3: unseen-since-cursor)
  let readCursor = 0;
  // outbound message sequence, for per-message ids (P2)
  let msgSeq = 0;
  // this lane's boot tag (roommsg.ts:msgId): the sequence restarts at 0 every session, so
  // without it a restarted lane mints ids its previous session already used — and the
  // receipt board keys on the id, so receipts from two sessions land on one entry.
  const BOOT = bootTag();
  // presence beat handle (P5)
  let hb: ReturnType<typeof setInterval> | null = null;
  // how often we restate our presence; a peer that misses three beats reads stale
  const HB_MS = (() => {
    const n = Number.parseInt(process.env.MQTT_HB_MS ?? "", 10);
    return Number.isFinite(n) && n >= 5_000 ? n : HEARTBEAT_MS_DEFAULT;
  })();

  /** Publish to the room (what people read). */
  const publishRoom = (payload: Record<string, unknown>) => {
    client?.publish(`chat/${room}`, JSON.stringify(payload));
  };
  /** Publish to the control topic — machinery, never shown as chat. */
  const publishCtl = (payload: unknown) => {
    if (room) client?.publish(controlTopic(room), JSON.stringify(payload));
  };
  /**
   * Pin a receipt to its own retained board, one topic per message id (P6). The
   * flat publish above only reaches whoever is connected at that moment; MQTT
   * replays the retained copy to anyone who subscribes later, so a restarted lead
   * can still answer "did that recipient acknowledge message <id>?."
   */
  const publishCtlRetained = (id: string, payload: unknown) => {
    if (!room) return;
    const t = ackTopic(room, id);
    if (!t) return; // id unusable as a topic leaf; the flat receipt still went out
    client?.publish(t, JSON.stringify(payload), { retain: true });
  };
  /** Restate our presence so the room can tell live from quiet (P5). */
  const beat = () => {
    if (!client || !room) return;
    client.publish(
      presenceTopic(room, nick),
      JSON.stringify({ nick, status: "online", ts: Date.now() }),
      { retain: true },
    );
  };
  const upsertPeer = (who?: string, status?: string, ts?: number) => {
    if (!who) return;
    // an unstamped record from the older shared presence topic must not mark a
    // live peer gone the moment the broker replays it to us (P5)
    const incoming: PeerSeen = {
      status: status === "offline" ? "offline" : "online",
      ts: typeof ts === "number" ? ts : 0,
    };
    if (!peerRecordWins(peers.get(who), incoming)) return;
    peers.set(who, incoming);
  };
  // ids already taken into the buffer: one message must read as ONE line however
  // many times it arrives - stacked handlers, retained replay, or a redelivery after a reconnect
  let seenRoomIds: string[] = [];
  // set when a mention was injected into this lane: its turn owes no room post,
  // and the lane is told that once the turn ends (P1)
  let owedTurns = 0;

  pi.on("session_start", async (_event, ctx) => {
    // flag values are only readable from session_start (not the factory)
    if (pi.getFlag("tabichat") !== true) return;
    // A person loses track of which seat is which nick. Stamp this
    // lane's own room nick in the footer (key sorts between "fs-gate" and "upstream"), set
    // before the client guard so a session restart inside the same process re-labels it.
    ctx.ui.setStatus("nick", `@${nick}`);
    if (client) return;
    room = String(pi.getFlag("room") ?? "") || process.env.MQTT_ROOM || "";
    if (!room) {
      ctx.ui.notify("[tabichat] --tabichat given but no room: pass --room <name> or set MQTT_ROOM", "warning");
      return;
    }
    // fail loudly, never silently: with no declared contextWindow there is no
    // percent to warn on, and the lane must know its advisory is disabled
    if (!ctx.getContextUsage()) {
      ctx.ui.notify(
        `[tabichat][ctx] no context window for this model — fresh-session advisory OFF; add "contextWindow" for this model to ~/.pi/agent/models.json (a virtual model declares none until its first response routes to a physical one)`,
        "warning",
      );
    } else {
      // Say the denominator out loud, once, at the start: every percentage this lane later quotes
      // divides by it, and so does pi's own compaction. It is a DECLARATION from pi's model config,
      // not a measurement of the serving host — that distinction is the whole lesson of the day.
      const u0 = ctx.getContextUsage();
      const s0: CtxSample | null = u0
        ? { tokens: u0.tokens ?? null, contextWindow: u0.contextWindow, percent: u0.percent ?? null }
        : null;
      ctx.ui.notify(
        `[tabichat][ctx] ${ctxDeclarationLine(s0, ctxModelLabel(ctx.model), CTX_WARN, CTX_TOKENS)}`,
        "info",
      );
    }
    // NO BROKER, LOUDLY — the refusal is the answer, not a step before the real one. Two channels:
    // a notify that survives scrollback and a stderr line, because a toast that clears is how a
    // misconfiguration reads to an operator as a broken product.
    if (brokerRefusal !== "") {
      ctx.ui.setStatus("broker", "NO BROKER");
      ctx.ui.notify(brokerRefusal, "error");
      console.error(brokerRefusal);
      return;
    }
    client = mqtt.connect(brokerUrl, {
      clientId: `pi-${nick}-${Math.random().toString(16).slice(2, 8)}`,
      // our own retained presence record, so a lane that dies marks ITSELF
      // offline instead of leaving the room guessing (P5)
      will: {
        topic: presenceTopic(room, nick),
        payload: JSON.stringify({ nick, status: "offline", ts: Date.now() }),
        qos: 0,
        retain: true,
      },
    });
    client.on("connect", () => {
      client!.subscribe(`chat/${room}`);
      client!.subscribe(controlTopic(room));
      client!.subscribe(`${controlTopic(room)}/#`);
      client!.subscribe(presenceWild(room));
      client!.subscribe(legacyPresenceTopic(room));
      beat();
      if (!hb) hb = setInterval(beat, HB_MS);
      ctx.ui.notify(`[tabichat] connected as ${nick} (room ${room})`, "info");
    });
    client.on("error", (err: Error) => {
      ctx.ui.notify(`[tabichat] error: ${err.message}`, "error");
    });
    client.on("message", (topic, payload) => {
      let msg: { nick?: string; message?: string; id?: string; ts?: number; status?: string; kind?: string; by?: string; to?: string; steer?: boolean };
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }
      // control topic: delivery receipts, kept out of the room buffer (P2). The
      // flat topic and the per-message retained board carry the SAME receipt, so
      // the two copies collapse to one entry instead of reading as two deliveries (P6).
      if (topic === controlTopic(room) || topic.startsWith(`${controlTopic(room)}/`)) {
        if (!isAck(msg)) return;
        const a: Ack = { kind: "ack", id: msg.id as string, to: msg.to ?? "?", by: msg.by as string, ts: typeof msg.ts === "number" ? msg.ts : Date.now() };
        const next = recordAck(acks, a, BUFFER_MAX);
        acks.length = 0;
        acks.push(...next);
        return;
      }
      // presence (per-nick now, plus the older shared topic for unmixed rooms)
      if (topic === legacyPresenceTopic(room) || topic.startsWith(`${legacyPresenceTopic(room)}/`)) {
        upsertPeer(msg.nick, msg.status, msg.ts);
        return;
      }
      const from = msg.nick;
      const text = msg.message;
      if (!from || !text || from === nick) return; // echo prevention
      // one message, one line: a repeat of an id we already took is dropped before the buffer and
      // before any mention can be injected, so a duplicate can neither be read nor wake a turn
      const seen = noteRoomId(seenRoomIds, msg.id);
      if (seen.dup) return;
      seenRoomIds = seen.seen;
      const inboundLine: RoomLine = {
        nick: from,
        message: text,
        ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
        id: msg.id,
      };
      buffer.push(inboundLine);
      if (buffer.length > BUFFER_MAX) buffer.shift();
      upsertPeer(from, "online", Date.now());
      // whole-token match only: "@allen" must not wake "@all", "@flash10"
      // must not wake "@worker1" (see mention.ts)
      const mentioned = mentions(text, nick);
      // P2: tell the sender we have it, on the control topic, so they can tell
      // "delivered and unanswered" apart from "never arrived at all". Only for
      // messages that address us, and only when they carry an id (an older
      // client's message has none, so there is nothing to acknowledge).
      if (mentioned && msg.id) {
        const ack = ackPayload(msg.id, nick, from, Date.now());
        publishCtl(ack);
        publishCtlRetained(msg.id, ack);
      }
      // Two ways to hand a mention to a lane that is mid-run (see steer.ts): queue it behind the
      // run (the shipped behaviour, and still the default) or, only when the sender asked AND is
      // on the allowlist, steer it — which pi delivers at the lane's next tool-result boundary.
      const cls = deliveryClass({
        idle: ctx.isIdle(),
        sender: from,
        flag: wantsSteer(msg),
        allow: STEER_NICKS,
      });
      const head = cls === "steer" ? `${steerHeader(from)}\n\n` : "";
      // ONLY a line that addresses this lane reaches its context (roommsg.ts:planInbound).
      // An unaddressed line stays in the buffer, where chat_read can still
      // reach it, and is otherwise silent: no flood, and nothing to mistake for an instruction.
      const plan = planInbound({ mentioned, head, line: inboundLine });
      if (plan.kind === "buffer-only") return;
      inbox.push(inboundLine);
      if (inbox.length > BUFFER_MAX) inbox.shift();
      owedTurns++;
      if (owedTurns > 20) owedTurns = 20;
      if (cls === "turn") pi.sendUserMessage(plan.body);
      else pi.sendUserMessage(plan.body, { deliverAs: cls });
    });
  });

  // One-line report shared by the context_usage tool and the /ctx command.
  // Structural parameter: the tool context, the command context and the event context all expose
  // getContextUsage() and a current model, and this needs nothing else.
  type CtxUsageReader = {
    getContextUsage: () => CtxSample | null | undefined;
    model?: { provider?: string; id?: string } | undefined;
  };
  const ctxReport = (ctx: CtxUsageReader): string => {
    const who = ctxModelLabel(ctx.model);
    const usage = ctx.getContextUsage();
    const rules = `threshold ${CTX_WARN}%` + (CTX_TOKENS > 0 ? ` or ${CTX_TOKENS} tokens absolute` : ", no absolute tripwire");
    if (!usage)
      return `context_usage: no context window declared for ${who} — percent advisory OFF; add "contextWindow" to ~/.pi/agent/models.json (${rules})`;
    if (usage.percent === null || usage.tokens === null)
      return `context_usage: unknown until the next model response (window ${usage.contextWindow} declared for ${who}; ${rules})`;
    const s: CtxSample = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    const pctDue = freshSessionDue(s, CTX_WARN, lastCtxWarn);
    const absDue = absoluteSessionDue(s, CTX_TOKENS, lastCtxWarnTokens);
    return (
      `context_usage: ${Math.floor(s.percent)}% = ${s.tokens}/${s.contextWindow} tokens ` +
      `(window declared for ${who}; ${rules}${lastCtxWarn >= 0 ? `, last advisory ${lastCtxWarn}%` : ""}) — ` +
      (pctDue || absDue
        ? `FRESH SESSION DUE (${pctDue ? "percent" : "absolute tokens"}): tell the lead and the owner in one room line`
        : "no fresh session due") +
      ` — the window is a DECLARATION in pi's model config, not a measurement of the serving host`
    );
  };

  // A turn that answered a mention ends without anything reaching the room (P1).
  // Say so here, once, so a lane is never fooled into thinking it has spoken.
  pi.on("agent_end", async (_event, ctx) => {
    if (!owedTurns) return;
    owedTurns = 0;
    ctx.ui.notify(
      "[tabichat] turn finished — nothing was published: your reply stayed in this terminal. Call chat_post if the room needs it.",
      "info",
    );
  });

  // Fresh-session advisory, two independent rules, one post per turn:
  //   percent  — at or over CTX_WARN of the DECLARED window (useless if that declaration lies)
  //   tokens   — at or over MQTT_CTX_TOKENS in absolute terms, declaration ignored
  // Footer always; room once, to lead + owner.
  pi.on("agent_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.tokens === null) {
      ctx.ui.setStatus("ctx", ctxStatusText(null));
      return;
    }
    const s: CtxSample = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    ctx.ui.setStatus("ctx", ctxStatusText(s));
    // forced handoff, checked BEFORE the advisory's own early return: at 75% the
    // lane must write its state down, because a lane past that point degrades quietly — which is what
    // a seat at 78% looks like from the outside
    forced = rearmForce(forced, s.percent, CTX_FORCE);
    if (gaveUp && (s.percent ?? 0) < CTX_FORCE) gaveUp = false;
    if (forceDue(s, CTX_FORCE, forced) && !gaveUp) {
      for (const d of [RESUME_DIR, RESUME_FALLBACK]) {
        try {
          mkdirSync(d, { recursive: true });
          resumeDirLive = d;
          break;
        } catch {
          /* fall through to the scratch dir; the lane is told which path to write */
        }
      }
      resumeFile = resumePath(resumeDirLive, nick, BOOT);
      forced = true;
      blockRefusals = 0;
      const targets = ctxWarnTargets(nick, OWNER_NICK);
      const line = forceRoomLine(nick, s, CTX_FORCE, resumeFile, targets);
      ctx.ui.notify(
        `[tabichat][ctx] FORCED HANDOFF — write ${resumeFile} (tools blocked until it exists).\n${RESUME_TEMPLATE}`,
        "warning",
      );
      if (client && room) {
        publishRoom({ nick, message: line, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
      } else {
        ctx.ui.notify("[tabichat][ctx] forced handoff armed; no room connection, so nothing was posted", "warning");
      }
    }
    const pctDue = freshSessionDue(s, CTX_WARN, lastCtxWarn);
    const absDue = absoluteSessionDue(s, CTX_TOKENS, lastCtxWarnTokens);
    if (!pctDue && !absDue) return;
    const trigger: CtxTrigger = pctDue ? "percent" : "tokens";
    // advance BOTH counters: a turn that fired one rule must not immediately fire the other
    lastCtxWarn = Math.floor(s.percent ?? 0);
    lastCtxWarnTokens = s.tokens ?? -1;
    const line = ctxWarnLine(s, ctxWarnTargets(nick, OWNER_NICK), trigger, CTX_TOKENS);
    ctx.ui.notify(
      `[tabichat][ctx] ${line} (window ${s.contextWindow} declared for ${ctxModelLabel(ctx.model)})`,
      "warning",
    );
    if (client && room) {
      publishRoom({ nick, message: line, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
    } else {
      ctx.ui.notify("[tabichat][ctx] not in a room — advisory shown in this terminal only", "warning");
    }
  });

  // The force in action: from the crossing onward a tool call is blocked BEFORE it runs, except reads,
  // writes to the lane's own RESUME path, and read-only git (so the handoff records TRUE git state).
  // The block lifts on its own the moment that file exists with real content — no human step — and after
  // GIVE_UP_AFTER unanswered refusals the gate stops blocking and says so in the room, because a lane
  // that hangs the fleet is worse than a lane that skips its notes.
  pi.on("tool_call", async (event, ctx) => {
    if (!forced) return undefined;
    const exists = resumeFile !== "" && existsSync(resumeFile);
    if (resumeWritten(exists, exists ? statSync(resumeFile).size : 0)) {
      forced = false;
      ctx.ui.notify(`[tabichat] RESUME file present (${resumeFile}) — block lifted, carry on.`, "info");
      return undefined;
    }
    const tool = String(event.toolName ?? "");
    const input = (event.rawInput ?? {}) as { path?: unknown; file_path?: unknown; command?: unknown };
    const target = String(input.path ?? input.file_path ?? "");
    const isSelf = target !== "" && target === resumeFile;
    if ((WRITE_TOOLS_SELF.includes(tool) && isSelf) || READ_TOOLS_SELF.includes(tool)) return undefined;
    if (tool === "bash" && typeof input.command === "string" && bashAllowedWhileForced(input.command)) {
      return undefined;
    }
    blockRefusals++;
    if (giveUpNow(blockRefusals, false)) {
      forced = false;
      gaveUp = true;
      const line = giveUpLine(nick, Math.floor(CTX_FORCE), resumeFile);
      ctx.ui.notify(`[tabichat] ${line}`, "error");
      if (client && room) {
        publishRoom({ nick, message: line, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
      }
      return undefined; // let this call through: a stalled lane is worse than an un-noted one
    }
    return { block: true, reason: forceBlockNote(resumeFile) };
  });

  // A provider error ends the turn, is not auto-retried for this class of text, and
  // leaves the process alive and quiet — which looks exactly like a lane that stopped
  // working. Put it in the footer so the difference is visible without poking it, and
  // say it once in this terminal. Nothing here goes to the room.
  pi.on("agent_end", async (event, ctx) => {
    const msgs = ((event as { messages?: unknown }).messages ?? []) as EndMessage[];
    lastTurn = endStateOf(msgs);
    const note = upstreamErrorNote(msgs);
    if (!note) {
      ctx.ui.setStatus("upstream", undefined);
      return;
    }
    ctx.ui.setStatus("upstream", note);
    ctx.ui.notify(`[tabichat][upstream] ${note}`, "warning");
  });

  // Lane breadcrumb: a start line, then an exit line carrying pi's own reason and how
  // the last turn ended. A lane that never writes its exit line was killed too hard to
  // say goodbye - that absence is the whole point of writing the pair.
  pi.on("session_start", async (event, ctx) => {
    startedAt = Date.now();
    lastTurn = "unknown";
    const usage = ctx.getContextUsage();
    const res = appendExitLine(
      EXIT_LOG,
      exitLine({
        kind: "start",
        pid: process.pid,
        nick,
        room,
        reason: String((event as { reason?: string }).reason ?? "?"),
        lastTurn: "unknown",
        ctxPercent: usage?.percent ?? null,
      }),
    );
    if (!res.ok) ctx.ui.notify(`[tabichat][exitlog] cannot write ${EXIT_LOG}: ${res.error}`, "warning");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    const res = appendExitLine(
      EXIT_LOG,
      exitLine({
        kind: "exit",
        pid: process.pid,
        nick,
        room,
        reason: String((event as { reason?: string }).reason ?? "?"),
        lastTurn,
        ctxPercent: usage?.percent ?? null,
        uptimeMs: startedAt ? Date.now() - startedAt : undefined,
      }),
    );
    if (!res.ok) ctx.ui.notify(`[tabichat][exitlog] cannot write ${EXIT_LOG}: ${res.error}`, "warning");
  });

  // A compaction frees context, so either advisory may be earned again later.
  pi.on("session_compact", async () => {
    lastCtxWarn = -1;
    lastCtxWarnTokens = -1;
  });

  pi.registerCommand("say", {
    description: "publish a message to the tabichat room (usage: /say <text>)",
    handler: async (args, ctx) => {
      const text = foldToOneLine(String(args ?? ""));
      if (!client || !room) {
        ctx.ui.notify("[tabichat] not in a room — start pi with --tabichat --room <name>", "warning");
        return;
      }
      if (!text) {
        ctx.ui.notify("[tabichat] /say needs something to say (blank text is not published)", "warning");
        return;
      }
      publishRoom({ nick, message: text, id: msgId(nick, ++msgSeq, BOOT), ts: Date.now() });
      ctx.ui.notify(`[tabichat] said ${text.length} chars to ${room}`, "info");
    },
  });

  pi.registerCommand("room", {
    description: `show recent tabichat room lines (usage: /room [n], max ${BUFFER_MAX})`,
    handler: async (args, ctx) => {
      if (!room) {
        ctx.ui.notify("[tabichat] not in a room — start pi with --tabichat --room <name>", "warning");
        return;
      }
      const wanted = parseInt(String(args ?? "").trim(), 10);
      const n = Number.isNaN(wanted) ? 10 : Math.min(Math.max(wanted, 1), BUFFER_MAX);
      const lines = buffer.slice(-n);
      if (!lines.length) {
        ctx.ui.notify(`[tabichat] room ${room}: no lines heard yet`, "info");
        return;
      }
      const text = lines.map(renderLine).join("\n");
      ctx.ui.notify(`[tabichat] last ${lines.length} line(s) in ${room}:\n${text}`, "info");
    },
  });

  pi.registerCommand("peers", {
    description: "who else the room believes is live (online / stale / offline, with age)",
    handler: async (_args, ctx) => {
      if (!room) {
        ctx.ui.notify("[tabichat] not in a room — start pi with --tabichat --room <name>", "warning");
        return;
      }
      const rows = renderPeers([...peers.entries()], Date.now(), nick);
      ctx.ui.notify(
        rows.length
          ? `[tabichat] peers in ${room}:\n${rows.join("\n")}`
          : `[tabichat] no other peer heard of in ${room}`,
        "info",
      );
    },
  });

  pi.registerCommand("ctx", {
    description: "show this session's context-window usage and advisory state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`[tabichat] ${ctxReport(ctx)}`, "info");
    },
  });

  pi.registerCommand("mqtt-status", {
    description: "MQTT chat connection status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `[tabichat] flag=${pi.getFlag("tabichat") === true} nick=${nick} room=${room} url=${brokerUrl || "<unset>"} ` +
          `source=${broker.ok ? broker.source : "NONE"} connected=${client?.connected ?? false}` +
          (brokerRefusal !== "" ? ` — REFUSING: ${brokerRefusal}` : ""),
        "info",
      );
    },
  });

  pi.on("session_shutdown", async () => {
    if (hb) {
      clearInterval(hb);
      hb = null;
    }
    if (client && room) {
      // Say so on our own presence record first, then close the socket kindly so
      // anything already queued (an ack, an advisory) still leaves. Forcing the
      // close drops it — measured: publishes made at the last turn end were lost.
      const done = (p: unknown) =>
        Promise.race([p as Promise<unknown>, new Promise((r) => setTimeout(r, 1000))]);
      try {
        await done(
          client.publish(
            presenceTopic(room, nick),
            JSON.stringify({ nick, status: "offline", ts: Date.now() }),
            { retain: true },
          ),
        );
      } catch {
        /* the broker is gone; there is nothing to flush to */
      }
      try {
        await done(client.end());
      } catch {
        /* same */
      }
    }
    client = null;
  });
}
