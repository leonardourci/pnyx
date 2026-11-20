import type { Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { HydraError } from '#store/errors.ts'
import { loadHydra } from '#app/store.ts'
import { checkCopy } from './copy-check.ts'
import { settleCopy } from './copy-settle.ts'

export async function copyCommand({
  hydraId,
  ref,
  action,
  values,
  meta,
}: {
  hydraId: string
  ref: string
  action?: string
  values: Record<string, string | boolean | undefined>
  meta: Meta
}): Promise<Output> {
  const card = findCard({
    state: loadHydra({ hydraId }).state,
    ref,
  })

  if (action === undefined) {
    if (!card.copy) {
      return {
        task: card.id,
        copy: 'none: this task has no copy of its own',
      }
    }

    return {
      task: card.id,
      copy: card.copy,
      ...(card.copy.state !== 'removed' ? {
        check: await checkCopy({
          card,
          copy: card.copy,
        }),
      } : {}),
    }
  }

  if (action !== 'remove' || (values.safe && values.discard)) {
    throw new HydraError({
      message: 'Use task copy <task> [remove [--safe | --discard]]',
      code: 'VALIDATION_ERROR',
    })
  }

  const {
    copy,
    check,
  } = await settleCopy({
    hydraId,
    ref: card.id,
    mode: values.discard ? 'discard' : values.safe ? 'safe' : 'check',
    meta,
  })

  return {
    task: card.id,
    copy: copy ?? 'none: this task has no copy of its own',
    ...(check ? { check } : {}),
    ...(copy?.state === 'flagged' ? { help: ['Land its current work and run task copy remove again; discarding it needs the owner'] } : {}),
  }
}
