import { proposeOwnerCommand } from '#app/confirmations.ts'
import { parseArgs } from 'node:util'
import { DEFAULT_HYDRA } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { AxiError } from 'axi-sdk-js'
import { hydraBypasses } from './hydra.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'
import { guard, WRITE } from '#app/cli-support.ts'
import { ownerOnlyCommand } from '#app/command-registry.ts'
import { requestEnv } from '#app/request-context.ts'
import { findCard } from '#tasks/push-rules.ts'
import { agentPermissionNeedsOwner } from '#workers/permission-level.ts'
import { settingsNotice } from './settings-notice.ts'
import { asRecord } from '#app/command-validation.ts'

type Command = ReturnType<typeof guard>

// Bypass counts only for the Hydra the command runs in, never one it names with --hydra.
export function runsInBypass({
  hydraId,
  env = requestEnv(),
}: {
  hydraId: string
  env?: NodeJS.ProcessEnv
}): boolean {
  return env.PNYX_HYDRA === hydraId && hydraBypasses({ state: loadHydra({ hydraId }).state })
}

// Hydra may propose owner-only actions, but only the owner can confirm them.
export function ownerOnly<T extends Record<string, Command>>({
  commands,
  env = requestEnv(),
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
          port: { type: 'string' },
        },
        strict: false,
        allowPositionals: true,
      })
      const hydra = env.PNYX_ACTOR === HYDRA_ACTOR || values.actor === HYDRA_ACTOR

      const actionArgs = [
        ...positionals,
        ...args.filter(arg => arg.startsWith('--')),
      ]

      // A hosted Hydra without --hydra still writes to its own chat.
      const hydraId = typeof values.hydra === 'string' ? values.hydra : env.PNYX_HYDRA || DEFAULT_HYDRA

      if (hydra && ownerOnlyCommand({
        name,
        args: actionArgs,
      })) {
        if (name === 'approval' || (name === 'rule' && [
          'confirm',
          'dismiss',
        ].includes(positionals[0] ?? ''))) {
          throw new AxiError(
            'Only the owner can answer an approval question',
            'OWNER_ONLY',
          )
        }

        const permissionMode = name === 'agent' && positionals[1] === 'mode'

        if (permissionMode && !agentPermissionNeedsOwner({
          card: findCard({
            state: loadHydra({ hydraId }).state,
            ref: positionals[0] ?? '',
          }),
          value: positionals[2] ?? '',
        })) {
          return run(args)
        }

        // Hydra's own permission prompts, raised in Bypass only by the owner's ask rules, stay the owner's.
        const ownPrompt = name === 'task' && positionals[0] === 'permission'

        if (!ownPrompt && !permissionMode && runsInBypass({
          hydraId,
          env,
        })) {
          // Setup without a target serves every Hydra and refuses --hydra.
          const service = name === 'setup' && positionals.length === 0
          const serviceArgs = args.filter((
            arg,
            index,
          ) => arg !== '--hydra' && args[index - 1] !== '--hydra' && !arg.startsWith('--hydra='))

          return run(service ? serviceArgs : args)
        }

        return proposeOwnerCommand({
          name,
          args,
          hydraId,
        })
      }

      const result = run(args)

      if (!hydra || ![
        'hydra',
        'project',
      ].includes(name) || positionals[0] !== 'set') {
        return result
      }

      const notice = ({ output }: { output: unknown }) => {
        const receipt = asRecord({ value: output })
        const event = asRecord({ value: receipt?.event })

        if (typeof event?.id === 'string') {
          const fields = args.filter(arg => arg.startsWith('--') && !(arg.slice(2).split('=')[0]! in WRITE))
            .map(arg => arg.slice(2).split('=')[0])
          settingsNotice({
            hydraId,
            meta: {
              actor: 'hydra',
              at: new Date().toISOString(),
            },
            changeId: `event:${event.id}`,
            text: `Changed ${name} settings: ${fields.join(', ')}`,
          })
        }

        return output
      }

      if (result instanceof Promise) {
        const finish = async () => notice({ output: await result })

        return finish()
      }

      return notice({ output: result })
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
