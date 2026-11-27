import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadTitan } from '#app/store.ts'
import { titanDir } from '#app/home-migration.ts'
import { taskRuntimeDir } from '#store/paths.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { privateDir } from '#store/storage.ts'
import { watchPath } from '#app/watch.ts'
import type { TitanState } from '#app/model.ts'
import type { WorkerCode, WorkerLine } from '#tasks/model.ts'
import { parseLink, decideLink } from '#tasks/delivery/links.ts'
import { applyDecision } from '#app/decision.ts'
import { TitanError } from '#store/errors.ts'
import { log } from '#app/diagnostics.ts'
import { background } from '#app/background.ts'
import { fileIdentity } from '#store/file-identity.ts'

const BATCH_BYTES = 64 * 1024
const LINE_BYTES = 16 * 1024
const BATCH_LINES = 128
// Enough bytes before a saved position to tell a moved worker.log from a new one.
const TAIL_BYTES = 256

const CODES = new Set<WorkerCode>([
  'needs-you',
  'blocked',
  'done',
  'link',
  'note',
])

export function workerTaskDir({
  titanId,
  task,
}: {
  titanId: string
  task: string
}): string {
  const card = loadTitan({ titanId }).state.cards[task]
  const dir = reportDirectory({
    titanFolder: titanDir({ titanId }),
    task,
    recorded: card?.workerLogDir,
  })
  privateDir({ dir })

  return dir
}

// A hash of the bytes just before a position: the same history in a new file hashes the same.
export function contentTail({
  fd,
  end,
}: {
  fd: number
  end: number
}): string {
  const start = Math.max(
    0,
    end - TAIL_BYTES,
  )
  const bytes = Buffer.alloc(end - start)
  const count = readSync(
    fd,
    bytes,
    0,
    bytes.length,
    start,
  )

  return createHash('sha256').update(bytes.subarray(
    0,
    count,
  ))
    .digest('hex')
}

// Another inode or device with the same bytes before the saved position is the same history, moved or copied.
function resumePoint({
  fd,
  size,
  identity,
  previous,
}: {
  fd: number
  size: number
  identity: string
  previous?: WorkerLine
}): {
  gen: number
  off: number
  moved: boolean
} {
  if (!previous) {
    return {
      gen: 0,
      off: 0,
      moved: false,
    }
  }

  if (previous.identity === identity) {
    return {
      gen: previous.gen,
      off: previous.off,
      moved: false,
    }
  }

  const sameHistory = size >= previous.off && contentTail({
    fd,
    end: previous.off,
  }) === previous.tail

  if (sameHistory) {
    return {
      gen: previous.gen,
      off: previous.off,
      moved: true,
    }
  }

  return {
    gen: previous.gen + 1,
    off: 0,
    moved: false,
  }
}

function reportDirectory({
  titanFolder,
  task,
  recorded,
}: {
  titanFolder: string
  task: string
  recorded?: string
}): string {
  if (recorded) {
    return resolve(recorded)
  }

  const legacy = resolve(
    titanFolder,
    'tasks',
    task,
  )

  if (existsSync(legacy)) {
    return legacy
  }

  return taskRuntimeDir({ task })
}

export function workerLogPath({
  titanFolder,
  task,
  recorded,
}: {
  titanFolder: string
  task: string
  recorded?: string
}): string {
  return join(
    reportDirectory({
      titanFolder,
      task,
      recorded,
    }),
    'worker.log',
  )
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

  const path = workerLogPath({
    titanFolder: writer.dir,
    task,
    recorded: card.workerLogDir,
  })
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

    const identity = fileIdentity({ stat })
    const previous = card.workerLog?.latest
    const {
      gen,
      off,
      moved,
    } = resumePoint({
      fd,
      size: stat.size,
      identity,
      previous,
    })
    const same = previous !== undefined && previous.gen === gen

    if (moved) {
      writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: `worker:${task}:${gen}:${off}:moved:${identity}`,
          at: new Date().toISOString(),
          cardId: task,
          actor: `worker:${task}`,
          type: 'task.worker-log',
          data: {
            identity,
            off,
            gen,
            tail: previous!.tail,
          },
        },
      })
    }

    if (stat.size < off) {
      const warning: Omit<WorkerLine, 'at'> = {
        identity,
        off,
        gen,
        tail: contentTail({
          fd,
          end: Math.min(
            off,
            stat.size,
          ),
        }),
        code: 'invalid',
        text: 'worker.log was truncated; restore its appended history or replace the file to resume updates',
      }

      if (previous?.discarding) {
        warning.discarding = true
      }

      writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: `worker:${task}:${gen}:truncated:${off}:${stat.size}`,
          at: new Date().toISOString(),
          cardId: task,
          actor: `worker:${task}`,
          type: 'task.worker-line',
          data: warning,
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
    let discarding = same && previous.discarding === true

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
          gen,
          tail: contentTail({
            fd,
            end: off + next,
          }),
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
            id: `worker:${task}:${gen}:${off + next}`,
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
      const id = `worker:${task}:${gen}:${lineOff}`
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
          if (!(error instanceof TitanError)) {
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
            gen,
            tail: contentTail({
              fd,
              end: lineOff,
            }),
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
  titanId,
  changed,
}: {
  titanId: string
  changed(): void
}) {
  const watches = new Map<string, ReturnType<typeof watchPath>>()
  let closed = false

  const reconcile = ({ state }: { state: TitanState }) => {
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
            titanId,
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
          titanId,
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
          titanId,
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
