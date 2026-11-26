import { parse, WRITE, meta } from '#app/cli-support.ts'
import { askCommand } from '#tasks/asks.ts'
import { TITAN_CARD } from './identity.ts'

export async function titanQuestion({ args }: { args: string[] }) {
  const {
    values,
    titanId,
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

  return await askCommand({
    action: 'ask',
    positionals: [
      'ask',
      TITAN_CARD,
    ],
    values: {
      ...values,
      to: 'owner',
    },
    titanId,
    meta: meta({ values }),
  })
}
