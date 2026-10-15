import { spawn } from 'node:child_process'
import { BoardError } from '../../core/model.ts'

export function runCommand({ command, cwd, env }: {
  command: string
  cwd: string
  env: Record<string, string>
}): { pid: number } {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' })
  // A failed spawn reports here as well as through the missing pid.
  child.on('error', () => undefined)
  child.unref()

  if (child.pid === undefined) {
    throw new BoardError({ message: 'the board command did not start', code: 'COMMAND_ERROR', help: ['Check it with `pnyx-axi board show`'] })
  }

  return { pid: child.pid }
}
