import { Keycap } from './keycap.tsx'
import { useState, type KeyboardEvent, type ComponentProps, type Ref } from 'react'
import { composing } from '#web-shared/ime.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { badgeKey } from './search-badges.ts'

export interface SearchBadge {
  id: string
  label: string
  // A badge's kind picks its color, as the Oracle colors scopes, kinds and columns apart.
  kind?: string
  icon?: string
}

interface SearchCombobox {
  expanded: boolean
  controls: string
  activeDescendant?: string
}

const BADGE_COLORS: Record<string, string> = {
  hydra: 'bg-gold-wash text-gold',
  ask: 'bg-gold-wash text-gold',
  section: 'bg-gold-wash text-gold',
  changed: 'bg-raised text-teal',
  kind: 'bg-raised text-slate',
  column: 'bg-raised text-blue',
  project: 'bg-raised text-teal',
  when: 'bg-raised text-purple',
}

export function SearchBadgeLabel({
  kind,
  className = '',
  ...props
}: ComponentProps<'span'> & { kind?: string }) {
  const color = BADGE_COLORS[kind ?? ''] ?? 'bg-raised text-ink'

  return <span {...props} data-kind={kind} className={`search-badge inline-flex h-6 items-center gap-1.25 rounded-md border border-transparent py-0 pr-1 pl-2 text-meta font-semibold whitespace-nowrap data-marked:border-red data-marked:ring-2 data-marked:ring-red/22 ${color} ${className}`} />
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
    <SearchBadgeLabel kind={badge.kind} data-marked={marked || undefined}>
      {badge.icon && <Icon name={badge.icon} size={ICON_SIZE.inline} />}
      {badge.label}
      <button
        type="button"
        className="search-badge-remove inline-flex size-4.5 items-center justify-center rounded-sm text-inherit opacity-60 hover:bg-hover hover:opacity-100"
        aria-label={`Remove ${badge.label}`}
        tabIndex={-1}
        onClick={remove}
      >
        <Icon name="close" size={ICON_SIZE.badge} />
      </button>
    </SearchBadgeLabel>
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
  combobox,
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
  combobox?: SearchCombobox
  onKeyDown?({ event }: { event: KeyboardEvent<HTMLInputElement> }): void
}) {
  const [
    marked,
    setMarked,
  ] = useState<number>()
  const markedId = marked === undefined ? undefined : badges[marked]?.id

  return (
    <div className="search-bar flex min-h-10.5 flex-wrap items-center gap-1.5 rounded-card border border-line bg-surface px-2.5 py-1.5 focus-within:border-gold-line focus-within:shadow-search-focus" role="search" aria-label={label}>
      <span className="search-bar-eye inline-flex flex-none text-gold"><Icon name="oracle" size={ICON_SIZE.heading} /></span>
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
        className="search-bar-input min-w-25 flex-search border-0 bg-transparent px-0.5 py-0.75 text-ui text-ink outline-0 placeholder:text-muted"
        aria-label={label}
        role={combobox ? 'combobox' : undefined}
        aria-expanded={combobox?.expanded}
        aria-controls={combobox?.controls}
        aria-activedescendant={combobox?.activeDescendant}
        aria-autocomplete={combobox ? 'list' : undefined}
        value={query}
        placeholder={placeholder}
        onChange={event => setQuery({ query: event.target.value })}
        onKeyDown={event => {
          if (composing({ event: event.nativeEvent })) {
            return
          }

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
      {count && <span className="search-bar-count text-meta whitespace-nowrap text-muted" aria-live="polite">{count}</span>}
      {hint && <Keycap className="search-bar-key px-1.25 py-0">{hint}</Keycap>}
    </div>
  )
}
