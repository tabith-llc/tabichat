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
  `chat/<room>/presence/<nick>`, heartbeat-controlled
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

