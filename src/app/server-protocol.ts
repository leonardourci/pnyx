import { CLONE_TIMEOUT_MS } from '#projects/limits.ts'
import { repeatable, waitsOnAgent } from './command-registry.ts'

export const MAX_MESSAGE_BYTES = 64 * 1024
// A Hydra's page HTML sets the token cookie for this path only, so only the page reaches zero-cache.
export const ZERO_PATH = '/zero'
// Zero 1.x serves only named queries; every page reads as the one local owner.
export const ZERO_OWNER = 'owner'
const OWNER_COMMAND_TIMEOUT_MS = 60_000
const REPLY_COMMAND_TIMEOUT_MS = 140_000
const CLONE_CONFIRMATION_MS = 20_000

export function commandBytes({
  name,
  args,
  id = '0'.repeat(36),
  scope,
}: {
  name: string
  args: string[]
  id?: string
  scope?: string
}) {
  return new TextEncoder().encode(JSON.stringify({
    type: 'command',
    ...(scope ? { scope } : {}),
    id,
    name,
    args,
  })).byteLength
}

function cloningProject({
  name,
  args,
}: {
  name: string
  args: string[]
}): boolean {
  return name === 'project' && args[0] === 'add'
    && args.some(arg => arg === '--clone' || arg.startsWith('--clone='))
}

export function commandTimeout({
  name,
  args,
}: {
  name: string
  args: string[]
}): number {
  if (cloningProject({
    name,
    args,
  })) {
    return CLONE_TIMEOUT_MS + CLONE_CONFIRMATION_MS
  }

  return waitsOnAgent({ name }) ? REPLY_COMMAND_TIMEOUT_MS : OWNER_COMMAND_TIMEOUT_MS
}

export function retryable({
  name,
  args,
}: {
  name: string
  args: string[]
}): boolean {
  if (cloningProject({
    name,
    args,
  })) {
    return false
  }

  return repeatable({ name }) || args.some(arg => arg === '--event-id' || arg.startsWith('--event-id='))
    || (name === 'hydras' && ([
      'edit',
      'move',
    ].includes(args[0] ?? '') || (args[0] === 'create' && !!args[2])))
}
