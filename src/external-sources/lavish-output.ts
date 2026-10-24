import type { SourceResult } from './model.ts'

export function lavishCanRearm({ result }: { result: SourceResult }): boolean {
  const session = lavishSession({ stdout: result.stdout })

  if (session.ended) {
    return false
  }

  if (result.outcome === 'completed') {
    return !result.terminal && session.status === 'feedback'
  }

  return [
    'failed',
    'interrupted',
    'expired',
    'stale',
    'stopped',
  ].includes(result.outcome)
}

export function lavishSession({ stdout }: { stdout: string }): {
  status: string
  ended: boolean
} {
  const lines = stdout.split('\n')

  if (lines[0] !== 'session:') {
    return {
      status: 'unknown',
      ended: false,
    }
  }

  const fields = new Map<string, string>()

  for (const line of lines.slice(1)) {
    if (!line.startsWith(' ')) {
      break
    }

    const match = /^ {2}(status|session_ended): ([a-z_]+)$/.exec(line)

    if (!match && /^ {2}(status|session_ended):/.test(line)) {
      return {
        status: 'unknown',
        ended: false,
      }
    }

    if (match) {
      if (fields.has(match[1]!)) {
        return {
          status: 'unknown',
          ended: false,
        }
      }

      fields.set(
        match[1]!,
        match[2]!,
      )
    }
  }

  const ended = fields.get('session_ended')

  if (ended !== undefined && ended !== 'true' && ended !== 'false') {
    return {
      status: 'unknown',
      ended: false,
    }
  }

  return {
    status: fields.get('status') ?? 'unknown',
    ended: fields.get('status') === 'ended' || fields.get('session_ended') === 'true',
  }
}
