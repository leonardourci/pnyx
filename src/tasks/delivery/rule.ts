import { matchesProject } from '#projects/identity.ts'
import type { TitanState } from '#app/model.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { LANDINGS, MERGERS, cardLanding, type Landing, type LandingRule, type Merger } from './model.ts'
import { projectsFor } from '#projects/read.ts'

export function landingWording({ rule }: { rule: LandingRule }): string {
  if (rule.landing === 'branch') {
    return 'a branch'
  }

  return `a pull request merged by ${rule.merge}`
}

export const READINESS_INSTRUCTIONS = "Before you report work as done or ready, finish what the brief and your project's instructions require, and check the final result. For code, that means required checks pass on its latest commit. For anything else, it means evidence of the end state: a link, screenshot or output. After later changes, redo the affected checks and refresh the description and evidence."

// The owner's rule for this task when one was recorded, otherwise its project's.
export function taskLanding({
  state,
  card,
}: {
  state: TitanState
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
    throw new TitanError({
      message: `--landing must be ${LANDINGS.join(' or ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value as Landing
}

export function parseMerger({ value }: { value: string }): Merger {
  if (!(MERGERS as readonly string[]).includes(value)) {
    throw new TitanError({
      message: `--merge must be ${MERGERS.join(' or ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value as Merger
}

// The worker header's landing line, so a worker knows exactly where its job stops.
function landingLine({
  rule,
}: {
  rule: LandingRule
}): string {
  if (rule.landing === 'branch') {
    return 'Landing: commit your work on your branch in this copy, then append your completion to worker.log. Do not push or open a pull request; the owner lands the branch.'
  }

  const merger = rule.merge === 'titan'
    ? 'Titan merges it once every check is green'
    : 'the owner merges it'

  return `Landing: commit on your branch, push with \`git push -u origin HEAD:refs/heads/<your-branch>\` to track its own remote branch, open a pull request as a draft if the readiness requirements above are not yet met, and mark it ready after meeting those requirements. Othrys discovers it from this task's branch; ${merger}. Never merge it yourself. Othrys sends you failed checks and new review comments to fix.`
}

export function taskStops({
  state,
  card,
}: {
  state: TitanState
  card: Card
}): string[] {
  const stops: string[] = []
  const rule = taskLanding({
    state,
    card,
  })

  if (rule) {
    stops.push(landingLine({
      rule,
    }))
  }

  return stops
}
