import {
  ORCHESTRATE_SKILL,
  REPORT_PROGRESS_SKILL,
  HYDRA_SKILLS,
} from '../integrations/skills/names.ts'
import { matchesProject } from '../projects/identity.ts'
import { requireReady } from '../tasks/dependencies.ts'
import { requireUnheld } from '../tasks/holds.ts'
import { projectIdentity } from '../projects/sources.ts'
import { readProjectMemory } from '../memory/project-memory.ts'
import { taskInstructions } from '../tasks/intent.ts'
import { projectWorkerContext } from '../projects/context.ts'
import { taskStops } from '../tasks/delivery/rule.ts'
import { chooseCandidate, accountEnvironment, dispatchTask, hostedOverride, ruleCandidates, startCandidates, type DispatchChoice, type Override } from './dispatch.ts'
import { modelIds, type ModelOption } from './provider.ts'
import { effectiveDispatch } from './dispatch-config.ts'
import { openPaseo } from '../integrations/paseo/client.ts'
import { findProject, projectsFor } from '../projects/read.ts'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { Decision, HydraState } from '../app/model.ts'
import type { Meta } from '../app/command-meta.ts'
import { decideNote } from '../tasks/notes.ts'
import { decidePush } from '../tasks/push.ts'
import { findCard } from '../tasks/push-rules.ts'
import { declaredState } from '../tasks/declarations.ts'
import { hydraConfig } from '../hydra/config.ts'
import { hydraEvent } from '../hydra/hydra.ts'
import { HYDRA_CARD } from '../hydra/identity.ts'
import { HydraError } from '../store/errors.ts'
import type { Card } from '../tasks/model.ts'
import type { HydraConfig } from '../hydra/model.ts'
import { paseoUrl } from '../integrations/paseo/url.ts'
import { liveTask } from '../tasks/select.ts'
import { sessionId } from './session-attachments.ts'
import { runCommand } from '../integrations/command/run.ts'
import { taskFolder } from '../projects/copies.ts'
import { resolveHome } from '../integrations/firstmate/home.ts'
import { copySkills, removeLegacyHydraSkills } from '../integrations/skills/install.ts'
import { fmNote } from '../integrations/firstmate/reply.ts'
import { createPaseoAgent, startAgent, type Harness } from '../integrations/paseo/launch.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { canonical } from '../store/paths.ts'
import { askHost } from '../app/server-state.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter, type Writer } from '../app/writer.ts'
import { pnyxHome } from '../store/storage.ts'
import type { Output } from '../app/cli-support.ts'

export const VIAS = [
  'pnyx',
  'paseo',
  'firstmate',
  'command',
] as const
type Via = (typeof VIAS)[number]
export const HYDRA_SKILL = join(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  ORCHESTRATE_SKILL,
  'SKILL.md',
)
export const HOME_SKILL = join(
  '.agents',
  'skills',
  ORCHESTRATE_SKILL,
)

function chooseVia({
  state,
  via,
}: {
  state: HydraState
  via?: string
}): Via {
  const chosen = via ?? (state.config?.hydra.kind === 'firstmate' ? 'firstmate' : 'pnyx')

  if (!(VIAS as readonly string[]).includes(chosen)) {
    throw new HydraError({
      message: `unknown start route: ${chosen}`,
      code: 'VALIDATION_ERROR',
      help: [`Use --via ${VIAS.join('|')}`],
    })
  }

  return chosen as Via
}

function apply({
  writer,
  decision,
}: {
  writer: Writer
  decision: Decision
}): void {
  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

export function freeTask({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): Card {
  const card = findCard({
    state,
    ref,
  })

  if (!liveTask({ card }) || card.id === HYDRA_CARD) {
    throw new HydraError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi task list`'],
    })
  }

  requireUnheld({ card })
  requireReady({
    state,
    card,
  })

  if (card.queue) {
    throw new HydraError({
      message: 'unqueue this task before starting a separate worker',
      code: 'CONFLICT',
    })
  }

  if (card.sessionIds?.length) {
    throw new HydraError({
      message: `task ${card.id} already has an attached agent; detach it first`,
      code: 'SESSION_CONFLICT',
    })
  }

  return card
}

export function workerPrompt({
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
export function workerHeader({
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
    'Authority: run routine commands (reading, building, testing, linting, committing on your own branch) without asking.',
    `Ask Hydra with \`pnyx-axi task ask ${id} --question "<question>" --hydra ${hydraId}\` about product or architecture choices the owner's ask leaves unsettled, proposed departures from an approved design, merges, destructive actions, writes to shared or production systems, and work outside this task. Wait for the answer before dependent work; continue independent, already-authorized work.`,
    `Native steering: when PNYX_STEERING_WORKER is set, read \`pnyx-axi task inbox read ${id} --hydra ${hydraId}\` at startup, on an inbox notice and before ending a turn. Handle pending IDs in order; after incorporating each instruction, run \`pnyx-axi task inbox ack ${id} <message-id> --session <session> --generation <generation> --hydra ${hydraId}\` with the claim returned by read. If incorporation is blocked, record the reason with --outcome blocked --note "<why>" and file any needed question separately. Delivery is not acknowledgement. Checkpoint side effects before acknowledging; after a crash, verify an existing effect before repeating it.`,
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

export function taskPrompt({
  hydraId,
  card,
  prompt,
  replacing,
}: {
  hydraId: string
  card: Card
  prompt?: string
  replacing?: string
}): string {
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
  let projectNotes = ''

  if (attachedProject) {
    projectNotes = readProjectMemory(projectIdentity({ path: attachedProject.path })).documents.workers ?? ''
  }

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

  const project = projectWorkerContext({
    hydraId,
    state,
    project: card.project,
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

const hydraPrompt = ({ hydraId }: { hydraId: string }) =>
  `You are Hydra, the orchestrator of the Pnyx Hydra "${hydraId}". Read ${HYDRA_SKILL} and follow it; the skills it names are beside it in ${dirname(dirname(HYDRA_SKILL))}. `
  + `Start with \`pnyx-axi hydra digest --hydra ${hydraId}\` and \`pnyx-axi hydra messages --hydra ${hydraId}\`.`

function namedProjectCommand({
  state,
  card,
  name,
}: {
  state: HydraState
  card: Card
  name: string
}) {
  const project = card.project
    ? findProject({
      state,
      ref: card.project,
      attached: true,
    }) : undefined
  const selected = project?.startCommand

  if (!selected || selected.name !== name) {
    throw new HydraError({
      message: `project command not found: ${name}; assign the task to its project and read project list`,
      code: 'NOT_FOUND',
    })
  }

  return selected
}

// The harness catalogs the Hydra's server reads; one it cannot read is left out, so its models are not checked.
async function hostedOffers({
  hydraId,
  harnesses,
}: {
  hydraId: string
  harnesses: Harness[]
}): Promise<Partial<Record<Harness, string[]>>> {
  const offers: Partial<Record<Harness, string[]>> = {}

  await Promise.all([...new Set(harnesses)].map(async harness => {
    try {
      const { models } = await askHost({
        hydraId,
        body: {
          action: 'models',
          harness,
        },
      }) as { models: ModelOption[] }
      offers[harness] = modelIds({ models })
    } catch (error) {
      if (error instanceof HydraError && error.code === 'NOT_RUNNING') {
        throw error
      }
    }
  }))

  return offers
}

export async function startTask({
  hydraId,
  task,
  via,
  rule,
  harness,
  override,
  prompt,
  folder: given,
  inPlace,
  replacement,
  commandName,
  url,
  meta,
  connect,
}: {
  hydraId: string
  task: string
  replacement?: string
  commandName?: string
  via?: string
  rule?: string
  harness?: string
  override?: Override
  prompt?: string
  folder?: string
  inPlace?: boolean
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref: task,
  })

  requireUnheld({ card })
  requireReady({
    state,
    card,
  })

  if (card.queue) {
    throw new HydraError({
      message: 'unqueue this task before starting a separate worker',
      code: 'CONFLICT',
    })
  }

  const how = chooseVia({
    state,
    via,
  })

  if (commandName && how !== 'command') {
    throw new HydraError({
      message: '--command needs --via command',
      code: 'VALIDATION_ERROR',
    })
  }

  if (replacement && how !== 'pnyx') {
    throw new HydraError({
      message: 'starting fresh from an outside session uses Pnyx',
      code: 'VALIDATION_ERROR',
    })
  }

  if (override && (how === 'firstmate' || how === 'command')) {
    throw new HydraError({
      message: '--model, --effort, --mode and --fast apply to an agent Pnyx or Paseo starts',
      code: 'VALIDATION_ERROR',
      help: ['Use --via pnyx or --via paseo'],
    })
  }

  if (how === 'firstmate') {
    return askFirstmate({
      hydraId,
      task,
      prompt,
      meta,
    })
  }

  if (meta.id && (how === 'pnyx' || how === 'paseo') && `${meta.id}:attach` in state.eventIds) {
    return {
      task: card.id,
      event: 'none: duplicate',
    }
  }

  let dispatch: DispatchChoice | undefined

  if (how !== 'command') {
    let offers: Partial<Record<Harness, string[]>> | undefined
    const { dispatch: effective } = effectiveDispatch({
      hydraId,
      state,
    })
    const list = harness ? startCandidates({
      dispatch: effective,
      rule,
      harness,
      override,
    }) ?? []
      : override?.model ? ([
        'claude',
        'codex',
      ] as const).map(harness => ({
        harness,
        model: override.model,
      }))
        : ruleCandidates({
          dispatch: effective,
          rule,
        }) ?? []

    if (how === 'pnyx') {
      // Only a candidate that names a model needs its harness's catalog.
      const named = list.filter(c => (!harness || c.harness === harness)
        && (override?.model || c.model))
      offers = await hostedOffers({
        hydraId,
        harnesses: named.map(c => c.harness),
      })
    }

    if (how === 'paseo') {
      offers = {}
      const client = await (connect ?? openPaseo)({ url: paseoUrl({ url }) })

      try {
        for (const candidate of list) {
          if (!offers[candidate.harness]) {
            const { models } = await client.providers.listModels(
              candidate.harness,
              {
                cwd: given ?? card.folder ?? process.cwd(),
              },
            )
            offers[candidate.harness] = models?.map(m => m.id) ?? []
          }
        }
      } finally {
        await client.close()
      }
    }

    dispatch = dispatchTask({
      hydraId,
      state,
      project: card.project,
      rule,
      harness,
      override,
      offers,
    })

    if (how === 'pnyx') {
      hostedOverride({
        harness: dispatch.candidate.harness,
        override: dispatch.override,
      })
    }
  }

  const agent = dispatch?.candidate
  const command = how === 'command' || !agent
  const selectedCommand = commandName
    ? namedProjectCommand({
      state,
      card,
      name: commandName,
    }) : undefined
  const ownsFolder = commandName
    ? selectedCommand?.bringsOwnFolder : Boolean(state.config?.commandOwnsFolder)
  const ownFolder = command && ownsFolder
  const currentState = loadHydra({ hydraId }).state
  const currentCard = findCard({
    state: currentState,
    ref: task,
  })
  requireUnheld({ card: currentCard })
  requireReady({
    state: currentState,
    card: currentCard,
  })

  const folder = replacement ? given
    : taskFolder({
      hydraId,
      task,
      folder: given,
      inPlace,
      ownFolder,
      meta,
    })

  if (command) {
    return startCommand({
      hydraId,
      role: 'worker',
      task,
      prompt,
      folder,
      harness,
      commandName,
      meta,
    })
  }

  if (how === 'pnyx') {
    return askHost({
      hydraId,
      body: {
        action: 'start',
        dispatch,
        task: card.id,
        ...(replacement ? { replacement } : {}),
        prompt: taskPrompt({
          hydraId,
          card,
          prompt,
          replacing: replacement,
        }),
        ...(canonical({ path: folder }) ? { folder: canonical({ path: folder }) } : {}),
        id: meta.id ?? randomUUID(),
        actor: meta.actor,
        ...(meta.reason ? { reason: meta.reason } : {}),
      },
    }) as Promise<Output>
  }

  return startAgent({
    hydraId,
    task,
    harness: harness ?? agent.harness,
    agent: {
      ...agent,
      ...dispatch?.override,
    },
    dispatch,
    prompt: taskPrompt({
      hydraId,
      card,
      prompt,
    }),
    folder,
    url,
    meta,
    connect,
  })
}

// Puts the request in Hydra's chat, then hands it to the Firstmate home that is
// this Hydra as an inbox note, which wakes Firstmate. The note's request id
// is the message's, so a retry replays the same note.
function askFirstmate({
  hydraId,
  task,
  prompt,
  meta,
}: {
  hydraId: string
  task: string
  prompt?: string
  meta: Meta
}): Output {
  const initial = findCard({
    state: loadHydra({ hydraId }).state,
    ref: task,
  })
  const brief = taskPrompt({
    hydraId,
    card: initial,
    prompt: prompt ? `Request: ${prompt}` : undefined,
  })
  const queued = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({
        state: writer.state,
        ref: task,
      })

      if (card.revision !== initial.revision) {
        throw new HydraError({
          message: 'Task changed while preparing its worker brief',
          code: 'REVISION_CONFLICT',
        })
      }

      requireUnheld({ card })
      requireReady({
        state: writer.state,
        card,
      })

      if (!liveTask({ card }) || card.id === HYDRA_CARD) {
        throw new HydraError({
          message: `task not found: ${task}`,
          code: 'NOT_FOUND',
        })
      }

      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })

      if (config.hydra.kind !== 'firstmate' || !config.hydra.home) {
        throw new HydraError({
          message: `Hydra ${hydraId} has no Firstmate Hydra`,
          code: 'NO_ROUTE',
          help: [`Run \`pnyx-axi setup hydra --home <firstmate home> --hydra ${hydraId}\``],
        })
      }

      const text = [
        `Pnyx Hydra ${hydraId} asks for a worker on task ${card.id} "${card.title}"${card.folder ? ` in ${card.folder}` : ''}.`,
        `Task brief (give this to the worker as its first prompt):\n${brief}`,
        `Use the ${ORCHESTRATE_SKILL} skill: read \`pnyx-axi task show ${card.id} --hydra ${hydraId}\`, dispatch the worker, and keep the task's status current.`,
      ].join('\n')
      const id = meta.id ?? randomUUID()
      apply({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            id,
          },
          cardId: card.id,
          change: {
            type: 'hydra.message',
            data: {
              task: card.id,
              action: 'worker',
              text,
              hydra: config.hydra.id,
            },
          },
        }),
      })

      return {
        card: card.id,
        home: config.hydra.home,
        id,
        text,
      }
    },
  })
  const sent = fmNote({
    home: queued.home,
    requestId: `pnyx:${hydraId}:${queued.id}`,
    text: queued.text,
  })

  return {
    task: queued.card,
    via: 'firstmate',
    message: queued.id,
    sent: sent.state,
    ...(sent.detail ? { detail: sent.detail } : {}),
    help: sent.state === 'failed'
      ? [`The request stays in \`pnyx-axi hydra messages --hydra ${hydraId}\`; retry with --event-id ${queued.id}`]
      : [`Firstmate dispatches the worker; follow it with \`pnyx-axi task history ${queued.card} --hydra ${hydraId}\``],
  }
}

// Runs the Hydra's command with the task in its environment, then notes the start;
// a repeated event id runs nothing again.
function startCommand({
  hydraId,
  role,
  task,
  prompt,
  folder,
  harness,
  commandName,
  meta,
}: {
  hydraId: string
  role: 'worker' | 'hydra'
  task?: string
  prompt?: string
  folder?: string
  harness?: string
  commandName?: string
  meta: Meta
}): Output {
  const id = meta.id ?? randomUUID()
  const claimed = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })

      if (!commandName && !config.command) {
        throw new HydraError({
          message: `Hydra ${hydraId} has no start command`,
          code: 'NO_COMMAND',
          help: [`Run \`pnyx-axi hydra set --hydra ${hydraId} --command '<shell command>'\``],
        })
      }

      const card = role === 'worker' ? freeTask({
        state: writer.state,
        ref: task!,
      }) : undefined
      const selected = commandName && card
        ? namedProjectCommand({
          state: writer.state,
          card,
          name: commandName,
        }) : undefined

      const command = commandName ? selected?.command : config.command

      if (!command) {
        throw new HydraError({
          message: `Hydra ${hydraId} has no start command`,
          code: 'NO_COMMAND',
          help: [`Run \`pnyx-axi hydra set --hydra ${hydraId} --command '<shell command>'\``],
        })
      }

      const cwd = canonical({ path: folder }) ?? card?.folder ?? (role === 'hydra' ? process.cwd() : undefined)

      if (!cwd || !existsSync(cwd)) {
        throw new HydraError({
          message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in',
          code: 'VALIDATION_ERROR',
          help: ['Pass --folder <absolute path>'],
        })
      }

      const duplicate = `${id}:started` in writer.state.eventIds

      if (!duplicate && role === 'hydra' && !writer.state.configured) {
        apply({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: {
              ...meta,
              id: `${id}:config`,
            },
            cardId: '$board',
            change: {
              type: 'board.configured',
              data: config,
            },
          }),
        })
      }

      return {
        duplicate,
        command,
        cwd,
        card,
      }
    },
  })
  const target = claimed.card?.id ?? HYDRA_CARD

  if (claimed.duplicate) {
    return {
      task: target,
      event: 'none: duplicate',
      help: ['This start was already recorded; nothing was started again'],
    }
  }

  const { pid } = runCommand({
    command: claimed.command,
    cwd: claimed.cwd,
    env: {
      PNYX_HOME: pnyxHome(),
      PNYX_HYDRA: hydraId,
      PNYX_TASK: target,
      PNYX_ROLE: role,
      PNYX_TASK_TITLE: claimed.card?.title ?? 'Hydra',
      PNYX_PROMPT: claimed.card
        ? taskPrompt({
          hydraId,
          card: claimed.card,
          prompt,
        }) : prompt ?? hydraPrompt({ hydraId }),
      PNYX_HARNESS: harness ?? '',
      PNYX_FOLDER: claimed.cwd,
    },
  })
  const text = `Started ${role === 'hydra' ? 'Hydra' : 'a worker'} with ${commandName ? `project command ${commandName}` : 'the Hydra command'} in ${claimed.cwd}`
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      apply({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            id: `${id}:launch`,
          },
          cardId: target,
          change: {
            type: 'task.launched',
            data: {
              via: 'command',
              at: meta.at,
              folder: claimed.cwd,
              pid,
              command: claimed.command,
              ...(harness ? { harness } : {}),
            },
          },
        }),
      })
      apply({
        writer,
        decision: decideNote({
          state: writer.state,
          ref: target,
          note: {
            kind: 'context',
            source: 'pnyx:start',
            text,
          },
          meta: {
            ...meta,
            id: `${id}:started`,
          },
        }),
      })
    },
  })

  return {
    [role === 'hydra' ? 'hydra' : 'task']: target,
    via: 'command',
    pid,
    folder: claimed.cwd,
    help: [
      role === 'hydra'
        ? `Its first session becomes the Hydra; check \`pnyx-axi hydra show --hydra ${hydraId}\``
        : `Its session attaches to ${target} when its hooks first report; check \`pnyx-axi task show ${target} --hydra ${hydraId}\``,
    ],
  }
}

export async function startHydra({
  hydraId,
  via,
  rule,
  harness,
  prompt,
  folder,
  home,
  url,
  meta,
  connect,
}: {
  hydraId: string
  via?: string
  rule?: string
  harness?: string
  prompt?: string
  folder?: string
  home?: string
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const current = loadHydra({ hydraId }).state.config?.hydra
  const how = via ?? (home || current?.kind === 'firstmate' ? 'firstmate' : 'paseo')

  if (how === 'firstmate') {
    const given = home ?? current?.home

    if (!given) {
      throw new HydraError({
        message: 'a Firstmate Hydra needs --home <firstmate home>',
        code: 'VALIDATION_ERROR',
      })
    }

    return setupHydra({
      hydraId,
      home: given,
      meta,
    })
  }

  if (how === 'command') {
    return startCommand({
      hydraId,
      role: 'hydra',
      prompt,
      folder,
      harness,
      meta,
    })
  }

  if (how !== 'paseo') {
    throw new HydraError({
      message: `unknown start route: ${how}`,
      code: 'VALIDATION_ERROR',
      help: ['Use --via paseo|firstmate|command'],
    })
  }

  if (meta.id && `${meta.id}:hydra` in loadHydra({ hydraId }).state.eventIds) {
    return {
      hydra: HYDRA_CARD,
      event: 'none: duplicate',
    }
  }

  const config = effectiveDispatch({
    hydraId,
    state: loadHydra({ hydraId }).state,
  })
  const selectedRule = rule ?? (config.dispatch.rules.hydra ? 'hydra' : 'default')
  const mainName = config.dispatch.main
  const main = mainName && Object.hasOwn(
    config.accounts,
    mainName,
  )
    ? config.accounts[mainName] : undefined

  if (!main || !mainName) {
    throw new HydraError({
      message: 'heads dispatch needs a registered main account',
      code: 'NO_ACCOUNTS',
    })
  }

  const chosen = (harness ?? main.provider) as Harness
  const client = await (connect ?? openPaseo)({ url: paseoUrl({ url }) })
  let offered: string[]

  try {
    const { models } = await client.providers.listModels(
      chosen,
      { cwd: folder ?? process.cwd() },
    )
    offered = models?.map(m => m.id) ?? []
  } finally {
    await client.close()
  }

  const candidates = ruleCandidates({
    dispatch: config.dispatch,
    rule: selectedRule,
  })
  // Hydra runs on its rule's first candidate for the harness, as a hosted Hydra does, so none can tie.
  const first = candidates?.filter(c => c.harness === chosen).slice(
    0,
    1,
  )
  const rules = first && selectedRule !== 'default'
    ? {
      ...config.dispatch.rules,
      [selectedRule]: {
        ...config.dispatch.rules[selectedRule]!,
        candidates: first,
      },
    }
    : config.dispatch.rules
  const dispatch = chooseCandidate({
    config: {
      ...config,
      dispatch: {
        ...config.dispatch,
        rules,
        ...(first && selectedRule === 'default' ? { default: first } : {}),
        workers: { [main.provider]: [mainName] },
        projects: {},
      },
    },
    rule: selectedRule,
    harness: chosen,
    offers: { [chosen]: offered },
  })
  const agent = dispatch.candidate

  const id = meta.id ?? randomUUID()
  const cwd = canonical({ path: folder }) ?? process.cwd()
  const endpoint = paseoUrl({ url })
  const free = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })

      if (`${id}:hydra` in writer.state.eventIds) {
        return false
      }

      if (writer.state.config?.hydra.session) {
        throw new HydraError({
          message: `Hydra ${hydraId} already has a Hydra session`,
          code: 'CONFLICT',
          help: [`Run \`pnyx-axi hydra set --hydra ${hydraId} --identity <new identity>\` to replace it`],
        })
      }

      return true
    },
  })

  if (!free) {
    return {
      hydra: HYDRA_CARD,
      event: 'none: duplicate',
      help: ['This start was already recorded; nothing was started again'],
    }
  }

  const {
    agent: started,
    ref,
  } = await createPaseoAgent({
    harness: chosen,
    agent,
    prompt: prompt ?? hydraPrompt({ hydraId }),
    cwd,
    title: `Hydra · ${hydraId}`,
    id,
    // No PNYX_TASK: the Paseo agent is recorded as Hydra here, not by its hooks.
    env: accountEnvironment({
      account: {
        provider: dispatch.provider,
        folder: dispatch.folder,
      },
      env: {
        PNYX_HOME: pnyxHome(),
        PNYX_HYDRA: hydraId,
      },
    }) as Record<string, string>,
    labels: {
      'pnyx.hydra': hydraId,
      'pnyx.role': 'hydra',
    },
    url: endpoint,
    connect,
  })

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      apply({
        writer,
        decision: decidePush({
          state: writer.state,
          key: `paseo:${started.id}`,
          input: {
            title: `Hydra · ${hydraId}`,
            agent: ref,
            activity: 'working',
            source: {
              adapter: 'paseo',
              instanceId: endpoint,
              objectId: started.id,
              observedAt: meta.at,
            },
          },
          meta: {
            ...meta,
            id: `${id}:session`,
            ifRevision: undefined,
          },
        }),
      })
      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })
      const hydra = {
        ...config.hydra,
        kind: 'agent' as const,
        session: sessionId({ agent: ref }),
      }
      delete hydra.home
      apply({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            id: `${id}:hydra`,
          },
          cardId: '$board',
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra,
            },
          },
        }),
      })

      return {
        hydra: {
          session: hydra.session,
          paseo: started.id,
          folder: cwd,
        },
        help: [`Talk to Hydra in Paseo, or queue work with \`pnyx-axi hydra send --hydra ${hydraId} --text <message>\``],
      }
    },
  })
}

export function setupHydra({
  hydraId,
  home,
  meta,
}: {
  hydraId: string
  home: string
  meta: Meta
}): Output {
  const real = resolveHome({ path: home })
  const dir = join(
    real,
    HOME_SKILL,
  )
  removeLegacyHydraSkills({
    folder: real,
    owns: ({ path }) => {
      const ignored = spawnSync(
        'git',
        [
          '-C',
          real,
          'check-ignore',
          '-v',
          '-z',
          '--stdin',
        ],
        {
          input: `${relative(
            real,
            join(
              path,
              'SKILL.md',
            ),
          )}\0`,
          encoding: 'utf8',
        },
      )
      const [
        source, ,
        pattern,
      ] = ignored.stdout?.split('\0') ?? []

      // Pnyx records each copied skill in info/exclude; tracked and owner skills stay untouched.
      return ignored.status === 0 && !!source?.endsWith('/info/exclude')
        && pattern === `/${relative(
          real,
          path,
        )}/`
    },
  })
  const excluded = copySkills({
    folder: real,
    names: HYDRA_SKILLS,
  })
    .map(folder => exclude({
      home: real,
      path: `/${relative(
        real,
        folder,
      )}/`,
    }))
    .every(Boolean)

  withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })

      if (config.hydra.kind === 'firstmate' && config.hydra.home === real) {
        return
      }

      const data: HydraConfig = {
        ...config,
        hydra: {
          id: `firstmate:${basename(real)}`,
          kind: 'firstmate',
          name: config.hydra.name,
          home: real,
        },
      }
      apply({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta,
          cardId: '$board',
          change: {
            type: 'board.configured',
            data,
          },
        }),
      })
    },
  })

  const text = [
    `Pnyx Hydra ${hydraId} uses this home as its Hydra.`,
    `Load the ${ORCHESTRATE_SKILL} skill (${join(
      HOME_SKILL,
      'SKILL.md',
    )}) and follow it for that Hydra.`,
    `Start with \`pnyx-axi hydra digest --hydra ${hydraId}\` and \`pnyx-axi hydra messages --hydra ${hydraId}\`.`,
  ].join('\n')
  const sent = fmNote({
    home: real,
    requestId: `pnyx:${hydraId}:hydra-skill`,
    text,
  })

  return {
    hydraId,
    hydra: {
      kind: 'firstmate',
      home: real,
    },
    skill: join(
      dir,
      'SKILL.md',
    ),
    excluded: excluded ? 'yes' : 'no: not a git clone',
    note: sent.state,
    ...(sent.detail ? { detail: sent.detail } : {}),
    help: ['A running `pnyx-axi serve` starts syncing Firstmate tasks from this home; run it if none is running'],
  }
}

function exclude({
  home,
  path,
}: {
  home: string
  path: string
}): boolean {
  const found = spawnSync(
    'git',
    [
      '-C',
      home,
      'rev-parse',
      '--git-path',
      'info/exclude',
    ],
    { encoding: 'utf8' },
  )

  if (found.status !== 0 || !found.stdout.trim()) {
    return false
  }

  const given = found.stdout.trim()
  const file = isAbsolute(given) ? given : join(
    home,
    given,
  )
  mkdirSync(
    dirname(file),
    { recursive: true },
  )
  const current = existsSync(file) ? readFileSync(
    file,
    'utf8',
  ) : ''

  if (!current.split('\n').includes(path)) {
    appendFileSync(
      file,
      `${current && !current.endsWith('\n') ? '\n' : ''}${path}\n`,
    )
  }

  return true
}
