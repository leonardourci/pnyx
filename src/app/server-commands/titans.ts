import { TitanError } from '#store/errors.ts'
import { createTitan, editTitan, listTitans } from '#app/server-titans.ts'
import type { CommandRequest } from './dispatch.ts'

export async function titansCommand({
  ws,
  id,
  args,
  fail,
  send,
  titanId,
  url,
  open,
}: CommandRequest & {
  titanId: string
  url: string
  open({ id }: { id: string }): Promise<string>
}) {
  const [
    action,
    first,
    second,
    third,
  ] = args
  const reply = ({
    open,
    creation,
    listed = false,
  }: {
    open?: string
    creation?: {
      attempt: string
      titanId: string
      status: 'saved'
      mount: 'pending'
    }
    listed?: boolean
  } = {}) => send({
    ws,
    message: {
      type: 'receipt',
      id,
      titanId,
      titans: listed || creation ? listTitans() : undefined,
      ...(open ? { url: open } : {}),
      ...(creation ? { creation } : {}),
    },
  })

  if (action === 'create') {
    if (args.length > 4 || (second !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(second))) {
      throw new TitanError({
        message: 'Invalid Titan creation attempt',
        code: 'VALIDATION_ERROR',
      })
    }

    const created = await createTitan({
      name: first?.trim().slice(
        0,
        100,
      ) ?? '',
      icon: third || undefined,
      attempt: second,
    })
    const opening = open({ id: created })

    if (second) {
      reply({
        open: new URL(
          `/titan/${created}/`,
          url,
        ).href,
        creation: {
          attempt: second,
          titanId: created,
          status: 'saved',
          mount: 'pending',
        },
      })
      void opening.catch(() => {})
    } else {
      void opening.then(
        open => reply({ open }),
        (error: Error) => fail({
          error: error.message,
          code: error instanceof TitanError ? error.code : 'UNKNOWN',
        }),
      )
    }
  } else if (action === 'open' && first) {
    void open({ id: first }).then(
      open => reply({ open }),
      (error: Error) => fail({
        error: error.message,
        code: error instanceof TitanError ? error.code : 'UNKNOWN',
      }),
    )
  } else if (action === 'edit' && first && (second?.trim() || third) && listTitans().some(b => b.id === first)) {
    await editTitan({
      id: first,
      name: second?.trim().slice(
        0,
        100,
      ),
      icon: third || undefined,
    })
    reply()
  } else if (action === 'move' && first && second && listTitans().some(b => b.id === first)) {
    await editTitan({
      id: first,
      position: Number(second),
    })
    reply()
  } else if (action === undefined) {
    reply({ listed: true })
  } else {
    throw new TitanError({
      message: 'Titans expects nothing, open <id>, create <name> [<attempt> <icon>], edit <id> <name> [<icon>] or move <id> <position>',
      code: 'VALIDATION_ERROR',
    })
  }
}
