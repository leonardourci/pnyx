import type { AgentRef, AgentSettings } from '#workers/model.ts'

// A setting found in a record; null clears one the harness no longer reports.
export type FoundSettings = Record<string, string | null>

function str({ value }: { value: unknown }): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function obj({ value }: { value: unknown }): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function known({ settings }: {
  settings: Record<string, string | null | undefined>
}): FoundSettings | undefined {
  const entries = Object.entries(settings).filter(([
    , v,
  ]) => v !== undefined)
  const found = Object.fromEntries(entries) as FoundSettings

  return Object.keys(found).length ? found : undefined
}

// Settings a harness's hooks report on nearly every event, so the latest hook holds
// the live value: Claude Code sends its model only at session start and after a switch.
export const LIVE_HOOK_SETTINGS: Record<string, string[]> = {
  'claude-code': [
    'effort',
    'mode',
  ],
  'codex': [
    'model',
    'mode',
  ],
}

const onOff = ({ fast }: { fast: boolean | undefined }) => (fast === undefined ? undefined : fast ? 'on' : 'off')

export function hookSettings({ payload }: {
  payload: Record<string, unknown>
}): FoundSettings | undefined {
  return known({
    settings: {
      model: str({ value: payload.model }) ?? str({ value: payload.to_model }),
      effort: str({
        value: payload.effort,
      }) ?? str({
        value: obj({
          value: payload.effort,
        }).level,
      }),
      mode: str({ value: payload.permission_mode }),
    },
  })
}

// Codex's service tier: fast is requested as priority; any other tier is not fast.
function codexFast({ tier }: { tier: unknown }): string | undefined {
  const value = str({ value: tier })

  return onOff({ fast: value === undefined ? undefined : value === 'fast' || value === 'priority' })
}

function approval({ value }: { value: unknown }): string | undefined {
  return str({
    value,
  }) ?? (Object.keys(obj({
    value,
  })).length ? Object.keys(obj({
      value,
    }))[0] : undefined)
}

function claudeSettings(
  {
    record,
    subagent,
  }: {
    record: Record<string, unknown>
    subagent: boolean
  },
): FoundSettings | undefined {
  // In a session's transcript a sidechain record belongs to a subagent, whose settings
  // live on its own card; a subagent's own transcript holds only sidechain records.
  if (record.isSidechain === true && !subagent) {
    return undefined
  }

  // A prompt records the mode it was sent in. The separate permission-mode records
  // keep the session's starting mode, not one changed with Shift+Tab since.
  if (record.type === 'user') {
    return known({ settings: { mode: str({ value: record.permissionMode }) } })
  }

  if (record.type !== 'assistant') {
    return undefined
  }

  const message = obj({ value: record.message })
  const model = str({ value: message.model })
  const speed = str({ value: obj({ value: message.usage }).speed })
  const requested = str({ value: record.requestedModel })

  return known({
    settings: {
    // A synthetic turn, such as an error, names no real model.
      model: model?.startsWith('<') ? undefined : model,
      effort: str({ value: record.effort }),
      fast: onOff({ fast: speed === undefined ? undefined : speed === 'fast' }),
      context: requested === undefined ? undefined : /\[1m\]$/i.test(requested) ? '1M' : null,
      client: str({ value: record.entrypoint }),
      version: str({ value: record.version }),
    },
  })
}

function codexSettings({ record }: { record: Record<string, unknown> }): FoundSettings | undefined {
  const payload = obj({ value: record.payload })

  if (record.type === 'session_meta') {
    return known({
      settings: {
        client: str({
          value: payload.originator,
        }),
        version: str({
          value: payload.cli_version,
        }),
      },
    })
  }

  if (record.type === 'turn_context') {
    return known({
      settings: {
        model: str({ value: payload.model }),
        effort: str({ value: payload.effort }),
        fast: codexFast({ tier: payload.service_tier }),
        approval: approval({ value: payload.approval_policy }),
        sandbox: str({ value: obj({ value: payload.sandbox_policy }).type }),
        collaboration: str({ value: obj({ value: payload.collaboration_mode }).mode }),
        summary: str({ value: payload.summary }),
      },
    })
  }

  if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    const settings = obj({ value: payload.thread_settings })

    return known({
      settings: {
        model: str({ value: settings.model }),
        effort: str({ value: settings.reasoning_effort }),
        fast: codexFast({ tier: settings.service_tier }),
        approval: approval({ value: settings.approval_policy }),
        collaboration: str({ value: obj({ value: settings.collaboration_mode }).mode }),
        summary: str({ value: settings.reasoning_summary }),
      },
    })
  }

  return undefined
}

// The settings one transcript record reports, or undefined for a record that holds
// none, read from a subagent's own transcript when subagent is set. Claude Code and
// Codex records are told apart by their shape.
export function transcriptSettings({
  record,
  subagent = false,
}: {
  record: unknown
  subagent?: boolean
}): FoundSettings | undefined {
  const r = obj({ value: record })

  return 'payload' in r ? codexSettings({ record: r }) : claudeSettings({
    record: r,
    subagent,
  })
}

export function observedSettings({
  agent,
  held,
  observed,
}: {
  agent: AgentRef
  held?: AgentSettings
  observed?: FoundSettings
}): FoundSettings | undefined {
  if (agent.host !== 'pnyx' || !held) {
    return observed
  }

  // Native history may still describe the turn before a hosted picker change.
  const desired = Object.fromEntries(Object.entries(held).filter(([name]) =>
    [
      'model',
      'effort',
      'mode',
    ].includes(name)))

  return {
    ...held,
    ...observed,
    ...desired,
  }
}
