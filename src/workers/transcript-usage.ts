export function object({ value }: { value: unknown }): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function textContent({ value }: { value: unknown }): string {
  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) ? value.map(part => object({ value: part }).text).filter(text => typeof text === 'string')
    .join('\n') : ''
}

export function taskContext({ text }: { text: string }): string[] {
  return [...new Set([...text.matchAll(/<pnyx-report\b[^>]*\btask="([^"]+)"/g)].map(match => match[1]!))]
}

export function count({ value }: { value: unknown }): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
