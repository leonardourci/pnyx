import { workerTaskDir } from './worker-log.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { applyDecision } from '#app/decision.ts'
import { requestCwd } from '#app/request-context.ts'
import { withWriter } from '#app/writer.ts'
import { hydraConfig } from '#titan/config.ts'
import { hydraEvent } from '#titan/titan.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { runCommand } from '#integrations/command/run.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { findProject } from '#projects/read.ts'
import { TitanError } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { othrysHome } from '#store/storage.ts'
import type { Card } from '#tasks/model.ts'
import { decideNote } from '#tasks/notes.ts'
import { freeTask } from './start.ts'
import { checkRevision, findCard } from '#tasks/push-rules.ts'
import { hydraPrompt, taskPrompt } from './worker-brief.ts'

export function namedProjectCommand({
  state,
  card,
  name,
}: {
  state: TitanState
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
    throw new TitanError({
      message: `project command not found: ${name}; assign the task to its project and read project list`,
      code: 'NOT_FOUND',
    })
  }

  return selected
}

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
  const claimed = await withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const target = role === 'worker' ? findCard({
        state: writer.state,
        ref: task!,
      }).id : TITAN_CARD

      if (`${id}:started` in writer.state.eventIds) {
        return {
          duplicate: true as const,
          target,
        }
      }

      checkRevision({
        card: writer.state.cards[target],
        ifRevision: meta.ifRevision,
      })
      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })

      if (!commandName && !config.command) {
        throw new TitanError({
          message: `Titan ${hydraId} has no start command`,
          code: 'NO_COMMAND',
          help: ['Configure the Titan start command in Settings.'],
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
        throw new TitanError({
          message: `Titan ${hydraId} has no start command`,
          code: 'NO_COMMAND',
          help: ['Configure the Titan start command in Settings.'],
        })
      }

      const cwd = canonical({ path: folder }) ?? card?.folder ?? (role === 'hydra' ? requestCwd() : undefined)

      if (!cwd || !existsSync(cwd)) {
        throw new TitanError({
          message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in',
          code: 'VALIDATION_ERROR',
          help: ['Pass --folder <absolute path>'],
        })
      }

      if (role === 'hydra' && !writer.state.configured) {
        applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: {
              ...meta,
              id: `${id}:config`,
              ifRevision: undefined,
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
        duplicate: false as const,
        target,
        command,
        cwd,
        card,
      }
    },
  })
  const target = claimed.target

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
      OTHRYS_HOME: othrysHome(),
      OTHRYS_TITAN: hydraId,
      OTHRYS_WORKER_HOME: othrysHome(),
      OTHRYS_TASK: target,
      OTHRYS_TASK_DIR: workerTaskDir({
        hydraId,
        task: target,
      }),
      OTHRYS_ROLE: role,
      OTHRYS_TASK_TITLE: claimed.card?.title ?? 'Titan',
      OTHRYS_PROMPT: claimed.card
        ? await taskPrompt({
          hydraId,
          card: claimed.card,
          prompt,
        }) : prompt ?? hydraPrompt({ hydraId }),
      OTHRYS_HARNESS: harness ?? '',
      OTHRYS_FOLDER: claimed.cwd,
    },
  })
  const text = `Started ${role === 'hydra' ? 'Titan' : 'a worker'} with ${commandName ? `project command ${commandName}` : 'the Titan command'} in ${claimed.cwd}`
  await withWriter({
    hydraId,
    fn: ({ writer }) => {
      applyDecision({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            id: `${id}:launch`,
            ifRevision: undefined,
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
            ifRevision: undefined,
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
        ? `Its first session becomes the Titan; read hydra.log in Titan ${hydraId}`
        : `Its session attaches to ${target} when its hooks first report; read tasks/${target}/task.log in Titan ${hydraId}`,
    ],
  }
}
