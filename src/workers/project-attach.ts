import type { Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { loadTitan } from '#app/store.ts'
import { scratchPath, taskFolder } from '#projects/copy-create.ts'
import { sameProjectPath } from '#projects/identity.ts'
import { findProject } from '#projects/read.ts'
import { taskLease } from '#routine-helper/leases.ts'
import { TitanError } from '#store/errors.ts'
import { findCard } from '#tasks/push-rules.ts'
import { sendReply } from './reply.ts'

export async function continueInProject({
  titanId,
  task,
  project,
  meta,
}: {
  titanId: string
  task: string
  project: string
  meta: Meta
}): Promise<Output> {
  const state = loadTitan({ titanId }).state
  const card = findCard({
    state,
    ref: task,
  })
  const worker = card.sessionIds?.[0]
  const scratch = scratchPath({ task: card.id })
  const inScratch = sameProjectPath({
    left: card.agent?.cwd,
    right: scratch,
  })

  if (!worker || !card.project || !inScratch) {
    return {}
  }

  try {
    const attachedProject = findProject({
      state,
      ref: project,
      attached: true,
    })

    if (attachedProject.path !== card.project) {
      return {}
    }

    const release = taskLease({
      titanId,
      task: card.id,
      actor: 'main',
    })

    try {
      const folder = await taskFolder({
        titanId,
        task: card.id,
        continuingSession: worker,
        meta: {
          ...meta,
          ifRevision: undefined,
        },
      })

      if (!folder) {
        throw new TitanError({
          code: 'CONFLICT',
          message: 'the task no longer has a project folder',
        })
      }

      const current = loadTitan({ titanId }).state.cards[card.id]

      if (current?.project !== attachedProject.path) {
        throw new TitanError({
          code: 'CONFLICT',
          message: 'the project changed while its folder was being prepared',
        })
      }

      await sendReply({
        titanId,
        request: {
          card: card.id,
          expectedSession: worker,
          text: `Project ${attachedProject.name} is now attached to this task. Continue the work in ${JSON.stringify(folder)}. Your earlier work is in ${JSON.stringify(scratch)}. Bring over the files the project needs.`,
          actor: 'othrys',
          id: meta.id ? `${meta.id}:continue` : undefined,
        },
      })

      return { worker: `asked to continue in ${folder}` }
    } finally {
      release()
    }
  } catch (error) {
    if (!(error instanceof TitanError)) {
      throw error
    }

    return {
      worker: `not moved: ${error.message}`,
      help: [
        ...error.help,
        `Tell the worker of ${card.id} where to continue`,
      ],
    }
  }
}
