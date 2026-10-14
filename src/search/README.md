# search

Full-text history search: `pnyx-axi search "<words>"`, `search status` and `search rebuild`.

- `search.db` in the board's folder is a derived index, not a store. It is deletable like `snapshot.json` and rebuilt from `events.jsonl` and the transcripts the hooks recorded; nothing reads it as board state.
- `index.ts` is its only writer. Each search first folds in what the log and the transcripts gained since the `cursors` table (the event seq and byte offset; per transcript its device and inode and byte offset). A replaced or shortened transcript is read again. A `meta` table holds the schema and chunker versions; on mismatch the file is deleted and rebuilt.
- `docs` holds one row per chunk with its card, kind (`event` or `transcript`), source, event seq or transcript line offset, part and time; `docs_fts` is an FTS5 external-content table over it. Results are ranked by BM25, best chunk per card.
- `text.ts` decides what is indexed: the text events carry, typed user messages and assistant text from Claude Code transcripts (not tool calls or output, thinking or injected text), with secret-shaped strings redacted, cut by a deterministic, versioned chunker.

Semantic search is planned: vectors will key on `docs.id`, so they attach without re-chunking.
