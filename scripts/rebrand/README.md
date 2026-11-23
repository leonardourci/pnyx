# Othrys source rename

Run `python3 scripts/rebrand/othrys.py` from this checkout. An already-renamed package exits without any edits. For the initial pass, the codemod is anchored to its recorded pre-rebrand Git revision and only transforms files whose bytes still match that revision. Repeating it leaves subsequent compatibility edits intact; a path move refuses an existing destination.

The mechanical pass renames product text, environment names, TypeScript symbols, source folders, executable entry paths and shipped skill folders. Historical plans, recorded agent fixtures, binary media, symlinks and persisted host literals are excluded. Semantic compatibility changes are reviewed separately; see [Compatibility](../../docs/compatibility.md) for retained storage identifiers, old readers and home selection.
