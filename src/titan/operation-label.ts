import type { TitanOperation } from './model.ts'

const LABELS: Record<TitanOperation['kind'], {
  done: string
  failed: string
}> = {
  restart: {
    done: 'Restarted',
    failed: 'Restart failed',
  },
  upgrade: {
    done: 'Upgraded',
    failed: 'Upgrade failed',
  },
  compaction: {
    done: 'Compacted',
    failed: 'Compaction failed',
  },
  inscribe: {
    done: 'Inscribed',
    failed: 'Inscribe failed',
  },
}

// The words the chat's divider shows when an operation that stopped Titan ends.
export const operationLabel = ({
  kind,
  state,
  inscribed = false,
}: Pick<TitanOperation, 'kind' | 'state'> & { inscribed?: boolean }) => {
  if (state === 'failed') {
    return LABELS[kind].failed
  }

  return kind === 'compaction' && inscribed ? 'Inscribed and compacted' : LABELS[kind].done
}
