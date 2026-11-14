import { guard, WRITE, parse, meta, required, commit, type Options } from '#app/cli-support.ts'
import { planDeliveryChange } from './plans.ts'

export const LINK_OPTIONS: Options = {
  ...WRITE,
  url: { type: 'string' },
  kind: { type: 'string' },
  number: { type: 'string' },
  title: { type: 'string' },
  state: { type: 'string' },
  remove: { type: 'boolean' },
}

export const link = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: LINK_OPTIONS,
      positionals: 1,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const operation = {
      op: 'link' as const,
      task: ref,
      url: required({
        value: values.url as string | undefined,
        what: '--url',
      }),
      kind: values.kind as string | undefined,
      number: values.number as string | undefined,
      title: values.title as string | undefined,
      state: values.state as string | undefined,
      remove: values.remove === true,
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.linked',
        card: ref,
      },
      decide: ({
        state,
        meta,
      }) => planDeliveryChange({
        state,
        operation,
        meta,
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
    const operation = {
      op: 'outcome' as const,
      task: ref,
      state: positionals[1],
      note: values.note as string | undefined,
      clear: values.clear === true,
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.outcome',
        card: ref,
      },
      decide: ({
        state,
        meta,
      }) => planDeliveryChange({
        state,
        operation,
        meta,
      }),
    })
  },
})
