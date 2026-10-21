import { useHeadsDispatch } from './heads-dispatch.ts'
import type { HydraState } from '../../../src/core/model.ts'
import type { Command } from './connection.ts'

export function AgentKinds({ command }: {
  state: HydraState
  command: Command
  notify({ text }: { text: string }): void
}) {
  const {
    effective,
    error,
  } = useHeadsDispatch({ command })

  return (
    <section className="settings-box" aria-label="Agents">
      <h2>Agents</h2>
      <p className="muted">Your explicit agent choice wins. Otherwise Hydra picks a rule and quota ranks its Claude and Codex candidates. Ask Hydra to propose rule or account changes, then Confirm or Dismiss them in chat.</p>
      {error && <p role="alert">{error}</p>}
      {!effective && !error && <p className="muted">Loading heads dispatch…</p>}
      {effective && (
        <>
          <h3>Rules</h3>
          {Object.entries({
            default: {
              when: 'Tasks without a named rule',
              candidates: effective.dispatch.default,
            },
            ...effective.dispatch.rules,
          }).map(([
            key,
            rule,
          ]) => (
            <div key={key} role="group" aria-label={`Rule ${key}`}>
              <strong>{key}</strong><p>{rule.when}</p>
              <ol>{rule.candidates.map((
                candidate,
                index,
              ) => <li key={index}>{candidate.harness} · {candidate.model ?? 'default model'}{candidate.effort ? ` · ${candidate.effort}` : ''}</li>)}
              </ol>
            </div>
          ))}
          <h3>Accounts</h3>
          <p>Main account: {effective.dispatch.main ?? 'not configured'}</p>
          {Object.entries(effective.accounts).map(([
            key,
            account,
          ]) => (
            <p key={key}>
              <strong>{key}</strong> · {account.provider} · <code>{account.folder}</code>
            </p>
          ))}
          {!Object.keys(effective.accounts).length && <p className="muted">No accounts configured. Run <code>pnyx-axi rule init --shared</code> to copy the templates.</p>}
          <h3>Worker account order</h3>
          {Object.entries(effective.dispatch.workers).map(([
            provider,
            order,
          ]) => <p key={provider}>{provider}: {order.join(' → ') || 'not configured'}</p>)}
          {Object.entries(effective.dispatch.projects).map(([
            project,
            orders,
          ]) => (
            <div key={project}><strong>{project}</strong>{Object.entries(orders).map(([
              provider,
              order,
            ]) => <p key={provider}>{provider}: {order.join(' → ')}</p>)}
            </div>
          ))}
        </>
      )}
    </section>
  )
}
