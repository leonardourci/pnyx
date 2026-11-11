import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const POLL_MS = 20

// Kills a detached child and its whole group, as a stopped session takes its work down with it,
// once the child has written the file that marks the point to cut it at. Call it right after the spawn.
export async function killMidway({
  child,
  reached,
  timeoutMs,
}: {
  child: ChildProcess
  reached: string
  timeoutMs: number
}) {
  assert.ok(
    child.pid,
    'the child did not start',
  )
  const closed = new Promise(resolve => child.once(
    'close',
    resolve,
  ))
  const deadline = Date.now() + timeoutMs

  while (!existsSync(reached) && child.exitCode === null && Date.now() < deadline) {
    await delay(POLL_MS)
  }

  const written = existsSync(reached)

  try {
    process.kill(
      -child.pid,
      'SIGKILL',
    )
  } catch (error) {
    // A child that already exited has no group left to kill; the assertion below reports it.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }
  }

  await closed
  assert.ok(
    written,
    `${reached} was not written (waited up to ${timeoutMs} ms; the child's exit code was ${child.exitCode})`,
  )
}
