import { HydraError } from '../core/model.ts'

export interface Learning {
  text: string
  at: string
  evidence?: string
}

const LEARNING_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

export function dateLearnings({
  before = [],
  after,
  at,
  confirmed,
  evidence,
}: {
  before?: Learning[]
  after: string | null
  at: string
  confirmed?: string
  evidence?: string
}): Learning[] {
  const texts = [
    ...new Set((after ?? '').split('\n').map(line => line.trim())
      .filter(Boolean)),
  ]

  const existingConfirmation = confirmed !== undefined && texts.includes(confirmed)
    && before.some(line => line.text === confirmed)

  if (confirmed !== undefined && !existingConfirmation) {
    throw new HydraError({
      message: 'Confirm an existing learning line exactly',
      code: 'VALIDATION_ERROR',
    })
  }

  if (confirmed !== undefined && !evidence?.trim()) {
    throw new HydraError({
      message: 'Confirm a learning with evidence from this session in --reason',
      code: 'VALIDATION_ERROR',
    })
  }

  return texts.map(text => {
    const existing = before.find(line => line.text === text)

    if (text === confirmed) {
      return {
        text,
        at,
        evidence,
      }
    }

    return existing ?? {
      text,
      at,
    }
  })
}

export function staleLearnings({
  lines,
  now,
}: {
  lines: Learning[]
  now: string
}): Learning[] {
  const cutoff = Date.parse(now) - LEARNING_LIFETIME_MS

  return lines.filter(line => {
    const confirmedAt = Date.parse(line.at)

    return !Number.isFinite(confirmedAt) || confirmedAt <= cutoff
  })
}

export function learningDigest({
  lines,
  now,
}: {
  lines: Learning[]
  now: string
}): string {
  const stale = new Set(staleLearnings({
    lines,
    now,
  }).map(line => line.text))
  const text = lines.map(line => `${stale.has(line.text) ? 'STALE' : 'Confirmed'} ${line.at}: ${line.text}`)

  if (stale.size) {
    text.push('Load inscribe: confirm stale learnings with session evidence or retire their lines; old versions stay in the memory log.')
  }

  return text.join('\n')
}
