import type { HydraState } from '#app/model.ts'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Highlight } from '#web-shared/ui/setting-row.tsx'
import { type ReactNode } from 'react'
import { ASK_BADGE,type Asking } from './ask-mode.ts'
import { type AskKey,type AskTarget } from './ask.ts'
import { type Filter,type FilterToken } from './filters.ts'
import { menuHint,resultIcon,resultMeta,type OracleResult } from './results.ts'

function Option({
  id,
  value,
  selected,
  icon,
  label,
  terms,
  meta,
  pick,
}: {
  id: string
  value: string
  selected: boolean
  icon: string
  label: string
  terms: string[]
  meta: string
  pick(): void
}) {
  return (
    <div
      id={id}
      role="option"
      className="oracle-option"
      data-value={value}
      aria-selected={selected}
      onMouseDown={event => event.preventDefault()}
      onClick={pick}
    >
      <Icon name={icon} size={15} />
      <span className="oracle-option-label"><Highlight text={label} terms={terms} /></span>
      {meta && <span className="oracle-option-meta">{meta}</span>}
    </div>
  )
}

function Group({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={label}>
      <div className="oracle-caption" aria-hidden="true">{label}</div>
      {children}
    </div>
  )
}

export function oracleResultList({
  terms,
  state,
  keys,
  now,
  choose,
  commit,
  optionId,
  menu,
  menuSelected,
  typedActions,
  groups,
  results,
  selected,
  token,
  ask,
  askTarget,
  mod,
  askAct,
  targets,
  pickedId,
  hydra,
  sendAsk,
}: {
  terms: string[]
  state: HydraState
  keys({ id }: { id: string }): string
  now: number
  choose({
    result,
    elsewhere,
  }: {
    result: OracleResult
    elsewhere: boolean
  }): void
  commit({ filter }: { filter?: Filter }): void
  optionId({ index }: { index: number }): string
  menu: Filter[]
  menuSelected: string | undefined
  typedActions: OracleResult[]
  groups: {
    label: string
    results: OracleResult[]
  }[]
  results: OracleResult[]
  selected: string | undefined
  token: FilterToken | null
  ask: Asking | null
  askTarget?: AskTarget
  mod: string
  askAct({ key }: { key: AskKey }): void
  targets: AskTarget[]
  pickedId?: string
  hydra: { id: string }
  sendAsk({
    to,
    opening,
  }: {
    to?: AskTarget
    opening: boolean
  }): Promise<void>
}) {
  const resultOption = ({
    result,
    index,
    picked,
  }: {
    result: OracleResult
    index: number
    picked: boolean
  }) => (
    <Option
      key={result.id}
      id={optionId({ index })}
      value={result.id}
      selected={picked}
      icon={resultIcon({ result })}
      label={result.title}
      terms={terms}
      meta={resultMeta({
        result,
        state,
        keys,
        now,
      })}
      pick={() => choose({
        result,
        elsewhere: false,
      })}
    />
  )
  const filterGroup = menu.length > 0 && (
    <Group key="filters" label="Filters">
      {menu.map((
        filter,
        index,
      ) => (
        <Option
          key={filter.id}
          id={optionId({ index })}
          value={filter.id}
          selected={filter.id === menuSelected}
          icon={filter.icon}
          label={filter.label}
          terms={[]}
          meta={menuHint({ filter })}
          pick={() => commit({ filter })}
        />
      ))}
    </Group>
  )
  const actionGroup = typedActions.length > 0 && (
    <Group key="actions" label="Actions and settings">
      {typedActions.map((
        result,
        index,
      ) => resultOption({
        result,
        index: menu.length + index,
        picked: result.id === menuSelected,
      }))}
    </Group>
  )
  const menuList = [
    filterGroup,
    actionGroup,
  ].filter(group => group !== false)
  const resultList = groups.map(group => (
    <Group key={group.label} label={group.label}>
      {group.results.map(result => resultOption({
        result,
        index: results.indexOf(result),
        picked: result.id === selected,
      }))}
    </Group>
  ))
  const askRow = (
    <Group label="Request">
      <Option
        id={optionId({ index: 0 })}
        value={ASK_BADGE}
        selected
        icon={askTarget?.icon ?? HYDRA_MARK}
        label={askTarget ? `Send to ${askTarget.name}` : 'Send to which Hydra?'}
        terms={[]}
        meta={askTarget ? `↵ sends · ${mod}↵ and opens its chat` : '↵ picks the Hydra'}
        pick={() => askAct({ key: askTarget ? 'send' : 'pick' })}
      />
    </Group>
  )
  const pickList = (
    <Group label="Send to which Hydra?">
      {targets.map((
        target,
        index,
      ) => (
        <Option
          key={target.id}
          id={optionId({ index })}
          value={target.id}
          selected={target.id === pickedId}
          icon={target.icon}
          label={target.name}
          terms={[]}
          meta={target.id === hydra.id ? 'this Hydra' : ''}
          pick={() => sendAsk({
            to: target,
            opening: false,
          })}
        />
      ))}
    </Group>
  )
  const askList = ask?.picking ? pickList : askRow
  const searchList = token ? menuList : resultList
  const shownList = ask ? [askList] : searchList

  return shownList
}
