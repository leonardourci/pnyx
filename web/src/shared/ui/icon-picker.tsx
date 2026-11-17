import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'
import { Popover } from './popover.tsx'

export function IconPicker({
  value,
  choices,
  label,
  size = 16,
  pick,
}: {
  value: string
  choices: string[]
  label: string
  size?: number
  pick({ icon }: { icon: string }): void
}) {
  return (
    <Popover
      label={label}
      below
      className="icon-picker [&>.button]:min-h-0 [&>.button]:py-0.75 [&>.button]:px-1 [&_.popover-panel]:w-icon-menu [&_.popover-panel]:p-1.5"
      trigger={<Icon name={value} size={size} />}
    >
      {({ close }) => (
        <div className="icon-grid grid grid-cols-7 gap-1 [&>.button]:h-9 [&>.button]:min-h-0 [&>.button]:p-0 [&>.button]:border [&>.button]:border-transparent [&>.button[aria-selected=true]]:border-gold-line [&>.button[aria-selected=true]]:bg-gold-wash [&>.button[aria-selected=true]]:text-gold" role="listbox" aria-label={label}>
          {choices.map(icon => (
            <Button
              key={icon}
              role="option"
              aria-selected={icon === value}
              aria-label={icon}
              title={icon}
              onClick={() => {
                pick({ icon }); close()
              }}
            ><Icon name={icon} size={22} />
            </Button>
          ))}
        </div>
      )}
    </Popover>
  )
}
