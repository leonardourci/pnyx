import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import { hydraTitle } from '#web-app/view.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { IconPicker } from '#web-shared/ui/icon-picker.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { ContextMenu,menuPoint,opensMenu } from '#web-shared/ui/menu.tsx'
import { useCallback,useState,type ReactNode } from 'react'
import { HYDRA_ICONS,HydraNameEditor,type HydraIdentity } from './hydra-title.tsx'

export function HydraHead({
  name,
  icon = HYDRA_MARK,
  taken,
  editHydra,
  addProject,
  connected,
  children,
}: {
  name: string
  icon?: string
  taken: string[]
  editHydra?({
    name,
    icon,
  }: HydraIdentity): void
  addProject?(): void
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
  const canEdit = !!editHydra && connected

  const openMenu = ({ event }: { event: Parameters<typeof menuPoint>[0]['event'] & { preventDefault(): void } }) => {
    event.preventDefault(); setMenu(menuPoint({ event }))
  }

  return (
    <header
      className="hydra-head"
      onContextMenu={event => canEdit && openMenu({ event })}
      onKeyDown={event => canEdit && opensMenu({ event }) && openMenu({
        event: {
          preventDefault: () => event.preventDefault(),
          currentTarget: event.currentTarget,
        },
      })}
    >
      {editing && editHydra ? (
        <HydraNameEditor
          saved={{
            name,
            icon,
          }}
          taken={taken}
          iconSize={24}
          save={({
            name,
            icon,
          }) => {
            setEditing(false); editHydra({
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
              choices={HYDRA_ICONS}
              size={24}
              pick={({ icon }) => editHydra({
                name,
                icon,
              })}
            />
          ) : <Icon name={icon} size={24} />}
          <Button
            className="hydra-title"
            disabled={!canEdit}
            title="Click to edit"
            aria-label={`Edit ${hydraTitle({ name })}`}
            onClick={() => setEditing(true)}
          ><span className={name ? 'hydra-label' : 'hydra-label muted'}>{hydraTitle({ name })}</span>
          </Button>
        </>
      )}
      {children}
      {menu && (
        <ContextMenu label={`${hydraTitle({ name })} menu`} at={menu} close={closeMenu}>
          <Button onClick={() => setEditing(true)}>Edit</Button>
          {addProject && <Button onClick={addProject}>Add project</Button>}
        </ContextMenu>
      )}
    </header>
  )
}
