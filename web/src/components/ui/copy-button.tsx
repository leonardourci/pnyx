import { useEffect, useState } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'

export function CopyButton({
  label,
  text,
  className = '',
}: {
  label: string
  text(): string
  className?: string
}) {
  const [
    result,
    setResult,
  ] = useState<'copied' | 'failed' | null>(null)
  useEffect(
    () => {
      if (!result) {
        return
      }

      const timer = setTimeout(
        () => setResult(null),
        1500,
      )

      return () => clearTimeout(timer)
    },
    [result],
  )
  const title = result === 'copied' ? 'Copied' : result === 'failed' ? 'Could not copy' : label

  return (
    <Button
      className={`icon-button copy-button ${className}`}
      aria-label={title}
      title={title}
      data-copied={result === 'copied' || undefined}
      contentEditable={false}
      onMouseDown={event => event.preventDefault()}
      onClick={() => void navigator.clipboard.writeText(text()).then(
        () => setResult('copied'),
        () => setResult('failed'),
      )}
    >
      <Icon name={result === 'copied' ? 'check' : 'copy'} size={14} />
    </Button>
  )
}
