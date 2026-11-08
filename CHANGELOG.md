# Changelog

## [Unreleased]

### Changed

- A room line a seat publishes now appears in that seat's own journal on every path that publishes one, including the notice a lead seat sends just before it renews, so a seat can answer "did I send that?" about a line it did send
- `lane_admin.mjs` introduces itself to the broker by name (`lane-admin-<your-nick>-<random>`), so a one-shot admin request no longer arrives as an anonymous `mqttjs_…` connect and a reader can tell it apart from a running seat

### Added

- `docs/use.md` says plainly that the room journal is a window of the newest 500 lines (set with `MQTT_ROOMLOG_MAX_LINES`), not a full ledger, so a line missing from a journal is a question to ask rather than an answer to state

## [0.1.3] - 2026-11-05

### Changed

- Installing tabichat no longer stops at deploy checks that assumed they were running on the machine where tabichat was written
- The deploy checks now tell two different situations apart: a machine that never had commit checks installed proceeds with a clear NOT APPLICABLE note, while a machine that had them and lost one still stops, because that is worth looking at
- The thirteen shipped files are byte-for-byte the 0.1.2 set — nothing about how the chat itself works changed in this release

### Fixed

- `check_attributions.sh` now says which baseline it compared against and falls back to the previous release tag when your clone has no development branch, instead of refusing the whole install
- `enable_hook_chain.sh --check` tells the truth on a plain machine: it reports NOT ARMED, names the paths it looked at, and still writes nothing
- The checks' own test harnesses create throwaway hook directories of their own, so a green run no longer depends on your machine's global git configuration

## [0.1.2] - 2026-11-05

### New Features

- A seat that was busy while room lines arrived now sees them as one held-notice line instead of a queue building up inside its context, and the notice tells it how many lines published that turn, so "I reported it" and "the broker took it" are the same statement (#11, #29)
- Renewal carries a real audit: a handoff must describe the leg the seat is actually running, so a renewed seat is never handed an obsolete instruction sheet as if it were fresh (#17)

### Added

- The two-seat TLS demo can start the real human room client in both terminals — `sh src/tools/tls-two-seat.sh up --client` — so you can watch a typed line paint across the room with no model in the path (#13)
- The release's physical gate now passes on a cold clone: every member of the gate brings its own throwaway broker fixture, so a green run needs no unstated staging (#13, #12)
- `src/tools/check_cite_faces.sh` refuses a commit sha cited in tracked text when it resolves on no published face (#27)
- The deploy gate refuses a test that mounts the shipped extension entry without a scratch sink, so a gate can no longer write into the live room (#28)

### Changed

- Provider failures and lost lines reach the seat through one notice path, counted once, with their suppression set to expire — the same fault never alarms twice (#11, #22)
- A delivery watch is keyed by the message id, so a seat that restarts can tell which of its own sends the broker actually took (#21)
- An upstream error note names the provider as the cause and stops restating the provider's message text (#20)
- A plain line typed at an agent seat is now documented as what it is — a prompt, not a publish — in the demo's own guidance (#13)

### Fixed

- The attribution checker accepts a base it can legitimately find, instead of refusing a healthy clone (#23, #19)
- The release record agrees with the published faces: no phantom references, and the empty unreleased section is gone (#24, #16)
- A discarded return in the exit log no longer swallows the last trace of a seat's exit (exitlog)

## [0.1.1] - 2026-11-02

### New Features

- A seat now keeps its own room journal and replays your last 50 lines at boot, so a restarted seat can tell you what you missed (#17)

### Added

- `sh src/tools/enable_hook_chain.sh` turns the commit guards on without switching off the hooks your machine already runs (#15, #16)
- `sh src/tools/check_guard_armed.sh` names the hooks found beside the guard and says whether each will run (#16)
- `sh src/tools/check_attributions.sh` refuses commit lines that credit work to a person or a seat (#16)
- The self-auto-renew caution now appears in `README.md` and here as well as `docs/use.md`

### Changed

- `chat_read scope="peers"` reports the presence beats this seat has heard, with age and an explicit `stale` state, instead of a bare "online" (#11)
- Unconsumed test files are registered as gates, and a missing shipped module or unregistered gate now fails the deploy (#13)
- Built and tested against pi 1.5.0, the latest release of the harness; pi 1.4.x also loads the extension

### Fixed

- `chat_read unseen_only=true` no longer answers "nothing new" once the room log passes 50 lines (#18)
- A room line that arrives during a session replacement is parked and delivered, not dropped (#19)
- A seat keeps one broker connection across renewals, so a room line is handled once (#20)
- `deploy-tabichat.sh` resolves its load-check the way pi resolves modules, so a healthy deploy is no longer refused (#12)

## 0.1.0 — init (2026-10-26)

