import { Icon } from './icon.tsx'
import { Button } from './controls.tsx'

export function CopyId({
  id,
  notify,
  icon = false,
}: {
  id: string
  icon?: boolean
  notify({ text }: { text: string }): void
}) {
  return (
    <Button
      aria-label={icon ? 'Copy ID' : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id)
          notify({ text: 'ID copied' })
        } catch {
          notify({ text: 'Could not copy ID' })
        }
      }}
    >{icon ? <Icon name="copy" size={15} /> : 'Copy ID'}
    </Button>
  )
}
