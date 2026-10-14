// Isolates a native send from the servers event loop; all writes use the CLI command.
import { firstmateCommands } from "../integrations/firstmate/cli.ts";
try { process.stdout.write(JSON.stringify(firstmateCommands.reply(process.argv.slice(2)))); }
catch { process.exitCode = 1; }
