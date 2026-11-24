import { useEffect, useId, useRef, useState } from 'react'
import type { Account, Harness } from '#workers/dispatch-config.ts'
import { ACCOUNT_LABEL_MAX, accountLabel, accountRegistration, homeFolderValid, LINE_BREAK } from '#workers/account-choice.ts'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { Button, Input, Select } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { SettingRow, SettingsRows, SettingField, SETTING_STACK } from '#web-shared/ui/setting-row.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { PROVIDERS } from './account-model-picker.tsx'
import { DISPATCH_CHANGED, showingAfter, useDispatchDocument, useTitanDispatch } from './heads-dispatch.ts'

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
  notify,
}: {
  command: Command
  initialProvider?: Harness
  notify({ text }: { text: string }): void
}) {
  const {
    snapshot,
    resource,
  } = useDispatchDocument({ command })
  const { effective } = useTitanDispatch({ command })
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
        form.current?.querySelector<HTMLElement>('[data-account-field="form"]')?.focus()
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
        message: `Use a display name of 1 to ${ACCOUNT_LABEL_MAX} characters on one line.`,
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

  // save rethrows anything that is not a command failure; report it instead of leaving it unhandled.
  const commit = ({ left }: { left: boolean }) => {
    void save({ left }).catch((error: Error) => notify({ text: error.message }))
  }

  const editor = draft && (
    <form
      ref={form}
      id={`${errorId}-form`}
      className={`${SETTING_STACK} account-form min-w-0 gap-(--settings-column-gap) [&_.select>.button]:justify-start [&_.select>.button>svg:last-child]:ml-auto [&_:is(.input,.select)]:w-settings-field`}
      onSubmit={event => {
        event.preventDefault(); commit({ left: false })
      }}
    >
      <SettingField>
        <span className="setting-name text-ui font-semibold">Provider</span>
        <Select
          label="Account provider"
          value={draft.provider}
          options={PROVIDERS.map(item => ({
            value: item.harness,
            label: item.label,
            icon: item.icon,
          }))}
          disabled={!!draft.key}
          onChange={({ value }) => setDraft({
            ...draft,
            provider: value as Harness,
          })}
        />
      </SettingField>
      <SettingField>
        <label className="setting-name text-ui font-semibold" htmlFor={`${errorId}-name`}>Display name</label>
        <Input
          id={`${errorId}-name`}
          autoFocus
          aria-label="Display name"
          data-account-field="label"
          value={draft.label}
          aria-invalid={visibleFailure?.field === 'label' || undefined}
          aria-describedby={visibleFailure?.field === 'label' ? errorId : undefined}
          onChange={event => setDraft({
            ...draft,
            label: event.target.value,
          })}
          onBlur={() => commit({ left: true })}
        />
      </SettingField>
      <SettingField>
        <label className="setting-name text-ui font-semibold" htmlFor={`${errorId}-home`}>Existing home folder</label>
        <p className="setting-description mx-0 mt-0.75 mb-2.5 text-ui text-muted">Use a home folder you have already configured for this provider.</p>
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
          onBlur={() => commit({ left: true })}
        />
      </SettingField>
      {visibleFailure && (
        <p
          className="account-form-error text-ui text-red"
          id={errorId}
          role="alert"
          data-account-field="form"
          tabIndex={-1}
        >{visibleFailure.message}
        </p>
      )}
      {!draft.key && (
        <div className="account-form-actions flex flex-wrap gap-(--settings-column-gap)">
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
    <div className="account-settings flex min-w-0 flex-col gap-3 [&>.settings-rows]:border-0 [&>.settings-rows]:bg-transparent [&>:not(.settings-rows)]:mx-5 [&>:not(.settings-rows)]:mt-0 [&>:not(.settings-rows)]:mb-4">
      <SettingsRows>
        {Object.entries(accounts).map(([
          key,
          account,
        ]) => {
          const provider = PROVIDERS.find(item => item.harness === account.provider)!
          const label = accountLabel({
            name: key,
            account,
          })
          const editing = draft?.key === key

          return (
            <SettingRow
              key={key}
              icon={provider.icon}
              label={label}
              description={`${provider.label} · ${account.folder}`}
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
                      provider: account.provider,
                      label,
                      folder: account.folder,
                    })
                  }}
                >{editing ? <><Icon name="check" size={ICON_SIZE.inline} />Done</> : <><Icon name="edit" size={ICON_SIZE.inline} />Edit</>}
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
            description="Register a Claude Code or Codex home you already use."
          >{editor}
          </SettingRow>
        ) : (
          <div className="account-add-row border-t border-subtle px-5 py-4" key="add-account">
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
            ><Icon name="plus" size={ICON_SIZE.control} />Add account
            </Button>
          </div>
        )}
      </SettingsRows>
      {!draft && snapshot.error && <p role="alert">{snapshot.error}</p>}
      <PendingStatus intents={snapshot.intents} />
    </div>
  )
}
