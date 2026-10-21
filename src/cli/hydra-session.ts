import { AxiError } from 'axi-sdk-js'
import { HYDRA_CARD } from '../core/hydra.ts'
import { HYDRA_ACTOR } from '../core/model.ts'
import { guard } from './commands.ts'

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
const OWNER_ONLY: Record<string, ({ args }: { args: string[] }) => boolean> = {
  agent: ({ args }) => args[1] === 'mode',
  rule: ({ args }) => (args[0] ?? 'list') !== 'list',
  account: ({ args }) => (args[0] ?? 'list') !== 'list',
  hydra: ({ args }) => args[0] === 'set' && (flag({
    args,
    name: '--command',
  }) || flag({
    args,
    name: '--session',
  })),
  project: ({ args }) => args[0] === 'set',
  setup: () => true,
  task: ({ args }) => args[0] === 'permission' && args[1] === HYDRA_CARD,
}

// Hydra runs pnyx-axi unasked with PNYX_ACTOR=hydra; dropping the variable takes a command that asks.
export function ownerOnly<T extends Record<string, Command>>({
  commands,
  env = process.env,
}: {
  commands: T
  env?: NodeJS.ProcessEnv
}): T {
  if (env.PNYX_ACTOR !== HYDRA_ACTOR) {
    return commands
  }

  const refuse = ({
    name,
    run,
  }: {
    name: string
    run: Command
  }) =>
    // eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
    (args: string[]) => {
      if (OWNER_ONLY[name]?.({ args })) {
        throw new AxiError(
          `Hydra cannot run \`pnyx-axi ${name} ${args[0] ?? ''}\` itself`,
          'OWNER_ONLY',
          ['Ask the owner in Hydra’s chat'],
        )
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
