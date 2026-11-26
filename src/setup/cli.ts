import { TitanError } from '#store/errors.ts'
import { guard, WRITE, parse, integer, type Options, type Output } from '#app/cli-support.ts'
import { setupCheckOutput } from './check.ts'
import { requireSetupHome } from './home.ts'
import { setupSkills } from './skills.ts'
import { setupService } from './service.ts'
import { HARNESSES, type Harness } from '#integrations/hooks/observe.ts'
import { detectedHarnesses, setupHooks } from './hooks.ts'

export const setup = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...WRITE,
      harness: { type: 'string' },
      remove: { type: 'boolean' },
      preview: { type: 'boolean' },
      'allow-custom-home': { type: 'boolean' },
      port: { type: 'string' },
    }
    const {
      values,
      positionals,
      titanId,
    } = parse({
      args,
      options,
      positionals: 1,
    })

    if (positionals[0] === 'check') {
      return setupCheckOutput({ titanId })
    }

    if (positionals[0] === undefined || [
      'hooks',
      'skills',
    ].includes(positionals[0] ?? '')) {
      requireSetupHome({ allowCustomHome: !!values['allow-custom-home'] })
    }

    if (positionals[0] === 'skills') {
      return setupSkills({
        remove: !!values.remove,
        preview: !!values.preview,
      })
    }

    if (positionals[0] === undefined) {
      if (args.some(a => /^--titan(?:=|$)/.test(a))) {
        throw new TitanError({
          message: 'setup runs every Titan; it takes no --titan',
          code: 'VALIDATION_ERROR',
        })
      }

      return setupService({
        port: integer({
          value: values.port,
          flag: '--port',
        }),
        remove: !!values.remove,
        preview: !!values.preview,
      })
    }

    if (positionals[0] !== 'hooks') {
      throw new TitanError({
        message: `unknown setup target: ${positionals[0] ?? '(none)'}`,
        code: 'VALIDATION_ERROR',
        help: ['Run `othrys setup`, `othrys setup check`, `othrys setup skills` or `othrys setup hooks`'],
      })
    }

    const harness = values.harness as string | undefined

    if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) {
      throw new TitanError({
        message: `unknown harness: ${harness}`,
        code: 'VALIDATION_ERROR',
        help: [`Use one of ${HARNESSES.join(', ')}`],
      })
    }

    const targets = harness ? [harness as Harness] : detectedHarnesses()

    if (targets.length === 0) {
      throw new TitanError({
        message: 'no Claude Code or Codex config folder found',
        code: 'NOT_FOUND',
        help: ['Run `othrys setup hooks --harness claude|codex`'],
      })
    }

    const remove = Boolean(values.remove)
    const preview = Boolean(values.preview)
    const hooks = targets.map(h => setupHooks({
      harness: h,
      opts: {
        remove,
        preview,
      },
    }))
    const out: Output = { hooks }

    if (preview) {
      out.preview = 'nothing written; rerun without --preview to apply'
    }

    const help: string[] = []

    if (!remove && !preview && targets.includes('codex')) {
      help.push('Codex asks you to review and trust new hooks: run `/hooks` in Codex')
    }

    help.push(remove ? 'Run `othrys setup hooks` to install them again' : 'New sessions appear on the Titan; run `othrys` to see it')
    out.help = help

    return out
  },
})
