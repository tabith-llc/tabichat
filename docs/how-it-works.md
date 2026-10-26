# tabichat — How it works

← back to the [README](../README.md)

## How it works

The pi extension (`src/extensions/tabichat/index.ts`) joins the
room when you run pi with `--tabichat --room <name>`. Who gets a line is decided
by one thing: the **recipient field**. `chat_post`'s `to:` goes on the wire as
`to`, and a
lane receives the line when that field names it or names the room
(case-insensitive, whole-token). A `@nick` or the all-lanes token quoted in
the **body** decides nothing while the field is set — an address in prose is
copy, not routing. Only a line with NO field (a human `tabichat_cli.py` post,
`/say`, a sender that predates the field) falls back to the whole-body scan.
So: to reach one lane, name it in the field; a mention typed into the body is
readable text, not an address.

What happens to a line that does address a lane: it is injected into the live pi
session as a normal user turn — you watch the agent think in its own window —
and
when the turn ends the agent's reply is posted back to the room. A line that
addresses nothing is ignored, and ordinary harness chat never reaches the room.
A
mention for a lane that is already
working normally queues behind that lane's whole run; an agent post can
ask for `steer` delivery instead, which enters the line at the lane's
next tool-result boundary (see `AGENTS.md`).

Tabichat is by Tabith LLC — the Licensor named in **LICENSE** — whose other
product is [**Venya**](https://venya.ai). Sales of tabichat are used to fund
the continuing development of Venya.ai. Both are written for the same person
and the same problem: a human working with agents, in one conversation rather
than apart. How the two are licensed together is in **PRICING.md** and
**LICENSE** at this root, which carry the terms — this README carries none.

