// Run once by hand with the server stopped: saves what restarts rebuilt from transcripts, after a backup.
import { closeSync, cpSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
import { contentTail, workerLogPath } from '#workers/worker-log.ts'
import { titanEvent } from '#titan/titan.ts'
import { TITAN_CARD } from '#titan/identity.ts'

const MIGRATION = 'save-session-turns'

// Saved file identities were "<device>:<inode>" before they became the inode alone.
const inode = ({ identity }: { identity: string }) => identity.split(':').at(-1)!

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

function rewriteHarvestCursors({ dir }: { dir: string }): number {
  const path = join(
    dir,
    'harvest.json',
  )

  if (!existsSync(path)) {
    return 0
  }

  const cursors = JSON.parse(readFileSync(
    path,
    'utf8',
  )) as Record<string, {
    identity: string
    pos: number
  }>
  let rewritten = 0

  for (const cursor of Object.values(cursors)) {
    const identity = inode({ identity: cursor.identity })

    if (identity !== cursor.identity) {
      cursor.identity = identity
      rewritten++
    }
  }

  writeFileSync(
    `${path}.${MIGRATION}`,
    JSON.stringify(cursors),
  )
  renameSync(
    `${path}.${MIGRATION}`,
    path,
  )

  return rewritten
}

// Gives each worker.log position its generation and the hash that recognizes the same history in another file.
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
        let identity = inode({ identity: latest.identity })
        let tail = ''

        if (existsSync(path)) {
          const fd = openSync(
            path,
            'r',
          )

          try {
            const stat = fstatSync(fd)

            // A file that is no longer the one the position was saved for is read again from its start, as before.
            if (fileIdentity({ stat }) === identity && stat.size >= latest.off) {
              tail = contentTail({
                fd,
                end: latest.off,
              })
            }

            identity = fileIdentity({ stat })
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

// A report the saved read cursor already covers counts as handled.
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
    const harvestCursors = rewriteHarvestCursors({ dir })
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
      `${harvestCursors} harvest cursors rewritten,`,
      `${reports} covered reports marked handled,`,
      `${Math.round(performance.now() - started)} ms`,
    ].join(' '))
  }
} finally {
  await closeNativeHomes()
  release()
}
