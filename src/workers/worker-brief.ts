import { recordContext } from '#titan/file-context.ts'
import { workerTaskDir } from './worker-log.ts'
import { runForClient, requestEnv, requestCwd } from '#app/request-context.ts'
import { ORCHESTRATE_SKILL, REPORT_PROGRESS_SKILL } from '#setup/skill-names.ts'
import { ownerMemory } from '#memory/owner-memory.ts'
import { taskInstructions } from '#tasks/owner-ask.ts'
import { projectWorkerContext } from '#projects/context.ts'
import { READINESS_INSTRUCTIONS, taskStops } from '#tasks/delivery/rule.ts'
import { dirname, join } from 'node:path'
import { currentState } from '#tasks/card-status.ts'
import type { Card } from '#tasks/model.ts'
import { loadTitan } from '#app/store.ts'

const TITAN_SKILL = join(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  ORCHESTRATE_SKILL,
  'SKILL.md',
)

function workerPrompt({
  titanId,
  id,
  title,
}: {
  titanId: string
  id: string
  title: string
}): string {
  return [
    `You are the Othrys worker for task ${id} "${title}" on Titan ${titanId}. Follow the ${REPORT_PROGRESS_SKILL} skill when it is installed.`,
    `Append one line to "${workerTaskDir({
      titanId,
      task: id,
    })}/worker.log" using needs-you: <question>, blocked: <why>, done: <summary>, link: <url> <label>, or note: <progress>. Othrys observes running and idle automatically.`,
  ].join(' ')
}

// Every worker Othrys starts opens with the same scope and authority, then where its job stops.
function workerHeader({
  titanId,
  id,
  stops = [],
  ownerNotes = '',
  hydraNotes = '',
  projectNotes = '',
}: {
  titanId: string
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
    `<othrys-worker task="${id}" hydra="${titanId}">`,
    `You are a worker that Titan supervises on Othrys Titan ${titanId}, for task ${id} only. Report through this task’s worker.log.`,
    recordContext({
      titanId,
      task: id,
    }),
    'When an ID-only steering notice arrives, read the full instruction in these files, then use its supplied othrys task ack action for each exact ID and assignment. Acknowledge only what you read; keep the same IDs on retries. A read receipt never means completed work or permission approval.',
    "Before changing anything, read your project's AGENTS.md, CLAUDE.md and CONTRIBUTING.md when present, and its skills under .agents/skills, .claude/skills and skills/. Follow them over generic habits, and use the project's skills for the jobs they cover.",
    'Scope: work inside your current folder, the task\'s own copy, and on nothing outside this task.',
    'Authority: run routine commands (reading, building, testing, linting, committing on your own branch) without asking. Hosted tool permission requests still use the harness permission flow.',
    'Ask Titan, never the owner, by appending `needs-you: <question>` to worker.log about procedural questions your project\'s instructions leave open, product or architecture choices the owner\'s ask leaves unsettled, proposed departures from an approved design, merges, destructive actions, writes to shared or production systems, and work outside this task. Wait for the answer before dependent work; continue independent, already-authorized work.',
    READINESS_INSTRUCTIONS,
    ...stops,
    ...standing,
    '</othrys-worker>',
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
  titanId,
  card,
  prompt,
  replacing,
}: {
  titanId: string
  card: Card
  prompt?: string
  replacing?: string
}): Promise<string> {
  return runForClient({
    identity: {
      ...requestEnv(),
      OTHRYS_ACTOR: `worker:${card.id}`,
      OTHRYS_TITAN: titanId,
      OTHRYS_TASK: card.id,
    },
    cwd: requestCwd(),
    run: async () => {
      const instructions = prompt ?? workerPrompt({
        titanId,
        id: card.id,
        title: card.title,
      })
      const ownerNotes = (await ownerMemory({})).workers?.text
      const state = loadTitan({ titanId }).state
      const project = await projectWorkerContext({
        titanId,
        state,
        project: card.project,
      })

      const header = workerHeader({
        titanId,
        id: card.id,
        ownerNotes,
        hydraNotes: state.hydraMemory?.workers?.text,
        projectNotes: project.workers,
        stops: taskStops({
          state,
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
        project.context,
        taskInstructions({ card }),
        instructions,
        progress,
      ].filter(Boolean).join('\n\n')
    },
  })
}

export const hydraPrompt = ({ titanId }: { titanId: string }) =>
  `You are Titan, the orchestrator of the Othrys Titan "${titanId}". Read ${TITAN_SKILL} and follow it; the skills it names are beside it in ${dirname(dirname(TITAN_SKILL))}. `
  + recordContext({ titanId })
