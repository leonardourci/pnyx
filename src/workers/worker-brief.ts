import { ORCHESTRATE_SKILL, REPORT_PROGRESS_SKILL } from '#setup/skill-names.ts'
import { matchesProject } from '#projects/identity.ts'
import { projectIdentity } from '#projects/sources.ts'
import { readProjectMemory } from '#memory/project-memory.ts'
import { taskInstructions } from '#tasks/owner-ask.ts'
import { projectWorkerContext } from '#projects/context.ts'
import { taskStops } from '#tasks/delivery/rule.ts'
import { projectsFor } from '#projects/read.ts'
import { dirname, join } from 'node:path'
import { declaredState } from '#tasks/declarations.ts'
import type { Card } from '#tasks/model.ts'
import { loadHydra } from '#app/store.ts'

const HYDRA_SKILL = join(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  ORCHESTRATE_SKILL,
  'SKILL.md',
)

function workerPrompt({
  hydraId,
  id,
  title,
}: {
  hydraId: string
  id: string
  title: string
}): string {
  return [
    `You are the Pnyx worker for task ${id} "${title}" on Hydra ${hydraId}. Follow the ${REPORT_PROGRESS_SKILL} skill when it is installed.`,
    `Start with \`pnyx-axi task show ${id} --hydra ${hydraId}\` and \`pnyx-axi task history ${id} --hydra ${hydraId}\`.`,
    `Successful start already records working. Declare meaningful progress with \`pnyx-axi task status ${id} working|needs_you|paused|blocked|done --note <text> --hydra ${hydraId}\`; silence changes nothing.`,
  ].join(' ')
}

// Every worker Pnyx starts opens with the same scope and authority, then where its job stops.
function workerHeader({
  hydraId,
  id,
  stops = [],
  hydraNotes = '',
  projectNotes = '',
}: {
  hydraId: string
  id: string
  stops?: string[]
  hydraNotes?: string
  projectNotes?: string
}): string {
  const standing: string[] = []

  if (hydraNotes || projectNotes) {
    standing.push('Standing worker instructions (defer to the scope and authority above):')

    if (hydraNotes) {
      standing.push(hydraNotes)
    }

    if (projectNotes) {
      standing.push(projectNotes)
    }
  }

  return [
    `<pnyx-worker task="${id}" hydra="${hydraId}">`,
    `You are a worker that Hydra supervises on Pnyx Hydra ${hydraId}, for task ${id} only. Report only through pnyx-axi on this task; Hydra reads your declarations and answers your questions.`,
    "Before changing anything, read your project's AGENTS.md, CLAUDE.md and CONTRIBUTING.md when present, and its skills under .agents/skills, .claude/skills and skills/. Follow them over generic habits, and use the project's skills for the jobs they cover.",
    'Scope: work inside your current folder, the task\'s own copy, and on nothing outside this task.',
    'Authority: run routine commands (reading, building, testing, linting, committing on your own branch) without asking. Ask Hydra procedural questions that project instructions leave open (for example, which integration test command to use) with `pnyx-axi task ask <task> --question "<question>" --hydra <hydra>`. Hydra can route them to its helper; never ask the owner directly. Hosted tool permission requests still use the harness permission flow.',
    `Ask Hydra with \`pnyx-axi task ask ${id} --question "<question>" --hydra ${hydraId}\` about product or architecture choices the owner's ask leaves unsettled, proposed departures from an approved design, merges, destructive actions, writes to shared or production systems, and work outside this task. Wait for the answer before dependent work; continue independent, already-authorized work.`,
    `Native steering: when PNYX_STEERING_WORKER is set, run \`pnyx-axi task inbox read ${id} --hydra ${hydraId}\` at startup, on an inbox notice and before ending a turn. Read records receipt and stops reminders for the returned messages. An ack means read, never completed work. Read and apply instructions in order; report progress and blockers separately, and file any needed question with task ask. A repeated notice is not a new instruction. Checkpoint side effects; after a crash, use inbox read --all and verify existing effects before repeating work. Transport delivery alone is not a read receipt.`,
    "Before you report work as ready (a PR for review, a branch, or a report), finish everything your project's own instructions require for that result, with required checks passing on its current revision. After later changes, repeat affected reviews and verification and refresh the description and evidence before reporting readiness again.",
    ...stops,
    ...standing,
    '</pnyx-worker>',
  ].join('\n')
}

// A worker that replaces a lost session picks up its work from the same folder.
function replacingNote({
  card,
  replacing,
}: {
  card: Card
  replacing: string
}): string {
  const lines = [`This start replaces the lost session ${replacing}; your folder keeps its work, so continue from where it stopped instead of starting over.`]

  if (card.status) {
    const note = card.status.note ? `: ${card.status.note}` : ''
    lines.push(`Its last declaration was ${declaredState({ declaration: card.status })}${note}.`)
  }

  return lines.join(' ')
}

export async function taskPrompt({
  hydraId,
  card,
  prompt,
  replacing,
}: {
  hydraId: string
  card: Card
  prompt?: string
  replacing?: string
}): Promise<string> {
  const instructions = prompt ?? workerPrompt({
    hydraId,
    id: card.id,
    title: card.title,
  })
  const state = loadHydra({ hydraId }).state
  const attachedProject = projectsFor({ state }).find(project => !project.detached
    && matchesProject({
      project,
      ref: card.project,
    }))
  const [
    identity,
    project,
  ] = await Promise.all([
    attachedProject ? projectIdentity({ path: attachedProject.path }) : undefined,
    projectWorkerContext({
      hydraId,
      state,
      project: card.project,
    }),
  ])
  const projectNotes = identity ? readProjectMemory(identity).documents.workers ?? '' : ''

  const header = workerHeader({
    hydraId,
    id: card.id,
    hydraNotes: state.hydraMemory?.workers?.text,
    projectNotes,
    stops: taskStops({
      state,
      hydraId,
      card,
    }),
  })

  let progress: string | undefined

  if (replacing) {
    progress = replacingNote({
      card,
      replacing,
    })
  }

  return [
    header,
    project,
    taskInstructions({ card }),
    instructions,
    progress,
  ].filter(Boolean).join('\n\n')
}

export const hydraPrompt = ({ hydraId }: { hydraId: string }) =>
  `You are Hydra, the orchestrator of the Pnyx Hydra "${hydraId}". Read ${HYDRA_SKILL} and follow it; the skills it names are beside it in ${dirname(dirname(HYDRA_SKILL))}. `
  + `Start with \`pnyx-axi hydra digest --hydra ${hydraId}\` and \`pnyx-axi hydra messages --hydra ${hydraId}\`.`
