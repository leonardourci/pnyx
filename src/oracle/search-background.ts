import { migrateOwnerMemory } from '#memory/owner-memory.ts'
import { Worker } from 'node:worker_threads'
import { log } from '#app/diagnostics.ts'
import { SOURCE_CONDITIONS } from '#app/source-conditions.ts'
import type { Query, SearchSnapshot } from './model.ts'
import { nativeHome } from '#app/native-home.ts'
import { loadTitan } from '#app/store.ts'
import { titanFiles } from '#store/file-home.ts'
import { taskRuntimeDir } from '#store/paths.ts'
import { join } from 'node:path'
import type { search } from './search.ts'
import { TitanError } from '#store/errors.ts'

const WORKER = new URL(
  import.meta.url.endsWith('.ts') ? './search-worker.ts' : './search-worker.js',
  import.meta.url,
)

const searchQueues = new Map<string, Promise<ReturnType<typeof search>>>()

export interface SearchInput {
  titanId: string
  query: Query
}

export type SearchWork = SearchInput & SearchSnapshot

function searchSnapshot({ titanId }: { titanId: string }): Promise<SearchSnapshot> {
  const home = nativeHome()

  return home.run({
    fn: () => {
      const view = home.files.positions({ titan: titanId })

      if (!view || view.issue) {
        throw view?.issue ?? new TitanError({
          code: 'NOT_FOUND',
          message: `unknown Titan: ${titanId}`,
        })
      }

      const state = loadTitan({ titanId }).state

      const sources: SearchSnapshot['sources'] = [
        {
          key: `titan:${titanId}`,
          scope: titanId,
          path: join(
            titanFiles({
              home: home.path,
              titan: titanId,
            }),
            'titan.log',
          ),
          position: view.position,
          accepted: view.accepted,
        },
      ]

      for (const [
        task,
        stored,
      ] of view.tasks) {
        if (stored.issue) {
          continue
        }

        sources.push({
          key: `task:${task}`,
          scope: task,
          path: join(
            state.cards[task]?.workerLogDir ?? taskRuntimeDir({ task }),
            'task.log',
          ),
          position: stored.position,
          accepted: stored.accepted,
        })
      }

      return structuredClone({
        state,
        positions: home.references({ titan: titanId }),
        sources,
      })
    },
  })
}

export type SearchAnswer = { result: ReturnType<typeof search> } | {
  error: {
    message: string
    code: string
    help?: string[]
  }
}

function requireSearchActive({ signal }: { signal?: AbortSignal }): void {
  if (signal?.aborted) {
    throw new TitanError({
      message: 'Oracle search cancelled',
      code: 'CANCELLED',
    })
  }
}

export async function searchInBackground({
  titanId,
  query,
  signal,
}: SearchInput & { signal?: AbortSignal }): Promise<ReturnType<typeof search>> {
  const previousSearch = searchQueues.get(titanId)

  const next = async () => {
    if (previousSearch) {
      await Promise.allSettled([previousSearch])
    }

    requireSearchActive({ signal })
    await migrateOwnerMemory()

    return searchInWorker({
      titanId,
      query,
      signal,
    })
  }

  const pending = next()
  searchQueues.set(
    titanId,
    pending,
  )

  try {
    return await pending
  } finally {
    if (searchQueues.get(titanId) === pending) {
      searchQueues.delete(titanId)
    }
  }
}

async function searchInWorker({
  titanId,
  query,
  signal,
}: SearchInput & { signal?: AbortSignal }): Promise<ReturnType<typeof search>> {
  requireSearchActive({ signal })
  const snapshot = await searchSnapshot({ titanId })
  requireSearchActive({ signal })

  return new Promise((
    resolve,
    reject,
  ) => {
    const worker = new Worker(
      WORKER,
      {
        execArgv: SOURCE_CONDITIONS,
        workerData: {
          titanId,
          query,
          ...snapshot,
        },
      },
    )
    let answer: SearchAnswer | undefined
    let failure: Error | undefined

    const cancel = () => {
      // Exit settles the request, so the next scan starts after this worker has stopped.
      worker.terminate().catch((error: Error) => {
        log({
          level: 'error',
          operation: 'oracle.cancel',
          titanId,
          error,
        })
      })
    }

    signal?.addEventListener(
      'abort',
      cancel,
      { once: true },
    )
    worker.once(
      'message',
      (found: SearchAnswer) => {
        answer = found
      },
    )
    worker.once(
      'error',
      (error: Error) => {
        failure = error
      },
    )
    worker.once(
      'exit',
      code => {
        signal?.removeEventListener(
          'abort',
          cancel,
        )

        if (signal?.aborted) {
          reject(new TitanError({
            message: 'Oracle search cancelled',
            code: 'CANCELLED',
          }))

          return
        }

        if (failure) {
          reject(failure)

          return
        }

        if (code !== 0 || !answer) {
          reject(new Error(`Oracle search worker exited with code ${code}`))

          return
        }

        if ('error' in answer) {
          reject(new TitanError(answer.error))

          return
        }

        resolve(answer.result)
      },
    )
  })
}
