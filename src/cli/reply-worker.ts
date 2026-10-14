// Isolates a native send from the servers event loop; all writes use the CLI command.
import { AxiError } from "axi-sdk-js";
import { firstmateCommands } from "../integrations/firstmate/cli.ts";
try { process.stdout.write(JSON.stringify(firstmateCommands.reply(process.argv.slice(2)))); }
catch (error) {
  if (error instanceof AxiError) process.stdout.write(JSON.stringify({ error: { message: error.message, code: error.code, help: error.suggestions } }));
  process.exitCode = 1;
}
