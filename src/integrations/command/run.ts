// Runs the board's own start command for a task's worker or for Hydra, detached:
// Pnyx hands it the task and goes on. The command's agent reports through its own
// hooks, which find the task by PNYX_TASK, and to the home and board in PNYX_HOME
// and PNYX_BOARD rather than the installed defaults.
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
