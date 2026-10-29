import { useState, type KeyboardEvent, type Ref } from 'react'
import { Icon } from './icon.tsx'
import { badgeKey } from './search-badges.ts'

export interface SearchBadge {
  id: string
  label: string
  // A badge's kind picks its color, as the Oracle colors scopes, kinds and columns apart.
  kind?: string
}

function Badge({
  badge,
  marked,
  remove,
}: {
  badge: SearchBadge
  marked: boolean
  remove(): void
}) {
  return (
    <span className="search-badge" data-kind={badge.kind} data-marked={marked || undefined}>
      {badge.label}
      <button
        type="button"
        className="search-badge-remove"
        aria-label={`Remove ${badge.label}`}
        tabIndex={-1}
        onClick={remove}
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}

// The Oracle's eye, filter badges inside the field, the query and a result count; Settings and the Oracle share it.
export function SearchBar({
  label,
  query,
  setQuery,
  badges = [],
  removeBadge,
  count,
  hint,
  placeholder,
  inputRef,
  onKeyDown,
}: {
  label: string
  query: string
  setQuery({ query }: { query: string }): void
  badges?: SearchBadge[]
  removeBadge?({ id }: { id: string }): void
  count?: string
  // The key that focuses this search, shown while it is empty.
  hint?: string
  placeholder?: string
  inputRef?: Ref<HTMLInputElement>
  onKeyDown?({ event }: { event: KeyboardEvent<HTMLInputElement> }): void
}) {
  const [
    marked,
    setMarked,
  ] = useState<number>()
  const markedId = marked === undefined ? undefined : badges[marked]?.id

  return (
    <div className="search-bar" role="search" aria-label={label}>
      <span className="search-bar-eye"><Icon name="oracle" size={20} /></span>
      {badges.map(badge => (
        <Badge
          key={badge.id}
          badge={badge}
          marked={badge.id === markedId}
          remove={() => removeBadge?.({ id: badge.id })}
        />
      ))}
      <input
        ref={inputRef}
        className="search-bar-input"
        aria-label={label}
        value={query}
        placeholder={placeholder}
        onChange={event => setQuery({ query: event.target.value })}
        onKeyDown={event => {
          const field = event.currentTarget
          const result = badgeKey({
            key: event.key,
            marked,
            count: badges.length,
            atStart: field.selectionStart === 0 && field.selectionEnd === 0,
          })

          if (!result.handled) {
            setMarked(undefined)
            onKeyDown?.({ event })

            return
          }

          event.preventDefault()
          setMarked(result.marked)

          if (result.remove !== undefined) {
            removeBadge?.({ id: badges[result.remove]!.id })
          }
        }}
        onBlur={() => setMarked(undefined)}
      />
      {count && <span className="search-bar-count" aria-live="polite">{count}</span>}
      {hint && <kbd className="search-bar-key">{hint}</kbd>}
    </div>
  )
}
