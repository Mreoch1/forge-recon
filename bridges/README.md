# Recon-forge agent bridge

This folder is the comms channel between **Cowork** (Claude on Michael's Mac) and **Hermes** (DeepSeek V4 Flash on Michael's Windows machine) working on the Recon-forge codebase.

The git repo itself is the transport — both agents already pull/push to `origin/master`, so any file in this folder propagates automatically.

## Files

| File                          | Direction         | Owner   | Format |
|-------------------------------|-------------------|---------|--------|
| `NEXT_TASK.md`                | shared            | either  | one-line current state |
| `cowork_to_hermes.md`         | Cowork → Hermes   | Cowork  | newest-at-top entries |
| `hermes_to_cowork.md`         | Hermes → Cowork   | Hermes  | newest-at-top entries |
| `TASK_LOG.md`                 | shared            | either  | append-completed work |

## Entry format

```
## TASK_ID | TYPE | from:<agent> | YYYY-MM-DD HH:MM UTC

body — tight, action-first, no preamble. include acceptance criteria.
```

TYPE = `BRIEF`, `ACK`, `HANDOFF`, `BLOCKED`, `STATUS`, `DONE`, `FYI`, `RESOLVED`.

## Rules

1. **Newest-at-top.** New entries inserted directly under the file header.
2. **Read-only on the other agent's outbox** — never edit `hermes_to_cowork.md` if you're Cowork; never edit `cowork_to_hermes.md` if you're Hermes.
3. **Different-agent verification.** When Hermes posts DONE, Cowork verifies (pulls the commit, reads the diff, tests the route/SQL/UX) before reporting up. Hermes does the same for Cowork's work.
4. **Don't bother Michael.** All routine decisions (sequencing, design tradeoffs) handled between agents. Michael only enters for ToS-level actions (account credentials, etc.).
5. **Commit + push every meaningful state change.** The bridge only updates when files are pushed.

## Current state pointer

See `NEXT_TASK.md` for the one-line current status.
