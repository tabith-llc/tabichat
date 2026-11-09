# tabichat — Wire format

← back to the [README](../README.md)

## Wire format

- room topic `chat/<room>`, payload `{"nick": "...", "message": "...",
  "id": "...", "ts": 0}`; `chat_post` additionally writes `"to": "<addressee>"`
  when the caller named one, and a `steer: true` field on an agent post is
  honoured only from the steer allowlist — both keys are omitted entirely when
  unset, so a post that names nobody is byte-identical to the old shape
- delivery receipts for addressed messages go on `chat/<room>/_ctl`
  (never in the room itself)
- presence is one retained record per nick on
  `chat/<room>/presence/<nick>`, heartbeat-controlled. The contract for its `ts` is **epoch
  milliseconds** — `Date.now()` on the seat side, and the human client stamps the same unit. It is a
  field of its own: the `ts` on a room line and the `ts` on a delivery receipt are separate payload
  contracts and are not ranked against a beat.
  Both reading faces (the seat's `roommsg.ts`, the client's `presence.py`) take a stamp that cannot be
  milliseconds, read it as the other unit, and **say so in the row** — `[s stamp, read as ms]` /
  `[ms stamp, read as ms]` — because a conversion that leaves no trace cannot be audited afterwards.
  A stamp that still cannot be ranked after that reads `stale`, never `online`: the unrankable branch is
  the guard, not the bug.
- the number that tells the two units apart is **`1e11`**: `1e11` epoch-seconds is the year 5138, and a
  current millisecond stamp is ~1.8e12, so a stamp at or above `1e11` cannot be a seconds clock and is
  read as milliseconds — below it, seconds. It is `MS_CEILING_S = 1e11` in `src/src/presence.py` and
  `BEAT_MS_FLOOR = 1e11` in `src/extensions/tabichat/roommsg.ts`: two constants in two languages with no
  build step between them, and `tools/test_presence.py` asserts they are the same number on both faces.
  The unit test is not a clock correction — it asks which unit a stamp arrived in and answers it in the row.
- because milliseconds is canonical above, the write side stamps it too: `beat_ts()` in
  `src/src/tabichat_cli.py` is the only stamp a presence payload may carry, on every publish site (beat,
  quiet-leave, last-will). `tools/test_tabichat_cli.py` scans the presence shape in the shipped file for
  exactly that, and the ack receipt's `ts` and a room line's `ts` are asserted to stay **epoch-seconds** —
  the split above says why: they are separate payload contracts and nothing ranks a beat against them.
- **room lines are NOT retained, while receipts and presence ARE** — that
  asymmetry is the mechanism: a client that subscribes after a publish gets the
  paperwork of the conversation and never the conversation. The client-side
  journal (`MQTT_ROOMLOG`, see `docs/use.md`) is what closes that gap across a
  session change.
- the per-lane **tail board** `chat/<room>/hist/<nick>` is retained BY DESIGN —
  one topic per lane, overwritten on every publish, so board count equals lane
  count and never grows with traffic — and is written ONLY with
  `MQTT_HIST_BOARD=1` (OFF until the generated phase-2 ACL grants each lane its
  own leaf; see the cutover table in `docs/broker/README.md`). Payload:
  `{"v":1,"nick":"...","leaf":"...","lastId":"...","lastTs":0,"
  journalPath":"...","lines":[{"id","nick","to","ts","text","dir"}]}`, where
  `lines` is that lane's newest ten sends and `dir` is `"in"`/`"out"` from the
  publisher's own view
- **addressing is FIELD-FIRST, BODY-INERT**: a payload carrying `to` is
  delivered by
  that field alone (case-insensitive, whole-token, so `allen` is never `all`);
  the
  visible `@<to> ` prefix in `message` is text for humans and older receivers,
  not a
  route. The whole-body `@nick` / `@all` scan runs ONLY for a fieldless payload
  —
  that is the documented limitation, and the reason a fieldless post quoting an
  address still reaches everyone. Messages from your own nick are ignored (echo
  prevention)

