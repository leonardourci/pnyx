import { ICON_SIZE } from '#web-shared/icons.tsx'
import { useEffect, useState } from 'react'
import { IconButton } from './icon-button.tsx'

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
    <IconButton
      className={`copy-button data-copied:text-green ${className}`}
      label={title}
      icon={result === 'copied' ? 'check' : 'copy'}
      iconSize={ICON_SIZE.inline}
      size="copy"
      title={title}
      data-copied={result === 'copied' || undefined}
      contentEditable={false}
      // eslint-disable-next-line othrys/object-params -- React owns the button event signature.
      onMouseDown={event => event.preventDefault()}
      // eslint-disable-next-line othrys/object-params -- React owns the button event signature.
      onClick={async event => {
        // Inside a summary, a click would also fold the row.
        event.preventDefault()
        const writing = 'write' in copied ? copied.write() : navigator.clipboard.writeText(copied.text())

        try {
          await writing
          setResult('copied')
        } catch {
          setResult('failed')
        }
      }}
    />
  )
}
