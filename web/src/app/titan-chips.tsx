import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEventHandler, type ReactNode } from 'react'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import type { TitanSummary } from '#app/server-titans.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { DisclosureChevron } from '#web-shared/ui/disclosure-chevron.tsx'
import { FloatingPanel } from '#web-shared/ui/floating-panel.tsx'
import { ContextMenu, menuPoint } from '#web-shared/ui/menu.tsx'
import { applyRuntimeStyle } from '#web-shared/ui/runtime-style.ts'
import { SortGroup } from '#web-shared/ui/sortable.tsx'
import { SortableChip } from '#web-shared/ui/sortable-chip.tsx'
import { WaitingCount } from '#web-shared/ui/waiting-count.tsx'
import { TitanLabel } from '#web-titan/titan-title.tsx'
import { titanTitle } from './view.ts'

const HOVER_OPEN_MS = 120
const HOVER_CLOSE_MS = 200
const PANEL_GAP = 6
const VIEWPORT_GAP = 8

export const titanWaiting = ({ titan }: { titan: TitanSummary }) =>
  titan.asks ?? titan.projects.reduce(
    (
      count,
      project,
    ) => count + project.asks,
    0,
  )

function TitanChip({
  titan,
  current,
  onClick,
  children,
}: {
  titan: TitanSummary
  current: boolean
  onClick: MouseEventHandler<HTMLButtonElement>
  children?: ReactNode
}) {
  return (
    <SortableChip
      item={{
        id: titan.id,
        kind: 'titan',
        scope: 'titans',
        titan: titan.id,
      }}
      variant="titan"
      aria-current={current ? 'page' : undefined}
      aria-haspopup={current ? 'menu' : undefined}
      onClick={onClick}
    >
      <TitanLabel name={titan.name} icon={titan.icon} size={ICON_SIZE.control} />
      <WaitingCount count={titanWaiting({ titan })} />
      {children}
    </SortableChip>
  )
}

function HoverProjects({
  titan,
  openProject,
  addProject,
  children,
}: {
  titan: TitanSummary
  openProject({
    titan,
    path,
  }: {
    titan: string
    path: string
  }): void
  addProject({ titan }: { titan: string }): void
  children: ReactNode
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [
    open,
    setOpen,
  ] = useState(false)

  const later = ({
    value,
    delay,
  }: {
    value: boolean
    delay: number
  }) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => setOpen(value),
      delay,
    )
  }

  useEffect(
    () => () => clearTimeout(timer.current),
    [],
  )

  useLayoutEffect(
    () => {
      const element = panel.current
      const chip = anchor.current?.querySelector('.titan-chip')?.getBoundingClientRect()

      if (!open || !element || !chip) {
        return
      }

      element.showPopover()
      applyRuntimeStyle({
        element,
        values: {
          left: Math.max(
            VIEWPORT_GAP,
            Math.min(
              chip.left,
              innerWidth - element.offsetWidth - VIEWPORT_GAP,
            ),
          ),
          top: chip.bottom + PANEL_GAP,
        },
      })
    },
    [open],
  )

  const choose = ({ action }: { action(): void }) => {
    clearTimeout(timer.current)
    setOpen(false)
    action()
  }

  return (
    <span
      ref={anchor}
      className="titan-hover contents"
      onPointerEnter={event => {
        if (event.pointerType === 'mouse') {
          later({
            value: true,
            delay: HOVER_OPEN_MS,
          })
        }
      }}
      onPointerLeave={() => later({
        value: false,
        delay: HOVER_CLOSE_MS,
      })}
    >
      {children}
      {open && (
        <FloatingPanel
          ref={panel}
          popover="manual"
          role="menu"
          aria-label={`${titanTitle(titan)} projects`}
          className="titan-projects-menu menu-items z-80 max-h-menu-height min-w-menu rounded-lg p-1"
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={() => later({
            value: false,
            delay: HOVER_CLOSE_MS,
          })}
        >
          <p className="px-2.5 pt-1 pb-1.5 text-meta font-semibold tracking-eyebrow text-muted uppercase">{titanTitle(titan)}</p>
          {titan.projects.map(project => (
            <Button
              key={project.path}
              role="menuitem"
              variant="menu-choice"
              className="w-full"
              onClick={() => choose({
                action: () => openProject({
                  titan: titan.id,
                  path: project.path,
                }),
              })}
            >
              <span>{project.name}</span>
              <div><WaitingCount count={project.asks} /></div>
            </Button>
          ))}
          <Button
            role="menuitem"
            variant="menu-choice"
            className="w-full text-gold"
            onClick={() => choose({ action: () => addProject({ titan: titan.id }) })}
          >
            <Icon name="plus" size={ICON_SIZE.inline} />
            <span>Add project</span>
          </Button>
        </FloatingPanel>
      )}
    </span>
  )
}

function ActiveTitan({
  titan,
  menu,
  projects,
}: {
  titan: TitanSummary
  menu: ReactNode
  projects: ReactNode
}) {
  const [
    at,
    setAt,
  ] = useState<{
    x: number
    y: number
  } | null>(null)

  return (
    <div className="active-titan flex min-w-0 flex-none items-center gap-1.25 rounded-full border border-gold-line py-0.5 pr-0.5 pl-0.5">
      <TitanChip
        titan={titan}
        current
        onClick={({ currentTarget }) => setAt(menuPoint({ event: { currentTarget } }))}
      >
        <DisclosureChevron expanded={!!at} />
      </TitanChip>
      {projects}
      {at && (
        <ContextMenu label={`${titanTitle(titan)} menu`} at={at} close={() => setAt(null)}>
          {menu}
        </ContextMenu>
      )}
    </div>
  )
}

export function TitanChips({
  titans,
  current,
  navigate,
  createTitan,
  menu,
  projects,
  openProject,
  addProject,
}: {
  titans: TitanSummary[]
  current: string
  navigate({ url }: { url: string }): Promise<void>
  createTitan(): unknown
  menu: ReactNode
  projects: ReactNode
  openProject({
    titan,
    path,
  }: {
    titan: string
    path: string
  }): void
  addProject({ titan }: { titan: string }): void
}) {
  return (
    <nav data-sort-surface={`titan-chips:${current}`} className="titan-chips flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden" aria-label="Titan navigation">
      <SortGroup id={`titan-chips:${current}`} items={titans.map(titan => titan.id)}>
        {titans.map((
          titan,
          index,
        ) => {
          const polis = titan.polis ?? 'shared'
          const previousPolis = titans[index - 1]?.polis ?? 'shared'
          const startsPolis = index > 0 && previousPolis !== polis
          const active = <ActiveTitan titan={titan} menu={menu} projects={projects} />
          const chip = titan.id === current ? active : (
            <HoverProjects titan={titan} openProject={openProject} addProject={addProject}>
              <TitanChip
                titan={titan}
                current={false}
                onClick={() => navigate({ url: `/titan/${encodeURIComponent(titan.id)}/` })}
              />
            </HoverProjects>
          )

          return (
            <Fragment key={titan.id}>
              {startsPolis && <span aria-hidden className="polis-gap w-2.5 flex-none" />}
              {chip}
            </Fragment>
          )
        })}
      </SortGroup>
      <IconButton
        label="New Titan"
        onClick={createTitan}
        icon="plus"
      />
    </nav>
  )
}
