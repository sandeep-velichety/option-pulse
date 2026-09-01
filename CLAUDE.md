# CLAUDE.md

## What this is

A multi-agent automated trading system (`trading-council`), pivoted from the
original OptionPulse advisory dashboard (still intact on `main`). All new work
happens on `poc/trading-council`.

Design docs: **Council Protocol** (architecture ADR) and **Ship Order** (MVP
build plan) are the source of truth for design decisions — both published as
web artifacts. [`docs/DECISION_LOG.md`](docs/DECISION_LOG.md) is the durable,
in-repo record of the same history and does not depend on those artifacts
staying reachable.

## Standing instruction: keep the decision log current

**At the end of every session that makes a real change — code, architecture,
scope, or a decision reversed — update `docs/DECISION_LOG.md` before
considering the work done.** Append to §5 ("What's actually been built") and
refresh the §6 status table; add a new dated entry rather than editing history
away. This is not optional cleanup — it's the reason the log exists. If a
session ends without touching it, do it before signing off, not "next time."

Skip it only for pure exploration/discussion that changed nothing (no files
touched, no decision made).

## Hard invariant

No process holding a broker (Alpaca) or LLM (Anthropic) credential accepts
inbound traffic from the public internet. `control-plane` and `execution`
communicate only through the database (`market_snapshots`, `trade_intents`),
never HTTP. Every service enforces its own credential isolation at runtime —
see the guard at the top of each `services/*/src/index.ts`. Don't relax these
guards to "make something work"; that defeats their purpose.
