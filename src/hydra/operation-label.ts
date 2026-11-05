import type { HydraOperation } from './model.ts'

const LABELS: Record<HydraOperation['kind'], {
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

// The words the chat's divider shows when an operation that stopped Hydra ends.
export const operationLabel = ({
  kind,
  state,
}: Pick<HydraOperation, 'kind' | 'state'>) => state === 'failed' ? LABELS[kind].failed : LABELS[kind].done
