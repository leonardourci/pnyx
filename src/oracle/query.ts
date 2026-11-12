import { similarity } from './fuzzy.ts'
import { synonymGroup } from './synonyms.ts'

const FUZZY_SIMILARITY = 0.4
const SHORT_WORD = 2

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

// Porter's steps 1a, 1b and 1c and its final-e step: plurals, -ed and -ing with the e-restore and
// double-consonant rules. A word ending in -us keeps its s, so status and statuses share a stem.
export function inflection({ word }: { word: string }): string {
  if (word.length <= SHORT_WORD) {
    return word
  }

  return finalE({ stem: yToI({ stem: endings({ stem: plural({ word }) }) }) })
}

const shape = ({ stem }: { stem: string }) => [...stem].reduce(
  (
    form,
    letter,
  ) => {
    const vowel = 'aeiou'.includes(letter) || letter === 'y' && form.at(-1) === 'c'

    return form + (vowel ? 'v' : 'c')
  },
  '',
)

const measure = ({ stem }: { stem: string }) => shape({ stem }).match(/v+c+/g)?.length ?? 0

const hasVowel = ({ stem }: { stem: string }) => shape({ stem }).includes('v')

const endsShort = ({ stem }: { stem: string }) => shape({ stem }).endsWith('cvc') && !/[wxy]$/.test(stem)

const withoutLast = ({
  stem,
  count,
}: {
  stem: string
  count: number
}) => stem.slice(
  0,
  -count,
)

function plural({ word }: { word: string }) {
  if (/(?:sses|ies)$/.test(word)) {
    return withoutLast({
      stem: word,
      count: 2,
    })
  }

  const singular = /(?:ss|us)$/.test(word) || !word.endsWith('s')

  return singular ? word : withoutLast({
    stem: word,
    count: 1,
  })
}

function endings({ stem }: { stem: string }) {
  if (stem.endsWith('eed')) {
    const agreed = measure({
      stem: withoutLast({
        stem,
        count: 3,
      }),
    }) > 0

    return agreed ? withoutLast({
      stem,
      count: 1,
    }) : stem
  }

  const suffix = /(?:ed|ing)$/.exec(stem)?.[0]

  if (!suffix) {
    return stem
  }

  const base = withoutLast({
    stem,
    count: suffix.length,
  })

  if (!hasVowel({ stem: base })) {
    return stem
  }

  if (/(?:at|bl|iz)$/.test(base)) {
    return `${base}e`
  }

  if (/([^aeiouylsz])\1$/.test(base)) {
    return withoutLast({
      stem: base,
      count: 1,
    })
  }

  const restoresE = measure({ stem: base }) === 1 && endsShort({ stem: base })

  return restoresE ? `${base}e` : base
}

function yToI({ stem }: { stem: string }) {
  const base = withoutLast({
    stem,
    count: 1,
  })

  return stem.endsWith('y') && hasVowel({ stem: base }) ? `${base}i` : stem
}

function finalE({ stem }: { stem: string }) {
  if (!stem.endsWith('e')) {
    return stem
  }

  const base = withoutLast({
    stem,
    count: 1,
  })
  const size = measure({ stem: base })
  const dropped = size > 1 || size === 1 && !endsShort({ stem: base })

  return dropped ? base : stem
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
