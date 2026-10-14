// pnyx-axi search: full-text search over a board's history, plus `search status|rebuild`.
import { AxiError } from "axi-sdk-js";
import { findCard } from "../core/decide.ts";
import { COMMON, guard, parse, type Options, type Output } from "../cli/commands.ts";
import { loadBoard } from "../store/board-store.ts";
import { KINDS, indexStatus, rebuildIndex, search, updateIndex, type IndexResult, type Kind } from "./index.ts";

const LIMIT = 20;
const MAX = 100;

const SEARCH: Options = {
  ...COMMON,
  kind: { type: "string" },
  card: { type: "string" },
  workspace: { type: "string" },
  limit: { type: "string" },
};

function status(board: string): Output {
  const s = indexStatus(board);
  const seq = loadBoard(board).state.seq;
  if (!s) {
    return {
      index: "none: not built yet",
      help: ['Run `pnyx-axi search "<words>"` or `pnyx-axi search rebuild` to build it'],
    };
  }
  if (!s.current) return { index: "stale: built by another version; the next search rebuilds it", bytes: s.bytes };
  return {
    index: s.builtThrough === seq ? `current through seq ${seq}` : `behind: through seq ${s.builtThrough} of ${seq}; the next search catches up`,
    mode: "lexical",
    semantic: "planned, not built",
    docs: s.docs,
    transcripts: s.transcripts,
    bytes: s.bytes,
  };
}

function built(result: IndexResult): Output {
  return { rebuilt: result, help: ['Run `pnyx-axi search "<words>"`'] };
}

const searchCommand = guard((args) => {
  if (args[0] === "status" || args[0] === "rebuild") {
    const { board } = parse(args.slice(1), COMMON, 0);
    return args[0] === "status" ? status(board) : built(rebuildIndex(board));
  }
  // Unquoted words are one query.
  const { values, positionals, board } = parse(args, SEARCH, Infinity);
  const text = positionals.join(" ");
  if (!text) throw new AxiError("missing query", "VALIDATION_ERROR", ['Run `pnyx-axi search "<words>"`']);
  const kind = values.kind as string | undefined;
  if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
    throw new AxiError(`unknown kind: ${kind}`, "VALIDATION_ERROR", [`Use one of ${KINDS.join(", ")}`]);
  }
  const rawLimit = values.limit as string | undefined;
  if (rawLimit !== undefined && !/^[1-9]\d*$/.test(rawLimit)) throw new AxiError("--limit must be a positive integer", "VALIDATION_ERROR");
  const card = values.card === undefined ? undefined : findCard(loadBoard(board).state, values.card as string).id;
  updateIndex(board);
  const { hits, total } = search(board, {
    text,
    limit: Math.min(rawLimit ? Number(rawLimit) : LIMIT, MAX),
    ...(kind ? { kind: kind as Kind } : {}),
    ...(card ? { card } : {}),
    ...(values.workspace ? { workspace: values.workspace as string } : {}),
  });
  if (hits.length === 0) {
    return { mode: "lexical", results: `none: no matches for ${JSON.stringify(text)}`, help: ["Every word must match; try fewer words or a prefix like `deplo*`"] };
  }
  const out: Output = { mode: "lexical", results: hits };
  const help = card ? [`Run \`pnyx-axi history --card ${card}\` for its events`] : [`Run \`pnyx-axi card ${hits[0]!.card}\` to open the top match`];
  if (total > hits.length) help.push(`${total - hits.length} more ${card ? "matches" : "matching cards"}; raise --limit (max ${MAX}) or narrow with --kind, --card or --workspace`);
  out.help = help;
  return out;
});

export const searchCommands = { search: searchCommand };

export const SEARCH_HELP = `usage: pnyx-axi search "<words>" [--kind event|transcript] [--card <id>] [--workspace <name>] [--limit <n>]
       pnyx-axi search status | rebuild [--board <name>]
Full-text search over card titles, links, event text and the session transcripts hooks recorded.
Every word must match somewhere on one card's text, its title or its link titles; end a word with * to match a prefix; \`search -- status\` searches for that word.
Results are ranked by BM25, best first, one per card (all of a card's matches with --card),
${LIMIT} by default (max ${MAX}).
Each search first indexes what the log and transcripts gained. The index, search.db in the board's
folder, is a derived cache: \`search rebuild\` deletes and rebuilds it from the log and transcripts.
Tool calls and output, thinking and injected text are not indexed; secret-shaped strings are redacted.
`;
