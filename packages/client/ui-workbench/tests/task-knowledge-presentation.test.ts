import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS} from '../src/client/i18n/locales/artifact-knowledge-secondary.ts'

test('真实任务详情有可嵌入的任务知识面板',()=>{
  assert.equal(existsSync(new URL('../src/client/TaskKnowledge.tsx',import.meta.url)),true)
})

test('任务知识解释与岗位默认知识的区别，并在提交前展示锁定版本',()=>{
  const source=readFileSync(new URL('../src/client/TaskKnowledge.tsx',import.meta.url),'utf8')
  const zh=Object.fromEntries(ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
  assert.equal(zh['taskKnowledge.description'],"任务知识是本项工作的补充上下文；员工的默认知识属于员工配置，不会因这里的选择而改变。")
  assert.equal(zh['taskKnowledge.addDescription'],'仅显示当前任务业务范围内已启用的知识。')
  assert.equal(zh['taskKnowledge.confirm'],'将锁定“{title}”的资料版本 v{version}，来源版本 {sourceVersion}。')
  for(const key of ['taskKnowledge.description','taskKnowledge.addDescription','taskKnowledge.confirm','taskKnowledge.available','taskKnowledge.recover'])assert.match(source,new RegExp(key.replaceAll('.', '\\.')))
})

test('TaskPage 仅为真实任务提供任务知识渲染槽位',()=>{
  const source=readFileSync(new URL('../src/client/TaskPage.tsx',import.meta.url),'utf8')
  assert.match(source,/knowledge\?:\(task:PreviewTask\)=>ReactNode/)
  assert.match(source,/knowledge=\{task\.storage==='persistent'\?knowledge\?\.\(task\):null\}/)
})

test('任务知识客户端接入真实 RPC、恢复记录与任务详情',()=>{
  const index=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8')
  const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
  assert.match(index,/createTaskMaterialApi/)
  assert.match(index,/teloa\.task-material-add\/v1/)
  assert.match(frame,/taskMaterialApi:TaskMaterialApi/)
  assert.match(frame,/<TaskKnowledge[^>]+api=\{taskMaterialApi\}[^>]+resources=\{resourceApi\}/)
})
