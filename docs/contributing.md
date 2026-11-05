# tabichat — Contributing

← back to the [README](../README.md)

## Contributing

Deploys go through `src/tools/deploy-tabichat.sh` (it runs every gate in
`src/tools/`; never hand-copy into `~/.pi/agent/extensions/`). Enable
the secret guard once per clone with the shipped enabler:

```
sh src/tools/enable_hook_chain.sh
```

That, and not `git config core.hooksPath .githooks`, because `core.hooksPath` is single-valued: a
local write replaces the global and system values for EVERY hook name at once. On a host that keeps a
guard in a global hooksPath directory — an identity check, a commit-msg rule, a pre-push — the bare
line stops all of them silently: no error, no changed exit code, commits keep landing. Nine clones on
one machine were in exactly that state and only a deliberate census found them (iid 15). The enabler
reads what is installed and FORWARDS to it: one small wrapper per hook name, written inside this
clone's own `.git`, running the host's hook first and this repo's guard after, and the first refusal
wins. On a host with nothing installed it writes the plain local value and says so, and `--check`
answers without touching anything — which is the form to use when you are only asking.

That command replaces the whole hook set git consults: a clone that already had a
`pre-commit` (a project check, husky, a personal guard) would otherwise stop running it
in silence. It no longer does. In the enabled state the guard chains that prior hook
itself — after its own checks, with its exit status propagated — so nothing you had is
lost and the refusal of either check refuses the commit. If instead you keep a DIFFERENT
hook set (`core.hooksPath` pointing somewhere else), make that hook set invoke
`.githooks/pre-commit` and return its exit status — the guard recognises that shape and
says so out loud rather than refusing.

If it cannot recognise that shape it refuses, and the refusal now tells you what it is
displacing — the value it found, the executable hooks git is consulting there instead of this
guard's own file, and the legacy hook the same value hides — plus the one prefix that proceeds
deliberately once you have read that:

```
TABICHAT_GUARD_PROCEED=1 git commit
```

The prefix waives the displacement refusal only. A staged secret, an unreadable or empty
pattern list, and a refusing chained hook still stop the commit with it set, so it is a
record of a decision taken, not an override of the check. It writes nothing to your
configuration either: the guard refuses rather than re-aiming your `core.hooksPath`.

To check where you stand, in this clone, before you commit anything:

```
sh src/tools/check_guard_armed.sh
sh src/tools/check_attributions.sh
```

The first prints one line — `ARMED` (naming a prior hook at the legacy path and whether the guard
chains it, when one exists), `ARMED (chained)`, or `NOT ARMED` with the command that arms it — and
exits non-zero when the guard is not on the path git would consult, or when a prior hook sits
displaced behind a guard that does not chain it. The second reads the lines this branch ADDED since
the published line and exits non-zero if any of them credits a decision to a person or to a seat —
the rule that a commit message says what the code does and nothing else, applied to the repo's
public bytes instead of only to the message. It looks at added lines alone, so what the repo
already carries is not this branch's to fix, and it always prints how many lines it scanned, so a
run that looked at nothing cannot read as a pass. `deploy-tabichat.sh` runs both, which is the only
reason either is a requirement rather than a suggestion.

**Run the gates with one env flag.** The `.ts` gates compare the seat's own
routing nick against the shipped default, so from your own shell:

```
env -u MQTT_LEAD_NICK ~/.bun/bin/bun src/tools/<gate>.ts
```

Without `-u MQTT_LEAD_NICK` those two gates used to return confident reds
that were your environment, not the tree. They no longer need the flag:
each one scrubs `MQTT_LEAD_NICK` and `MQTT_OWNER_NICK` before it
imports the module that reads them, so the result is the same in any terminal.
The flag stays harmless, and other gates may still read the environment. The
python gates run as `python3 src/tools/test_broker.py` and
`python3 src/tools/test_wrap_rows.py`. The build gate runs from `src/`, with
the three externals — a checkout has no `src/node_modules/`, so without them
it dies on `mqtt`:

```
cd src && bun build --target=bun --outdir <scratch-dir> \
  extensions/tabichat/index.ts \
  --external @earendil-works/pi-ai \
  --external @earendil-works/pi-coding-agent --external mqtt
```

(From the repo root the entry path is `src/extensions/tabichat/index.ts`;
the path must match where you stand.)

**Every code file under `src/` carries the licence preamble.** The project is
Business Source License 1.1 (see **LICENSE**); each `.ts`, `.mjs`, `.py`, and
`.sh` file opens with the same four comment lines — `//` for the first two
kinds, `#` for the last two — naming the copyright holder and the licence,
with `SPDX-License-Identifier: BUSL-1.1`. Rules for a new file, mechanical
and not negotiable: the name is **Business Source License 1.1** (no coined
variants), the reference is "the LICENSE file in the repository root" (no
URL), and the Change Date and Additional Use Grant are NOT restated in a
header — the LICENSE file owns those terms and a header that quotes them can
rot out of agreement. A `#!` line stays line 1, so the preamble sits on lines
2–5 in every file that carries one. A comment above a Python module docstring
does not un-docstring it — comments are not statements — which is why the
tool that prints its own `__doc__` as usage text, and the test that asserts
on that docstring, both stayed green. `preview-ext/` and doc files carry no
preamble.
