import { ApplyError, type ApplyIssue } from './schema.ts'

type Frame = { path: string[] } & (
  | {
    kind: 'object'
    members: Set<string>
    key?: string
    keyNext: boolean
  }
  | {
    kind: 'array'
    index: number
  }
)

function valuePath({ frames }: { frames: Frame[] }): string[] {
  const parent = frames.at(-1)

  if (!parent) {
    return []
  }

  if (parent.kind === 'array') {
    return [
      ...parent.path,
      String(parent.index),
    ]
  }

  return [
    ...parent.path,
    parent.key ?? '',
  ]
}

export function parseApplyJson({ contents }: { contents: string }): unknown {
  const parsed: unknown = JSON.parse(contents)
  const frames: Frame[] = []
  const errors: ApplyIssue[] = []
  // Syntax is already checked; whole string tokens keep punctuation inside values out of the scan.
  const tokens = contents.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]/g)

  for (const [token] of tokens) {
    if (token === '{') {
      frames.push({
        kind: 'object',
        path: valuePath({ frames }),
        members: new Set(),
        keyNext: true,
      })
      continue
    }

    if (token === '[') {
      frames.push({
        kind: 'array',
        path: valuePath({ frames }),
        index: 0,
      })
      continue
    }

    if (token === '}' || token === ']') {
      frames.pop()
      continue
    }

    const frame = frames.at(-1)

    if (!frame) {
      continue
    }

    if (token === ',') {
      if (frame.kind === 'array') {
        frame.index++
      } else {
        frame.keyNext = true
      }

      continue
    }

    if (token === ':' && frame.kind === 'object') {
      frame.keyNext = false
      continue
    }

    if (frame.kind !== 'object' || !frame.keyNext || !token.startsWith('"')) {
      continue
    }

    const key: string = JSON.parse(token)
    frame.key = key

    if (frame.members.has(key)) {
      const segments = [
        ...frame.path,
        key,
      ]
      const path = `/${segments.map(segment => segment.replaceAll(
        '~',
        '~0',
      ).replaceAll(
        '/',
        '~1',
      )).join('/')}`
      let operation: number | null = null

      if (segments[0] === 'changes' && /^\d+$/.test(segments[1] ?? '')) {
        operation = Number(segments[1])
      }

      errors.push({
        operation,
        path,
        code: 'VALIDATION_ERROR',
        reason: `duplicate JSON member ${key}`,
      })
    }

    frame.members.add(key)
  }

  if (errors.length) {
    throw new ApplyError({ errors })
  }

  return parsed
}
