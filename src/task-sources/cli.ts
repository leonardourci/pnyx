import { COMMON, integer, meta, parse, required, type Output } from '../app/cli-support.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter } from '../app/writer.ts'
import { steeringClaim } from '../workers/steering.ts'
import { armLavish } from './lavish.ts'
import {
  captureResult, commandIdentity, handleResult, invalidSource, registerSource,
  SOURCE_MAX_BYTES, SOURCE_TIMEOUT_MS, sourceById, sourceTask,
} from './sources.ts'

export function sourceCommand({ args }: { args: string[] }): Output {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    positionals: 4,
    options: {
      ...COMMON,
      actor: { type: 'string' },
      executable: { type: 'string' },
      argv: { type: 'string' },
      cwd: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'max-bytes': { type: 'string' },
      'max-runs': { type: 'string' },
      restart: { type: 'string' },
      expires: { type: 'string' },
      session: { type: 'string' },
      generation: { type: 'string' },
      all: { type: 'boolean' },
      page: { type: 'string' },
      after: { type: 'string' },
      sequence: { type: 'string' },
      'agent-reply-file': { type: 'string' },
    },
  })
  const [
    action,
    ref,
    id,
  ] = positionals
  const task = required({
    value: ref,
    what: 'task',
  })
  const actor = meta({ values })
  const worker = process.env.PNYX_STEERING_WORKER

  if (action === 'list' || action === 'read') {
    const state = loadHydra({ hydraId }).state
    const card = sourceTask({
      writer: { state },
      ref: task,
      meta: actor,
      worker,
    })
    const sources = card.externalSources ?? []

    if (action === 'list') {
      return {
        task: card.id,
        sources: sources.length ? sources : 'none: no external sources',
      }
    }

    const source = sourceById({
      card,
      id: required({
        value: id,
        what: 'source id',
      }),
    })
    const results = values.all ? source.results : source.results.filter(result => !result.handled)

    return {
      task: card.id,
      source: source.id,
      state: source.state,
      lavish: source.lavish ?? 'none: generic source',
      claim: steeringClaim({ card }) ?? 'none: no worker',
      results: results.length ? results : 'none: no unread results',
    }
  }

  if (![
    'register',
    'handled',
    'stop',
    'lavish',
  ].includes(action ?? '')) {
    invalidSource({ message: 'Use task source register|lavish|list|read|handled|stop' })
  }

  const sourceId = required({
    value: id,
    what: 'source id',
  })

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      if (action === 'lavish') {
        let claim

        if (values.session || values.generation) {
          claim = {
            session: required({
              value: values.session as string | undefined,
              what: '--session',
            }),
            generation: integer({
              value: required({
                value: values.generation as string | undefined,
                what: '--generation',
              }),
              flag: '--generation',
            })!,
          }
        }

        return {
          source: armLavish({
            writer,
            ref: task,
            id: sourceId,
            page: required({
              value: values.page as string | undefined,
              what: '--page',
            }),
            executable: required({
              value: values.executable as string | undefined,
              what: '--executable',
            }),
            replyFile: values['agent-reply-file'] as string | undefined,
            after: values.after as string | undefined,
            sequence: integer({
              value: values.sequence,
              flag: '--sequence',
            }),
            claim,
            meta: actor,
            worker,
          }),
          next: 'Registration saved. Read task source list/read to confirm reply acceptance and a running listener before reporting listening.',
        }
      }

      if (action === 'handled') {
        return {
          result: handleResult({
            writer,
            ref: task,
            id: sourceId,
            sequence: integer({
              value: positionals[3],
              flag: 'sequence',
            }) ?? 0,
            claim: {
              session: required({
                value: values.session as string | undefined,
                what: '--session',
              }),
              generation: integer({
                value: required({
                  value: values.generation as string | undefined,
                  what: '--generation',
                }),
                flag: '--generation',
              })!,
            },
            meta: actor,
            worker,
          }),
        }
      }

      if (action === 'stop') {
        const card = sourceTask({
          writer,
          ref: task,
          meta: actor,
          worker,
        })
        const source = sourceById({
          card,
          id: sourceId,
        })

        if (source.state === 'registered' || source.state === 'running') {
          captureResult({
            writer,
            card,
            source,
            run: source.run?.id ?? source.registration,
            outcome: 'stopped',
            detail: 'Stopped explicitly; unread results remain owed',
            meta: actor,
          })
        }

        return {
          source: sourceById({
            card: writer.state.cards[card.id]!,
            id: sourceId,
          }),
        }
      }

      let argv: unknown

      try {
        argv = JSON.parse(required({
          value: values.argv as string | undefined,
          what: '--argv JSON',
        }))
      } catch {
        invalidSource({ message: '--argv must be a JSON array of strings' })
      }

      const restart = values.restart ?? 'never'

      if (restart !== 'never' && restart !== 'on-failure') {
        invalidSource({ message: '--restart takes never or on-failure' })
      }

      return {
        source: registerSource({
          writer,
          ref: task,
          id: sourceId,
          command: commandIdentity({
            executable: required({
              value: values.executable as string | undefined,
              what: '--executable',
            }),
            argv,
            cwd: required({
              value: values.cwd as string | undefined,
              what: '--cwd',
            }),
          }),
          timeoutMs: integer({
            value: values['timeout-ms'],
            flag: '--timeout-ms',
          }) ?? SOURCE_TIMEOUT_MS,
          maxBytes: integer({
            value: values['max-bytes'],
            flag: '--max-bytes',
          }) ?? SOURCE_MAX_BYTES,
          expiresAt: values.expires as string | undefined,
          restart,
          maxRuns: integer({
            value: values['max-runs'],
            flag: '--max-runs',
          }) ?? 1,
          meta: actor,
          worker,
        }),
      }
    },
  })
}
