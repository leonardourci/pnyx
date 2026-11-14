import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { applyDecision } from '#app/decision.ts'
import { requestCwd } from '#app/request-context.ts'
import { withWriter } from '#app/writer.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { runCommand } from '#integrations/command/run.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { findProject } from '#projects/read.ts'
import { HydraError } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { pnyxHome } from '#store/storage.ts'
import type { Card } from '#tasks/model.ts'
import { decideNote } from '#tasks/notes.ts'
import { freeTask } from './start.ts'
import { hydraPrompt, taskPrompt } from './worker-brief.ts'

export function namedProjectCommand({
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

// Runs the Hydra's command with the task in its environment, then notes the start;
// a repeated event id runs nothing again.
export async function startCommand({
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
}): Promise<Output> {
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

      const cwd = canonical({ path: folder }) ?? card?.folder ?? (role === 'hydra' ? requestCwd() : undefined)

      if (!cwd || !existsSync(cwd)) {
        throw new HydraError({
          message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in',
          code: 'VALIDATION_ERROR',
          help: ['Pass --folder <absolute path>'],
        })
      }

      const duplicate = `${id}:started` in writer.state.eventIds

      if (!duplicate && role === 'hydra' && !writer.state.configured) {
        applyDecision({
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
      PNYX_WORKER_HOME: pnyxHome(),
      PNYX_TASK: target,
      PNYX_ROLE: role,
      PNYX_TASK_TITLE: claimed.card?.title ?? 'Hydra',
      PNYX_PROMPT: claimed.card
        ? await taskPrompt({
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
      applyDecision({
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
      applyDecision({
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
