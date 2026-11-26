import { spawn } from 'node:child_process'
import { TitanError } from '#store/errors.ts'

export function runCommand({
  command,
  cwd,
  env,
}: {
  command: string
  cwd: string
  env: Record<string, string>
}): { pid: number } {
  // A worker never writes as the actor that started it, such as Titan, nor counts as the Titan Othrys runs.
  const inherited = { ...process.env }

  for (const name of [
    'OTHRYS_ACTOR',
    'OTHRYS_HOSTED',
  ]) {
    delete inherited[name]
  }

  const child = spawn(
    '/bin/sh',
    [
      '-c',
      command,
    ],
    {
      cwd,
      env: {
        ...inherited,
        ...env,
      },
      detached: true,
      stdio: 'ignore',
    },
  )
  // A failed spawn reports here as well as through the missing pid.
  child.on(
    'error',
    () => undefined,
  )
  child.unref()

  if (child.pid === undefined) {
    throw new TitanError({
      message: 'the Titan command did not start',
      code: 'COMMAND_ERROR',
      help: ['Use othrys titan to inspect the Titan'],
    })
  }

  return { pid: child.pid }
}
