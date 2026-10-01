import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {changeTaskPreview,emptyTaskPreview,taskHistoryText,withTaskExamples,type TaskHistoryEntry} from '../src/client/task-preview.ts'
import {approvalText,type LocalizedText} from '../src/client/approval-preview.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

const now='2026-09-13T01:00:00.000Z'
const translator=(values:Readonly<Record<string,string>>):TeloaTranslate=>(key,params)=>{
 const template=values[key]??key
 return template.replace(/\{(\w+)\}/g,(_,name:string)=>String(params?.[name]??`{${name}}`))
}
const en=translator({
 'task.history.created':'Created task',
 'task.history.progress.start':'Task started',
 'task.history.approvalDecision':'{status}: {note}',
 'approvalCard.status.approved':'Approved',
 'task.approval.subject':'Task',
 'task.approval.risk.none':'No external action proposed',
 'task.approval.effect':'The decision covers only this object and submitted version.',
})

test('new task history stores stable message keys and localizes when rendered',()=>{
 let state=changeTaskPreview(emptyTaskPreview(),{type:'create',id:'task-1',title:'用户标题',goal:'用户目标',scope:'general',now})
 const created=state.tasks[0]!.history[0]!
 assert.deepEqual(created.message,{key:'task.history.created'})
 assert.equal('text' in created,false)
 assert.equal(taskHistoryText(created,en),'Created task')
 state=changeTaskPreview(state,{type:'progress',taskId:'task-1',action:'start',now})
 assert.equal(taskHistoryText(state.tasks[0]!.history.at(-1)!,en),'Task started')
})

test('approval history composes translated system status with the original user note',()=>{
 const before=withTaskExamples(emptyTaskPreview(),now),approval=before.approvals[0]!
 const after=changeTaskPreview(before,{type:'decide',approvalId:approval.id,expectedVersion:1,decision:'approved',note:'Keep this note 原文',now})
 const entry=after.tasks.find(task=>task.id===approval.taskId)!.history.at(-1)!
 assert.equal(taskHistoryText(entry,en),'Approved: Keep this note 原文')
})

test('task approvals store localizable system copy while keeping legacy strings readable',()=>{
 const state=withTaskExamples(emptyTaskPreview(),now),snapshot=state.approvals[0]!.snapshot
 assert.deepEqual(snapshot.subjectLabel,{key:'task.approval.subject'})
 assert.deepEqual(snapshot.effect,{key:'task.approval.effect'})
 assert.equal(approvalText(snapshot.subjectLabel,en),'Task')
 assert.equal(approvalText(snapshot.effect,en),'The decision covers only this object and submitted version.')
 assert.equal(approvalText('历史原文',en),'历史原文')
})

test('legacy task history remains readable and is never rewritten',()=>{
 const legacy={text:'历史原文',actorId:'self',at:now} satisfies TaskHistoryEntry
 assert.equal(taskHistoryText(legacy,en),'历史原文')
 const dynamic={key:'task.approval.risk.none'} satisfies LocalizedText
 assert.equal(approvalText(dynamic,en),'No external action proposed')
})

test('formal task and approval views render semantic content through the current translator',async()=>{
 const root=new URL('../src/client/',import.meta.url)
 const [taskPage,approvalCard]=await Promise.all([
  readFile(new URL('task-timeline-events.ts',root),'utf8'),
  readFile(new URL('ApprovalCard.tsx',root),'utf8'),
 ])
 assert.match(taskPage,/taskHistoryText\(entry,input\.t\)/)
 for(const field of ['object','subjectLabel','risk','effect'])assert.match(approvalCard,new RegExp(`approvalText\\(snapshot\\.${field},t\\)`),field)
})
