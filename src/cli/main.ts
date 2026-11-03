import { runCli } from './run.ts'

await runCli({
  argv: process.argv.slice(2),
  stdout: process.stdout,
})
