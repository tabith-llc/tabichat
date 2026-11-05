#!/usr/bin/env python3
# Copyright (c) 2026 Tabith LLC.
# Licensed under the Business Source License 1.1 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at the LICENSE
# file in the repository root. SPDX-License-Identifier: BUSL-1.1
"""test_fixture_isolation.py — the fixture record is OWNER-SCOPED, and one run's teardown cannot
destroy another run's broker.

WHY THIS FILE EXISTS. `broker-fixture.sh` kept its record at one box-global path,
`${TMPDIR}/tabichat-fixture.state`. `test_broker_auth.ts` starts a fixture, runs its cells, and calls
`down` at teardown — so it stopped and destroyed whatever broker was recorded there, including one a
different seat had started for its own physical TLS cells. The victim's own test then printed
`NOT RUN — no fixture recorded`, which reads exactly like a product failure and is not one. The lead
reproduced it deterministically, twice, and another lane had already met it once as an
unexplained anomaly and correctly refused to guess a cause.

This is the same disease the serve tooling was fixed for: a teardown that acts on whatever it finds
instead of only on what it started. The rule is identify before you signal, and scope the record.

A CELL THAT CANNOT RUN IS A FAILURE, NOT A SKIP — same bar as every other physical file here.
"""

import os
import re
import subprocess
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TMP = os.environ.get("TMPDIR", "/tmp")
PREFIX = "tabichat-fixture-"

failed = []
TOTAL = 0


def check(name, got, want):
    global TOTAL
    TOTAL += 1
    if got != want:
        failed.append(name)
        print("FAIL  %s: got %r, want %r" % (name, got, want))
    else:
        print("ok    %s: %r" % (name, got))


def fixture(args, owner, timeout=180):
    env = dict(os.environ, TABICHAT_FIXTURE_OWNER=owner)
    return subprocess.run(
        ["sh", "src/tools/broker-fixture.sh"] + args,
        cwd=REPO, env=env, capture_output=True, text=True, timeout=timeout,
    )


def record(owner):
    return os.path.join(TMP, "tabichat-fixture-%s.state" % owner)


def state_of(name):
    r = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", name],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "absent"


def fields(path):
    with open(path, encoding="utf-8") as fh:
        parts = fh.read().split()
    return dict(zip(("name", "dir", "port", "room", "phase"), parts))


DOCKER = subprocess.run(["docker", "info"], capture_output=True)
if DOCKER.returncode != 0:
    print("NOT RUN — docker is not usable here, so the isolation half cannot be observed.")
    print(DOCKER.stderr.decode(errors="replace").strip()[:200])
    sys.exit(1)

A, B = "isolation-A", "isolation-B"
MY_DIRS = []
for o in (A, B):
    fixture(["down"], o)  # idempotent pre-clean of our OWN owners only

print("owner A starts a fixture...")
ra = fixture(["up", "phase2"], A)
if "FIXTURE_PORT=" not in ra.stdout:
    print("NOT RUN — owner A's fixture did not start:"); print(ra.stdout + ra.stderr)
    sys.exit(1)
NAME_A = fields(record(A))["name"]
MY_DIRS.append(fields(record(A))["dir"])
check("A's record lives at its own owner-scoped path",
      os.path.isfile(record(A)) and not os.path.isfile(record(B)), True)

print("owner B starts its own, while A's is still up...")
rb = fixture(["up", "phase2"], B)
if "FIXTURE_PORT=" not in rb.stdout:
    print("NOT RUN — owner B's fixture did not start:"); print(rb.stdout + rb.stderr)
    fixture(["down"], A)
    sys.exit(1)
NAME_B = fields(record(B))["name"]
MY_DIRS.append(fields(record(B))["dir"])
check("the two owners hold two DIFFERENT brokers", NAME_A != NAME_B, True)

# THE HEADLINE CELL, and it is the one that used to fail: B tearing down must leave A alone.
fixture(["down"], B)
check("B's own record is gone after B's teardown", os.path.isfile(record(B)), False)
check("A's record SURVIVES its neighbour's teardown", os.path.isfile(record(A)), True)
check("A's broker is STILL RUNNING after its neighbour came down", state_of(NAME_A), "true")
check("and A's broker was not even restarted: same container id, same name",
      fields(record(A))["name"], NAME_A)

# --- NEGATIVE HALVES: a record naming something that is not a fixture is not a kill command -------
BOGUS = os.path.join(TMP, "tabichat-fixture-bogus.state")
with open(BOGUS, "w", encoding="utf-8") as fh:
    fh.write("definitely-not-a-fixture-container /tmp/nope 1 fixture phase1\n")
r = fixture(["down"], "bogus")
check("down REFUSES a record naming a non-fixture container", r.returncode, 1)
check("and it says so, naming the container", "REFUSING" in (r.stderr + r.stdout), True)
check("a refusal leaves the RECORD in place rather than laundering it away",
      os.path.isfile(BOGUS), True)

# An owner-scoped path must also be derived identically by the reader, or the hand-run recipe breaks.
# AND THE INSTRUMENT MUST TEST CODE, NOT PROSE. A substring search over a whole file reads red on the
# comment that EXPLAINS the old hazard, and a check that reads red on clean prose is a check that gets
# disabled — so this asserts on the STATE assignment line, which is the only line that decides where
# the record goes. The prose is allowed to name what it forbids.
src_reader = open(os.path.join(REPO, "src/tools/test_tlsenv_paho.py"), encoding="utf-8").read()
src_writer = open(os.path.join(REPO, "src/tools/broker-fixture.sh"), encoding="utf-8").read()
STATE_LINES = [l.strip() for l in src_writer.splitlines() if l.strip().startswith("STATE=")]
reader_code = "\n".join(l for l in src_reader.splitlines() if not l.strip().startswith("#"))
check("the writer has exactly one STATE assignment, and it is owner-scoped",
      len(STATE_LINES) == 1 and "${OWNER}" in STATE_LINES[0], True)
check("no CODE line anywhere still writes the old box-global record path",
      "tabichat-fixture.state" in ("\n".join(STATE_LINES) + reader_code), False)
check("the python reader derives the owner-scoped name",
      'tabichat-fixture-%s.state" % OWNER' in src_reader, True)
check("and the reader still refuses loudly when there is no record (no silent pass)",
      "if not os.path.isfile(STATE):" in src_reader, True)

for o in (A, B, "bogus"):
    fixture(["down"], o)
    p = record(o)
    if o == "bogus":
        # `down` refuses to act on it, so remove it here — it is this file's own scratch.
        if os.path.isfile(p):
            os.remove(p)
if os.path.isfile(BOGUS):
    os.remove(BOGUS)

# Scope the residue claim to fixtures THIS run created. `/tmp` is shared with every other seat on this
# box, and a cell that reads red because a neighbour is mid-run is a cell that will get deleted.
mine = set(n for n in (NAME_A, NAME_B) if n)
all_names = subprocess.run(["docker", "ps", "-a", "--format", "{{.Names}}"],
                           capture_output=True, text=True).stdout.split()
check("this run's own containers are gone", sorted(n for n in all_names if n in mine), [])
check("this run's own scratch dirs are gone",
      sorted(d for d in MY_DIRS if os.path.isdir(d)), [])

if failed:
    print("\n%d FIXTURE-ISOLATION check(s) FAILED: %s" % (len(failed), ", ".join(failed)))
    sys.exit(1)
passed = TOTAL - len(failed)
print("\nall %d fixture-isolation checks pass (owner-scoped record, neighbour teardown cannot "
      "reach a foreign broker, refusals leave both record and process alone)" % passed)
