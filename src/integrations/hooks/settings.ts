import { foundSettings, transcriptString } from '#workers/transcript-content.ts'
import { object } from '#workers/transcript-usage.ts'
import type { AgentRef, AgentSettings } from '#workers/model.ts'

import type { FoundSettings } from '#workers/provider.ts'

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

export function hookSettings({ payload }: {
  payload: Record<string, unknown>
}): FoundSettings | undefined {
  return foundSettings({
    settings: {
      model: transcriptString({ value: payload.model })
        ?? transcriptString({ value: payload.to_model }),
      effort: transcriptString({
        value: payload.effort,
      }) ?? transcriptString({
        value: object({
          value: payload.effort,
        }).level,
      }),
      mode: transcriptString({ value: payload.permission_mode }),
    },
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
