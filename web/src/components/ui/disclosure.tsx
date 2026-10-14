import { useId, useState, type ReactNode } from 'react'
import { Button } from './controls.tsx'

export function Disclosure({ title, children, className = '' }: {
  title: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <details className={`disclosure ${className}`}>
      <summary>
        {title}
        <span className="disclosure-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}

// Long text shows its first lines until asked for the rest.
export function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false), id = useId()
  const long = text.length > 240 || text.split('\n').length > 4

  return (
    <div>
      <p id={id} className={!expanded && long ? 'text-preview' : undefined}>{text}</p>
      {long && (
        <Button aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Read more'}
        </Button>
      )}
    </div>
  )
}
