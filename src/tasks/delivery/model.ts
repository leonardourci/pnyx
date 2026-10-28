import type { HydraProject } from '../../projects/model.ts'
import type { Card } from '../model.ts'
import type { EventBase } from '../../store/events.ts'

export const LINK_KINDS = [
  'github_pr',
  'linear',
  'url',
] as const

export type LinkKind = (typeof LINK_KINDS)[number]

export const LINK_STATES = [
  'open',
  'merged',
  'closed',
] as const

export type LinkState = (typeof LINK_STATES)[number]

// The outcomes a person or agent records. "ended" is observed only: a harness
// reporting its session closed.
export const OUTCOME_STATES = [
  'done',
  'failed',
  'cancelled',
] as const

export type OutcomeState = (typeof OUTCOME_STATES)[number] | 'ended'

export interface Link {
  kind: LinkKind
  url: string
  number?: number
  title?: string
  state?: LinkState
  checkedAt?: string
  draft?: boolean
  // A followed pull request's last seen checks summary and comment count, so only changes reach its worker.
  checks?: string
  comments?: number
  mergeAttempt?: {
    outcome: 'merged' | 'queued' | 'unknown'
    head: string
    requestedAt: string
    detail?: string
  }
  mergeProof?: {
    head: string
    commit: string
    confirmedAt: string
  }
}

// closed: the source closed the task, so even a failure is final and needs no one.
// source: the adapter that observed the outcome; only that source may change it.
export interface Outcome {
  state: OutcomeState
  note?: string
  closed?: boolean
  source?: string
}

// How a project's work lands: a pull request, or a commit on the task's branch only.
export const LANDINGS = [
  'pr',
  'branch',
] as const

export type Landing = (typeof LANDINGS)[number]

// Who merges a project's pull requests: the owner, or Hydra once every check is green.
export const MERGERS = [
  'owner',
  'hydra',
] as const

export type Merger = (typeof MERGERS)[number]

export interface LandingRule {
  landing: Landing
  merge: Merger
}

const DEFAULT_LANDING: Landing = 'pr'

const DEFAULT_MERGER: Merger = 'owner'

// A project saved before landing rules lands through a pull request the owner merges.
export function landingRule({ project }: { project: Pick<HydraProject, 'landing' | 'merge'> }): LandingRule {
  return {
    landing: project.landing ?? DEFAULT_LANDING,
    merge: project.merge ?? DEFAULT_MERGER,
  }
}

// The owner's rule for this task when one was recorded, otherwise its project's.
export function cardLanding({
  card,
  projects,
}: {
  card: Card
  projects: HydraProject[]
}): LandingRule | undefined {
  if (card.landing) {
    return card.landing
  }

  const project = projects.find(p => !p.detached
    && (p.path === card.project || p.name === card.project))

  return project ? landingRule({ project }) : undefined
}

// gh-axi's checks line ("3 passed, 1 failed, 1 skipped, 6 total"), counted.
function checkTally({ checks }: { checks?: string }) {
  const count = ({ word }: { word: string }) => Number(new RegExp(`(\\d+) ${word}`).exec(checks ?? '')?.[1] ?? 0)

  return {
    passed: count({ word: 'passed' }),
    failed: count({ word: 'failed' }),
    skipped: count({ word: 'skipped' }),
    total: count({ word: 'total' }),
  }
}

export function failedChecks({ checks }: { checks?: string }): number {
  return checkTally({ checks }).failed
}

// Whatever is neither passed, failed nor skipped is still running.
export function pendingChecks({ checks }: { checks?: string }): number {
  const {
    passed,
    failed,
    skipped,
    total,
  } = checkTally({ checks })

  return Math.max(
    0,
    total - passed - failed - skipped,
  )
}

// At least one check passed or failed, so the line reports a real run rather than none or only skips.
export function ranChecks({ checks }: { checks?: string }): boolean {
  const {
    passed,
    failed,
  } = checkTally({ checks })

  return passed + failed > 0
}

export type LinkedEvent = EventBase & {
  type: 'card.linked'
  data: {
    url: string
    before: Link | null
    after: Link | null
  }
}

// Keeps the card's title, workspace, tags and links as they were when the outcome
// was recorded, so history stays readable after later edits.
export type OutcomeEvent = EventBase & {
  type: 'card.outcome'
  data: {
    before: Outcome | null
    after: Outcome | null
    card: {
      title: string
      workspace: string
      tags: string[]
      links: Link[]
    }
  }
}
