import { MAX_BRIEF_LENGTH } from '#tasks/model.ts'

export const DESCRIPTION_LIMIT_MESSAGE = `A description holds up to ${MAX_BRIEF_LENGTH} characters`

export function taskDescription({ text }: { text: string }): string {
  return text.trim() ? text : ''
}

export function descriptionExceedsLimit({ text }: { text: string }): boolean {
  return taskDescription({ text }).length > MAX_BRIEF_LENGTH
}
