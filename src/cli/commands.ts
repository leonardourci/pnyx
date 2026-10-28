import { requireSetupHome } from '../setup/home.ts'
import { setupCheckOutput } from '../setup/check.ts'
import { setupService } from '../server/service.ts'
import { setupSkills } from '../integrations/skills/install.ts'
import { setupHydra } from '../workers/start.ts'
import { AxiError } from 'axi-sdk-js'
import { detectedHarnesses, setupHooks } from '../integrations/hooks/install.ts'
import { HARNESSES, type Harness } from '../integrations/hooks/observe.ts'
import { WRITE, parse, required, integer, meta, guard, type Output, type Options } from '../app/cli-support.ts'

export const setup = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...WRITE,
      harness: { type: 'string' },
      remove: { type: 'boolean' },
      preview: { type: 'boolean' },
      'allow-custom-home': { type: 'boolean' },
      home: { type: 'string' },
      port: { type: 'string' },
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

    if (positionals[0] === 'check') {
      return setupCheckOutput({ hydraId })
    }

    if ([
      'hooks',
      'service',
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

    if (positionals[0] === 'service') {
      if (values.home !== undefined || args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
        throw new AxiError(
          'setup service runs every Hydra; it takes no --hydra or --home',
          'VALIDATION_ERROR',
          ['Run `pnyx-axi setup hydra --home <firstmate home> --hydra <id>` to link a Firstmate home to its Hydra'],
        )
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

    if (positionals[0] === 'hydra') {
      return setupHydra({
        hydraId,
        home: required({
          value: values.home as string | undefined,
          what: '--home',
        }),
        meta: meta({ values }),
      })
    }

    if (positionals[0] !== 'hooks') {
      throw new AxiError(
        `unknown setup target: ${positionals[0] ?? '(none)'}`,
        'VALIDATION_ERROR',
        ['Run `pnyx-axi setup check`, `pnyx-axi setup skills`, `pnyx-axi setup hooks` or `pnyx-axi setup hydra --home <firstmate home>`'],
      )
    }

    const harness = values.harness as string | undefined

    if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) {
      throw new AxiError(
        `unknown harness: ${harness}`,
        'VALIDATION_ERROR',
        [`Use one of ${HARNESSES.join(', ')}`],
      )
    }

    const targets = harness ? [harness as Harness] : detectedHarnesses()

    if (targets.length === 0) {
      throw new AxiError(
        'no Claude Code or Codex config folder found',
        'NOT_FOUND',
        ['Run `pnyx-axi setup hooks --harness claude|codex`'],
      )
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

    help.push(remove ? 'Run `pnyx-axi setup hooks` to install them again' : 'New sessions appear on the Hydra; run `pnyx-axi` to see it')
    out.help = help

    return out
  },
})
