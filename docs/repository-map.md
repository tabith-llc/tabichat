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
| `.agents/skills/` | the four load-on-demand skills a running seat opens: `tabichat-room`, `control-channel`, `lane-renew-handoff`, `lead-refresh-renew`. Each `SKILL.md` carries the conduct; the mechanism numbers live in its `references/` file with the grep that re-derives them. This is the Agent Skills location a harness discovers, so the same names resolve in this repository and in the private workspace that grew them. |

Why pi: the whole bet was pi's supported `pi.sendUserMessage()`
extension API, which the previous harness lacked. It paid off: the
extension needs no polling.


## Citing a commit or a tag

A pointer is not a citation until it says what it is a pointer *of*. Four lines and one check:

- **Name the ref you measured at.** `at dev = 3cf645d` can be re-checked; `at 3cf645d` leaves a reader to
  guess which line held it. Short shas widen the gap: `git rev-parse --short` prints as few digits as
  *your* repository needs to be unambiguous, which is not what the next reader's repository will need.
- **Say which side of the cut the claim is on.** *ancestor of tag `0.1.1`* means shipped; *on `dev`*
  means unreleased. `main` and `dev` in this repository do not share history, so ancestry against `main`
  says nothing about what a reader on `dev` can reach — and a commit can sit on many `feature/*` refs
  while being on no release line at all.
- **Re-derive a tag name before using it as an address:** `git rev-parse '0.1.1'^{commit}`. A
  `git ls-remote` line prints the **tag object** (`0.1.1` → `d2b54a9`), which is not the commit anyone
  means (`874187e`). Both published faces hand out the SAME tag object and the same peeled commit here —
  `0.1.0` → `b773331` peeling to `059bbd5`, `0.1.1` → `d2b54a9` peeling to `874187e` — so the trap is a tag
  object standing where a commit belongs, not two faces disagreeing. Re-derive it in the repository you are
  citing, and mind the width: every 7-character prefix resolves uniquely in this clone
  (`git cat-file --batch-all-objects --batch-check='%(objectname)' | cut -c1-7 | sort | uniq -d` prints
  nothing), which tells your reader nothing about theirs.
- **A sha that opens on no published face is a bad cite, not a bad day.** Correct it forward in the next
  thing you write. Do not amend landed history or rewrite an old report to hide it.

`src/tools/check_cite_faces.sh` reads those rules off the tracked Markdown pages, off named files, or off
a diff on stdin, and prints per cite whether it resolves, which refs contain it, and what a tag peels to.
It describes a cite that opens on the wrong line and refuses only a cite that opens nowhere:

```sh
sh src/tools/check_cite_faces.sh                       # every tracked page in this clone
git show HEAD | sh src/tools/check_cite_faces.sh -     # the pointers a change just wrote
```

The specimens behind this rule are measured in issue #27 rather than repeated here, deliberately: three
of them are pointers a fresh clone of the published faces cannot open, and pasting one into the packet
would be the thing this page warns about.
