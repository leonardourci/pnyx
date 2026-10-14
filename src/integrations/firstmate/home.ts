// Reads one Firstmate home's files and turns them into card observations. Read-only:
// it never writes the home, and it never looks at the home's backends (Paseo,
// Herdr, tmux). Files read: state/<task>.meta, state/<task>.status and the
// markdown backlog at data/backlog.md, plus each task's data/<task>/brief.md for its
// Captain's intent.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { canonical } from '../../cli/commands.ts'
import { basename, join } from 'node:path'
import { BoardError, type SourceNote } from '../../core/model.ts'
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
  // The backlog lists the task under Done, which Firstmate's cleanup does once the
  // task is closed; merged when its pull request merged too.
  done: boolean
  merged: boolean
  activity?: string
  // Canonical path of the task's worktree from its meta, where its agent runs.
  worktree?: string
  // The Paseo terminal the task's agent was launched in, from its meta, which tells
  // tasks sharing a worktree apart.
  paseoTerminal?: string
  decisions: OpenDecision[]
  // The latest status line, when it is failed: or blocked:.
  stalled?: { verb: string; note: string }
  // Decisions and reports from the status log, and the brief's Captain's intent.
  notes: SourceNote[]
}

export interface HomeObservation {
  path: string
  key: string
  title: string
  tasks: TaskObservation[]
}

interface BacklogRow {
  title: string
  repo?: string
  done: boolean
  merged: boolean
}

// Canonical path of a configured home; refuses anything that is not a Firstmate home.
export function resolveHome(path: string): string {
  let real: string

  try {
    real = realpathSync(path)
  } catch {
    throw new BoardError(`Firstmate home not found: ${path}`, 'NOT_FOUND', ["Pass the home's root folder with --home"])
  }

  if (!isDir(join(real, 'state'))) {
    throw new BoardError(`not a Firstmate home (no state/ folder): ${path}`, 'VALIDATION_ERROR', [
      "Pass the home's root folder with --home",
    ])
  }

  return real
}

// Card key of a home: stable for the same canonical path, distinct across homes
// that share a folder name.
export function homeKey(home: string): string {
  return `${ADAPTER}:${createHash('sha256').update(home)
    .digest('hex')
    .slice(0, 8)}`
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

// A regular file's text, or undefined when it is missing or a symlink.
function readRegular(path: string): string | undefined {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

export function parseMeta(text: string): Record<string, string> {
  const meta: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')

    if (eq > 0) {
      meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }

  return meta
}

// Trailing row facts the backlog writer appends; any other parenthetical stays in the title.
const ROW_FACTS = new Set(['repo', 'kind', 'priority', 'since', 'merged', 'reported', 'done', 'hold', 'hold-kind', 'hold-until'])

// Backlog rows: `- [ ] <id> - <title> (repo: x) (kind: y) (since d)`, grouped
// under `## In flight`, `## Queued` and `## Done`; a done row ends `(merged d)`
// when its pull request merged.
export function parseBacklog(text: string): Map<string, BacklogRow> {
  const rows = new Map<string, BacklogRow>()
  let section = ''

  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
        .toLowerCase()
    }

    const row = /^- \[[ xX]\] (\S+) - (.+)$/.exec(line)

    if (!row) {
      continue
    }

    let title = row[2]!.trim()
    const facts: Record<string, string> = {}

    for (let m; (m = /\s*\(([a-z][a-z-]*):? ([^()]*)\)$/.exec(title)) && ROW_FACTS.has(m[1]!); ) {
      facts[m[1]!] = m[2]!.trim()
      title = title.slice(0, m.index)
    }

    rows.set(row[1]!, {
      title: title || row[1]!,
      ...(facts.repo ? { repo: facts.repo } : {}),
      done: section === 'done',
      merged: section === 'done' && facts.merged !== undefined,
    })
  }

  return rows
}

// The body of a brief's `## Captain's intent` section, up to the next heading of
// the same or a higher level.
export function captainsIntent(brief: string): string | undefined {
  const lines = brief.split('\n')
  const start = lines.findIndex(l => /^##\s+Captain'?s intent\s*$/i.test(l))

  if (start < 0) {
    return undefined
  }

  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l))

  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
    .trim() || undefined
}

function taskNotes(home: string, task: string, log: string): SourceNote[] {
  const notes: SourceNote[] = statusNotes(log).map(({ line, ...note }) => ({ ...note, source: ADAPTER, ref: `status:${line}` }))
  const intent = captainsIntent(readRegular(join(home, 'data', task, 'brief.md')) ?? '')

  if (intent) {
    notes.push({ kind: 'context', source: ADAPTER, text: `Captain's intent:\n${intent}`, ref: `brief:${intent}` })
  }

  return notes
}

// Every task with a meta record, in id order. The pull request comes only from the
// meta's pr= field, which Firstmate records when the pull request is ready.
export function readHome(home: string): HomeObservation {
  const state = join(home, 'state')
  const backlog = parseBacklog(readRegular(join(home, 'data', 'backlog.md')) ?? '')
  const tasks: TaskObservation[] = []

  for (const file of readdirSync(state).sort()) {
    const task = file.endsWith('.meta') ? file.slice(0, -'.meta'.length) : ''

    if (!TASK_ID.test(task)) {
      continue
    }

    const metaText = readRegular(join(state, file))

    if (metaText === undefined) {
      continue
    }

    const meta = parseMeta(metaText)
    const log = readRegular(join(state, `${task}.status`)) ?? ''
    const row = backlog.get(task)
    const pr = meta.pr
    const activity = latestActivity(log)
    const last = latestLine(log)
    const worktree = canonical(meta.worktree)
    const paseoTerminal = meta.paseo_terminal_id
    tasks.push({
      task,
      title: row?.title ?? task,
      ...(row?.repo ? { repo: row.repo } : {}),
      ...(pr ? { pr } : {}),
      done: row?.done ?? false,
      merged: row?.merged ?? false,
      ...(activity ? { activity } : {}),
      ...(worktree ? { worktree } : {}),
      ...(TERMINAL_FIELDS.paseoTerminal.test(paseoTerminal ?? '') ? { paseoTerminal } : {}),
      decisions: openDecisions(log, meta.kind || 'ship'),
      ...(last && (last.verb === 'failed' || last.verb === 'blocked') ? { stalled: { verb: last.verb, note: last.note } } : {}),
      notes: taskNotes(home, task, log),
    })
  }

  return { path: home, key: homeKey(home), title: basename(home), tasks }
}
