import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadHydra } from '#app/store.ts'
import { hydraDir } from '#app/home-migration.ts'
import { taskRuntimeDir } from '#store/paths.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { privateDir } from '#store/storage.ts'
import { watchPath } from '#app/watch.ts'
import type { HydraState } from '#app/model.ts'
import type { WorkerCode, WorkerLine } from '#tasks/model.ts'
import { parseLink, decideLink } from '#tasks/delivery/links.ts'
import { applyDecision } from '#app/decision.ts'
import { HydraError } from '#store/errors.ts'
import { log } from '#app/diagnostics.ts'
import { background } from '#app/background.ts'

const BATCH_BYTES = 64 * 1024
const LINE_BYTES = 16 * 1024
const BATCH_LINES = 128

const CODES = new Set<WorkerCode>([
  'needs-you',
  'blocked',
  'done',
  'link',
  'note',
])

export function workerTaskDir({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): string {
  const card = loadHydra({ hydraId }).state.cards[task]
  const dir = reportDirectory({
    hydraFolder: hydraDir({ hydraId }),
    task,
    recorded: card?.workerLogDir,
  })
  privateDir({ dir })

  return dir
}

function reportDirectory({
  hydraFolder,
  task,
  recorded,
}: {
  hydraFolder: string
  task: string
  recorded?: string
}): string {
  if (recorded) {
    return resolve(recorded)
  }

  const legacy = resolve(
    hydraFolder,
    'tasks',
    task,
  )

  if (existsSync(legacy)) {
    return legacy
  }

  return taskRuntimeDir({ task })
}

export function foldWorkerLog({
  writer,
  task,
}: {
  writer: Writer
  task: string
}): boolean {
  const card = writer.state.cards[task]

  if (!card) {
    return false
  }

  const path = join(
    reportDirectory({
      hydraFolder: writer.dir,
      task,
      recorded: card.workerLogDir,
    }),
    'worker.log',
  )
  let fd: number

  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }

  try {
    const stat = fstatSync(fd)

    if (!stat.isFile()) {
      log({
        level: 'warn',
        operation: 'read worker log',
        taskId: task,
        error: 'worker.log must be a regular file',
      })

      return false
    }

    const identity = `${stat.dev}:${stat.ino}`
    const previous = card.workerLog?.latest
    const off = previous?.identity === identity ? previous.off : 0

    if (stat.size < off) {
      writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: `worker:${task}:${identity}:truncated:${off}:${stat.size}`,
          at: new Date().toISOString(),
          cardId: task,
          actor: `worker:${task}`,
          type: 'task.worker-line',
          data: {
            identity,
            off,
            code: 'invalid',
            text: 'worker.log was truncated; restore its appended history or replace the file to resume updates',
          },
        },
      })

      return false
    }

    const bytes = Buffer.alloc(Math.min(
      BATCH_BYTES,
      stat.size - off,
    ))
    const count = readSync(
      fd,
      bytes,
      0,
      bytes.length,
      off,
    )
    let start = 0
    let lines = 0
    let discarding = previous?.identity === identity && previous.discarding === true

    const complete = bytes.subarray(
      0,
      count,
    )

    while (start < count && lines < BATCH_LINES) {
      const newline = complete.indexOf(
        10,
        start,
      )
      const end = newline < 0 ? count : newline
      const oversized = end - start > LINE_BYTES

      if (discarding || oversized) {
        const next = newline < 0 ? count : newline + 1
        discarding = newline < 0
        const warning: Omit<WorkerLine, 'at'> = {
          identity,
          off: off + next,
          code: 'invalid',
          text: 'Line exceeds the worker.log line limit; discarding through its next newline',
        }

        if (discarding) {
          warning.discarding = true
        }

        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: `worker:${task}:${identity}:${off + next}`,
            at: new Date().toISOString(),
            cardId: task,
            actor: `worker:${task}`,
            type: 'task.worker-line',
            data: warning,
          },
        })
        start = next
        lines++
        continue
      }

      if (newline < 0) {
        break
      }

      const raw = bytes.subarray(
        start,
        end,
      ).toString('utf8')
        .replace(
          /\r$/,
          '',
        )
      const containsNullByte = raw.includes('\0')
      const match = containsNullByte ? null : /^([^:]+):\s*(.*)$/s.exec(raw)
      const kind = match?.[1]
      const content = match?.[2]
      let code: WorkerCode = 'invalid'
      let text = containsNullByte ? raw.replaceAll(
        '\0',
        '\\0',
      ) : raw

      if (kind && content?.trim() && CODES.has(kind as WorkerCode)) {
        code = kind as WorkerCode
        text = content
      }

      const lineOff = off + end + 1
      const id = `worker:${task}:${identity}:${lineOff}`
      const at = new Date().toISOString()
      let link

      if (code === 'link') {
        const [
          url = '',
          ...label
        ] = text.split(/\s+/)

        try {
          link = {
            ...parseLink({
              input: {
                url,
                title: label.join(' '),
              },
            }),
            src: 'worker' as const,
          }
        } catch (error) {
          if (!(error instanceof HydraError)) {
            throw error
          }

          code = 'invalid'
          text = raw
        }
      }

      writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id,
          at,
          cardId: task,
          actor: `worker:${task}`,
          type: 'task.worker-line',
          data: {
            identity,
            off: lineOff,
            code,
            text,
          },
        },
      })

      if (link && !writer.state.cards[task]?.links.some(known => known.url === link.url)) {
        applyDecision({
          writer,
          decision: decideLink({
            state: writer.state,
            ref: task,
            url: link.url,
            link,
            meta: {
              at,
              actor: `worker:${task}`,
              id: `${id}:link`,
            },
          }),
        })
      }

      start = end + 1
      lines++
    }

    return stat.size > off + count || lines === BATCH_LINES && start < count
  } finally {
    closeSync(fd)
  }
}

export function followWorkerLogs({
  hydraId,
  changed,
}: {
  hydraId: string
  changed(): void
}) {
  const watches = new Map<string, ReturnType<typeof watchPath>>()
  let closed = false

  const reconcile = ({ state }: { state: HydraState }) => {
    if (closed) {
      return
    }

    for (const [
      task,
      watcher,
    ] of watches) {
      if (!state.cards[task]) {
        watcher.close()
        watches.delete(task)
      }
    }

    for (const card of Object.values(state.cards)) {
      if (watches.has(card.id)) {
        continue
      }

      let reading = false
      let again = false
      let scheduled = false

      const schedule = () => {
        if (scheduled || closed || !watches.has(card.id)) {
          return
        }

        scheduled = true
        setImmediate(() => {
          scheduled = false
          background({
            name: 'continue worker log',
            run: read,
            retry: () => watches.get(card.id)?.reconcile(),
          })
        }).unref()
      }

      const read = async () => {
        if (closed || !watches.has(card.id)) {
          return
        }

        if (reading) {
          again = true

          return
        }

        reading = true
        again = false

        try {
          const more = await withWriter({
            hydraId,
            fn: ({ writer }) => foldWorkerLog({
              writer,
              task: card.id,
            }),
          })
          changed()

          if (more || again) {
            schedule()
          }
        } finally {
          reading = false
        }
      }

      try {
        const dir = workerTaskDir({
          hydraId,
          task: card.id,
        })
        const watcher = watchPath({
          path: join(
            dir,
            'worker.log',
          ),
          changed: read,
          poll: true,
        })
        watches.set(
          card.id,
          watcher,
        )
        watcher.reconcile()
      } catch (error) {
        log({
          level: 'warn',
          operation: 'read worker log',
          hydraId,
          taskId: card.id,
          error,
        })
      }
    }
  }

  return {
    reconcile,
    close() {
      closed = true

      for (const watcher of watches.values()) {
        watcher.close()
      }

      watches.clear()
    },
  }
}
