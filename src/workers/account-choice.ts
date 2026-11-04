import { HydraError } from '#store/errors.ts'
import type { Account, EffectiveDispatch, Harness } from './dispatch-config.ts'
import type { DispatchDocument } from './dispatch-check.ts'

export const ACCOUNT_LABEL_MAX = 80
export const LINE_BREAK = /[\r\n\0]/

// A login home is an absolute path or one under ~/, on one line.
export function homeFolderValid({ folder }: { folder: string }): boolean {
  const rooted = folder.startsWith('/') || folder.startsWith('~/')

  return rooted && !LINE_BREAK.test(folder)
}

export function accountRegistration({
  effective,
  name,
  account,
}: {
  effective: EffectiveDispatch
  name: string
  account: Account
}): Partial<DispatchDocument> {
  const patch: Partial<DispatchDocument> = { accounts: { [name]: account } }

  if (effective.fallback) {
    patch.accounts = {
      ...effective.accounts,
      ...patch.accounts,
    }
    patch.workers = effective.dispatch.workers

    if (effective.dispatch.main) {
      patch.main = effective.dispatch.main
    }
  }

  return patch
}

export const accountLabel = ({
  name,
  account,
}: {
  name: string
  account?: Account
}) => typeof account?.label === 'string' && account.label.trim() ? account.label : name

// The account a harness runs under: the one asked for, which must be registered for it, else the main one, else the first for that harness.
export function harnessAccount({
  effective,
  harness,
  prefer,
}: {
  effective: EffectiveDispatch
  harness: Harness
  prefer?: string
}): string | undefined {
  const ours = ({ name }: { name?: string }) =>
    !!name && effective.accounts[name]?.provider === harness

  if (prefer && !ours({ name: prefer })) {
    throw new HydraError({
      code: 'NO_ACCOUNTS',
      message: `account ${prefer} is not registered for ${harness}`,
    })
  }

  return [
    prefer,
    effective.dispatch.main,
  ].find(name => ours({ name }))
    ?? Object.keys(effective.accounts).find(name => ours({ name }))
}
