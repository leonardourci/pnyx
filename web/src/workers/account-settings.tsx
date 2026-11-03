import { useEffect, useId, useRef, useState } from 'react'
import type { Account, Harness } from '#workers/dispatch-config.ts'
import { ACCOUNT_LABEL_MAX, accountLabel, accountRegistration, homeFolderValid, LINE_BREAK } from '#workers/account-choice.ts'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { Button, Input, Select } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SettingRow } from '#web-shared/ui/setting-row.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { PROVIDERS } from './account-model-picker.tsx'
import { DISPATCH_CHANGED, showingAfter, useDispatchDocument, useHeadsDispatch } from './heads-dispatch.ts'

interface Draft {
  id: string
  key?: string
  provider: Harness
  label: string
  folder: string
}

export function AccountSettings({
  command,
  initialProvider,
}: {
  command: Command
  initialProvider?: Harness
}) {
  const {
    snapshot,
    resource,
  } = useDispatchDocument({ command })
  const { effective } = useHeadsDispatch({ command })
  const [
    draft,
    setDraft,
  ] = useState<Draft | undefined>(() => initialProvider ? {
    id: crypto.randomUUID(),
    provider: initialProvider,
    label: '',
    folder: '',
  } : undefined)
  const [
    failure,
    setFailure,
  ] = useState<{
    message: string
    field: 'label' | 'folder' | 'form'
    draft: string
  }>()
  const form = useRef<HTMLFormElement>(null)
  const errorId = useId()
  const visibleFailure = failure?.draft === draft?.id ? failure : undefined

  useEffect(
    () => {
      // A refusal from the server moves focus to its message; a field's own error stays beside it.
      if (visibleFailure?.field === 'form') {
        form.current?.querySelector<HTMLElement>(`[data-account-field="${visibleFailure.field}"]`)?.focus()
      }
    },
    [visibleFailure],
  )
  const base = snapshot.view
  const registeredAccounts = base?.document.accounts
  const hasRegistered = registeredAccounts && Object.keys(registeredAccounts).length > 0
  const accounts = hasRegistered ? registeredAccounts : effective?.accounts ?? {}

  const reject = ({
    message,
    field,
  }: {
    message: string
    field: 'label' | 'folder' | 'form'
  }) => {
    if (draft) {
      setFailure({
        message,
        field,
        draft: draft.id,
      })
    }
  }

  // Saves the account once both fields are valid; leaving a blank field of a new account is not an error yet.
  const save = async ({ left }: { left: boolean }) => {
    if (!draft || !base) {
      return
    }

    const label = draft.label.trim()
    const folder = draft.folder.trim()
    const saved = draft.key ? accounts[draft.key] : undefined

    if (saved && saved.provider === draft.provider && saved.folder === folder && accountLabel({
      name: draft.key ?? '',
      account: saved,
    }) === label) {
      setFailure(undefined)

      return
    }

    if (left && !draft.key && (!label || !folder)) {
      return
    }

    if (!label || label.length > ACCOUNT_LABEL_MAX || LINE_BREAK.test(label)) {
      reject({
        message: `Use an account name of 1 to ${ACCOUNT_LABEL_MAX} characters on one line.`,
        field: 'label',
      })

      return
    }

    if (!homeFolderValid({ folder })) {
      reject({
        message: 'Use an absolute home folder or ~/path.',
        field: 'folder',
      })

      return
    }

    const submitted = draft
    const key = draft.key ?? `${draft.provider}:${draft.id}`
    const account: Account = {
      provider: draft.provider,
      label,
      folder,
    }
    // Keep the implicit logins available when the first named account is registered.
    const patch = effective ? accountRegistration({
      effective,
      name: key,
      account,
    }) : { accounts: { [key]: account } }
    const envelope = {
      version: 1,
      expected: { revision: base.revision },
      patch,
    }
    const id = crypto.randomUUID()
    const writing = resource.write({
      command: showingAfter({ command }),
      name: 'rule',
      args: [
        'apply',
        '--json',
        JSON.stringify(envelope),
        '--event-id',
        id,
      ],
      patch,
      targets: [`account:${key}`],
    })

    // A new account becomes its own row; an edited one stays open for the next field.
    if (!draft.key) {
      setDraft(undefined)
    }

    setFailure(undefined)

    try {
      await writing
      window.dispatchEvent(new Event(DISPATCH_CHANGED))
    } catch (error) {
      if (!(error instanceof CommandFailure)) {
        throw error
      }

      if (error.outcome === 'refused') {
        setDraft(current => current ?? submitted)
        reject({
          message: error.message,
          field: 'form',
        })
      }
    }
  }

  const editor = draft && (
    <form
      ref={form}
      id={`${errorId}-form`}
      className="setting-stack account-form"
      onSubmit={async event => {
        event.preventDefault(); await save({ left: false })
      }}
    >
      <div className="account-form-field">
        <span className="setting-name">Provider</span>
        <Select
          label="Account provider"
          value={draft.provider}
          options={PROVIDERS.map(item => ({
            value: item.harness,
            label: item.label,
            icon: item.icon,
          }))}
          disabled={!!draft.key && PROVIDERS.some(item => item.harness === draft.provider)}
          onChange={({ value }) => setDraft({
            ...draft,
            provider: value as Harness,
          })}
        />
      </div>
      <div className="account-form-field">
        <label className="setting-name" htmlFor={`${errorId}-name`}>Account name</label>
        <Input
          id={`${errorId}-name`}
          autoFocus
          aria-label="Account name"
          data-account-field="label"
          value={draft.label}
          maxLength={ACCOUNT_LABEL_MAX}
          aria-invalid={visibleFailure?.field === 'label' || undefined}
          aria-describedby={visibleFailure?.field === 'label' ? errorId : undefined}
          onChange={event => setDraft({
            ...draft,
            label: event.target.value,
          })}
          onBlur={() => save({ left: true })}
        />
      </div>
      <div className="account-form-field">
        <label className="setting-name" htmlFor={`${errorId}-home`}>Existing home folder</label>
        <p className="setting-description">Use a home folder you have already configured for this provider.</p>
        <Input
          id={`${errorId}-home`}
          aria-label="Existing home folder"
          data-account-field="folder"
          value={draft.folder}
          aria-invalid={visibleFailure?.field === 'folder' || undefined}
          aria-describedby={visibleFailure?.field === 'folder' ? errorId : undefined}
          placeholder={draft.provider === 'claude' ? '~/.claude-work' : '~/.codex-work'}
          onChange={event => setDraft({
            ...draft,
            folder: event.target.value,
          })}
          onBlur={() => save({ left: true })}
        />
      </div>
      {visibleFailure && (
        <p
          className="account-form-error"
          id={errorId}
          role="alert"
          data-account-field="form"
          tabIndex={-1}
        >{visibleFailure.message}
        </p>
      )}
      {!draft.key && (
        <div className="account-form-actions">
          <Button
            onClick={() => {
              setDraft(undefined); setFailure(undefined)
            }}
          >Cancel
          </Button>
        </div>
      )}
    </form>
  )
  const adding = draft && !draft.key

  return (
    <div className="account-settings">
      <div className="settings-rows">
        {Object.entries(accounts).map(([
          key,
          account,
        ]) => {
          const provider = PROVIDERS.find(item => item.harness === account?.provider)
          const label = accountLabel({
            name: key,
            account,
          })
          const editing = draft?.key === key

          return (
            <SettingRow
              key={key}
              icon={provider?.icon ?? 'agent'}
              label={label}
              description={`${provider?.label ?? account?.provider ?? 'Unknown provider'} · ${account?.folder ?? 'Home not configured'}`}
              action={(
                <Button
                  aria-label={`Edit ${label}`}
                  disabled={!base}
                  aria-expanded={editing}
                  aria-controls={editing ? `${errorId}-form` : undefined}
                  onClick={() => {
                    setFailure(undefined); setDraft(editing ? undefined : {
                      id: crypto.randomUUID(),
                      key,
                      provider: account?.provider ?? 'claude',
                      label,
                      folder: String(account?.folder ?? ''),
                    })
                  }}
                >{editing ? <><Icon name="check" size={14} />Done</> : <><Icon name="edit" size={14} />Edit</>}
                </Button>
              )}
            >{editing && editor}
            </SettingRow>
          )
        })}
        {adding ? (
          <SettingRow
            key="add-account"
            icon="plus"
            label="Add account"
            description="Use an existing provider and configured home."
          >{editor}
          </SettingRow>
        ) : (
          <div className="account-add-row" key="add-account">
            <Button
              variant="surface"
              disabled={!base}
              onClick={() => {
                setFailure(undefined); setDraft({
                  id: crypto.randomUUID(),
                  provider: 'claude',
                  label: '',
                  folder: '',
                })
              }}
            ><Icon name="plus" size={16} />Add account
            </Button>
          </div>
        )}
      </div>
      {!draft && snapshot.error && <p role="alert">{snapshot.error}</p>}
      <PendingStatus intents={snapshot.intents} />
    </div>
  )
}
