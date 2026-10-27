import { STEP_WORDS, type UpgradeOperation } from '../../../src/upgrade/model.ts'

const short = ({ commit }: { commit?: string }) => commit?.slice(
  0,
  7,
)

// The step a failed or refused upgrade stopped at, as the row and the fix prompt name it.
export const stoppedWhile = ({ operation }: { operation: UpgradeOperation }) => operation.state === 'refused'
  ? 'checking the Pnyx folder'
  : operation.failed ? STEP_WORDS[operation.failed][1].toLowerCase() : 'upgrading'

// What Ask Hydra to fix puts in the composer; Hydra handles it as a usual task.
export function fixPrompt({ operation }: { operation: UpgradeOperation }): string {
  const from = short({ commit: operation.from }) ?? 'the installed version'
  const to = short({ commit: operation.to }) ?? 'the latest main'
  const error = operation.state === 'refused' ? operation.reasons?.join(' ') : operation.error

  return [
    `The Pnyx upgrade from ${from} to ${to} failed while ${stoppedWhile({ operation })}: ${error ?? 'no error was recorded'}. Pnyx went back to ${from} and is still running.`,
    '1. Find the cause: my setup (Node or pnpm version, disk space, network, local changes) or Pnyx itself.',
    '2. Search the Pnyx GitHub issues for this error. If it\'s a known issue with a fix or workaround, use it and give me the link.',
    '3. Fix it locally so the upgrade works, then run /upgrade again. If the fix changes Pnyx\'s own files, tell me exactly what changed.',
    '4. If it looks like a Pnyx bug nobody has reported, ask whether I want an issue opened. Show me the draft and post it only if I say yes.',
  ].join('\n')
}
