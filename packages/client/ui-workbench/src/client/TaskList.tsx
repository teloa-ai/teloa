import {StatusLabel} from './StatusLabel.js'
import {taskStatusMark} from './status-presentation.js'
import {useId,useRef,useState,type KeyboardEvent} from 'react'
import clsx from 'clsx'
import type {AttentionKind,PreviewTask} from './task-preview.js'
import {groupTaskRows,nextListIndex,pinRank,sortTaskRows,taskObjectLabel,type TaskRowAttention} from './task-list-presentation.js'
import {useI18n} from './i18n/provider.js'
import css from './TaskPage.module.css'
import {useCollectionWindow} from './collection-window.js'
import {CollectionFooter} from './CollectionFooter.js'

export type TaskListRow={task:PreviewTask;attention:TaskRowAttention;ownerName:string;scopeLabel:string;unverified:boolean}

export function TaskList({rows,filter,selected,select,stateLabel,attentionLabel,stamp}:{rows:readonly TaskListRow[];filter:'all'|'formal';selected:string|null;select:(id:string|null)=>void;stateLabel:(state:PreviewTask['state'])=>string;attentionLabel:(kind:AttentionKind)=>string;stamp:(at:string)=>string}):JSX.Element{
  const {t}=useI18n()
  const list=useRef<HTMLDivElement>(null),groupId=useId()
  const [routedOpen,setRoutedOpen]=useState(false)
  const grouped=groupTaskRows(rows,filter),formal=sortTaskRows(grouped.formal),routed=sortTaskRows(grouped.routed)
  const formalWindow=useCollectionWindow(formal,row=>row.task.id,selected??undefined)
  const routedWindow=useCollectionWindow(routed,row=>row.task.id,selected??undefined)
  // 漫游只在可见行之间走：群内回应组收起时，↑↓ 不会落进看不见的行。
  const visibleRows=routedOpen?[...formalWindow.items,...routedWindow.items]:formalWindow.items
  const navigateRows=(event:KeyboardEvent<HTMLDivElement>)=>{
    const entry=event.target instanceof Element?event.target.closest<HTMLElement>('tr[data-teloa-entry]'):null
    if(!entry)return
    const current=visibleRows.findIndex(row=>row.task.id===entry.dataset.teloaEntry)
    if(current<0)return
    if(event.key==='Enter'||event.key===' '){event.preventDefault();select(visibleRows[current]!.task.id);return}
    const next=nextListIndex(event.key,current,visibleRows.length)
    if(next===undefined||!visibleRows[next])return
    event.preventDefault()
    select(visibleRows[next].task.id)
    requestAnimationFrame(()=>list.current?.querySelectorAll<HTMLButtonElement>('button[data-teloa-task-open]')[next]?.focus())
  }
  const renderRow=(item:TaskListRow)=>{
    const {task,attention}=item,pinned=pinRank(attention,task.state)<4
    const attentionText=attention.kinds.map(attentionLabel).join(' · ')||(item.task.storage==='persistent'&&item.unverified?t('task.attention.unverified'):'')
    return <tr key={task.id} className={clsx(css.listRow,pinned&&css.listPinned)} data-active={task.id===selected?true:undefined} data-teloa-entry={task.id}>
      <td><button type="button" className={css.tableLink} title={task.title} data-teloa-task-open aria-current={task.id===selected?'page':undefined} onClick={()=>select(task.id)}>{task.title}</button><small>{item.scopeLabel} · {taskObjectLabel(task,t)}</small>{selected&&<span className={css.rowOwner} title={item.ownerName}>{item.ownerName}</span>}</td>
      {!selected&&<td title={item.ownerName} data-label={t('task.table.owner')}>{item.ownerName}</td>}
      <td data-label={t('task.table.state')}><StatusLabel label={stateLabel(task.state)} mark={taskStatusMark(task.state)} tone={attention.kinds.length?'warn':task.state==='completed'?'good':task.state==='cancelled'?'muted':'info'}/>{selected&&attentionText&&<small>{attentionText}</small>}</td>
      {!selected&&<><td data-label={t('task.table.attention')}>{attentionText||'—'}</td><td data-label={t('task.table.updated')}>{stamp(task.updatedAt)}</td></>}
    </tr>
  }
  return <><div ref={list} className={css.tableWrap} onKeyDown={navigateRows}>
    <table role="table" aria-label={t('task.list.aria')}>
      <thead><tr><th scope="col">{t('task.table.task')}</th>{!selected&&<th scope="col">{t('task.table.owner')}</th>}<th scope="col">{t('task.table.state')}</th>{!selected&&<><th scope="col">{t('task.table.attention')}</th><th scope="col">{t('task.table.updated')}</th></>}</tr></thead>
      <tbody>
        {formalWindow.items.map(renderRow)}
        {routed.length>0&&<tr className={css.listGroupRow}><td colSpan={selected?2:5}><button type="button" aria-expanded={routedOpen} aria-controls={groupId} onClick={()=>setRoutedOpen(value=>!value)}>{t('task.list.routed',{count:routed.length})}</button></td></tr>}
      </tbody>
      {routedOpen&&routed.length>0&&<tbody id={groupId}>{routedWindow.items.map(renderRow)}</tbody>}
    </table>
  </div><CollectionFooter {...formalWindow}/>{routedOpen&&<CollectionFooter {...routedWindow}/>}</>
}
