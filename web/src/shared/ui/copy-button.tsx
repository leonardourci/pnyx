import { useEffect, useState } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'

const RESULTS = {
  copied: 'Copied',
  failed: 'Could not copy',
}

export function CopyButton({
  label,
  className = '',
  ...copied
}: {
  label: string
  className?: string
} & ({ text(): string } | { write(): Promise<void> })) {
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
  const title = (result && RESULTS[result]) || label

  return (
    <Button
      className={`icon-button copy-button ${className}`}
      aria-label={title}
      title={title}
      data-copied={result === 'copied' || undefined}
      contentEditable={false}
      onMouseDown={event => event.preventDefault()}
      onClick={event => {
        // Inside a summary, a click would also fold the row.
        event.preventDefault()
        const writing = 'write' in copied ? copied.write() : navigator.clipboard.writeText(copied.text())
        void writing.then(
          () => setResult('copied'),
          () => setResult('failed'),
        )
      }}
    >
      <Icon name={result === 'copied' ? 'check' : 'copy'} size={14} />
    </Button>
  )
}
