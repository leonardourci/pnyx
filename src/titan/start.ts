import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { TitanError } from '#store/errors.ts'
import { startCommand } from '#workers/start-command.ts'

export async function startTitan({
  titanId,
  via,
  harness,
  prompt,
  folder,
  meta,
}: {
  titanId: string
  via?: string
  harness?: string
  prompt?: string
  folder?: string
  meta: Meta
}): Promise<Output> {
  const how = via ?? 'command'

  if (how !== 'command') {
    throw new TitanError({
      message: `unknown start route: ${how}`,
      code: 'VALIDATION_ERROR',
      help: ['Use --via command'],
    })
  }

  return startCommand({
    titanId,
    role: 'titan',
    prompt,
    folder,
    harness,
    meta,
  })
}
