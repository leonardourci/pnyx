#!/usr/bin/env node
import { createRequire } from "node:module";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { serve, stop } from "../server/server.ts";
import { TOP_LEVEL_HELP, commandHelp, commands, home } from "./commands.ts";

// Same relative path from src/cli and dist/cli.
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

await runAxiCli({
  description: "Deterministic board of every agent and its work",
  version,
  topLevelHelp: TOP_LEVEL_HELP,
  home,
  getCommandHelp: commandHelp,
  commands: {
    ...commands,
    serve,
    stop,
    // Shadows the SDK's npm self-update: pnyx-axi is not published while pre-v1.
    update: () => {
      throw new AxiError("pnyx-axi is not published yet", "VALIDATION_ERROR", [
        "Pull the repository and run `pnpm install && pnpm run build`",
      ]);
    },
  },
});
