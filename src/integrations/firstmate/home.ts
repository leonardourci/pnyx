import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { HydraError } from '../../store/errors.ts'
import { type FirstmateRecord, type SourceNote } from '../../core/model.ts'
import { canonical } from '../../store/paths.ts'
import { TERMINAL_FIELDS } from '../../core/route.ts'
import { latestActivity, latestLine, openDecisions, statusNotes, type OpenDecision } from './status.ts'

export const ADAPTER = 'firstmate'
// objectId of the home's own card; task ids start with a letter or digit.
export const HOME_OBJECT = '@home'
// Attention key of a latest failed: or blocked: line. Decision keys are slugs, so
// it never names a decision fm-send could resolve.
export const STATUS_KEY = '@status'
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface TaskObservation {
  task: string
  title: string
  repo?: string
  pr?: string
  // Firstmate closes tasks in Done before moving older rows to its done archive.
  done: boolean
  merged: boolean
  activity?: string
  worktree?: string
  // The Paseo terminal the task's agent was launched in, from its meta, which tells
  // tasks sharing a worktree apart.
  paseoTerminal?: string
  // The backlog section the task's row sits under, lower-cased; empty without a row.
  section: string
  hold?: Hold
  decisions: OpenDecision[]
  // The latest status line, when it is failed: or blocked:.
  stalled?: {
    verb: string
    note: string
  }
  notes: SourceNote[]
  record: FirstmateRecord
}

export interface HomeObservation {
  path: string
  key: string
  title: string
  tasks: TaskObservation[]
}

// blockers keeps only ids whose rows are not Done; a missing row stays a blocker.
export interface Hold {
  reason?: string
  kind?: string
  until?: string
  // The day the hold was set, from the row's `Captain hold set:` line or its `since` fact.
  set?: string
  blockers: string[]
}

interface BacklogRow {
  title: string
  repo?: string
  done: boolean
  merged: boolean
  raw: string
  section: string
  hold?: Hold
}

export function resolveHome({ path }: { path: string }): string {
  let real: string

  try {
    real = realpathSync(path)
  } catch {
    throw new HydraError({
      message: `Firstmate home not found: ${path}`,
      code: 'NOT_FOUND',
      help: ["Pass the home's root folder with --home"],
    })
  }

  if (!isDir({
    path: join(
      real,
      'state',
    ),
  })) {
    throw new HydraError({
      message: `not a Firstmate home (no state/ folder): ${path}`,
      code: 'VALIDATION_ERROR',
      help: ["Pass the home's root folder with --home"],
    })
  }

  return real
}

// Card key of a home: stable for the same canonical path, distinct across homes
// that share a folder name.
export function homeKey({ home }: { home: string }): string {
  return `${ADAPTER}:${createHash('sha256').update(home)
    .digest('hex')
    .slice(
      0,
      8,
    )}`
}

function isDir({ path }: { path: string }): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

// A regular file's text, or undefined when it is missing or a symlink.
function readRegular({ path }: { path: string }): string | undefined {
  try {
    return lstatSync(path).isFile() ? readFileSync(
      path,
      'utf8',
    ) : undefined
  } catch {
    return undefined
  }
}

export function parseMeta({ text }: { text: string }): Record<string, string> {
  const meta: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')

    if (eq > 0) {
      meta[line.slice(
        0,
        eq,
      ).trim()] = line.slice(eq + 1).trim()
    }
  }

  return meta
}

// Trailing row facts the backlog writer appends; any other parenthetical stays in the title.
const ROW_FACTS = new Set([
  'repo',
  'kind',
  'priority',
  'since',
  'merged',
  'reported',
  'done',
  'hold',
  'hold-kind',
  'hold-until',
])

// A lane continuing an existing PR has no pr in its meta, only the URL ending its title.
function titlePull({ title }: { title?: string }): string | undefined {
  return /(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+)\s*$/.exec(title ?? '')?.[1]
}

// Backlog rows: `- [ ] <id> - <title> (repo: x) (kind: y) (since d)`, grouped
// under `## In flight`, `## Queued` and `## Done`; a done row ends `(merged d)`
// when its pull request merged.
export function parseBacklog({
  text,
  archived = false,
}: {
  text: string
  archived?: boolean
}): Map<string, BacklogRow> {
  const rows = new Map<string, BacklogRow>()
  let section = ''
  let last: BacklogRow | undefined

  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
        .toLowerCase()
      last = undefined
    }

    const row = /^- \[[ xX]\] (\S+) - (.+)$/.exec(line)
    const stamp = /^\s+Captain hold set:\s*(\d{4}-\d{2}-\d{2})/.exec(line)?.[1]

    if (stamp && last?.hold) {
      last.hold.set = stamp
    }

    if (!row) {
      continue
    }

    let title = row[2]!.trim()
    const facts: Record<string, string> = {}

    for (let m; (m = /\s*\(([a-z][a-z-]*):? ([^()]*)\)$/.exec(title)) && ROW_FACTS.has(m[1]!); ) {
      facts[m[1]!] = m[2]!.trim()
      title = title.slice(
        0,
        m.index,
      )
    }

    const held = facts.hold !== undefined || facts['hold-kind'] !== undefined
    last = {
      title: title || row[1]!,
      ...(facts.repo ? { repo: facts.repo } : {}),
      done: archived || section === 'done',
      merged: (archived || section === 'done') && facts.merged !== undefined,
      raw: line,
      section,
      ...(held ? {
        hold: {
          ...(facts.hold ? { reason: facts.hold } : {}),
          ...(facts['hold-kind'] ? { kind: facts['hold-kind'] } : {}),
          ...(facts['hold-until'] ? { until: facts['hold-until'] } : {}),
          ...(facts.since ? { set: facts.since } : {}),
          blockers: [...title.matchAll(/blocked-by:\s+([^\s)]+)/g)].map(m => m[1]!),
        },
      } : {}),
    }
    rows.set(
      row[1]!,
      last,
    )
  }

  for (const row of rows.values()) {
    if (row.hold) {
      row.hold.blockers = row.hold.blockers.filter(id => !rows.get(id)?.done)
    }
  }

  return rows
}

export function captainsIntent({ brief }: { brief: string }): string | undefined {
  const lines = brief.split('\n')
  const start = lines.findIndex(l => /^##\s+Captain'?s intent\s*$/i.test(l))

  if (start < 0) {
    return undefined
  }

  const end = lines.findIndex((
    l,
    i,
  ) => i > start && /^#{1,2}\s/.test(l))

  return lines.slice(
    start + 1,
    end < 0 ? undefined : end,
  ).join('\n')
    .trim() || undefined
}

function taskNotes({
  home,
  task,
  log,
}: {
  home: string
  task: string
  log: string
}): SourceNote[] {
  const notes: SourceNote[] = statusNotes({ log }).map(({
    line,
    ...note
  }) => ({
    ...note,
    source: ADAPTER,
    ref: `status:${line}`,
  }))
  const intent = captainsIntent({
    brief: readRegular({
      path: join(
        home,
        'data',
        task,
        'brief.md',
      ),
    }) ?? '',
  })

  if (intent) {
    notes.push({
      kind: 'context',
      source: ADAPTER,
      text: `Captain's intent:\n${intent}`,
      ref: `brief:${intent}`,
    })
  }

  return notes
}

// Every task with a meta record, in id order. The pull request comes only from the
// meta's pr= field, which Firstmate records when the pull request is ready.
export function readHome({
  home,
  mirroredTasks = [],
}: {
  home: string
  mirroredTasks?: Pick<FirstmateRecord, 'task' | 'status'>[]
}): HomeObservation {
  const state = join(
    home,
    'state',
  )
  const backlog = parseBacklog({
    text: readRegular({
      path: join(
        home,
        'data',
        'backlog.md',
      ),
    }) ?? '',
  })
  const archive = parseBacklog({
    text: readRegular({
      path: join(
        home,
        'data',
        'done-archive.md',
      ),
    }) ?? '',
    archived: true,
  })
  const mirroredStatus = new Map(mirroredTasks.map(({
    task,
    status,
  }) => [
    task,
    status,
  ]))
  const tasks: TaskObservation[] = []

  // Old archive entries only reconcile tasks this Hydra already knows.
  const taskIds = new Set([
    ...backlog.keys(),
    ...mirroredTasks.map(t => t.task).filter(task => archive.has(task)),
    ...readdirSync(state).filter(f => f.endsWith('.meta'))
      .map(f => f.slice(
        0,
        -'.meta'.length,
      )),
  ])

  for (const task of [...taskIds].sort()) {
    if (!TASK_ID.test(task)) {
      continue
    }

    const metaText = readRegular({
      path: join(
        state,
        `${task}.meta`,
      ),
    })
    const statusText = readRegular({
      path: join(
        state,
        `${task}.status`,
      ),
    })
    const meta = parseMeta({ text: metaText ?? '' })
    const row = backlog.get(task) ?? archive.get(task)
    // Cleanup can remove the worker log after Firstmate has closed the task.
    const log = statusText ?? (row?.done ? mirroredStatus.get(task) : undefined) ?? ''
    // The mirrored row keeps its shape: an extra field would read as a changed Firstmate record.
    const mirroredRow = row && { ...row }
    delete mirroredRow?.hold
    const pr = meta.pr || titlePull({ title: row?.title })
    const activity = latestActivity({ log })
    const last = latestLine({ log })
    const worktree = canonical({ path: meta.worktree })
    const present = {
      meta: metaText !== undefined,
      status: statusText !== undefined,
    }
    const paseoTerminal = meta.paseo_terminal_id
    tasks.push({
      task,
      title: row?.title ?? task,
      ...(row?.repo ? { repo: row.repo } : {}),
      ...(pr ? { pr } : {}),
      done: row?.done ?? false,
      merged: row?.merged ?? false,
      section: row?.section ?? '',
      ...(row?.hold ? { hold: row.hold } : {}),
      ...(activity ? { activity } : {}),
      ...(worktree ? { worktree } : {}),
      ...(TERMINAL_FIELDS.paseoTerminal.test(paseoTerminal ?? '') ? { paseoTerminal } : {}),
      decisions: openDecisions({
        log,
        kind: meta.kind || 'ship',
      }),
      ...(last && (last.verb === 'failed' || last.verb === 'blocked') ? {
        stalled: {
          verb: last.verb,
          note: last.note,
        },
      } : {}),
      notes: taskNotes({
        home,
        task,
        log,
      }),
      record: {
        home,
        task,
        meta,
        status: log,
        present,
        ...(mirroredRow ? { backlog: mirroredRow } : {}),
      },
    })
  }

  return {
    path: home,
    key: homeKey({ home }),
    title: basename(home),
    tasks,
  }
}
