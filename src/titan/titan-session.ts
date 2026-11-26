import { canonicalCommandName, parseCommandArgs } from '#app/command-aliases.ts'
import { inform } from '#app/command-notices.ts'
import { TASK_OPTIONS } from '#app/task-cli.ts'
import { TITAN_OPTIONS } from './cli.ts'
import { DEFAULT_TITAN } from '#app/home-migration.ts'
import { TITAN_ACTOR } from '#app/actors.ts'
import { guard, WRITE, type Options } from '#app/cli-support.ts'
import { agentNoticeCommand } from '#app/command-registry.ts'
import { requestEnv } from '#app/request-context.ts'
import { settingsNotice } from './settings-notice.ts'
import { asRecord } from '#app/command-validation.ts'

type Command = ReturnType<typeof guard>

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
    handler: async ({ args }) => {
      let commandOptions: Options = {}

      if (name === 'task') {
        commandOptions = TASK_OPTIONS
      } else if (name === 'hydra') {
        commandOptions = TITAN_OPTIONS
      }

      const {
        values,
        positionals,
      } = parseCommandArgs({
        args,
        options: {
          ...WRITE,
          ...commandOptions,
          polis: { type: 'string' },
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
      const hydra = env.OTHRYS_ACTOR === TITAN_ACTOR || values.actor === TITAN_ACTOR

      const actionArgs = [
        ...positionals,
        ...args.filter(arg => arg.startsWith('--')),
      ]

      // A hosted Titan without --titan still writes to its own chat.
      const titanId = typeof values.hydra === 'string' ? values.hydra : env.OTHRYS_TITAN || DEFAULT_TITAN

      if (hydra && agentNoticeCommand({
        name,
        args: actionArgs,
      })) {
        inform({
          reason: `Agent requested ${name} directly`,
          clear: 'Inspect or change the configuration in Settings.',
        })
      }

      const result = run(args)

      if (!hydra || ![
        'hydra',
        'project',
      ].includes(name) || positionals[0] !== 'set') {
        return result
      }

      const notice = async ({ output }: { output: unknown }) => {
        const receipt = asRecord({ value: output })
        const event = asRecord({ value: receipt?.event })

        if (typeof event?.id === 'string') {
          const fields = args.filter(arg => arg.startsWith('--') && !(arg.slice(2).split('=')[0]! in WRITE))
            .map(arg => arg.slice(2).split('=')[0])
          await settingsNotice({
            titanId,
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

      return await notice({ output: await result })
    },
  })

  return Object.fromEntries(Object.entries(commands)
    .map(([
      name,
      run,
    ]) => [
      name,
      wrap({
        name: canonicalCommandName({ name }),
        run,
      }),
    ])) as T
}
