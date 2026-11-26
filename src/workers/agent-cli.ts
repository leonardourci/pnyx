import { TitanError } from '#store/errors.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { findCard } from '#tasks/push-rules.ts'
import { KEY_LABEL, confirms, findOption, harnessControls, inputReason } from './controls.ts'
import { replyRoute } from './reply-route.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { askHost } from '#app/server-state.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { COMMON, guard, meta, parse, required, type Options, type Output } from '#app/cli-support.ts'
import { routeName } from './reply-delivery.ts'
import { sendReply } from './reply.ts'

// Time for a harness to record a change it writes at once, as Codex does, before
// the transcript is read back.
const READBACK_MS = 1000

function agentSummary({
  titanId,
  ref,
}: {
  titanId: string
  ref: string
}): Output {
  const card = findCard({
    state: loadTitan({ titanId }).state,
    ref,
  })
  const provider = card.agent?.provider
  const found = replyRoute({ card })
  const harness = harnessControls({
    provider,
    hosted: 'route' in found && found.route.kind === 'othrys',
  })
  const controls = (harness?.controls ?? []).map(c => {
    const unavailable = 'reason' in found
      ? found.reason
      : c.options.map(o => inputReason({
        kind: found.route.kind,
        input: o.input,
      })).find(Boolean)

    return {
      setting: c.setting,
      now: card.settings?.[c.setting] ?? 'unknown',
      options: c.options.map(o => o.value).join(' '),
      ready: unavailable ?? 'yes',
    }
  })
  const agent = {
    card: card.id,
    harness: provider ?? 'none',
    route: 'route' in found ? routeName({ route: found.route }) : `none: ${found.reason}`,
    ...(harness?.note ? { note: harness.note } : {}),
  }

  if (!harness) {
    return {
      agent,
      controls: [],
      help: [provider ? `Othrys changes settings only for Claude Code and Codex sessions, not ${provider}` : 'This card has no agent session joined yet, so there is nothing to change'],
    }
  }

  const ready = controls.find(c => c.ready === 'yes')

  return {
    agent,
    controls,
    help: ready ? ['Change the worker setting in the task UI'] : ['No setting can be changed on this route'],
  }
}

export const agent = guard({
  handler: async ({ args }) => {
    const options: Options = {
      ...COMMON,
      actor: { type: 'string' },
      'idempotency-key': { type: 'string' },
      'cancel-compact': { type: 'boolean' },
    }
    const {
      values,
      positionals,
      titanId,
    } = parse({
      args,
      options,
      positionals: 3,
    })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })

    if (values['cancel-compact']) {
      if (positionals.length !== 1) {
        throw new TitanError({
          message: 'Compaction controls take only the card ID',
          code: 'VALIDATION_ERROR',
        })
      }

      return askHost({
        titanId,
        body: {
          action: 'compact',
          card: ref,
          actor: meta({ values }).actor,
        },
      })
    }

    if (positionals.length < 3) {
      if (positionals.length === 2) {
        throw new TitanError({
          message: 'give a setting and a value',
          code: 'VALIDATION_ERROR',
          help: ['Read the worker settings in the task UI'],
        })
      }

      return agentSummary({
        titanId,
        ref,
      })
    }

    const [
      , setting,
      value,
    ] = positionals as [string, string, string]
    const card = findCard({
      state: loadTitan({ titanId }).state,
      ref,
    })
    const provider = card.agent?.provider
    const found = replyRoute({ card })
    const picked = findOption({
      provider,
      setting,
      value,
      hosted: 'route' in found && found.route.kind === 'othrys',
    })

    if (!picked) {
      throw new TitanError({
        message: `card ${card.id} offers no ${setting} ${value}`,
        code: 'VALIDATION_ERROR',
        help: ['Read the worker settings and values in the task UI'],
      })
    }

    const {
      control,
      option,
    } = picked

    // What the session reported before, with everything it has recorded folded in,
    // so the readback compares like with like.
    const settled = async () => await withWriter({
      titanId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        harvestTranscripts({
          writer,
          cardIds: [card.id],
          at: new Date().toISOString(),
        })

        return writer.state.cards[card.id]?.settings?.[setting]
      },
    })
    const before = await settled()
    const input = option.input
    const typed = 'set' in input
      ? {
        text: `${setting} ${input.set}`,
        setting: {
          name: setting,
          value: input.set,
        },
      }
      : 'key' in input
        ? {
          text: `[${KEY_LABEL[input.key]}]`,
          key: input.key,
        }
        : {
          text: input.text,
          confirm: input.confirm,
        }

    const receipt = await sendReply({
      titanId,
      request: {
        card: card.id,
        ...typed,
        control: true,
        actor: meta({ values }).actor,
        ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
      },
    })
    let now = before

    if (receipt.state === 'delivered') {
      // A harness that records the change at once, as Codex does, confirms it here;
      // otherwise the session's next hook or turn does.
      await delay(READBACK_MS)
      now = await settled()
    }

    const confirmed = confirms({
      control,
      option,
      before,
      after: now,
    })
    const out: Output = {
      agent: {
        card: card.id,
        setting,
        value,
        sent: receipt.state,
        before: before ?? 'unknown',
        now: now ?? 'unknown',
        confirmed,
      },
    }

    if (receipt.recordError) {
      out.help = [`The change ended ${receipt.state} but was not recorded: ${receipt.recordError}; check the session before sending again`]
    } else if (receipt.state === 'failed') {
      out.help = [`Nothing was changed${receipt.detail ? `: ${receipt.detail}` : ''}`]
    } else if (receipt.state !== 'delivered') {
      out.help = [`The change may have landed${receipt.detail ? ` (${receipt.detail})` : ''}; check the session before sending again`]
    } else if (!confirmed) {
      out.help = [`The session has not reported its new ${setting} yet; it does on its next hook or turn. Run \`othrys card ${card.id}\` to check`]
    }

    return out
  },
})
