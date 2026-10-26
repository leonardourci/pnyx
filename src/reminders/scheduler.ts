export interface ReminderScheduler {
  now(): number
  schedule({
    at,
    fire,
  }: {
    at: number
    fire(): void
  }): () => void
}

export const systemReminderScheduler: ReminderScheduler = {
  now: () => Date.now(),
  schedule: ({
    at,
    fire,
  }) => {
    const timer = setTimeout(
      fire,
      Math.max(
        100,
        Math.min(
          60_000,
          at - Date.now(),
        ),
      ),
    )

    return () => clearTimeout(timer)
  },
}
