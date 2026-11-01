import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {isReservedExecutionSessionId} from '@teloa/contract'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),require=createRequire(import.meta.url)
const official=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
const packageRoot=dirname(official.resolve('@deepseek-ai/dsh-client-ui-workspace/package.json'))
const basename='dsh-client-ui-workspace-0.2.1-rc.2-reserved-session-reuse'
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')

async function navigationSource(t:TestContext){
 const source=await readFile(join(packageRoot,'lib/client.js'),'utf8')
 const runtime=await readFile(join(root,'scripts/runtime/native-runtime.mjs'),'utf8')
 // 使用生产接线决定是否应用补丁；漏接时仍执行官方实现，让行为回归真实失败。
 if(!runtime.includes("basename:'dsh-client-ui-workspace-'+version+'-reserved-session-reuse'"))return source
 const manifest=JSON.parse(await readFile(join(root,'packages/harness-dsh/compat',basename+'.json'),'utf8'))
 const patch=await readFile(join(root,'packages/harness-dsh/compat',basename+'.patch'))
 assert.equal(manifest.package,'@deepseek-ai/dsh-client-ui-workspace');assert.equal(manifest.version,'0.2.1-rc.2')
 assert.equal(manifest.upstreamCommit,'687f282e8625c6b8d11ff58211a90524be2e4317')
 assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].path,'lib/client.js')
 assert.equal(digest(source),manifest.files[0].beforeSha256);assert.equal(digest(patch),manifest.patchSha256)
 const temp=await mkdtemp(join(tmpdir(),'teloa-workspace-reserved-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await mkdir(join(temp,'lib'));await writeFile(join(temp,'lib/client.js'),source);await writeFile(join(temp,'fix.patch'),patch)
 execFileSync('/usr/bin/git',['apply','--no-index','--unidiff-zero','--check',join(temp,'fix.patch')],{cwd:temp})
 execFileSync('/usr/bin/git',['apply','--no-index','--unidiff-zero',join(temp,'fix.patch')],{cwd:temp})
 const result=await readFile(join(temp,'lib/client.js'),'utf8');assert.equal(digest(result),manifest.files[0].afterSha256)
 assert.equal(digest(await readFile(join(packageRoot,'lib/client.js'))),manifest.files[0].beforeSha256,'安装依赖保持不变')
 return result
}

test('原生初始连接与新工作复用跳过待执行员工/群运行，显式历史恢复保持原身份及预设',async t=>{
 const source=await navigationSource(t),start=source.indexOf('var UiWorkspaceService = class '),end=source.indexOf('\n\t\t//#endregion',start)
 assert.ok(start>0&&end>start)
 // 完整执行固定官方导航类及其同区 helper；仅提供不涉及 DOM 的服务/目录端口。
 const Navigation=new Function('_deepseek_ai_cordis',source.slice(start,end)+'\nreturn UiWorkspaceService;')({Service:class {}})
 const run='task-run-11111111-1111-4111-8111-111111111111',group='group-routing-22222222-2222-4222-8222-222222222222'
 for(const id of [run,group])assert.equal(isReservedExecutionSessionId(id),true)
 const rows=[{id:run,blank:true,cwd:'/work',updatedAt:3,projectionValues:{agentPreset:'ptc'}},{id:group,blank:true,cwd:'/work',updatedAt:2,projectionValues:{agentPreset:'ptc-python'}},{id:'ordinary',blank:true,cwd:'/work',updatedAt:1,projectionValues:{agentPreset:'standard'}}]
 const requests:any[]=[],opened:string[]=[],workspace={workspaceId:'workspace',path:'/work',sessionIds:rows.map(row=>row.id)}
 const nav=Object.assign(Object.create(Navigation.prototype),{
  workspaces:{list:{getSnapshot:()=>({items:[workspace],archivedSessionIds:[]})}},
  sessions:{list:{getSnapshot:()=>({ids:rows.map(row=>row.id),byId:Object.fromEntries(rows.map(row=>[row.id,row]))})},refreshProjections:async()=>{}},
  connecting:new Map(),selection:{getSnapshot:()=>({})},lifetime:new AbortController(),ctx:{layout:{beginNavigation:()=>new AbortController().signal}},
  createNamed:async(request:any)=>{requests.push(request);return request.sessionId??'fresh-ordinary'},
  replaceMain:(id:string)=>opened.push(id),
 })
 await nav.restoreSelection({items:[workspace],archivedSessionIds:[]},nav.sessions.list.getSnapshot())
 assert.deepEqual(requests,[{workspaceId:'workspace',sessionId:'ordinary'}],'全新浏览器不能把预备 Run 当作默认空白会话')
 assert.deepEqual(opened,['ordinary'])
 rows.pop();requests.length=0
 await nav.connectWorkspace('workspace')
 assert.deepEqual(requests,[{workspaceId:'workspace'}],'没有普通草稿时创建独立会话，不改变已准备 Run')
 requests.length=0
 await nav.restoreBlank('workspace',run)
 assert.deepEqual(requests,[{workspaceId:'workspace',sessionId:run,agentPreset:'ptc'}],'本人显式恢复已保存运行仍沿用原身份与配置')
 assert.deepEqual(rows.map(row=>row.projectionValues.agentPreset),['ptc','ptc-python'])
})
