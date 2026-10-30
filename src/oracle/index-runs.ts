// A change waits this long for others to fold into the same catch-up.
export const INDEX_DELAY_MS = 5000

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
        run,
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
