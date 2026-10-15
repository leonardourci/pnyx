import { useId, useState } from 'react'
import type { Folder } from '../../../../src/projects/folders.ts'
import { Button, Input } from './controls.tsx'

export function FolderSearch({ label, value, folders, disabled, onChange }: {
  label: string
  value: string
  folders: Folder[]
  disabled: boolean
  onChange({ path }: { path: string }): void
}) {
  const id = useId()
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1)

  const choose = ({ path }: { path: string }) => {
    onChange({ path }); setOpen(false); setActive(-1)
  }

  return (
    <div
      className="folder-search"
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
          } else if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault(); setOpen(true); setActive(n => Math.max(0, Math.min(folders.length - 1, n + (e.key === 'ArrowDown' ? 1 : -1))))
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
          className="folder-options"
        >
          {folders.map((folder, n) => (
            <Button
              key={folder.path}
              id={`${id}-${n}`}
              role="option"
              aria-selected={active === n}
              tabIndex={-1}
              className={active === n ? 'active' : ''}
              onPointerDown={e => e.preventDefault()}
              onPointerMove={() => setActive(n)}
              onClick={() => choose({ path: folder.path })}
            ><strong>{folder.name}</strong><small>{folder.path}</small>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
