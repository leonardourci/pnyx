export const KINDS = [
  'event',
  'note',
] as const
export type Kind = (typeof KINDS)[number]

export interface IndexResult {
  events: number
  docs: number
}

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
  highlight?: boolean
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
// that way, so words with typos or cut short matched the indexed words nearest them.
export type Match = 'lexical' | 'fuzzy'

export interface Hit {
  card: string
  title: string
  kind?: 'hydra'
  match: Match
  snippets: Snippet[]
}

export interface IndexStatus {
  builtThrough: number
  docs: Record<Kind, number>
  bytes: number
  current: boolean
}
