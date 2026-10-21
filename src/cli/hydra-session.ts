import { proposeOwnerCommand } from '../confirmations/commands.ts'
import { parseArgs } from 'node:util'
import { DEFAULT_HYDRA } from '../store/hydra-store.ts'
import { AxiError } from 'axi-sdk-js'
import { HYDRA_CARD } from '../core/hydra.ts'
import { HYDRA_ACTOR } from '../core/model.ts'
import { guard, WRITE } from './commands.ts'

type Command = ReturnType<typeof guard>
const flag = ({
  args,
  name,
}: {
  args: string[]
  name: string
}) =>
  args.some(arg => arg === name || arg.startsWith(`${name}=`))

// What only the owner may change: what agents may run, which logins they use, and Hydra's own prompts.
// Hydra may create the missing shared config (rule init never overwrites) and read the setup check.
const OWNER_ONLY: Record<string, ({ args }: { args: string[] }) => boolean> = {
  agent: ({ args }) => args[1] === 'mode',
  rule: ({ args }) => !([
    'list',
    'propose',
  ].includes(args[0] ?? 'list') || (args[0] === 'init' && args.includes('--shared'))),
  account: ({ args }) => ![
    'list',
    'propose',
  ].includes(args[0] ?? 'list'),
  hydra: ({ args }) => args[0] === 'set' && (flag({
    args,
    name: '--command',
  }) || flag({
    args,
    name: '--session',
  })),
  project: ({ args }) => args[0] === 'set',
  setup: ({ args }) => args[0] !== 'check',
  task: ({ args }) => (args[0] === 'permission' && args[1] === HYDRA_CARD)
    || (args[0] === 'copy' && flag({
      args,
      name: '--discard',
    })),
  approval: () => true,
}

// Hydra may propose owner-only actions, but only the owner can confirm them.
export function ownerOnly<T extends Record<string, Command>>({
  commands,
  env = process.env,
}: {
  commands: T
  env?: NodeJS.ProcessEnv
}): T {
  const refuse = ({
    name,
    run,
  }: {
    name: string
    run: Command
  }) =>
    // eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
    (args: string[]) => {
      const {
        values,
        positionals,
      } = parseArgs({
        args,
        options: {
          ...WRITE,
          command: { type: 'string' },
          session: { type: 'string' },
          'command-name': { type: 'string' },
          'brings-own-folder': { type: 'string' },
          copy: { type: 'string' },
          model: { type: 'string' },
          harness: { type: 'string' },
          effort: { type: 'string' },
          mode: { type: 'string' },
          fast: { type: 'string' },
          candidates: { type: 'string' },
          when: { type: 'string' },
          provider: { type: 'string' },
          folder: { type: 'string' },
          order: { type: 'string' },
          project: { type: 'string' },
          main: { type: 'string' },
        },
        strict: false,
        allowPositionals: true,
      })
      const hydra = env.PNYX_ACTOR === HYDRA_ACTOR || values.actor === HYDRA_ACTOR

      const actionArgs = [
        ...positionals,
        ...args.filter(arg => arg.startsWith('--')),
      ]

      if (hydra && OWNER_ONLY[name]?.({ args: actionArgs })) {
        if (name === 'approval' || (name === 'rule' && [
          'confirm',
          'dismiss',
        ].includes(positionals[0] ?? ''))) {
          throw new AxiError(
            'Only the owner can answer an approval question',
            'OWNER_ONLY',
          )
        }

        // A Hydra Pnyx runs has PNYX_HYDRA, so a command copied without --hydra still lands in its own chat.
        const hydraId = typeof values.hydra === 'string' ? values.hydra : env.PNYX_HYDRA || DEFAULT_HYDRA

        return proposeOwnerCommand({
          name,
          args,
          hydraId,
        })
      }

      return run(args)
    }

  return Object.fromEntries(Object.entries(commands)
    .map(([
      name,
      run,
    ]) => [
      name,
      refuse({
        name,
        run,
      }),
    ])) as T
}
