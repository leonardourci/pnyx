import { proposeOwnerCommand } from '../confirmations/commands.ts'
import { createHash } from 'node:crypto'
import type { Output } from '../app/cli-support.ts'
import { findCard, type Meta } from '../core/decide.ts'
import { runsInBypass } from '../cli/hydra-session.ts'
import { HydraError } from '../core/model.ts'
import { HYDRA_ACTOR } from '../app/actors.ts'
import { loadHydra } from '../app/store.ts'
import { checkCopy, settleCopy } from './copies.ts'

export function copyCommand({
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
}): Output {
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
        check: checkCopy({
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

  const hydraDiscards = values.discard && meta.actor === HYDRA_ACTOR

  if (hydraDiscards && !runsInBypass({ hydraId })) {
    return proposeOwnerCommand({
      hydraId,
      name: 'task',
      args: [
        'copy',
        ref,
        'remove',
        '--discard',
      ],
    })
  }

  // The owner's browser click is already the confirmation; the CLI asks for a token.
  if (values.discard && meta.actor !== 'web' && card.copy && card.copy.state !== 'removed') {
    const token = createHash('sha256').update(JSON.stringify({
      hydraId,
      card: card.id,
      path: card.copy.path,
      revision: card.revision,
      actor: meta.actor,
    }))
      .digest('hex')
      .slice(
        0,
        24,
      )

    if (values.confirm !== token) {
      return {
        confirmation: 'needed',
        token,
        action: `Discard the copy of ${card.id} at ${card.copy.path}, including uncommitted changes; its branch stays`,
        check: checkCopy({
          card,
          copy: card.copy,
        }),
        help: ['Repeat the same command with --confirm <token>'],
      }
    }
  }

  const {
    copy,
    check,
  } = settleCopy({
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
