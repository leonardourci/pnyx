import type { ChildProcess } from 'node:child_process'

// A process that ignores SIGTERM this long is killed outright.
const STOP_TIMEOUT_MS = 10000

// Processes a test started that are still running; one that exits on its own leaves the set.
const running = new Set<number>()

// A test process that ends before its hooks run still takes what it started down with it.
process.on('exit', () => {
  for (const pid of running) {
    signal({ pid, name: 'SIGKILL' })
  }
})

function signal({ pid, name }: { pid: number; name: NodeJS.Signals | 0 }): boolean {
  try {
    process.kill(pid, name)

    return true
  } catch {
    return false
  }
}

export function track({ child }: { child: ChildProcess }): void {
  const pid = child.pid!
  running.add(pid)
  child.once('exit', () => running.delete(pid))
}

// SIGTERM, then SIGKILL when it has not exited in time; resolves once the process is gone.
export async function stopProcess({ pid }: { pid: number }): Promise<void> {
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    if (!signal({ pid, name })) {
      break
    }

    for (const end = Date.now() + STOP_TIMEOUT_MS; signal({ pid, name: 0 }) && Date.now() < end;) {
      await new Promise(r => setTimeout(r, 20))
    }
  }

  running.delete(pid)
}

export const stopAll = () => Promise.all([...running].map(pid => stopProcess({ pid })))
