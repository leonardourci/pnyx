// Isolates a native send from the servers event loop; all writes use the CLI command.
import { AxiError } from 'axi-sdk-js'
import { reply } from './reply.ts'

try {
  process.stdout.write(JSON.stringify(await reply(process.argv.slice(2))))
} catch (error) {
  if (error instanceof AxiError) {
    process.stdout.write(JSON.stringify({
      error: { message: error.message, code: error.code, help: error.suggestions },
    }))
  }

  process.exitCode = 1
}
