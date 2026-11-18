#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'

const args = process.argv.slice(2)

if (args[1] === process.env.PNYX_TEST_GIT_PROJECT && args.includes(process.env.PNYX_TEST_GIT_ARG ?? '--git-dir')) {
  const socket = createConnection(process.env.PNYX_TEST_GIT_SOCKET)
  socket.resume()
  await once(
    socket,
    'end',
  )
}

const child = spawn(
  '/usr/bin/git',
  args,
  { stdio: 'inherit' },
)
const [code] = await once(
  child,
  'exit',
)
process.exitCode = code ?? 1
