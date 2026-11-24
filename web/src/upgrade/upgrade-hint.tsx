import { useState } from 'react'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { clock } from '#web-titan/chat.ts'

export const checkedDay = ({ at }: { at: string }) => {
  const day = new Date(at).toDateString()

  return day === new Date().toDateString() ? 'today'
    : day === new Date(Date.now() - 86_400_000).toDateString() ? 'yesterday'
      : `on ${new Date(at).toLocaleDateString()}`
}

// The brand's hint that GitHub's main has a newer Othrys; Upgrade sends /upgrade to the open Titan.
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
      className="upgrade-hint shrink-0 [&_.popover-panel]:w-upgrade-menu [&_.tooltip-anchor]:items-center [&_.tooltip-anchor]:gap-1 [&>.button]:inline-flex [&>.button]:items-center [&>.button]:gap-1 [&>.button]:rounded-full [&>.button]:border [&>.button]:border-gold-line [&>.button]:bg-gold-wash [&>.button]:px-2 [&>.button]:py-px [&>.button]:font-sans [&>.button]:text-meta [&>.button]:font-medium [&>.button]:tracking-normal [&>.button]:whitespace-nowrap [&>.button]:text-gold max-phone:[&>.button]:p-0.75"
      trigger={<Tooltip content="Upgrade available"><Icon name="upgrade" size={ICON_SIZE.inline} /><span className="upgrade-hint-label max-phone:hidden">Upgrade</span></Tooltip>}
    >
      {({ close }) => (
        <div className="upgrade-popover grid gap-2 font-sans text-ui leading-detail tracking-normal [&_p]:m-0 [&_p]:text-muted [&_strong]:font-semibold">
          <strong>Upgrade available</strong>
          <p>
            Checked {checkedDay({ at: status.checkedAt })} at {clock({ at: status.checkedAt })}.
            {' '}Restarts the server; workers keep going and the page reconnects.
          </p>
          <div className="upgrade-actions flex justify-end gap-2">
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
