import { HydraError } from '#store/errors.ts'
import { createHydra, editHydra, listHydras } from '#app/server-hydras.ts'
import type { CommandRequest } from './dispatch.ts'

// `hydras [open|create|edit|move ...]`: the Hydra list, as it is now; the page follows it through Zero.
export function hydrasCommand({
  ws,
  id,
  args,
  fail,
  send,
  hydraId,
  url,
  open,
}: CommandRequest & {
  hydraId: string
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
  }: {
    open?: string
    creation?: {
      attempt: string
      hydraId: string
      status: 'saved'
      mount: 'pending'
    }
  } = {}) => send({
    ws,
    message: {
      type: 'receipt',
      id,
      hydraId,
      hydras: listHydras(),
      ...(open ? { url: open } : {}),
      ...(creation ? { creation } : {}),
    },
  })

  if (action === 'create') {
    if (args.length > 4 || (second !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(second))) {
      throw new HydraError({
        message: 'Invalid Hydra creation attempt',
        code: 'VALIDATION_ERROR',
      })
    }

    const created = createHydra({
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
          `/hydra/${created}/`,
          url,
        ).href,
        creation: {
          attempt: second,
          hydraId: created,
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
          code: error instanceof HydraError ? error.code : 'UNKNOWN',
        }),
      )
    }
  } else if (action === 'open' && first) {
    void open({ id: first }).then(
      open => reply({ open }),
      (error: Error) => fail({
        error: error.message,
        code: error instanceof HydraError ? error.code : 'UNKNOWN',
      }),
    )
  } else if (action === 'edit' && first && (second?.trim() || third) && listHydras().some(b => b.id === first)) {
    editHydra({
      id: first,
      name: second?.trim().slice(
        0,
        100,
      ),
      icon: third || undefined,
    })
    reply()
  } else if (action === 'move' && first && second && listHydras().some(b => b.id === first)) {
    editHydra({
      id: first,
      position: Number(second),
    })
    reply()
  } else if (action === undefined) {
    reply()
  } else {
    throw new HydraError({
      message: 'Hydras expects nothing, open <id>, create <name> [<attempt> <icon>], edit <id> <name> [<icon>] or move <id> <position>',
      code: 'VALIDATION_ERROR',
    })
  }
}
