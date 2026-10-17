import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import * as presentation from '../src/client/task-detail-presentation.ts'

test('复用原目标与业务，只有会话草稿端口被调用，不传运行、审批或历史结果',()=>{
 const repeat=(presentation as Record<string,unknown>).requestTaskRepeat
 assert.equal(typeof repeat,'function','需要提供创建会话草稿的复用动作')
 const calls:unknown[]=[]
 const task={title:'核对客户资料',goal:'对比两份材料并列出差异',scope:'general',assigneeId:'old-role',approvalRequired:true,result:'旧结果'}
 ;(repeat as (...args:unknown[])=>void)(task,(scope:string,goal:string)=>calls.push({scope,goal}),(_key:string,args:{title:string;goal:string})=>'再做一次：'+args.title+'\n'+args.goal)
 assert.deepEqual(calls,[{scope:'general',goal:'再做一次：核对客户资料\n对比两份材料并列出差异'}])
})

test('再做一次回到原生会话草稿，不保存模板或自动新建执行',()=>{
 const detail=readFileSync(new URL('../src/client/TaskDetail.tsx',import.meta.url),'utf8')
 const page=readFileSync(new URL('../src/client/TaskPage.tsx',import.meta.url),'utf8')
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(detail,/id:'repeat'/)
 assert.match(detail,/repeatTask\?\.\(task\)/)
 assert.doesNotMatch(detail,/id:'template'/)
 assert.match(page,/repeatTask=.*requestTaskRepeat\(task/)
 assert.match(frame,/requestTaskCreationConversation=.*goal\?:string/)
 assert.match(frame,/goal:goal\?\?t\('workbench\.create\.taskPrompt'\)/)
})
