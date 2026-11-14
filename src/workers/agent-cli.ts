import { setTimeout as delay } from 'node:timers/promises'
import { AxiError } from 'axi-sdk-js'
import { findCard } from '#tasks/push-rules.ts'
import { KEY_LABEL, confirms, findOption, harnessControls, inputReason, settingRequest } from './controls.ts'
import { replyRoute } from './reply-route.ts'
import { resolveHome } from '#integrations/firstmate/home.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { askHost } from '#app/server-state.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { COMMON, guard, meta, parse, required, type Options, type Output } from '#app/cli-support.ts'
import { routeName } from './reply-delivery.ts'
import { sendReply } from './reply.ts'

// Time for a harness to record a change it writes at once, as Codex does, before
// the transcript is read back.
const READBACK_MS = 1000

function agentSummary({
  hydraId,
  ref,
  homes,
}: {
  hydraId: string
  ref: string
  homes: string[]
}): Output {
  const card = findCard({
    state: loadHydra({ hydraId }).state,
    ref,
  })
  const provider = card.agent?.provider
  const found = replyRoute({
    card,
    homes: homes.map(path => resolveHome({ path })),
  })
  const firstmate = 'route' in found && found.route.kind === 'firstmate' ? found.route : undefined
  const harness = harnessControls({
    provider,
    firstmate: !!firstmate,
    hosted: 'route' in found && found.route.kind === 'pnyx',
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
    route: 'route' in found ? routeName({
      route: found.route,
      control: true,
    }) : `none: ${found.reason}`,
    ...(harness?.note ? { note: harness.note } : {}),
  }

  if (!harness) {
    return {
      agent,
      controls: [],
      help: [provider ? `Pnyx changes settings only for Claude Code and Codex sessions, not ${provider}` : 'This card has no agent session joined yet, so there is nothing to change'],
    }
  }

  const ready = controls.find(c => c.ready === 'yes')

  return {
    agent,
    controls,
    help: ready ? [`Run \`pnyx-axi agent ${card.id} ${ready.setting} ${ready.options.split(' ')[0]}\` to change it`] : ['No setting can be changed on this route'],
  }
}

export const agent = guard({
  handler: async ({ args }) => {
    const options: Options = {
      ...COMMON,
      home: {
        type: 'string',
        multiple: true,
      },
      actor: { type: 'string' },
      'idempotency-key': { type: 'string' },
      'cancel-compact': { type: 'boolean' },
      'send-now': { type: 'string' },
    }
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 3,
    })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const homes = (values.home as string[] | undefined) ?? []

    if (values['cancel-compact'] || values['send-now']) {
      if (positionals.length !== 1) {
        throw new AxiError(
          'Compaction controls take only the card ID',
          'VALIDATION_ERROR',
        )
      }

      return askHost({
        hydraId,
        body: {
          action: 'compact',
          card: ref,
          sendNow: values['send-now'],
          actor: meta({ values }).actor,
        },
      })
    }

    if (positionals.length < 3) {
      if (positionals.length === 2) {
        throw new AxiError(
          'give a setting and a value',
          'VALIDATION_ERROR',
          [`Run \`pnyx-axi agent ${ref}\` to list them`],
        )
      }

      return agentSummary({
        hydraId,
        ref,
        homes,
      })
    }

    const [
      , setting,
      value,
    ] = positionals as [string, string, string]
    const card = findCard({
      state: loadHydra({ hydraId }).state,
      ref,
    })
    const provider = card.agent?.provider
    const found = replyRoute({
      card,
      homes: homes.map(path => resolveHome({ path })),
    })
    const firstmate = 'route' in found && found.route.kind === 'firstmate' ? found.route : undefined
    const picked = findOption({
      provider,
      setting,
      value,
      firstmate: !!firstmate,
      hosted: 'route' in found && found.route.kind === 'pnyx',
    })

    if (!picked) {
      throw new AxiError(
        `card ${card.id} offers no ${setting} ${value}`,
        'VALIDATION_ERROR',
        [`Run \`pnyx-axi agent ${card.id}\` to list its settings and values`],
      )
    }

    const {
      control,
      option,
    } = picked

    // What the session reported before, with everything it has recorded folded in,
    // so the readback compares like with like.
    const settled = () => withWriter({
      hydraId,
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
    const before = settled()
    const input = option.input
    const harness = harnessControls({ provider })!.name
    // A Firstmate task's worker is never typed into: its orchestrator gets a request note.
    const typed = firstmate
      ? {
        text: settingRequest({
          option,
          task: firstmate.task,
          harness,
        }),
      }
      : 'request' in input
        ? undefined
        : 'set' in input
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

    if (!typed) {
      throw new AxiError(
        'this setting requires a Firstmate request route',
        'NO_ROUTE',
      )
    }

    const receipt = await sendReply({
      hydraId,
      request: {
        card: card.id,
        ...typed,
        control: true,
        homes,
        actor: meta({ values }).actor,
        ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
      },
    })
    let now = before

    if (receipt.state === 'delivered' && !firstmate) {
      // A harness that records the change at once, as Codex does, confirms it here;
      // otherwise the session's next hook or turn does.
      await delay(READBACK_MS)
      now = settled()
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
    } else if (!confirmed && firstmate) {
      out.help = [`${receipt.detail ?? 'The request note'} asks Firstmate's orchestrator for it; the worker's next hook or turn confirms its new ${setting}`]
    } else if (!confirmed) {
      out.help = [`The session has not reported its new ${setting} yet; it does on its next hook or turn. Run \`pnyx-axi card ${card.id}\` to check`]
    }

    return out
  },
})

export const AGENT_HELP = `usage: pnyx-axi agent <id> [<setting> <value>] [--cancel-compact | --send-now <message-id>] [--home <path>]... [--idempotency-key <key>]
Without a setting, lists the card's harness, settings and the ones Pnyx can change, with values.
With one, types what the harness's own interface takes into the session, on the card's reply
route (receipts as for reply), then reads the setting back from the transcript:
  Claude Code: model opus|sonnet|haiku|fable (/model), effort low|medium|high|xhigh|max (/effort),
    fast on|off (/fast), mode next (Shift+Tab). Claude Code saves a typed model, effort or fast
    mode as the default for new sessions; one more Enter answers its confirmation, if shown.
  Direct Codex sessions: effort lower|raise (Shift+Down, Shift+Up), fast toggle (/fast), collaboration toggle
    (Shift+Tab, Plan or Default). Codex picks model and approval mode only in its own pickers.
An agent Pnyx runs (task start) takes its provider’s model, effort and mode directly. Codex takes
model gpt-6.1-sol|gpt-6-astra|gpt-6-sol|gpt-6-luna, effort low|medium|high|xhigh, and mode
untrusted|on-request|never for its next turn. Claude Code takes model opus|sonnet|haiku|fable, effort low|medium|high|xhigh|max
and mode default|acceptEdits|plan|auto|bypassPermissions directly through the Hydra's server, nothing typed.
Terminal and Herdr press only Enter and refuse the keys. Nothing is typed while the session
waits on a permission prompt or question.
A Firstmate task's worker is never typed into: every change goes to its orchestrator as a request
note. Codex task cards also offer model gpt-6.1-sol|gpt-6-astra|gpt-6-sol|gpt-6-luna and
approval untrusted|on-request|never as request-only settings, without any typed input. Notes go
through the home's bin/fm-inbox.sh note --request-id <id> (a retry with the same
--idempotency-key replays that note).
A setting the session has not reported yet is confirmed by its next hook or turn.
`
