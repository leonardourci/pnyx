import { Button } from './controls.tsx'

export function CopyId({ id, notify }: { id: string; notify({ text }: { text: string }): void }) {
  return (
    <Button
      onClick={() => void navigator.clipboard.writeText(id).then(() => notify({ text: 'ID copied' }))
        .catch(() => notify({ text: 'Could not copy ID' }))}
    >Copy ID
    </Button>
  )
}
