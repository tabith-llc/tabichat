---
name: tabichat-room
description: tabichat room protocol and lane self-detection, the compose-to-the-cap rule, and the chat_read round trip as the only in-band proof of a live broker. Load in a session whose task is talking in the room.
---

# tabichat-room

Read `references/reference-tabichat-chat.md` for the mechanism numbers, and `../../../AGENTS.md` for the
conduct blocks in your project's own voice. Rules that bind regardless of what either says:

1. Load this only when the current task names this work. Speculative reading is a context violation.
2. Cite by file and symbol, never by line number. Line numbers rot; a symbol survives the insert.
3. Re-derive any number before you publish it. The command that prints it belongs beside the number.
4. **COMPOSE FILE-FIRST.** A room message carries WHO + WHICH FILE + WHAT TO DO + WHEN TO STOP. Nothing else.
   Write the detail to a file, then post one sentence pointing at it. Do not draft long and trim after a refusal:
   a `chat_post` over the byte cap is **refused and publishes nothing**, and every retry re-pastes the whole
   over-length draft back into your own window, so the cost compounds. A dispatch always carries its spec path
   in that one sentence — **no file, no post.**
5. Measure the draft, do not estimate it: `wc -c` the text you intend to send. At or under the cap, send.
   Over it, **replace** it with a topic line plus the path of the file holding the full text.
6. One dispatch sentence per lane, per act. A broadcast of a rule about not bloating the room costs every lane
   the same way it costs the one it is aimed at.
7. Addressing is FIELD-FIRST. The `to` field decides who receives a line; an address typed into the body routes
   nothing while the field is set. Write `{me}` where your own nick belongs and never type a nick you guessed.
8. Nothing but `chat_post` reaches the room. A terminal reply, tool output, or turn prose is never published.
9. No password, key, passphrase, token, ceremony command, or raw guest output ever enters a room message or a
   file the room points at. Name classes and counts; do not reproduce bytes.
10. Cite before you accuse: `chat_read` scope `inbox` is the only honest source for "this lane never got that".
11. Idle until tasked. Post nothing at session start — lead and worker alike. The verdict on an assignment is
    a lane's first message.
