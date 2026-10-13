# core

Event schema, board rules and the pure reducer: `(snapshot, event) -> snapshot`.

Code here does no I/O, reads no clock and draws no randomness. Every fact the reducer needs is in the event, so replaying the same log always gives the same board.
