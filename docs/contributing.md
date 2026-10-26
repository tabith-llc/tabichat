# tabichat — Contributing

← back to the [README](../README.md)

## Contributing

Deploys go through `src/tools/deploy-tabichat.sh` (it runs every gate in
`src/tools/`; never hand-copy into `~/.pi/agent/extensions/`). Enable
the secret guard once per clone: `git config core.hooksPath .githooks`.

**Run the gates with one env flag.** The `.ts` gates compare the seat's own
routing nick against the shipped default, so from your own shell:

```
env -u MQTT_LEAD_NICK ~/.bun/bin/bun src/tools/<gate>.ts
```

Without `-u MQTT_LEAD_NICK` those two gates used to return confident reds
that were your environment, not the tree. They no longer need the flag:
since leg 540 each one scrubs `MQTT_LEAD_NICK` and `MQTT_OWNER_NICK` before it
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
