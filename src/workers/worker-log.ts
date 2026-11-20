import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { loadHydra } from '#app/store.ts'
import { hydraDir } from '#app/home-migration.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { privateDir } from '#store/storage.ts'
import { watchPath, type PathWatch } from '#app/watch.ts'
import type { HydraState } from '#app/model.ts'
import type { WorkerCode } from '#tasks/model.ts'
import { parseLink, decideLink } from '#tasks/delivery/links.ts'
import { applyDecision } from '#app/decision.ts'
import { HydraError } from '#store/errors.ts'
import { log } from '#app/diagnostics.ts'

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
  const dir = loadHydra({ hydraId }).state.cards[task]?.workerLogDir ?? join(
    hydraDir({ hydraId }),
    'tasks',
    task,
  )
  privateDir({ dir })

  return dir
}

export function foldWorkerLog({
  writer,
  task,
}: {
  writer: Writer
  task: string
}): void {
  const card = writer.state.cards[task]

  if (!card) {
    return
  }

  const path = join(
    card.workerLogDir ?? join(
      writer.dir,
      'tasks',
      task,
    ),
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
      return
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

      return
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

      return
    }

    const bytes = Buffer.alloc(stat.size - off)
    const count = readSync(
      fd,
      bytes,
      0,
      bytes.length,
      off,
    )
    let start = 0

    const complete = bytes.subarray(
      0,
      count,
    )

    for (let end = complete.indexOf(10); end >= 0; end = complete.indexOf(
      10,
      start,
    )) {
      const raw = bytes.subarray(
        start,
        end,
      ).toString('utf8')
        .replace(
          /\r$/,
          '',
        )
      const containsNullByte = raw.includes('\0')
      const match = containsNullByte ? null : /^([^:]+):\s*(.*)$/.exec(raw)
      const kind = match?.[1]
      const content = match?.[2]
      let code: WorkerCode = 'invalid'
      let text = containsNullByte ? raw.replaceAll('\0', '\\0') : raw

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
    }
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
  const watches = new Map<string, PathWatch>()
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
      if (card.mirror || watches.has(card.id)) {
        continue
      }

      const read = () => {
        withWriter({
          hydraId,
          fn: ({ writer }) => foldWorkerLog({
            writer,
            task: card.id,
          }),
        })
        changed()
      }

      try {
        const dir = workerTaskDir({
          hydraId,
          task: card.id,
        })
        watches.set(
          card.id,
          watchPath({
            path: join(
              dir,
              'worker.log',
            ),
            changed: read,
            poll: true,
          }),
        )
        read()
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
