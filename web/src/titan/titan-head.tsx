import { TITAN_MARK } from '#titan/titan-names.ts'
import { titanTitle } from '#web-app/view.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { IconPicker } from '#web-shared/ui/icon-picker.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { ContextMenu,menuPoint,opensMenu } from '#web-shared/ui/menu.tsx'
import { useCallback,useState,type ReactNode } from 'react'
import { TITAN_ICONS,TitanNameEditor,type TitanIdentity } from './titan-title.tsx'

export function TitanHead({
  name,
  icon = TITAN_MARK,
  taken,
  editTitan,
  connected,
  children,
}: {
  name: string
  icon?: string
  taken: string[]
  editTitan?({
    name,
    icon,
  }: TitanIdentity): void
  connected: boolean
  children: ReactNode
}) {
  const [
    editing,
    setEditing,
  ] = useState(false)
  const [
    menu,
    setMenu,
  ] = useState<{
    x: number
    y: number
  } | null>(null)
  const closeMenu = useCallback(
    () => setMenu(null),
    [],
  )
  const canEdit = !!editTitan && connected

  const openMenu = ({ event }: { event: Parameters<typeof menuPoint>[0]['event'] & { preventDefault(): void } }) => {
    event.preventDefault(); setMenu(menuPoint({ event }))
  }

  return (
    <header
      className="titan-head max-phone:hidden max-phone:has-[.titan-status]:flex font-brand font-bold flex items-center justify-start gap-2 py-2.5 px-3.5 border-b border-line shrink-0 text-pane [&_strong]:min-w-0 [&_strong]:truncate [&_strong]:[font-weight:inherit] [&_.titan-name-editor]:flex-1 [&_.titan-name-editor]:max-w-90 [&_.titan-name-field_.input]:text-ui"
      onContextMenu={event => canEdit && openMenu({ event })}
      onKeyDown={event => canEdit && opensMenu({ event }) && openMenu({
        event: {
          preventDefault: () => event.preventDefault(),
          currentTarget: event.currentTarget,
        },
      })}
    >
      {editing && editTitan ? (
        <TitanNameEditor
          saved={{
            name,
            icon,
          }}
          taken={taken}
          iconSize={ICON_SIZE.brand}
          save={({
            name,
            icon,
          }) => {
            setEditing(false); editTitan({
              name,
              icon,
            })
          }}
          cancel={() => setEditing(false)}
        />
      ) : (
        <>
          {canEdit ? (
            <IconPicker
              label="Change icon"
              value={icon}
              choices={TITAN_ICONS}
              size={ICON_SIZE.brand}
              pick={({ icon }) => editTitan({
                name,
                icon,
              })}
            />
          ) : <Icon name={icon} size={ICON_SIZE.brand} />}
          <Button
            className="titan-title min-w-0 min-h-0 py-0.5 px-1.5 -ml-1.5 justify-start text-[length:inherit]"
            disabled={!canEdit}
            title="Click to edit"
            aria-label={`Edit ${titanTitle({ name })}`}
            onClick={() => setEditing(true)}
          ><span className={name ? 'titan-label' : 'titan-label muted'}>{titanTitle({ name })}</span>
          </Button>
        </>
      )}
      {children}
      {menu && (
        <ContextMenu label={`${titanTitle({ name })} menu`} at={menu} close={closeMenu}>
          <Button onClick={() => setEditing(true)}>Edit</Button>
        </ContextMenu>
      )}
    </header>
  )
}
