import { useState } from 'react'
import type { UpgradeStatus } from '../../../src/upgrade/model.ts'
import { Button } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Popover } from '../components/ui/popover.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { clock } from '../hydra/chat.ts'

const checkedDay = ({ at }: { at: string }) => {
  const day = new Date(at).toDateString()

  return day === new Date().toDateString() ? 'today'
    : day === new Date(Date.now() - 86_400_000).toDateString() ? 'yesterday'
      : `on ${new Date(at).toLocaleDateString()}`
}

// The brand's hint that GitHub's main has a newer Pnyx; Upgrade sends /upgrade to the open Hydra.
export function UpgradeHint({
  status,
  upgrade,
}: {
  status?: UpgradeStatus
  upgrade(): void
}) {
  const [
    later,
    setLater,
  ] = useState<string>()

  if (!status?.available || later === status.checkedAt) {
    return null
  }

  // The pill keeps a short label so it fits the brand row; the full label is its tooltip.
  return (
    <Popover
      below
      label="Upgrade available"
      className="upgrade-hint"
      trigger={<Tooltip content="Upgrade available"><Icon name="upgrade" size={14} /><span className="upgrade-hint-label">Upgrade</span></Tooltip>}
    >
      {({ close }) => (
        <div className="upgrade-popover">
          <strong>Upgrade available</strong>
          <p>
            Checked {checkedDay({ at: status.checkedAt })} at {clock({ at: status.checkedAt })}.
            {' '}Restarts the server; workers keep going and the page reconnects.
          </p>
          <div className="upgrade-actions">
            <Button
              onClick={() => {
                setLater(status.checkedAt); close()
              }}
            >Later
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                close(); upgrade()
              }}
            >Upgrade
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
}
