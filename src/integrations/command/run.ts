import { spawn } from 'node:child_process'
import { HydraError } from '../../store/errors.ts'

export function runCommand({
  command,
  cwd,
  env,
}: {
  command: string
  cwd: string
  env: Record<string, string>
}): { pid: number } {
  // A worker never writes as the actor that started it, such as Hydra, nor counts as the Hydra Pnyx runs.
  const {
    PNYX_ACTOR: _actor,
    PNYX_HOSTED: _hosted,
    ...inherited
  } = process.env
  void _actor
  void _hosted
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
    throw new HydraError({
      message: 'the Hydra command did not start',
      code: 'COMMAND_ERROR',
      help: ['Check it with `pnyx-axi hydra show`'],
    })
  }

  return { pid: child.pid }
}
