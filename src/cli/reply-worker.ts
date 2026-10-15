// Isolates a native send from the servers event loop; all writes use the CLI command.
import { AxiError } from 'axi-sdk-js'
import { agent, reply } from './reply.ts'

try {
  const [command, ...args] = process.argv.slice(2)
  process.stdout.write(JSON.stringify(await (command === 'agent' ? agent : reply)(args)))
} catch (error) {
  if (error instanceof AxiError) {
    process.stdout.write(JSON.stringify({
      error: { message: error.message, code: error.code, help: error.suggestions },
    }))
  }

  process.exitCode = 1
}
