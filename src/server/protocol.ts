export const MAX_MESSAGE_BYTES = 64 * 1024

export function commandBytes({
  name,
  args,
  id = '0'.repeat(36),
}: {
  name: string
  args: string[]
  id?: string
}) {
  return new TextEncoder().encode(JSON.stringify({
    type: 'command',
    id,
    name,
    args,
  })).byteLength
}
