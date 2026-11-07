import { availableParallelism } from 'node:os'

// A change waits this long for others to fold into the same catch-up.
export const INDEX_DELAY_MS = 5000

// Background catch-ups across every Hydra this process serves share half the CPUs: a start
// mounts every Hydra at once, and each one launching its index process together starves the
// server's own work. A query waiting on its index never queues here.
export const BACKGROUND_CATCHUPS = Math.max(
  1,
  Math.floor(availableParallelism() / 2),
)
let active = 0
const queued: (() => void)[] = []

const acquire = ({ granted }: { granted(): void }) => {
  if (active < BACKGROUND_CATCHUPS) {
    active += 1
    granted()

    return
  }

  queued.push(granted)
}

const release = () => {
  const next = queued.shift()

  if (next) {
    next()

    return
  }

  active -= 1
}

// One catch-up at a time; changes during one fold into a single follow-up. start never rejects.
export function indexRuns<Outcome>({ start }: { start(): Promise<Outcome> }) {
  let running: Promise<Outcome> | null = null
  let again = false
  let waiting: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const run = (): Promise<Outcome> => {
    clearTimeout(waiting)
    waiting = undefined

    if (running) {
      again = true

      return running
    }

    running = start().finally(() => {
      running = null

      if (again && !stopped) {
        again = false
        // Nothing is lost by not awaiting it: start never rejects.
        run()
      }
    })

    return running
  }

  return {
    changed() {
      if (stopped || waiting) {
        return
      }

      waiting = setTimeout(
        () => acquire({
          granted: () => {
            // A Hydra stopped, or already caught up by another run, while its catch-up waited for a
            // turn no longer writes or indexes.
            if (stopped || !waiting) {
              release()

              return
            }

            // A turn that joins a running catch-up keeps its slot through the follow-up it asked for.
            void run().then(() => running)
              .finally(release)
          },
        }),
        INDEX_DELAY_MS,
      )
    },
    // The outcome of a catch-up that started after this call; a running one may predate the change.
    async ready(): Promise<Outcome> {
      if (!running) {
        return run()
      }

      const current = running
      again = true
      await current

      // The end of current started the follow-up asked for above, unless stop() came first.
      return running ?? run()
    },
    // Ends background runs only; start decides what a ready() after it gets.
    stop() {
      stopped = true
      clearTimeout(waiting)
    },
  }
}
