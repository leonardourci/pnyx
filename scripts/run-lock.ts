import { readFileSync, rmSync, writeFileSync } from 'node:fs'

// Shared by every checkout on the machine, so two full runs never load it at once.
const LOCK = '/tmp/pnyx-full-run.lock'
const POLL_MS = 1000

function holder({ path }: { path: string }): string | undefined {
  try {
    return readFileSync(
      path,
      'utf8',
    )
  } catch {
    return undefined
  }
}

function alive({ pid }: { pid: number }): boolean {
  try {
    process.kill(
      pid,
      0,
    )

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Waits until no other full run holds the lock, then holds it until this process exits. A run
// started by one that already holds it (verify's test steps) shares it.
export async function holdRunLock({
  name,
  path = process.env.PNYX_RUN_LOCK_FILE ?? LOCK,
  waiting = ({ owner }) => console.log(`${name}: waiting for the full run already in progress (${owner})`),
}: {
  name: string
  path?: string
  waiting?({ owner }: { owner: string }): void
}): Promise<void> {
  const mine = `${process.pid} ${name} since ${new Date().toISOString()}`
  let reported = ''

  for (;;) {
    const owner = holder({ path })

    if (owner !== undefined && owner === process.env.PNYX_RUN_LOCK) {
      return
    }

    // An empty lock is one another run is still writing.
    if (owner === undefined || (owner && !alive({ pid: Number.parseInt(owner) }))) {
      // ponytail: two waiters that find the same dead holder at once may both take over; they then
      // only run side by side, as they would without the lock.
      rmSync(
        path,
        { force: true },
      )

      try {
        writeFileSync(
          path,
          mine,
          { flag: 'wx' },
        )
        process.env.PNYX_RUN_LOCK = mine
        process.once(
          'exit',
          () => {
            if (holder({ path }) === mine) {
              rmSync(
                path,
                { force: true },
              )
            }
          },
        )

        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }

        continue
      }
    }

    if (owner !== reported) {
      reported = owner
      waiting({ owner })
    }

    await new Promise(resolve => setTimeout(
      resolve,
      POLL_MS,
    ))
  }
}
