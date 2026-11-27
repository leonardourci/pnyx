import { closeSync, cpSync, existsSync, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claimServer } from '#app/server-state.ts'
import { titanDir, titanIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { closeNativeHomes } from '#app/native-home.ts'
import { othrysHome } from '#store/paths.ts'
import { fileIdentity } from '#store/file-identity.ts'
import { restoreSessionActivity } from '#workers/session-recovery.ts'
import { hashBefore, workerLogPath } from '#workers/worker-log.ts'
import { titanEvent } from '#titan/titan.ts'
import { TITAN_CARD } from '#titan/identity.ts'

const MIGRATION = 'save-session-turns'

const withoutDevice = ({ identity }: { identity: string }) => identity.slice(identity.lastIndexOf(':') + 1)

function logFiles({ dir }: { dir: string }): string[] {
  const tasks = join(
    dir,
    'tasks',
  )
  const taskLogs = existsSync(tasks) ? readdirSync(tasks).map(task => join(
    tasks,
    task,
    'task.log',
  ))
    .filter(path => existsSync(path)) : []

  return [
    join(
      dir,
      'titan.log',
    ),
    ...taskLogs,
  ]
}

function turnRecords({ dir }: { dir: string }): number {
  return logFiles({ dir }).reduce(
    (
      count,
      path,
    ) => count + readFileSync(
      path,
      'utf8',
    ).split('\n')
      .filter(line => line.includes('"t":"activity"')).length,
    0,
  )
}

async function saveWorkerLogPositions({ titanId }: { titanId: string }): Promise<number> {
  return await withWriter({
    titanId,
    fn: ({ writer }) => {
      let saved = 0

      for (const card of Object.values(writer.state.cards)) {
        const latest = card.workerLog?.latest

        if (!latest || card.id === TITAN_CARD) {
          continue
        }

        const path = workerLogPath({
          titanFolder: writer.dir,
          task: card.id,
          recorded: card.workerLogDir,
        })
        const identity = withoutDevice({ identity: latest.identity })
        let tail = ''

        if (existsSync(path)) {
          const fd = openSync(
            path,
            'r',
          )

          try {
            const stat = fstatSync(fd)
            const savedFileHoldsPosition = fileIdentity({ stat }) === identity && stat.size >= latest.off

            if (savedFileHoldsPosition) {
              tail = hashBefore({
                fd,
                end: latest.off,
              })
            }
          } finally {
            closeSync(fd)
          }
        }

        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: `${MIGRATION}:worker-log:${card.id}`,
            at: new Date().toISOString(),
            cardId: card.id,
            actor: 'othrys',
            type: 'task.worker-log',
            data: {
              identity,
              off: latest.off,
              gen: 0,
              tail,
            },
          },
        })
        saved++
      }

      return saved
    },
  })
}

async function handleCoveredReports({ titanId }: { titanId: string }): Promise<number> {
  return await withWriter({
    titanId,
    fn: ({ writer }) => {
      const handledSeq = writer.state.titanHandledSeq ?? 0
      const notes = writer.state.contextNotes ?? []
      const covered = notes.filter(note => note.report && note.seq <= handledSeq)

      if (!covered.length) {
        return 0
      }

      applyDecision({
        writer,
        decision: titanEvent({
          state: writer.state,
          cardId: TITAN_CARD,
          meta: {
            at: new Date().toISOString(),
            actor: 'othrys',
            id: `${MIGRATION}:handled-reports`,
          },
          change: {
            type: 'titan.context-delivered',
            data: {
              through: handledSeq,
              ids: covered.map(note => note.id),
            },
          },
        }),
      })

      return covered.length
    },
  })
}

const release = claimServer()

try {
  const backup = join(
    othrysHome(),
    'backups',
    `${MIGRATION}-${new Date().toISOString()
      .replaceAll(
        ':',
        '-',
      )}`,
  )
  cpSync(
    join(
      othrysHome(),
      'titans',
    ),
    join(
      backup,
      'titans',
    ),
    { recursive: true },
  )
  console.log(`Backed up ${join(
    othrysHome(),
    'titans',
  )} to ${backup}`)

  for (const titanId of titanIds()) {
    const dir = titanDir({ titanId })
    const started = performance.now()
    const recordsBefore = turnRecords({ dir })
    await restoreSessionActivity({ titanId })
    const turns = turnRecords({ dir }) - recordsBefore
    const workerLogs = await saveWorkerLogPositions({ titanId })
    const reports = await handleCoveredReports({ titanId })
    const sessions = Object.keys(loadTitan({ titanId }).state.sessions ?? {}).length
    console.log([
      `Titan ${titanId}:`,
      `${sessions} sessions,`,
      `${turns} turn records saved,`,
      `${workerLogs} worker.log positions saved,`,
      `${reports} covered reports marked handled,`,
      `${Math.round(performance.now() - started)} ms`,
    ].join(' '))
  }
} finally {
  await closeNativeHomes()
  release()
}
