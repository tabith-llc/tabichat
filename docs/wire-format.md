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

