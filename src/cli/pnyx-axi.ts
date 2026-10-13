#!/usr/bin/env node
import { createRequire } from "node:module";
import { AxiError, runAxiCli } from "axi-sdk-js";

// Same relative path from src/cli and dist/cli.
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const TOP_LEVEL_HELP = `usage: pnyx-axi [command] [args] [flags]
description: Deterministic board of every agent and its work
commands:
  pnyx-axi   Show the board summary
flags:
  --help     Show this help
  --version  Show the version
status: pre-v1; the event log, sources and web board land in upcoming releases
`;

await runAxiCli({
  description: "Deterministic board of every agent and its work",
  version,
  topLevelHelp: TOP_LEVEL_HELP,
  // ponytail: no event log yet, so the board is always empty; the store PR replaces this.
  home: () => ({
    board: "default",
    columns: { needs_you: 0, workers_on_it: 0, review: 0, done: 0 },
    cards: "none: no sources are connected yet",
    help: ["Run `pnyx-axi --help` to see commands"],
  }),
  commands: {
    // Shadows the SDK's npm self-update: pnyx-axi is not published while pre-v1.
    update: () => {
      throw new AxiError("pnyx-axi is not published yet", "VALIDATION_ERROR", [
        "Pull the repository and run `pnpm install && pnpm run build`",
      ]);
    },
  },
});
