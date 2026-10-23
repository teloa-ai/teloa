import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

// BIZ-010：工具授权闭环。准备执行被「空执行工具」拒绝时，用户要看到可操作路径：
// 去员工详情 → 员工权限（工具授权）保存工具，然后「撤回」原准备并重新「准备执行」；
// 不展示内部 reason/ID。TaskDetail 的无工具运行横幅也要能把用户带到员工详情。
const source=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('准备执行被空工具拒绝时给出授权入口与撤回→重新准备路径',async()=>{
 const code=await source('TaskExecutions.tsx')
 assert.match(code,/role-run-no-execution-tools/,'必须识别服务端准备期拒绝原因')
 assert.match(code,/toolGateBlocked/,'要有独立的可操作状态，而不是只落通用错误')
 assert.match(code,/roleDelegation\.noTools/,'要说明先配置工具授权')
 assert.match(code,/taskExecution\.withdrawThenPrepare/,'要给出撤回原准备并重新准备的下一步')
 assert.doesNotMatch(code,/details\?\.reason[^\n]{0,80}(setError|String\()/,'不把内部 reason 直接展示给用户')
})

test('无工具运行横幅保留打开员工入口，并提示保存工具后撤回再重新准备',async()=>{
 const code=await source('TaskDetail.tsx')
 assert.match(code,/missingToolRun/,'保留空工具运行横幅')
 assert.match(code,/market\.industry\.planForm\.openRole/,'保留打开员工入口')
 assert.match(code,/taskExecution\.withdrawThenPrepare/,'提示撤回原准备并重新准备')
})

// BIZ-010 入口验证：员工详情「员工权限」面板渲染真实 RoleToolGrants，工作台把 role-tool-grant API 接到 TeamPage。
test('员工详情的员工权限面板挂载真实工具授权组件，工作台已接线',async()=>{
 const teamPage=await source('TeamPage.tsx')
 assert.match(teamPage,/openProfilePanel\('permissions'\)/,'员工详情要有员工权限入口')
 assert.match(teamPage,/profilePanel==='permissions'[\s\S]{0,200}capabilities\(role\.id\)/,'员工权限面板渲染能力/工具授权节点')
 assert.match(teamPage,/capabilities: \(id: string\) => ReactNode/,'员工详情由工作台注入能力入口')
 assert.match(teamPage,/<EmployeeGrantedTools role=\{role\} api=\{roleTools\}/,'已授予工具展示使用真实 API')
 const frame=await source('WorkbenchFrame.tsx')
 assert.match(frame,/roleTools=\{roleToolGrantApi\}/,'TeamPage 必须收到工具授权 API')
 assert.match(frame,/<RoleToolGrants role=\{role\} api=\{roleToolGrantApi\}/,'能力入口必须渲染真实工具授权组件')
})
