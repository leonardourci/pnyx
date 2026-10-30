import type { KeyInput } from '#preferences/keyboard.ts'

export function capturedKey({ event }: { event: KeyInput }): string {
  const modifiers: string[] = []

  if (event.ctrlKey) {
    modifiers.push('Control')
  }

  if (event.metaKey) {
    modifiers.push('Meta')
  }

  if (event.altKey) {
    modifiers.push('Alt')
  }

  if (event.shiftKey) {
    modifiers.push('Shift')
  }

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  return [
    ...modifiers,
    key,
  ].join('+')
}
