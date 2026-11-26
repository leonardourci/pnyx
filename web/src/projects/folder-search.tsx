import { FolderChoice, FolderDescription } from './folder-ui.tsx'
import { useId, useState } from 'react'
import type { FolderEntry } from '#projects/folders.ts'
import { Input } from '#web-shared/ui/controls.tsx'

export function FolderSearch({
  label,
  value,
  folders,
  disabled,
  onChange,
}: {
  label: string
  value: string
  folders: FolderEntry[]
  disabled: boolean
  onChange({ path }: { path: string }): void
}) {
  const id = useId()
  const [
      open,
      setOpen,
    ] = useState(false), [
      active,
      setActive,
    ] = useState(-1)

  const choose = ({ path }: { path: string }) => {
    onChange({ path }); setOpen(false); setActive(-1)
  }

  return (
    <div
      className="folder-search relative grid gap-1.5 text-meta"
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && !!folders.length}
        aria-controls={open && folders.length ? `${id}-options` : undefined}
        aria-activedescendant={open && folders[active] ? `${id}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="/path/to/folder"
        disabled={disabled}
        required
        onFocus={() => setOpen(true)}
        onChange={e => {
          onChange({ path: e.target.value }); setOpen(true); setActive(-1)
        }}
        onKeyDown={e => {
          if (e.key === 'Escape' && open) {
            e.preventDefault(); e.stopPropagation(); setOpen(false)
          } else if ([
            'ArrowDown',
            'ArrowUp',
          ].includes(e.key)) {
            e.preventDefault(); setOpen(true); setActive(n => Math.max(
              0,
              Math.min(
                folders.length - 1,
                n + (e.key === 'ArrowDown' ? 1 : -1),
              ),
            ))
          } else if (e.key === 'Enter' && open && folders[active]) {
            e.preventDefault(); choose({ path: folders[active].path })
          }
        }}
      />
      {open && !disabled && !!folders.length && (
        <div
          id={`${id}-options`}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="folder-options absolute top-full left-0 z-40 max-h-65 w-folder-options max-w-folder-viewport overflow-y-auto rounded-lg border border-line bg-surface p-1.25 shadow-menu"
        >
          {folders.map((
            folder,
            n,
          ) => (
            <FolderChoice
              key={folder.path}
              id={`${id}-${n}`}
              role="option"
              aria-selected={active === n}
              tabIndex={-1}
              className={active === n ? 'active bg-raised' : ''}
              retainFocus
              onPointerMove={() => setActive(n)}
              onClick={() => choose({ path: folder.path })}
            ><strong>{folder.name}</strong><FolderDescription>{folder.path}</FolderDescription>
            </FolderChoice>
          ))}
        </div>
      )}
    </div>
  )
}
