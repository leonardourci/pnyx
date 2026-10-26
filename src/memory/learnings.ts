import { INSCRIBE_SKILL } from '../integrations/skills/names.ts'
import { HydraError, type HydraState } from '../core/model.ts'
import { hydraConfig } from '../core/hydra.ts'

export interface Learning {
  text: string
  at: string
  evidence?: string
  kind?: 'normal' | 'for-now'
  until?: string
  passes?: number
}

export interface LearningChange {
  kind?: string
  until?: string
  save?: boolean
  used?: string
  archive?: string
}

export interface LearningConditions {
  doneTasks: string[]
  mergedPullRequests: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const NORMAL_DAYS = 30
const FOR_NOW_DAYS = 7
const NORMAL_PASSES = 10
const FOR_NOW_PASSES = 3

export function learningChange({
  action,
  kind,
  until,
  used,
  text,
}: {
  action: string
  kind?: string
  until?: string
  used?: string
  text?: string
}): LearningChange | undefined {
  if ((kind !== undefined || until !== undefined) && action !== 'set') {
    throw new HydraError({
      message: '--kind and --until belong to memory set',
      code: 'VALIDATION_ERROR',
    })
  }

  if (used !== undefined && action !== 'save') {
    throw new HydraError({
      message: '--used belongs to memory save',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'save') {
    return {
      save: true,
      used,
    }
  }

  if (action === 'archive') {
    if (!text?.trim()) {
      throw new HydraError({
        message: 'Archive needs --text <existing learning line>',
        code: 'VALIDATION_ERROR',
      })
    }

    return { archive: text }
  }

  if (kind !== undefined || until !== undefined) {
    return {
      kind,
      until,
    }
  }

  return undefined
}

function checkCondition({ until }: { until?: string }): void {
  const date = until?.match(/^date:(\d{4}-\d{2}-\d{2})$/)?.[1]
  let validDate = false

  if (date && Number.isFinite(Date.parse(date))) {
    validDate = new Date(date).toISOString()
      .startsWith(date)
  }

  const validTask = /^task:[a-z0-9][a-z0-9._-]{0,63}\/[^\s/]+$/i.test(until ?? '')
  const validPullRequest = /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+$/.test(until ?? '')
  const validVersion = /^version:\S.*$/.test(until ?? '')
  const validReference = validTask || validPullRequest || validVersion

  if (!validDate && !validReference) {
    throw new HydraError({
      message: 'A for-now learning needs --until task:<hydra>/<task>, a PR URL, version:<version>, or date:YYYY-MM-DD',
      code: 'VALIDATION_ERROR',
    })
  }
}

export function learningText({
  before,
  after,
  confirmed,
  change,
}: {
  before: string | null
  after: string | null
  confirmed?: string
  change?: LearningChange
}): string | null {
  if (change?.archive !== undefined) {
    const lines = (before ?? '').split('\n')

    if (!lines.some(line => line.trim() === change.archive)) {
      throw new HydraError({
        message: 'Archive an existing learning line exactly',
        code: 'VALIDATION_ERROR',
      })
    }

    const remaining = lines.filter(line => line.trim() !== change.archive).join('\n')
      .trim()

    return remaining.length ? remaining : null
  }

  return confirmed !== undefined || change?.save ? before : after
}

export function dateLearnings({
  before = [],
  after,
  at,
  confirmed,
  evidence,
  change,
}: {
  before?: Learning[]
  after: string | null
  at: string
  confirmed?: string
  evidence?: string
  change?: LearningChange
}): Learning[] {
  const texts = [
    ...new Set((after ?? '').split('\n').map(line => line.trim())
      .filter(Boolean)),
  ]
  const reinforced = (change?.used ?? '').split('\n').filter(Boolean)

  if (confirmed !== undefined) {
    reinforced.push(confirmed)
  }

  if (reinforced.some(text => !texts.includes(text) || !before.some(line => line.text === text))) {
    throw new HydraError({
      message: 'Confirm or use an existing learning line exactly',
      code: 'VALIDATION_ERROR',
    })
  }

  if (reinforced.length && !evidence?.trim()) {
    throw new HydraError({
      message: 'Confirm a learning with evidence from this session in --reason',
      code: 'VALIDATION_ERROR',
    })
  }

  if (change?.used !== undefined && !change.save) {
    throw new HydraError({
      message: '--used belongs to a memory save',
      code: 'VALIDATION_ERROR',
    })
  }

  if (change?.kind !== undefined && ![
    'normal',
    'for-now',
  ].includes(change.kind)) {
    throw new HydraError({
      message: 'Learning kind must be normal or for-now',
      code: 'VALIDATION_ERROR',
    })
  }

  if (change?.kind === 'for-now') {
    checkCondition({ until: change.until })
  } else if (change?.until !== undefined) {
    throw new HydraError({
      message: '--until requires --kind for-now',
      code: 'VALIDATION_ERROR',
    })
  }

  return texts.map(text => {
    const existing = before.find(line => line.text === text)

    if (existing && reinforced.includes(text)) {
      return {
        ...existing,
        at,
        evidence,
        passes: 0,
      }
    }

    if (existing) {
      return change?.save ? {
        ...existing,
        passes: (existing.passes ?? 0) + 1,
      } : existing
    }

    const learning: Learning = {
      text,
      at,
    }

    if (change?.kind === 'for-now') {
      learning.kind = 'for-now'
      learning.until = change.until
    }

    return learning
  })
}

export function learningConditions({ states }: {
  states: Record<string, HydraState>
}): LearningConditions {
  const doneTasks: string[] = []
  const mergedPullRequests: string[] = []

  for (const [
    hydra,
    state,
  ] of Object.entries(states)) {
    const doneColumns = hydraConfig({ state }).columns.filter(column => column.role === 'done')
      .map(column => column.id)

    for (const card of Object.values(state.cards)) {
      if (card.status?.state === 'done' || doneColumns.includes(card.column)) {
        doneTasks.push(`task:${hydra}/${card.id}`)

        if (card.key) {
          doneTasks.push(`task:${hydra}/${card.key}`)
        }
      }

      mergedPullRequests.push(...card.links.filter(link => link.kind === 'github_pr' && link.state === 'merged').map(link => link.url))
    }
  }

  return {
    doneTasks,
    mergedPullRequests,
  }
}

export function expiredLearning({
  line,
  now,
  conditions,
}: {
  line: Learning
  now: string
  conditions?: LearningConditions
}): boolean {
  if (line.kind !== 'for-now' || !line.until) {
    return false
  }

  if (line.until.startsWith('date:')) {
    return Date.parse(now) >= Date.parse(line.until.slice('date:'.length))
  }

  const taskDone = conditions?.doneTasks.includes(line.until)
  const pullRequestMerged = conditions?.mergedPullRequests.includes(line.until)

  return Boolean(taskDone || pullRequestMerged)
}

export function staleLearnings({
  lines,
  now,
  conditions,
}: {
  lines: Learning[]
  now: string
  conditions?: LearningConditions
}): Learning[] {
  const currentTime = Date.parse(now)

  return lines.filter(line => {
    const days = line.kind === 'for-now' ? FOR_NOW_DAYS : NORMAL_DAYS
    const passLimit = line.kind === 'for-now' ? FOR_NOW_PASSES : NORMAL_PASSES
    const confirmedAt = Date.parse(line.at)
    const invalidDate = !Number.isFinite(confirmedAt)
    const tooOld = confirmedAt <= currentTime - days * DAY_MS
    const unused = (line.passes ?? 0) >= passLimit
    const expired = expiredLearning({
      line,
      now,
      conditions,
    })

    return invalidDate || tooOld || unused || expired
  })
}

export function learningDigest({
  lines,
  now,
  conditions,
}: {
  lines: Learning[]
  now: string
  conditions?: LearningConditions
}): string {
  const stale = new Set(staleLearnings({
    lines,
    now,
    conditions,
  }).map(line => line.text))
  const text = lines.map(line => {
    const expired = expiredLearning({
      line,
      now,
      conditions,
    })
    const status = expired ? 'EXPIRED for now' : stale.has(line.text) ? 'STALE' : 'Confirmed'
    const condition = line.until ? `; for now until ${line.until}` : ''

    return `${status} ${line.at}; ${line.passes ?? 0} unused saves${condition}: ${line.text}`
  })

  if (stale.size) {
    text.push(`Load ${INSCRIBE_SKILL}: recheck stale learnings, confirm with session evidence or archive; old versions stay recoverable in the memory log.`)
  }

  return text.join('\n')
}
