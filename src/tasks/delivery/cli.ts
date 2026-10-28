import { OUTCOME_STATES, type LandingRule, type OutcomeState } from './model.ts'
import { AxiError } from 'axi-sdk-js'
import { guard, WRITE, parse, meta, required, commit, type Options } from '#app/cli-support.ts'
import { parseLink, decideLink } from './links.ts'
import { decideOutcome } from './outcome.ts'

export function landingWording({ rule }: { rule: LandingRule }): string {
  if (rule.landing === 'branch') {
    return 'a branch'
  }

  return `a pull request merged by ${rule.merge}`
}

export const link = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...WRITE,
      url: { type: 'string' },
      kind: { type: 'string' },
      number: { type: 'string' },
      title: { type: 'string' },
      state: { type: 'string' },
      remove: { type: 'boolean' },
    }
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 1,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const url = required({
      value: values.url as string | undefined,
      what: '--url',
    })
    const s = ({ name }: { name: string }) => values[name] as string | undefined
    const parsed = values.remove
      ? null
      : parseLink({
        input: {
          url,
          kind: s({ name: 'kind' }),
          number: s({ name: 'number' }),
          title: s({ name: 'title' }),
          state: s({ name: 'state' }),
          checkedAt: s({ name: 'state' }) && new Date().toISOString(),
        },
      })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.linked',
        card: ref,
      },
      decide: ({ state }) => decideLink({
        state,
        ref,
        url,
        link: parsed,
        meta: m,
      }),
    })
  },
})

export const outcome = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...WRITE,
        note: { type: 'string' },
        clear: { type: 'boolean' },
      },
      positionals: 2,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const state = positionals[1]

    if (Boolean(values.clear) === (state !== undefined)) {
      throw new AxiError(
        'give either an outcome or --clear',
        'VALIDATION_ERROR',
        [`Outcomes: ${OUTCOME_STATES.join(', ')}`],
      )
    }

    if (state !== undefined && !(OUTCOME_STATES as readonly string[]).includes(state)) {
      throw new AxiError(
        `unknown outcome: ${state}`,
        'VALIDATION_ERROR',
        [`Use one of ${OUTCOME_STATES.join(', ')}`],
      )
    }

    const note = values.note as string | undefined
    const result = state === undefined
      ? null
      : {
        state: state as OutcomeState,
        ...(note ? { note } : {}),
      }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.outcome',
        card: ref,
      },
      decide: ({ state: s }) => decideOutcome({
        state: s,
        ref,
        outcome: result,
        meta: m,
      }),
    })
  },
})
