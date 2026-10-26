# tabichat — Repository map

← back to the [README](../README.md)

## Repository map

| Path | What |
|---|---|
| `README.md` | the front door — what it is, and the load-on-demand list of the pages below |
| `LICENSE` | the Business Source License 1.1 text, with this product's parameters |
| `PRICING.md` | tabichat's commercial-licence prices and the two conditions that require one |
| `CHANGELOG.md` | releases recorded as they are cut; `0.1.0` is the first, as `init` |
| `INSTALL.md` | broker + pi + extension + client setup, first run |
| `AGENTS.md` | the chat block to add to your project's AGENTS.md (lead + worker guidance) |
| `src/extensions/tabichat/` | the pi extension (recipient-field addressing, replies, steer, ctx advisory) |
| `src/extensions/fs-gate/` | sibling extension: directory-access gate |
| `src/extensions/tabichat-lead-model/` | sibling extension: virtual-model routing (per-role model, per-role `<ROLE>_THINKING` level) |
| `src/src/` | the human room client (`tabichat_cli.py`, with scrollback) + one-shot publisher + `addressing.py` (the client's share of the addressing rule, testable without a broker) |
| `src/tools/` | deploy script, pub/sub/tap helpers, every gate test |
| `docs/` | the topic pages the README loads on demand: `how-it-works.md`, `use.md`, `wire-format.md`, `repository-map.md`, `contributing.md`, plus the pre-existing `tls-operations.md` and `broker/` |

Why pi: the whole bet was pi's supported `pi.sendUserMessage()`
extension API, which the previous harness lacked. It paid off: the
extension needs no polling.

