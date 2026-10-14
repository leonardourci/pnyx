// Reads a session's settings from what Claude Code and Codex already record: hook
// payloads and transcript records. Pure, and read-only towards the transcript. Every
// harness maps onto the same names, model, effort, mode and fast, and adds its own
// settings under names of their own:
//
// | Setting | Claude Code | Codex |
// |---|---|---|
// | model | SessionStart `model`; an assistant turn's `message.model` | every hook's `model`; turn context and thread settings `model` |
// | effort | `effort.level` on tool and Stop hooks; an assistant turn's `effort` | turn context `effort`, thread settings `reasoning_effort` |
// | mode | `permission_mode` on hooks; `permission-mode` records | `permission_mode` on hooks |
// | fast | an assistant turn's `message.usage.speed` | thread settings or turn context `service_tier` (`fast`, sent as `priority`) |
// | context | `requestedModel` ending in `[1m]` | |
// | client | `entrypoint` | session meta `originator` |
// | version | `version` | session meta `cli_version` |
// | approval, sandbox, collaboration, summary | | `approval_policy`, `sandbox_policy.type`, `collaboration_mode.mode`, reasoning summary |

// A setting found in a record; null clears one the harness no longer reports.
export type FoundSettings = Record<string, string | null>

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function known(settings: Record<string, string | null | undefined>): FoundSettings | undefined {
  const entries = Object.entries(settings).filter(([, v]) => v !== undefined)
  const found = Object.fromEntries(entries) as FoundSettings

  return Object.keys(found).length ? found : undefined
}

const onOff = (fast: boolean | undefined) => (fast === undefined ? undefined : fast ? 'on' : 'off')

// Settings a hook payload carries: Claude Code sends the model only on SessionStart
// and effort only around tool use and Stop; Codex sends the model on every hook.
export function hookSettings(payload: Record<string, unknown>): FoundSettings | undefined {
  return known({
    model: str(payload.model),
    effort: str(payload.effort) ?? str(obj(payload.effort).level),
    mode: str(payload.permission_mode),
  })
}

// Codex's service tier: fast is requested as priority; any other tier is not fast.
function codexFast(tier: unknown): string | undefined {
  const value = str(tier)

  return onOff(value === undefined ? undefined : value === 'fast' || value === 'priority')
}

// A granular approval policy is an object of switches, shown by its kind.
function approval(value: unknown): string | undefined {
  return str(value) ?? (Object.keys(obj(value)).length ? Object.keys(obj(value))[0] : undefined)
}

function claudeSettings(
  record: Record<string, unknown>,
  subagent: boolean,
): FoundSettings | undefined {
  if (record.type === 'permission-mode') {
    return known({ mode: str(record.permissionMode) })
  }

  // In a session's transcript a sidechain record belongs to a subagent, whose settings
  // live on its own card; a subagent's own transcript holds only sidechain records.
  if (record.type !== 'assistant' || (record.isSidechain === true && !subagent)) {
    return undefined
  }

  const message = obj(record.message)
  const model = str(message.model)
  const speed = str(obj(message.usage).speed)
  const requested = str(record.requestedModel)

  return known({
    // A synthetic turn, such as an error, names no real model.
    model: model?.startsWith('<') ? undefined : model,
    effort: str(record.effort),
    fast: onOff(speed === undefined ? undefined : speed === 'fast'),
    context: requested === undefined ? undefined : /\[1m\]$/i.test(requested) ? '1M' : null,
    client: str(record.entrypoint),
    version: str(record.version),
  })
}

function codexSettings(record: Record<string, unknown>): FoundSettings | undefined {
  const payload = obj(record.payload)

  if (record.type === 'session_meta') {
    return known({ client: str(payload.originator), version: str(payload.cli_version) })
  }

  if (record.type === 'turn_context') {
    return known({
      model: str(payload.model),
      effort: str(payload.effort),
      fast: codexFast(payload.service_tier),
      approval: approval(payload.approval_policy),
      sandbox: str(obj(payload.sandbox_policy).type),
      collaboration: str(obj(payload.collaboration_mode).mode),
      summary: str(payload.summary),
    })
  }

  if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    const settings = obj(payload.thread_settings)

    return known({
      model: str(settings.model),
      effort: str(settings.reasoning_effort),
      fast: codexFast(settings.service_tier),
      approval: approval(settings.approval_policy),
      collaboration: str(obj(settings.collaboration_mode).mode),
      summary: str(settings.reasoning_summary),
    })
  }

  return undefined
}

// The settings one transcript record reports, or undefined for a record that holds
// none, read from a subagent's own transcript when subagent is set. Claude Code and
// Codex records are told apart by their shape.
export function transcriptSettings(record: unknown, subagent = false): FoundSettings | undefined {
  const r = obj(record)

  return 'payload' in r ? codexSettings(r) : claudeSettings(r, subagent)
}
