import type { HydraState } from '../app/model.ts'

export interface SaveCommand {
  type: 'command'
  id: string
  name: string
  args: string[]
}

export function saveEventId({ command }: { command: SaveCommand }): string | undefined {
  if (command.name === 'hydra-agent') {
    return command.id
  }

  if (command.name !== 'hydra' || command.args[0] !== 'send') {
    return
  }

  const inline = command.args.find(arg => arg.startsWith('--event-id='))

  if (inline) {
    return inline.slice('--event-id='.length)
  }

  const index = command.args.indexOf('--event-id')

  if (index >= 0) {
    return command.args[index + 1]
  }
}

export function savedReceipt({
  command,
  state,
}: {
  command: SaveCommand
  state: HydraState
}): Record<string, unknown> | undefined {
  const id = saveEventId({ command })
  const seq = id && state.eventIds[id]

  if (typeof seq !== 'number') {
    return
  }

  const receipt: Record<string, unknown> = {
    type: 'receipt',
    id: command.id,
    saved: true,
    event: {
      id,
      seq,
      type: 'board.configured',
    },
  }

  if (command.name === 'hydra') {
    receipt.state = 'queued'
    receipt.message = id
    receipt.event = {
      id,
      seq,
      type: 'hydra.message',
    }
  }

  return receipt
}
