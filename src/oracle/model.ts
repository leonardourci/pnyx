import type { TitanState } from '#app/model.ts'
import type { LogPosition } from '#store/log.ts'

export interface SearchSnapshot {
  state: TitanState
  positions: Map<string, number>
  sources: {
    key: string
    scope: string
    path: string
    position: LogPosition
    accepted: ReadonlyMap<string, { n: number }>
  }[]
}

export const KINDS = [
  'event',
  'note',
] as const
export type Kind = (typeof KINDS)[number]

export interface Query {
  text: string
  kind?: Kind
  card?: string
  workspace?: string
  limit: number
  live?: boolean
  columns?: string[]
  projects?: string[]
  since?: string
  includeParts?: true
}

export interface Snippet {
  kind: Kind
  at: string
  snippet: string
  parts?: SnippetPart[]
}

export interface SnippetPart {
  text: string
  matched: boolean
}

// lexical: the words as typed, stemmed and with synonyms; fuzzy: nothing matched
// that way, so words with typos or cut short matched similar words in the source text.
export type Match = 'lexical' | 'fuzzy'

export interface Hit {
  card: string
  title: string
  kind?: 'titan'
  match: Match
  snippets: Snippet[]
}

export interface Document {
  project?: string
  card: string
  kind: Kind
  at: string
  text: string
}
