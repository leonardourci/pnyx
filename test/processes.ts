import type { ChildProcess } from 'node:child_process'

// A process that ignores SIGTERM this long is killed outright.
const STOP_TIMEOUT_MS = 10000

// Processes a test started that are still running; one that exits on its own leaves the set.
const running = new Set<number>()

function signal({ pid, name }: { pid: number; name: NodeJS.Signals | 0 }): boolean {
  try {
    process.kill(pid, name)

    return true
  } catch {
    return false
  }
}

export function track({ child }: { child: ChildProcess }): void {
  const pid = child.pid

  // A spawn that failed has no process to stop.
  if (pid === undefined) {
    return
  }

  running.add(pid)
  child.once('exit', () => running.delete(pid))
}

// SIGTERM, then SIGKILL when it has not exited in time.
export async function stopProcess({ pid }: { pid: number }): Promise<void> {
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    // A process that already exited is not signalled again.
    if (!signal({ pid, name: 0 }) || !signal({ pid, name })) {
      break
    }

    for (const end = Date.now() + STOP_TIMEOUT_MS; signal({ pid, name: 0 }) && Date.now() < end;) {
      await new Promise(r => setTimeout(r, 20))
    }
  }

  running.delete(pid)
}

export const stopAll = () => Promise.all([...running].map(pid => stopProcess({ pid })))
