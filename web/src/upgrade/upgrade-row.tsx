import { OperationLine } from '#web-shared/ui/operation-line.tsx'
import type { ComponentProps } from 'react'
import { STEP_WORDS, type UpgradeOperation, type UpgradeStepName } from '#upgrade/model.ts'
import { useElapsed } from '#web-workers/compaction.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { fixPrompt, stoppedWhile } from './fix-prompt.ts'

function UpgradeAction({ ...props }: ComponentProps<typeof Button>) {
  return <Button variant="surface" {...props} className="upgrade-fix inline-flex items-center gap-1.5 justify-self-start" />
}

const STEPS: UpgradeStepName[] = [
  'pull',
  'install',
  'build',
  'data',
  'restart',
]

// Every step while it runs, so the ones still to come show too; only the steps that ran once it stopped.
function Steps({ operation }: { operation: UpgradeOperation }) {
  const active = operation.state === 'running' || operation.state === 'waiting' || operation.state === 'restarting'
  const restartOnly = operation.steps.length === 1 && operation.steps[0]?.step === 'restart'
  const shown = active && !restartOnly ? STEPS : operation.steps.map(step => step.step)

  return (
    <ol className="upgrade-steps m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-muted [&_li]:inline-flex [&_li]:items-center [&_li]:gap-1 [&_li[data-state=done]_svg]:text-green [&_li[data-state=failed]]:text-red [&_li[data-state=stopped]]:text-ink [&_li[data-state=todo]]:text-control">
      {shown.map(name => {
        const step = operation.steps.find(item => item.step === name)
        const [
          todo,
          doing,
          done,
        ] = STEP_WORDS[name]

        return (
          <li key={name} data-state={step?.state ?? 'todo'}>
            {step?.state === 'done' ? <>{done}<Icon name="check" size={ICON_SIZE.badge} /></>
              : step?.state === 'running' ? `${doing}…`
                : step?.state === 'failed' ? <>{doing} failed<Icon name="error" size={ICON_SIZE.badge} /></>
                  : step?.state === 'stopped' ? `${doing} stopped`
                    : todo}
          </li>
        )
      })}
    </ol>
  )
}

// The chat row Othrys draws for an /upgrade, from its first step to the restarted server.
export function UpgradeRow({
  operation,
  askTitan,
  stop,
  restartNow,
}: {
  operation: UpgradeOperation
  askTitan({ text }: { text: string }): void
  stop(): Promise<void>
  // Restarts a built upgrade without waiting for agents between turns.
  restartNow(): Promise<void>
}) {
  const active = operation.state === 'running' || operation.state === 'waiting' || operation.state === 'restarting'
  const elapsed = useElapsed({
    startedAt: operation.startedAt ?? operation.queuedAt,
    endedAt: operation.endedAt,
    running: active,
  })
  const restartOnly = operation.steps.length === 1 && operation.steps[0]?.step === 'restart'
  const progressTitle = restartOnly ? 'Restarting Othrys' : 'Upgrading Othrys'
  const finishedTitle = restartOnly ? 'Restarted' : 'Upgraded'
  const activeIcon = restartOnly ? 'restart' : 'upgrade'
  const brokenBack = operation.rolledBack === false
  const needsFix = operation.state === 'failed' || operation.state === 'refused' || (operation.state === 'stopped' && brokenBack)
  const [
    title,
    detail,
  ] = operation.state === 'waiting' ? [
    'Upgraded; restarting once no agent is mid-turn',
    `Othrys restarts by ${new Date(operation.restartBy ?? Date.now()).toLocaleTimeString(
      [],
      {
        hour: '2-digit',
        minute: '2-digit',
      },
    )} at the latest.`,
  ]
    : active ? [`${progressTitle}… ${elapsed}`]
      : operation.state === 'done' ? [`${finishedTitle} · ${elapsed}`]
        : operation.state === 'current' ? ['Othrys is already up to date']
          : operation.state === 'stopped' ? brokenBack ? [
            'Upgrade stopped.',
            'Going back to the previous version failed, so the Othrys folder may be partly upgraded.',
          ] : ['Upgrade stopped; nothing changed.']
            : operation.state === 'refused' ? [
              'Upgrade not started.',
              `The Othrys folder in ${operation.folder} isn't ready. Nothing was stashed or changed.`,
            ]
              : operation.failed === 'restart' ? restartOnly ? ['Restart failed.'] : [
                'Upgrade finished, but restart failed.',
                'The upgraded code remains on disk.',
              ]
                : [
                  `Upgrade failed while ${stoppedWhile({ operation })}.`,
                  operation.rolledBack === false
                    ? 'Going back to the previous version failed too, so the Othrys folder may be partly upgraded.'
                    : 'Went back to the previous version; nothing changed.',
                ]

  return (
    <OperationLine upgrade data-state={needsFix ? 'failed' : operation.state} role={active ? 'status' : undefined}>
      <Icon name={active ? activeIcon : needsFix ? 'error' : operation.state === 'stopped' ? 'stop' : 'check'} size={ICON_SIZE.inline} />
      <div className="upgrade-body grid min-w-0 flex-1 gap-1.5">
        <span className="upgrade-title font-medium">{title}</span>
        {detail && <span className="upgrade-detail -mt-1 text-muted">{detail}</span>}
        {operation.reasons?.length ? (
          <ul className="upgrade-reasons m-0 grid list-disc gap-0.5 pl-4 text-muted">
            {operation.reasons?.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
        ) : null}
        {operation.steps.length > 0 && operation.state !== 'current' && <Steps operation={operation} />}
        {operation.state === 'running' && (
          <UpgradeAction onClick={stop}>
            <Icon name="stop" size={ICON_SIZE.badge} />Stop
          </UpgradeAction>
        )}
        {operation.state === 'waiting' && (
          <UpgradeAction onClick={restartNow}>
            <Icon name="restart" size={ICON_SIZE.badge} />Restart now
          </UpgradeAction>
        )}
        {operation.state === 'restarting' && (
          <span className="upgrade-stop-note flex flex-wrap items-center gap-2 text-muted">
            <UpgradeAction disabled><Icon name="stop" size={ICON_SIZE.badge} />Stop</UpgradeAction>
            Can't stop during the restart.
          </span>
        )}
        {needsFix && operation.error && <pre className="upgrade-error m-0 max-h-upgrade-error overflow-auto rounded-md border border-line bg-raised px-2 py-1.5 font-mono text-meta leading-normal wrap-anywhere whitespace-pre-wrap text-ink">{operation.error}</pre>}
        {needsFix && !restartOnly && (
          <UpgradeAction onClick={() => askTitan({ text: fixPrompt({ operation }) })}>
            <Icon name="fix" size={ICON_SIZE.inline} />Ask Titan to fix
          </UpgradeAction>
        )}
      </div>
    </OperationLine>
  )
}
