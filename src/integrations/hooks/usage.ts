export interface RecordedUsage {
  at?: string
  tokens: number
  tasks: string[]
}

function object({ value }: { value: unknown }): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textContent({ value }: { value: unknown }): string {
  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) ? value.map(part => object({ value: part }).text).filter(text => typeof text === 'string')
    .join('\n') : ''
}

function taskContext({ text }: { text: string }): string[] {
  return [...new Set([...text.matchAll(/<pnyx-report\b[^>]*\btask="([^"]+)"/g)].map(match => match[1]!))]
}

function count({ value }: { value: unknown }): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function recordedUsage({
  provider,
  records,
}: {
  provider: string
  records: unknown[]
}): RecordedUsage[] {
  const rows: RecordedUsage[] = []
  const messages = new Map<string, number>()
  let previousTotal = 0
  let tasks: string[] = []

  for (const value of records) {
    const record = object({ value })
    const payload = object({ value: record.payload })
    const message = object({ value: record.message })
    const at = typeof record.timestamp === 'string' ? record.timestamp : undefined

    if ((record.type === 'user' && !record.toolUseResult) || (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user')) {
      tasks = taskContext({ text: textContent({ value: record.type === 'user' ? message.content : payload.content }) })
    }

    if (provider === 'claude' || provider === 'claude-code') {
      const usage = object({ value: message.usage })

      if (record.type !== 'assistant' || typeof message.id !== 'string' || !Object.keys(usage).length) {
        continue
      }

      const tokens = count({ value: usage.input_tokens }) + count({ value: usage.output_tokens })
        + count({ value: usage.cache_read_input_tokens })
        + count({ value: usage.cache_creation_input_tokens })
      const index = messages.get(message.id)
      const row = {
        at,
        tokens,
        tasks: [...tasks],
      }

      if (index === undefined) {
        messages.set(
          message.id,
          rows.length,
        )
        rows.push(row)
      } else if (rows[index]!.tokens < tokens) {
        rows[index] = row
      }
    }

    if (provider === 'codex' && record.type === 'event_msg' && payload.type === 'token_count') {
      const info = object({ value: payload.info })
      const usage = object({ value: info.total_token_usage })
      const total = count({ value: usage.total_tokens })

      if (!total) {
        continue
      }

      const delta = total >= previousTotal ? total - previousTotal : total
      previousTotal = total

      if (delta) {
        rows.push({
          at,
          tokens: delta,
          tasks: [...tasks],
        })
      }
    }
  }

  return rows
}
