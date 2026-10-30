import { open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { deferred } from './deferred.ts'

async function replace({
  path,
  text,
}: {
  path: string
  text: string
}) {
  const stage = `${path}.next`
  const file = await open(
    stage,
    'w',
    0o600,
  )

  try {
    await file.chmod(0o600)
    await file.writeFile(text)
    await file.sync()
  } finally {
    await file.close()
  }

  await rename(
    stage,
    path,
  )
  const directory = await open(
    dirname(path),
    'r',
  )

  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

// Each waiter is covered by its snapshot or a later snapshot that includes the same durable state.
export function durableWriter({ path }: { path: string }) {
  let pending: (() => string) | undefined
  let running = false
  let waiters: ReturnType<typeof deferred<void>>[] = []

  const flush = async () => {
    while (pending) {
      const text = pending
      const batch = waiters
      pending = undefined
      waiters = []

      try {
        await replace({
          path,
          text: text(),
        })

        for (const waiter of batch) {
          waiter.resolve()
        }
      } catch (error) {
        for (const waiter of batch) {
          waiter.reject(error)
        }
      }
    }

    running = false
  }

  return {
    write({ text }: { text(): string }): Promise<void> {
      const waiter = deferred<void>()
      pending = text
      waiters.push(waiter)

      if (!running) {
        running = true
        queueMicrotask(() => {
          void flush()
        })
      }

      return waiter.promise
    },
  }
}
