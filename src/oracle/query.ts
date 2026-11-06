import { synonymGroup } from './synonyms.ts'

export const fold = ({ text }: { text: string }) => text.toLowerCase().normalize('NFD')
  .replace(
    /\p{M}/gu,
    '',
  )

// The distinct words of a text, folded, as typo matching looks them up. Words under
// three letters have no trigram; longer than 32 are mostly hashes and ids.
export function words({ text }: { text: string }): Set<string> {
  return new Set(tokens({ text: fold({ text }) }).filter(w => w.length >= 3 && w.length <= 32))
}

export const quote = ({ phrase }: { phrase: string }) => `"${phrase.replace(
  /"/g,
  '""',
)}"`

export const bare = ({ token }: { token: string }) => token.replace(
  /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
  '',
)

// One query word, or a synonym phrase, and what it may match: its synonym group,
// or the word itself. A trailing * matches the word as a prefix, and the indexed
// words starting with it, and skips synonyms and typos.
export interface Term {
  alts: readonly string[]
  prefix: boolean
  typo: boolean
}

export function tokens({
  text,
  prefixes = false,
}: {
  text: string
  prefixes?: boolean
}): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+\*?/gu) ?? []).map(token => prefixes ? token : token.replace(
    /\*$/,
    '',
  ))
}

export function queryTerms({ text }: { text: string }): Term[] {
  const typed = tokens({
    text,
    prefixes: true,
  })
  const terms: Term[] = []

  for (let i = 0; i < typed.length; i += 1) {
    const token = typed[i]!

    if (token.endsWith('*')) {
      terms.push({
        alts: [
          token.slice(
            0,
            -1,
          ),
        ],
        prefix: true,
        typo: false,
      })
      continue
    }

    const pair = i + 1 < typed.length ? synonymGroup.get(`${bare({ token })} ${bare({ token: typed[i + 1]! })}`.toLowerCase()) : undefined

    if (pair) {
      i += 1
    }

    const group = pair ?? synonymGroup.get(bare({ token }).toLowerCase())
    terms.push(
      group
        ? {
          alts: group,
          prefix: false,
          typo: false,
        }
        : {
          alts: [token],
          prefix: false,
          typo: true,
        },
    )
  }

  return terms
}

// A term as an FTS5 expression, each phrase quoted so punctuation is never read as
// query syntax. A prefix term's first alternative is the prefix.
export function termExpr({ term }: { term: Term }): string {
  const alts = term.alts.map((
    alt,
    i,
  ) => `${quote({ phrase: alt })}${term.prefix && i === 0 ? '*' : ''}`)

  return alts.length === 1 ? alts[0]! : `(${alts.join(' OR ')})`
}
