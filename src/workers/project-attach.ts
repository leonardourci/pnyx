import type { Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { loadTitan } from '#app/store.ts'
import { scratchPath, taskFolder } from '#projects/copy-create.ts'
import { sameProjectPath } from '#projects/identity.ts'
import { projectName } from '#projects/read.ts'
import { taskLease } from '#routine-helper/leases.ts'
import { TitanError } from '#store/errors.ts'
import { findCard } from '#tasks/push-rules.ts'
import { sendReply } from './reply.ts'

// A worker that started without a project moves to the project attached later; its scratch files stay where they are.
export async function continueInProject({
  titanId,
  task,
  meta,
}: {
  titanId: string
  task: string
  meta: Meta
}): Promise<Output> {
  const card = findCard({
    state: loadTitan({ titanId }).state,
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
    const release = taskLease({
      titanId,
      task: card.id,
      actor: 'main',
    })

    try {
      const folder = await taskFolder({
        titanId,
        task: card.id,
        worker: true,
        meta: {
          ...meta,
          ifRevision: undefined,
        },
      })
      await sendReply({
        titanId,
        request: {
          card: card.id,
          expectedSession: worker,
          text: `Project ${projectName({ path: card.project })} is now attached to this task. Continue the work in ${folder}. What you made so far stays in ${scratch}; bring over what the project needs.`,
          actor: 'othrys',
          ...(meta.id ? { id: `${meta.id}:continue` } : {}),
        },
      })

      return { worker: `continues in ${folder}` }
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
