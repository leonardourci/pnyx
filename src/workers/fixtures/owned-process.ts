import { createInterface } from 'node:readline'

const STDERR_BYTES = 1024 * 1024

if (process.argv[2] === 'claude') {
  process.stderr.write(
    'x'.repeat(STDERR_BYTES),
    () => process.stdout.write('ready\n'),
  )
  setInterval(
    () => {},
    1000,
  )
} else {
  createInterface({ input: process.stdin }).on(
    'line',
    line => {
      const request = JSON.parse(line)

      if (request.id === undefined) {
        return
      }

      const result = request.method === 'thread/start'
        ? { thread: { id: 'owned-native-thread' } }
        : {}
      process.stdout.write(`${JSON.stringify({
        id: request.id,
        result,
      })}\n`)
    },
  )
}
