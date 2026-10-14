# search

Full-text history search: `pnyx-axi search "<words>"`, `search status` and `search rebuild`.

- `search.db` in the board's folder is a derived index, not a store. It is deletable like `snapshot.json` and rebuilt from `events.jsonl` and the transcripts the hooks recorded; nothing reads it as board state.
- `index.ts` is its only writer. Each search first folds in what the log and the transcripts gained since the `cursors` table (the event seq and byte offset; per transcript its device and inode and byte offset). A replaced or shortened transcript is read again. A `meta` table holds the schema and chunker versions; on mismatch the file is deleted and rebuilt.
- `docs` holds one row per chunk with its card, kind (`event`, `note` or `transcript`), source, event seq or transcript line offset, part and time; `docs_fts` is an FTS5 external-content table over it. `card_fts` holds one contentless row per card (its title and link titles, its notes, and all its other chunks), rebuilt when the card gains or loses chunks or is renamed, so every word of a query can match anywhere on a card. Cards are ranked by BM25 on it, the title and link titles weighing half and notes double, and shown with their best-matching chunks; `--card` and `--kind` match single chunks instead, a note chunk also ranking double.
- Both FTS5 tables use the `porter unicode61 remove_diacritics 2` tokenizer: words match by stem, with case and accents folded. `terms` holds every distinct indexed word (folded, unstemmed) and `terms_tri` its trigrams. When a query finds nothing, each word is retried with the indexed words nearest it by trigram similarity, or containing it, and the hits are marked `fuzzy`.
- `synonyms.ts` is the versioned synonym map: a query word or phrase in a group matches the whole group. Add a group there and bump its version.
- `text.ts` decides what is indexed: the text events carry, including harvested notes, and typed user messages and assistant text from Claude Code and Codex transcripts (not tool calls or output, thinking, injected text or a compaction summary, which is a note), with secret-shaped strings redacted, cut by a deterministic, versioned chunker.

Semantic search is planned: vectors will key on `docs.id`, so they attach without re-chunking.
