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
      className="icon-picker"
      trigger={<Icon name={value} size={size} />}
    >
      {({ close }) => (
        <div className="icon-grid" role="listbox" aria-label={label}>
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
