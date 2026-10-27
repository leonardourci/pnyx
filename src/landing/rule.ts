import { matchesProject } from '../projects/identity.ts'
import type { HydraState } from '../app/model.ts'
import { HydraError, LANDINGS, MERGERS, cardLanding, type Card, type Landing, type LandingRule, type Merger } from '../core/model.ts'
import { investigationLine, reportLine } from '../investigation/report.ts'
import { projectsFor } from '../projects/read.ts'

// The owner's rule for this task when one was recorded, otherwise its project's.
export function taskLanding({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): LandingRule | undefined {
  const projects = projectsFor({ state })
  const project = projects.find(project => !project.detached && matchesProject({
    project,
    ref: card.project,
  }))

  return cardLanding({
    card: {
      ...card,
      project: project?.path ?? card.project,
    },
    projects,
  })
}

export function parseLanding({ value }: { value: string }): Landing {
  if (!(LANDINGS as readonly string[]).includes(value)) {
    throw new HydraError({
      message: `--landing must be ${LANDINGS.join(' or ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value as Landing
}

export function parseMerger({ value }: { value: string }): Merger {
  if (!(MERGERS as readonly string[]).includes(value)) {
    throw new HydraError({
      message: `--merge must be ${MERGERS.join(' or ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value as Merger
}

// The worker header's landing line, so a worker knows exactly where its job stops.
export function landingLine({
  rule,
  hydraId,
  id,
}: {
  rule: LandingRule
  hydraId: string
  id: string
}): string {
  if (rule.landing === 'branch') {
    return 'Landing: commit your work on your branch in this copy, then declare done. Do not push or open a pull request; the owner lands the branch.'
  }

  const merger = rule.merge === 'hydra'
    ? 'Hydra merges it once every check is green'
    : 'the owner merges it'

  const declaration = rule.merge === 'hydra'
    ? 'then declare needs_you with its URL'
    : 'then use needs_you with its URL only if readiness has not been recorded yet'

  return `Landing: commit on your branch, push it, open a ready pull request and link it with \`pnyx-axi link ${id} --url <pull request url> --hydra ${hydraId}\`, ${declaration}: ${merger}; never merge it yourself. Pnyx follows the pull request, sends you failed checks and new review comments to fix, and marks the task done when it merges.`
}

// Where this task's worker stops: an investigation at its stored report, anything else at its landing rule.
export function taskStops({
  state,
  hydraId,
  card,
}: {
  state: HydraState
  hydraId: string
  card: Card
}): string[] {
  if (card.kind === 'investigation') {
    return [
      investigationLine({
        hydraId,
        id: card.id,
      }),
    ]
  }

  const stops: string[] = []
  const rule = taskLanding({
    state,
    card,
  })

  if (card.report) {
    stops.push(reportLine({
      hydraId,
      id: card.id,
    }))
  }

  if (rule) {
    stops.push(landingLine({
      rule,
      hydraId,
      id: card.id,
    }))
  }

  return stops
}
