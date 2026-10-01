import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {dirname,join} from 'node:path'
import {parse} from 'yaml'
import type {Context} from '@deepseek-ai/cordis'
import type {TaskRun} from '@teloa/backend'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {compositionSnapshot,compositionViolations,presetBodyNormalizedDigest,shippedPresetBodyDigests} from '../src/composition-safety.ts'
import {compositionEntries} from './fixtures/production-host.ts'

const parseDocument=(source:string)=>parse(source,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>({__jsExpr:value})}]})
const require=createRequire(import.meta.url)
const officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const presetRoot=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-app/package.json')),'presets')
const overlayUrl=new URL('../../bundle/agent-presets/standard.patch.yml',import.meta.url)

test('官方真实补丁与 Teloa bundle 按发行顺序组合后五份预设通过安全复验',async()=>{
 const boot=await import(pathToFileURL(officialRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
 const patches:unknown[]=[]
 for(const name of ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']){
  const manifestPath=officialRequire.resolve(name+'/package.json')
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
  for(const path of [manifest.dsh.bundle.patch].flat())patches.push(parseDocument(await readFile(join(dirname(manifestPath),path),'utf8')))
 }
 const bundle=new URL('../../bundle/',import.meta.url)
 const manifest=JSON.parse(await readFile(new URL('package.json',bundle),'utf8'))
 for(const path of manifest.dsh.bundle.patch)patches.push(parseDocument(await readFile(new URL(path,bundle),'utf8')))
 const rows=boot.composeEntries(patches).map((row:Record<string,unknown>)=>({...row,disabled:row.disabled===true}))
 assert.deepEqual(compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]})),[])
 assert.deepEqual(rows.filter((row:Record<string,unknown>)=>row.name==='@deepseek-ai/dsh-agent-preset'&&!row.disabled).map((row:{config:{id:string}})=>row.config.id).sort(),['cordis','minimal','ptc','standard','teloa-standard'])
})

test('官方覆盖由锁定声明生成，仅替换受管派发与本地压缩预算适配',async()=>{
 assert.equal(existsSync(overlayUrl),true,'缺少受管 standard 覆盖')
 const official=parseDocument(await readFile(join(presetRoot,'standard.patch.yml'),'utf8'))[0].insert[0]
 const overlay=parseDocument(await readFile(overlayUrl,'utf8'))[0]
 assert.equal(overlay.id,'preset-standard')
 const expected=structuredClone(official.config)
 const delegation=expected.plugins.find((row:{id:string})=>row.id==='delegation')
 delegation.config.find((row:{id:string})=>row.id==='workflow-ptc').config.provider='teloa-workflow-spawn'
 expected.plugins.find((row:{id:string})=>row.id==='compaction').config.find((row:{id:string})=>row.id==='compaction-basic').name='@teloa/harness-dsh/local-compaction'
 assert.deepEqual(overlay.config,expected)
 const manifest=JSON.parse(await readFile(new URL('../../bundle/package.json',import.meta.url),'utf8'))
 assert.ok(manifest.dsh.bundle.patch.includes('./agent-presets/standard.patch.yml'))
 const generated=spawnSync(process.execPath,[fileURLToPath(new URL('../../../scripts/生成官方预设适配.mjs',import.meta.url)),'--check'],{encoding:'utf8'})
 assert.equal(generated.status,0,generated.stderr)
 assert.equal(presetBodyNormalizedDigest(overlay.config.plugins),shippedPresetBodyDigests.standard)
 for(const id of ['ptc','minimal','cordis'] as const){
  const native=parseDocument(await readFile(join(presetRoot,id+'.patch.yml'),'utf8'))[0].insert[0]
  if(id==='minimal')assert.equal(presetBodyNormalizedDigest(native.config.plugins),shippedPresetBodyDigests[id],id)
  else{
   const adapted=parseDocument(await readFile(new URL('../../bundle/agent-presets/'+id+'.patch.yml',import.meta.url),'utf8'))[0]
   native.config.plugins.find((row:{id:string})=>row.id==='compaction').config.find((row:{id:string})=>row.id==='compaction-basic').name='@teloa/harness-dsh/local-compaction'
   assert.deepEqual(adapted.config,native.config,id+' 未增加无关改动')
   assert.equal(presetBodyNormalizedDigest(adapted.config.plugins),shippedPresetBodyDigests[id],id)
   assert.ok(manifest.dsh.bundle.patch.includes('./agent-presets/'+id+'.patch.yml'))
  }
 }
})

test('官方正文的 PTC 模式、派发 provider 或任何插件被改动时仍拒绝启动',()=>{
 for(const preset of ['standard','ptc','minimal','cordis']){
  const rows=[...compositionEntries().entries()].map(entry=>({...entry.options,disabled:entry.disabled}))
  const row=rows.find(row=>row.id==='preset-'+preset)!
  const config=structuredClone(row.config) as {plugins:Record<string,unknown>[]}
  row.config=config
  config.plugins.push({id:'unexpected',name:'@vendor/tool'})
  assert.ok(compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]})).includes('tools'),preset)
 }
})

test('本人可选择每个官方默认预设，而部署默认仍固定 Teloa',async()=>{
 const rows=[...compositionEntries().entries()].map(entry=>({...entry.options,disabled:entry.disabled}))
 const registry=rows.find(row=>row.id==='agent-preset-registry')!
 for(const selectedDefault of ['teloa-standard','standard','ptc','minimal','cordis']){
  registry.config={default:'teloa-standard',selectedDefault}
  assert.deepEqual(compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]})),[],selectedDefault)
 }
 registry.config={default:'standard'}
 assert.ok(compositionViolations(compositionSnapshot(rows,{bundles:[],packages:[]})).includes('agentPresets'))
})

test('岗位缺省遇到本人创造模式时回退 Teloa，显式创造模式不能准备执行',async()=>{
 const resolved:(string|undefined)[]=[],created:string[]=[]
 const ctx={agentPresets:{resolve:async(id?:string)=>{resolved.push(id);return {id:id??'cordis'}}},sessionController:{
  create:async({sessionId,agentPreset}:{sessionId:string;agentPreset:string})=>{created.push(agentPreset);return {sessionId,agentPreset}},
  inspect:async(id:string)=>({meta:{id,agentPreset:created.at(-1)}}),
 }} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'run',status:'ready'}))
 assert.equal(await ports.resolvePreset!(undefined,new AbortController().signal),'teloa-standard')
 assert.equal(await ports.prepareSession!('run',undefined,new AbortController().signal),'teloa-standard')
 await assert.rejects(ports.prepareSession!('run','cordis',new AbortController().signal),/创造模式/)
 assert.deepEqual(created,['teloa-standard'])
 assert.ok(resolved.includes('teloa-standard'))
})

test('受管历史运行不得继续使用创造模式会话',async()=>{
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{agentPreset:'cordis'},snapshotEvents:()=>[]}}
 const ctx={sessionController:{resolveAgent:async()=>({agent})}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'run',status:'ready'}))
 await assert.rejects(ports.check({sessionId:'run',agentPresetId:'cordis'} as TaskRun,new AbortController().signal),/创造模式/)
})
