import { STEP_WORDS, type UpgradeOperation, type UpgradeStepName } from '../../../src/upgrade/model.ts'
import { useElapsed } from '../compaction/compaction.tsx'
import { Button } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { fixPrompt, stoppedWhile } from './fix-prompt.ts'

const STEPS: UpgradeStepName[] = [
  'pull',
  'install',
  'build',
  'restart',
]

// Every step while it runs, so the ones still to come show too; only the steps that ran once it stopped.
function Steps({ operation }: { operation: UpgradeOperation }) {
  const active = operation.state === 'running' || operation.state === 'restarting'
  const shown = active ? STEPS : operation.steps.map(step => step.step)

  return (
    <ol className="upgrade-steps">
      {shown.map(name => {
        const step = operation.steps.find(item => item.step === name)
        const [
          todo,
          doing,
          done,
        ] = STEP_WORDS[name]

        return (
          <li key={name} data-state={step?.state ?? 'todo'}>
            {step?.state === 'done' ? <>{done}<Icon name="check" size={12} /></>
              : step?.state === 'running' ? `${doing}…`
                : step?.state === 'failed' ? <>{doing} failed<Icon name="error" size={12} /></>
                  : step?.state === 'stopped' ? `${doing} stopped`
                    : todo}
          </li>
        )
      })}
    </ol>
  )
}

// The chat row Pnyx draws for an /upgrade, from its first step to the restarted server.
export function UpgradeRow({
  operation,
  askHydra,
  stop,
}: {
  operation: UpgradeOperation
  askHydra({ text }: { text: string }): void
  stop(): Promise<void>
}) {
  const active = operation.state === 'running' || operation.state === 'restarting'
  const elapsed = useElapsed({
    startedAt: operation.startedAt ?? operation.queuedAt,
    endedAt: operation.endedAt,
    running: active,
  })
  const brokenBack = operation.rolledBack === false
  const needsFix = operation.state === 'failed' || operation.state === 'refused' || (operation.state === 'stopped' && brokenBack)
  const [
    title,
    detail,
  ] = active ? [`Upgrading Pnyx… ${elapsed}`]
    : operation.state === 'done' ? [`Upgraded · ${elapsed}`]
      : operation.state === 'current' ? ['Pnyx is already up to date']
        : operation.state === 'stopped' ? brokenBack ? [
          'Upgrade stopped.',
          'Going back to the previous version failed, so the Pnyx folder may be partly upgraded.',
        ] : ['Upgrade stopped; nothing changed.']
          : operation.state === 'refused' ? [
            'Upgrade not started.',
            `The Pnyx folder in ${operation.folder} isn't ready. Nothing was stashed or changed.`,
          ]
            : [
              `Upgrade failed while ${stoppedWhile({ operation })}.`,
              operation.rolledBack === false
                ? 'Going back to the previous version failed too, so the Pnyx folder may be partly upgraded.'
                : 'Went back to the previous version; nothing changed.',
            ]

  return (
    <div className="compaction-row upgrade-row" data-state={needsFix ? 'failed' : operation.state} role={active ? 'status' : undefined}>
      <Icon name={active ? 'upgrade' : needsFix ? 'error' : operation.state === 'stopped' ? 'stop' : 'check'} size={14} />
      <div className="upgrade-body">
        <span className="upgrade-title">{title}</span>
        {detail && <span className="upgrade-detail">{detail}</span>}
        {operation.state === 'refused' ? (
          <ul className="upgrade-reasons">
            {operation.reasons?.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
        ) : operation.steps.length > 0 && operation.state !== 'current' && <Steps operation={operation} />}
        {operation.state === 'running' && (
          <Button variant="surface" className="upgrade-fix" onClick={() => void stop()}>
            <Icon name="stop" size={12} />Stop
          </Button>
        )}
        {operation.state === 'restarting' && (
          <span className="upgrade-stop-note">
            <Button variant="surface" className="upgrade-fix" disabled><Icon name="stop" size={12} />Stop</Button>
            Restarting; this can't be stopped now.
          </span>
        )}
        {needsFix && operation.error && <pre className="upgrade-error">{operation.error}</pre>}
        {needsFix && (
          <Button variant="surface" className="upgrade-fix" onClick={() => askHydra({ text: fixPrompt({ operation }) })}>
            <Icon name="fix" size={14} />Ask Hydra to fix
          </Button>
        )}
      </div>
    </div>
  )
}
