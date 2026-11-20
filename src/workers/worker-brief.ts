import { workerTaskDir } from './worker-log.ts'
import { requireHydraCapability } from '#memory/command-access.ts'
import { runForClient, requestEnv, requestCwd } from '#app/request-context.ts'
import { readMemoryContext } from '#memory/context.ts'
import { readableProjects } from '#memory/poleis.ts'
import { ORCHESTRATE_SKILL, REPORT_PROGRESS_SKILL } from '#setup/skill-names.ts'
import { matchesProject } from '#projects/identity.ts'
import { projectIdentity } from '#projects/sources.ts'
import { ownerMemory } from '#memory/owner-memory.ts'
import { readProjectMemory } from '#memory/project-memory.ts'
import { taskInstructions } from '#tasks/owner-ask.ts'
import { projectWorkerContext } from '#projects/context.ts'
import { READINESS_INSTRUCTIONS, taskStops } from '#tasks/delivery/rule.ts'
import { dirname, join } from 'node:path'
import { currentState } from '#tasks/card-status.ts'
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
    `Append one line to "${workerTaskDir({
      hydraId,
      task: id,
    })}/worker.log" using needs-you: <question>, blocked: <why>, done: <summary>, link: <url> <label>, or note: <progress>. Pnyx observes running and idle automatically.`,
  ].join(' ')
}

// Every worker Pnyx starts opens with the same scope and authority, then where its job stops.
function workerHeader({
  hydraId,
  id,
  stops = [],
  ownerNotes = '',
  hydraNotes = '',
  projectNotes = '',
}: {
  hydraId: string
  id: string
  stops?: string[]
  ownerNotes?: string
  hydraNotes?: string
  projectNotes?: string
}): string {
  const notes = [
    ownerNotes,
    hydraNotes,
    projectNotes,
  ].filter(Boolean)
  const standing = notes.length ? [
    'Standing worker instructions (defer to the scope and authority above):',
    ...notes,
  ] : []

  return [
    `<pnyx-worker task="${id}" hydra="${hydraId}">`,
    `You are a worker that Hydra supervises on Pnyx Hydra ${hydraId}, for task ${id} only. Report through this task’s worker.log; ask Hydra questions through pnyx-axi task ask.`,
    "Before changing anything, read your project's AGENTS.md, CLAUDE.md and CONTRIBUTING.md when present, and its skills under .agents/skills, .claude/skills and skills/. Follow them over generic habits, and use the project's skills for the jobs they cover.",
    'Scope: work inside your current folder, the task\'s own copy, and on nothing outside this task.',
    'Authority: run routine commands (reading, building, testing, linting, committing on your own branch) without asking. Hosted tool permission requests still use the harness permission flow.',
    `Ask Hydra, never the owner, with \`pnyx-axi task ask ${id} --question "<question>" --hydra ${hydraId}\` about procedural questions your project's instructions leave open, product or architecture choices the owner's ask leaves unsettled, proposed departures from an approved design, merges, destructive actions, writes to shared or production systems, and work outside this task. Wait for the answer before dependent work; continue independent, already-authorized work.`,
    READINESS_INSTRUCTIONS,
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
  const lines = [`This start continues from session ${replacing} in the existing folder; keep its work and pick up where it stopped.`]

  const latest = currentState({ card })

  if (latest) {
    lines.push(`Latest worker update: ${latest.text}`)
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
  return readMemoryContext({
    read: async () => {
      requireHydraCapability({ hydraId })

      return runForClient({
        identity: {
          ...requestEnv(),
          PNYX_ACTOR: `worker:${card.id}`,
          PNYX_HYDRA: hydraId,
          PNYX_TASK: card.id,
        },
        cwd: requestCwd(),
        run: async () => {
          const instructions = prompt ?? workerPrompt({
            hydraId,
            id: card.id,
            title: card.title,
          })
          const ownerNotes = ownerMemory({ hydraId }).workers?.text
          const state = loadHydra({ hydraId }).state
          const attachedProject = (await readableProjects({
            state,
            hydraId,
          })).find(project => !project.detached
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
          const projectNotes = identity ? readProjectMemory({
            ...identity,
            hydraId,
          }).documents.workers ?? '' : ''

          const header = workerHeader({
            hydraId,
            id: card.id,
            ownerNotes,
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
        },
      })
    },
  })
}

export const hydraPrompt = ({ hydraId }: { hydraId: string }) =>
  `You are Hydra, the orchestrator of the Pnyx Hydra "${hydraId}". Read ${HYDRA_SKILL} and follow it; the skills it names are beside it in ${dirname(dirname(HYDRA_SKILL))}. `
  + `Start with \`pnyx-axi hydra digest --hydra ${hydraId}\` and \`pnyx-axi hydra messages --hydra ${hydraId}\`.`
