import { inform } from '#app/command-notices.ts'
import { requireCommandMemoryAccess } from '#memory/command-access.ts'
import { TASK_OPTIONS } from '#app/task-cli.ts'
import { HYDRA_OPTIONS } from './cli.ts'
import { parseArgs } from 'node:util'
import { DEFAULT_HYDRA } from '#app/home-migration.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'
import { guard, WRITE, type Options } from '#app/cli-support.ts'
import { agentNoticeCommand } from '#app/command-registry.ts'
import { requestEnv } from '#app/request-context.ts'
import { settingsNotice } from './settings-notice.ts'
import { asRecord } from '#app/command-validation.ts'

type Command = ReturnType<typeof guard>

// Native commands check cross-Hydra memory capabilities before owner-only proposals.
export function agentNotices<T extends Record<string, Command>>({
  commands,
  env = requestEnv(),
}: {
  commands: T
  env?: NodeJS.ProcessEnv
}): T {
  const wrap = ({
    name,
    run,
  }: {
    name: string
    run: Command
  }) => guard({
    handler: ({ args }) => {
      let commandOptions: Options = {}

      if (name === 'task') {
        commandOptions = TASK_OPTIONS
      } else if (name === 'hydra') {
        commandOptions = HYDRA_OPTIONS
      }

      const {
        values,
        positionals,
      } = parseArgs({
        args,
        options: {
          ...WRITE,
          ...commandOptions,
          polis: { type: 'string' },
          'read-poleis': { type: 'string' },
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

      requireCommandMemoryAccess({
        name,
        args,
        positionals,
        values,
        hydraId,
      })

      if (hydra && agentNoticeCommand({
        name,
        args: actionArgs,
      })) {
        inform({
          reason: `Agent requested ${name} directly`,
          clear: `Use pnyx-axi ${name} --help to inspect or change its settings`,
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
    },
  })

  return Object.fromEntries(Object.entries(commands)
    .map(([
      name,
      run,
    ]) => [
      name,
      wrap({
        name,
        run,
      }),
    ])) as T
}
