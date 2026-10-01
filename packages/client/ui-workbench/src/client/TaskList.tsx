import {StatusLabel} from './StatusLabel.js'
import {taskStatusMark} from './status-presentation.js'
import {useId,useRef,useState,type KeyboardEvent} from 'react'
import clsx from 'clsx'
import type {AttentionKind,PreviewTask} from './task-preview.js'
import {groupTaskRows,nextListIndex,pinRank,sortTaskRows,taskObjectLabel,type TaskRowAttention} from './task-list-presentation.js'
import {useI18n} from './i18n/provider.js'
import css from './TaskPage.module.css'

export type TaskListRow={task:PreviewTask;attention:TaskRowAttention;ownerName:string;scopeLabel:string;unverified:boolean}

export function TaskList({rows,filter,selected,select,stateLabel,attentionLabel,stamp}:{rows:readonly TaskListRow[];filter:'all'|'formal';selected:string|null;select:(id:string|null)=>void;stateLabel:(state:PreviewTask['state'])=>string;attentionLabel:(kind:AttentionKind)=>string;stamp:(at:string)=>string}):JSX.Element{
  const {t}=useI18n()
  const list=useRef<HTMLDivElement>(null),groupId=useId()
  const [routedOpen,setRoutedOpen]=useState(false)
  const grouped=groupTaskRows(rows,filter),formal=sortTaskRows(grouped.formal),routed=sortTaskRows(grouped.routed)
  // 漫游只在可见行之间走：群内回应组收起时，↑↓ 不会落进看不见的行。
  const visibleRows=routedOpen?[...formal,...routed]:formal
  const navigateRows=(event:KeyboardEvent<HTMLDivElement>)=>{
    const entry=event.target instanceof Element?event.target.closest<HTMLElement>('tr[role="option"]'):null
    if(!entry)return
    const current=visibleRows.findIndex(row=>row.task.id===entry.dataset.teloaEntry)
    if(current<0)return
    if(event.key==='Enter'||event.key===' '){event.preventDefault();select(visibleRows[current]!.task.id);return}
    const next=nextListIndex(event.key,current,visibleRows.length)
    if(next===undefined||!visibleRows[next])return
    event.preventDefault()
    select(visibleRows[next].task.id)
    requestAnimationFrame(()=>list.current?.querySelectorAll<HTMLTableRowElement>('tr[role="option"]')[next]?.focus())
  }
  const renderRow=(item:TaskListRow,index:number)=>{
    const {task,attention}=item,pinned=pinRank(attention,task.state)<4
    const attentionText=attention.kinds.map(attentionLabel).join(' · ')||(item.task.storage==='persistent'&&item.unverified?t('task.attention.unverified'):'')
    return <tr key={task.id} className={clsx(css.listRow,pinned&&css.listPinned)} role="option" aria-selected={task.id===selected} tabIndex={task.id===selected||(!selected&&index===0)?0:-1} data-teloa-entry={task.id}>
      <td><button type="button" className={css.tableLink} title={task.title} tabIndex={-1} onClick={()=>select(task.id)}>{task.title}</button><small>{item.scopeLabel} · {taskObjectLabel(task,t)}</small></td>
      <td title={item.ownerName}>{item.ownerName}</td>
      <td><StatusLabel label={stateLabel(task.state)} mark={taskStatusMark(task.state)} tone={attention.kinds.length?'warn':task.state==='completed'?'good':task.state==='cancelled'?'muted':'info'}/>{selected&&attentionText&&<small>{attentionText}</small>}</td>
      {!selected&&<><td>{attentionText||'—'}</td><td>{stamp(task.updatedAt)}</td></>}
    </tr>
  }
  return <div ref={list} className={css.tableWrap} role="listbox" aria-label={t('task.list.aria')} onKeyDown={navigateRows}>
    <table>
      <thead><tr><th>{t('task.table.task')}</th><th>{t('task.table.owner')}</th><th>{t('task.table.state')}</th>{!selected&&<><th>{t('task.table.attention')}</th><th>{t('task.table.updated')}</th></>}</tr></thead>
      <tbody>
        {formal.map((item,index)=>renderRow(item,index))}
        {routed.length>0&&<tr className={css.listGroupRow}><td colSpan={selected?3:5}><button type="button" aria-expanded={routedOpen} aria-controls={groupId} onClick={()=>setRoutedOpen(value=>!value)}>{t('task.list.routed',{count:routed.length})}</button></td></tr>}
      </tbody>
      {routedOpen&&routed.length>0&&<tbody id={groupId}>{routed.map((item,index)=>renderRow(item,formal.length+index))}</tbody>}
    </table>
  </div>
}
