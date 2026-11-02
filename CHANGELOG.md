# Changelog

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

