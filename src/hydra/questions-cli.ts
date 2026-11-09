import { parse, WRITE, meta } from '#app/cli-support.ts'
import { askCommand } from '#tasks/asks.ts'
import { HYDRA_CARD } from './identity.ts'

export function hydraQuestion({ args }: { args: string[] }) {
  const {
    values,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      question: { type: 'string' },
      context: { type: 'string' },
      details: { type: 'string' },
      'details-file': { type: 'string' },
      choice: {
        type: 'string',
        multiple: true,
      },
      recommend: { type: 'string' },
    },
    positionals: 0,
  })

  return askCommand({
    action: 'ask',
    positionals: [
      'ask',
      HYDRA_CARD,
    ],
    values: {
      ...values,
      to: 'owner',
    },
    hydraId,
    meta: meta({ values }),
  })
}
