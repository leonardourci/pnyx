import { similarity } from './fuzzy.ts'
import { synonymGroup } from './synonyms.ts'

const FUZZY_SIMILARITY = 0.4
const MIN_STEM = 3

export const fold = ({ text }: { text: string }) => text.toLowerCase().normalize('NFD')
  .replace(
    /\p{M}/gu,
    '',
  )

export const bare = ({ token }: { token: string }) => token.replace(
  /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
  '',
)

// One query word, or a synonym phrase, and what it may match: its synonym group,
// or the word itself. A trailing * matches the word as a prefix, and words starting with it, and skips synonyms and typos.
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

// Each space-separated token is split into words the way every search box splits them. A token of
// several words, such as a path, a branch name or don't, stays one phrase with no synonyms or typos,
// so it matches those words only side by side.
export function queryTerms({ text }: { text: string }): Term[] {
  const typed = text.split(/\s+/).map(token => tokens({
    text: token,
    prefixes: true,
  }))
    .filter(runs => runs.length)
  const terms: Term[] = []

  for (let i = 0; i < typed.length; i += 1) {
    const runs = typed[i]!

    if (runs.length > 1) {
      terms.push({
        alts: [
          runs.map(run => run.replace(
            /\*$/,
            '',
          )).join(' '),
        ],
        prefix: runs.at(-1)!.endsWith('*'),
        typo: false,
      })
      continue
    }

    const token = runs[0]!

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

    const next = typed[i + 1]
    const pair = next?.length === 1 ? synonymGroup.get(`${token} ${bare({ token: next[0]! })}`) : undefined

    if (pair) {
      i += 1
    }

    const group = pair ?? synonymGroup.get(token)
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

export const inflection = ({ word }: { word: string }) => {
  const stem = word.replace(
    /(?:ing|ed|es|s)$/u,
    '',
  )

  return stem.length >= MIN_STEM ? stem : word
}

export function matches({
  word,
  term,
  fuzzy,
}: {
  word: string
  term: Term
  fuzzy: boolean
}): boolean {
  return term.alts.some(alt => {
    const alternative = fold({ text: alt })

    if (term.prefix) {
      return word.startsWith(alternative)
    }

    if (word === alternative || inflection({ word }) === inflection({ word: alternative })) {
      return true
    }

    if (!fuzzy || !term.typo || alternative.length < 3) {
      return false
    }

    const contains = alternative.length >= 4 && word.includes(alternative)
    const similar = similarity({
      a: word,
      b: alternative,
    }) >= FUZZY_SIMILARITY

    return contains || similar
  })
}
