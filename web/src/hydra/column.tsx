import { Icon } from '../shared/ui/icon.tsx'
import { useRef, useState, type ReactNode } from 'react'
import type { HydraColumn, Card, Column as ColumnId, ViewPreferences } from '../../../src/core/model.ts'
import { LOCKED_DELETE } from '../../../src/core/hydra.ts'
import { DEFAULT_COLUMN_WIDTH, VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import { Button, Textarea } from '../shared/ui/controls.tsx'
import { InlineTitle } from '../shared/ui/inline-title.tsx'
import { CopyId } from '../shared/ui/copy-id.tsx'
import { DeleteItem, Menu } from '../shared/ui/menu.tsx'
import { Resize } from '../shared/ui/resize.tsx'
import type { Command } from '../app/connection.ts'
import { columnLook, dropBefore } from './view.ts'

export function Column({
  id,
  title,
  description,
  role,
  cards,
  view,
  save,
  children,
  command,
  notify,
  revision,
  connected,
  columnIds,
  locked,
  editingTitle,
  titleFinished,
  createTask,
}: HydraColumn & {
  cards: Card[]
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  children: ReactNode
  command: Command
  notify({ text }: { text: string }): void
  revision: number
  connected: boolean
  columnIds: ColumnId[]
  // A Firstmate-linked Hydra's default column, which cannot be deleted.
  locked: boolean
  editingTitle: boolean
  titleFinished(): void
  createTask({
    column,
    parent,
  }: {
    column: string
    parent?: string
  }): void
}) {
  const descriptionVersion = useRef(0)
  const [
    width,
    setWidth,
  ] = useState<number | null>(null)
  const [
    rename,
    setRename,
  ] = useState(false)
  const [
      describing,
      setDescribing,
    ] = useState(false), [
      draft,
      setDraft,
    ] = useState('')
  const edit = ({ args }: { args: string[] }) => command({
    name: 'column',
    args: [
      ...args,
      '--if-revision',
      String(revision),
      '--event-id',
      crypto.randomUUID(),
    ],
  })
  const report = ({ error }: { error: Error }) => notify({ text: error.message })
  const size = view.columnWidths[id] ?? view.defaultColumnWidths[id] ?? DEFAULT_COLUMN_WIDTH

  return (
    <section
      data-column={id}
      className={`column column-${role ?? id}`}
      aria-label={title}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault()
        const source = e.dataTransfer.getData('application/pnyx-column')
        const task = e.dataTransfer.getData('application/pnyx-task')

        if (source && source !== id) {
          const target = columnIds.indexOf(id)
          const before = columnIds.indexOf(source as ColumnId) < target ? columnIds[target + 1] : id
          void edit({
            args: [
              'reorder',
              source,
              ...(before ? [
                '--before',
                before,
              ] : []),
            ],
          }).catch(error => report({ error }))
        } else if (task) {
          const over = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-task]') : null
          const rect = over?.getBoundingClientRect()
          const before = dropBefore({
            cards,
            over: over?.dataset.task,
            below: !!rect && e.clientY > rect.top + rect.height / 2,
          })

          if (before !== task) {
            void command({
              name: 'move',
              args: [
                task,
                id,
                ...(before ? [
                  '--before',
                  before,
                ] : []),
                '--event-id',
                crypto.randomUUID(),
              ],
            }).catch(error => report({ error }))
          }
        }
      }}
      style={{
        width: width ?? size,
        flexBasis: width ?? size,
        minWidth: VIEW_SIZE_LIMITS.columnWidth.min,
      }}
    >
      <header
        className="column-header"
        draggable={connected && !describing && !rename && !editingTitle}
        onDragStart={e => {
          if ((e.target as Element).closest('button, input, textarea')) {
            e.preventDefault()

            return
          }

          e.dataTransfer.setData(
            'application/pnyx-column',
            id,
          )
        }}
      >
        <h2
          title={description || undefined}
          data-column-heading={id}
          data-key-scope="hydra"
          tabIndex={0}
        >
          <Icon
            name={columnLook({
              column: {
                id,
                role,
              },
            }).icon}
          />
          <InlineTitle
            value={title}
            label={`Rename ${title} column`}
            doubleClick
            startEditing={editingTitle || rename}
            finished={() => {
              setRename(false); titleFinished()
            }}
            save={({ title }) => edit({
              args: [
                'rename',
                id,
                `--title=${title}`,
              ],
            }).then(() => {
              setRename(false); titleFinished()
            })}
          />
        </h2>
        <span className="count">{cards.length}</span>
        <Button
          className="column-add"
          aria-label={`New task in ${title}`}
          disabled={!connected}
          onClick={() => createTask({ column: id })}
        ><Icon name="plus" />
        </Button>
        <Menu label={`${title} column menu`}>
          <CopyId id={id} notify={notify} />
          <Button disabled={!connected} onClick={() => setRename(true)}>Rename</Button>
          <Button
            disabled={!connected}
            onClick={() => {
              descriptionVersion.current++
              setDraft(description ?? ''); setDescribing(true)
            }}
          >Edit description
          </Button>
          <DeleteItem
            label="Delete column"
            disabled={!connected || columnIds.length === 1}
            {...(locked ? { refusal: LOCKED_DELETE } : {})}
            confirm={() => edit({
              args: [
                'delete',
                id,
              ],
            }).catch(error => report({ error }))}
          />
        </Menu>
      </header>
      {describing && (
        <form
          className="column-description"
          onSubmit={e => {
            e.preventDefault()
            const version = ++descriptionVersion.current
            setDescribing(false)
            void edit({
              args: [
                'describe',
                id,
                '--description',
                draft,
              ],
            }).catch((error: Error) => {
              if (descriptionVersion.current === version) {
                setDescribing(true)
              }

              report({ error })
            })
          }}
        >
          <Textarea
            aria-label={`${title} description`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            autoFocus
          />
          <div className="row"><Button type="submit">Save description</Button><Button onClick={() => setDescribing(false)}>Cancel</Button></div>
        </form>
      )}
      <div className="column-cards">
        {children}
        {cards.length === 0 && (
          <p
            className="empty"
            data-empty-column={id}
            data-key-scope="hydra"
            aria-label={`${title}: no cards`}
            tabIndex={0}
          >No tasks here
          </p>
        )}
      </div>
      <Resize
        label={`Resize ${title} column`}
        value={size}
        min={VIEW_SIZE_LIMITS.columnWidth.min}
        onPreview={({ value }) => setWidth(value)}
        onCommit={({ value }) => save({ patch: { columnWidths: { [id]: value } } }).then(saved => {
          setWidth(null)

          return saved
        })}
      />
    </section>
  )
}
