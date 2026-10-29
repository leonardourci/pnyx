import { Button } from '#web-shared/ui/controls.tsx'
import type { NativeStatus } from '#app/native-status.ts'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import type { ReactNode } from 'react'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { UpgradeHint } from '#web-upgrade/upgrade-hint.tsx'

export function Panel({
  shown,
  connected,
  upgrade,
  native,
  startUpgrade,
  page,
  navigate,
  oracle,
  children,
}: {
  shown: boolean
  connected: boolean
  upgrade?: UpgradeStatus
  native?: NativeStatus
  startUpgrade(): void
  page: string
  navigate({ page }: { page: string }): void
  oracle: ReactNode
  children: ReactNode
}) {
  const settings = page === 'settings'

  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><Icon name="pnyx" size={24} /><span>pnyx</span>{!connected && <span className="offline" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
      {connected && native && <NativeReadiness status={native} />}
      {oracle}
      <nav aria-label="Main pages">
        <Button aria-pressed={settings} onClick={() => navigate({ page: settings ? 'hydra' : 'settings' })}><Icon name="settings" />Settings</Button>
      </nav>
      {children}
    </aside>
  )
}

function NativeReadiness({ status }: { status: NativeStatus }) {
  if (status.state === 'ready') {
    return null
  }

  const title = status.state === 'draining' ? 'Agent maintenance pending' : status.state === 'unavailable' ? 'Agent host unavailable' : 'Agent recovery needs attention'
  const text = status.state === 'draining'
    ? 'Existing work can finish. New work waits. Answers and interrupts remain available.'
    : 'Keep saved work in place while native ownership is checked.'

  return (
    <div className="native-status" role="status" data-native-status={status.state}>
      <strong>{title}</strong>
      <p>{text}</p>
      {status.reasons.length > 0 && (
        <Disclosure title="What is blocking">
          <ul>{status.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        </Disclosure>
      )}
    </div>
  )
}
