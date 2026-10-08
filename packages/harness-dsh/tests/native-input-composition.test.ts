import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire,registerHooks} from 'node:module'
import {readFileSync} from 'node:fs'
import {chmod,cp,lutimes,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,utimes,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,dirname,join,relative,resolve as resolvePath} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {applyPatches,clientModuleRegistry,communityRows,compatibilityAPIs,discoveredClientModules,dshVersion,findRow,officialManifestPath,projectRoot,sessionControllerPackage,type Row} from './fixtures/native-input-composition.ts'

// 基线取自本进程加载组合接口之前：末尾用例据此证明“同一提交内加载并调用接口不改变社区默认组合”。
const baseline=JSON.stringify(communityRows())
const resolved:string[]=[]
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);resolved.push(result.url);return result}})
const composition=await import('../src/native-input-composition.ts')
const {loadNativeInputProviders:load,composeNativeInput:compose,assertNativeInputClientFaces:assertFaces,NativeInputCompositionError}=composition

type Cleanup={after:(action:()=>unknown)=>void}
const require=createRequire(import.meta.url)
const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
const providerModule=/\/(?:native-input-provider|managed-session-controller|managed-subagent)\.(?:ts|js)$/
const facePatch=(patch:unknown)=>JSON.stringify(patch).includes('teloa-client-face-')
const faceDirectory=(rows:readonly Row[])=>dirname(fileURLToPath(findRow(rows,'teloa-client-face-session-controller')?.name??''))
const managedServices=(compat:Awaited<ReturnType<typeof load>>):Record<string,unknown>=>({teloaNativeInput:Object.create(compat.input.prototype),sessionController:Object.create(compat.controller.prototype),subagents:Object.create(compat.subagent.prototype)})
const official=JSON.parse(await readFile(officialManifestPath,'utf8')) as {dsh:{client:unknown};exports:{'./client':{default:string}}}
const officialClient=await readFile(join(dirname(officialManifestPath),official.exports['./client'].default))

async function temporary(t:Cleanup){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-input-composition-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 return root
}
/** 实际安装的官方包副本；mutate 模拟宿主已应用的兼容补丁或被改坏的安装。 */
async function installedPackage(t:Cleanup,mutate:(root:string)=>Promise<void>=async()=>{}){
 const root=join(await temporary(t),'node_modules',sessionControllerPackage)
 await cp(dirname(officialManifestPath),root,{recursive:true,dereference:true})
 await mutate(root)
 const manifest=join(root,'package.json')
 return (specifier:string)=>specifier===sessionControllerPackage+'/package.json'?manifest:require.resolve(specifier)
}
async function editManifest(root:string,edit:(manifest:Record<string,unknown>)=>void){
 const path=join(root,'package.json'),manifest=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>
 edit(manifest);await writeFile(path,JSON.stringify(manifest))
}
let loaded:Awaited<ReturnType<typeof load>>|undefined
const providers=async()=>loaded??=await load({compatibilityAPIs:compatibilityAPIs()})

test('兼容能力核对失败时拒绝组合，核对通过前不导入任何受管提供方',async t=>{
 const complete=compatibilityAPIs(),cases:unknown[]=[undefined,null,[],'invalid',{}]
 for(const [name,apis] of Object.entries(composition.nativeInputRequiredAPIs)){
  const missing=structuredClone(complete);delete missing[name];cases.push(missing)
  const partial=structuredClone(complete);partial[name]=(complete[name]??[]).filter(api=>api!==apis[0]);cases.push(partial)
  cases.push({...complete,[name]:apis.join(',')})
 }
 for(const compatibilityAPIs of cases)await assert.rejects(load({compatibilityAPIs}),NativeInputCompositionError)
 await assert.rejects(load({compatibilityAPIs:{...complete,'@deepseek-ai/dsh-api-session-controller':[]}}),/@deepseek-ai\/dsh-api-session-controller/)
 const withoutCheckpoint={...complete,'@deepseek-ai/dsh-agent-loop':(complete['@deepseek-ai/dsh-agent-loop']??[]).filter(name=>!name.includes('Checkpoint'))}
 await assert.rejects(load({compatibilityAPIs:withoutCheckpoint,requireCheckpoint:true}),NativeInputCompositionError)
 for(const requireCheckpoint of [null,1,'true'])await assert.rejects(load({compatibilityAPIs:complete,requireCheckpoint} as never),NativeInputCompositionError)
 // 未经核对的提供方不能直接拿去组合
 const runtimeRoot=await temporary(t)
 await assert.rejects(compose(communityRows(),{providers:Object.freeze({input:class{},controller:class{},subagent:class{}}) as never,runtimeRoot}),NativeInputCompositionError)
 assert.deepEqual(resolved.filter(url=>providerModule.test(url)),[])
 // 核对通过后才导入固定的受管提供方
 const basic=await load({compatibilityAPIs:withoutCheckpoint})
 assert.ok(resolved.some(url=>providerModule.test(url)))
 assert.ok(Object.isFrozen(basic));assert.equal(basic.recoveryCandidate,undefined)
 for(const name of ['input','controller','subagent'] as const)assert.equal(typeof basic[name],'function')
 const durable=await load({compatibilityAPIs:complete,requireCheckpoint:true})
 assert.equal(typeof durable.recoveryCandidate,'function')
 // 核心声明的必需能力均出自随附的官方兼容补丁清单
 for(const version of [dshVersion,'0.2.0-rc.2'])await load({compatibilityAPIs:compatibilityAPIs(version),requireCheckpoint:true})
})

test('替换官方会话控制器行时组合结果包含浏览器面载体行',async t=>{
 const rows=communityRows(),before=JSON.stringify(rows),runtimeRoot=await temporary(t)
 const patches=await compose(rows,{providers:await providers(),runtimeRoot})
 assert.equal(JSON.stringify(rows),before)
 // 宿主通常把补丁写成 JSON 文件再交给官方加载
 const composed=applyPatches(rows,JSON.parse(JSON.stringify(patches)) as unknown[])
 for(const [id,target] of [['session-controller','teloa-managed-session-controller'],['subagent','teloa-managed-subagent']] as const){
  const original=findRow(rows,id),managed=findRow(composed,target)
  assert.equal(findRow(composed,id)?.disabled,true)
  assert.equal(managed?.name,'@teloa/harness-dsh/managed-'+(id==='subagent'?'subagent':'session-controller'))
  assert.deepEqual(managed?.config,original?.config);assert.deepEqual(managed?.inject,original?.inject)
 }
 assert.equal(findRow(composed,'teloa-native-input')?.name,'@teloa/harness-dsh/native-input-provider')
 const loop=findRow(composed,'agent-loop')
 assert.deepEqual(loop?.inject,['teloaNativeInput']);assert.equal((loop?.config as {requireRestoreAdmission?:unknown}).requireRestoreAdmission,true)
 const packages=(findRow(composed,'typert-loader')?.config as {packages:string[]}).packages
 for(const name of [sessionControllerPackage,'@deepseek-ai/dsh-subagent'])assert.ok(packages.includes(name),name)
 // 载体是独立一行，指向运行目录内从官方包生成的浏览器面
 const face=findRow(composed,'teloa-client-face-session-controller'),faceName=face?.name
 assert.ok(face&&typeof faceName==='string'&&faceName.startsWith('file:'));assert.equal(face.disabled,undefined)
 const directory=dirname(fileURLToPath(faceName))
 assert.equal(relative(join(runtimeRoot,'native-client-faces'),dirname(directory)),'')
 const carrier=JSON.parse(await readFile(join(directory,'package.json'),'utf8')) as {name:string;version:string;dsh:unknown;teloaClientFace:{schema:string;source:string;sha256:string}}
 assert.equal(carrier.name,sessionControllerPackage);assert.equal(carrier.version,dshVersion)
 assert.deepEqual(carrier.dsh,{client:official.dsh.client})
 assert.deepEqual(carrier.teloaClientFace,{schema:'teloa.native-client-face/v1',source:sessionControllerPackage,sha256:sha256(officialClient)})
 assert.deepEqual(await readFile(join(directory,'client.js')),officialClient)
 assert.deepEqual((await readdir(directory)).sort(),['client.js','index.mjs','package.json'])
 const host=await import(faceName) as Record<string,unknown>
 assert.deepEqual(Object.keys(host),['apply'])
 // 官方子代理包没有浏览器面，不生成载体
 assert.equal(findRow(composed,'teloa-client-face-subagent'),undefined)
 // 组合后核对通过；官方客户端发现从载体取到会话控制器浏览器面
 assertFaces(composed)
 assert.equal((await discoveredClientModules(composed)).get(sessionControllerPackage),join(directory,'client.js'))
 // 根因复现：只换宿主行、不带载体时官方发现丢失该浏览器面；默认组合由官方行提供
 assert.equal((await discoveredClientModules(applyPatches(rows,patches.filter(patch=>!facePatch(patch))))).has(sessionControllerPackage),false)
 assert.ok((await discoveredClientModules(rows)).has(sessionControllerPackage))
 // 重复启动复用同一载体
 assert.deepEqual(await compose(rows,{providers:await providers(),runtimeRoot}),patches)
})

test('二次替换提供方后载体仍在',async t=>{
 const rows=communityRows(),runtimeRoot=await temporary(t),hostRoot=await temporary(t)
 const patches=await compose(rows,{providers:await providers(),runtimeRoot}),composed=applyPatches(rows,patches)
 await writeFile(join(hostRoot,'package.json'),JSON.stringify({name:'host-session-provider',type:'module'}))
 await writeFile(join(hostRoot,'provider.mjs'),'export function apply(){}\n')
 // 宿主在其后再换一层：停用受管行，插入自己的提供方
 const managed=findRow(composed,'teloa-managed-session-controller') as Row
 const second=[{id:'teloa-managed-session-controller',name:managed.name,disabled:true},{insert:[{...structuredClone(managed),id:'host-session-controller',name:pathToFileURL(join(hostRoot,'provider.mjs')).href}]}]
 const final=applyPatches(rows,[...patches,...second])
 assert.equal(findRow(final,'teloa-managed-session-controller')?.disabled,true)
 const face=findRow(final,'teloa-client-face-session-controller')
 assert.ok(face?.name);assert.equal(face.disabled,undefined)
 assertFaces(final)
 assert.equal((await discoveredClientModules(final)).get(sessionControllerPackage),join(dirname(fileURLToPath(face.name)),'client.js'))
 // 已组合过的树不能再组合一次（不会叠出第二份替换或载体）
 await assert.rejects(compose(composed,{providers:await providers(),runtimeRoot}),NativeInputCompositionError)
})

test('组合后核对：插件图缺少会话控制器浏览器面时抛出明确的启动失败',async t=>{
 const rows=communityRows(),runtimeRoot=await temporary(t),hostRoot=await temporary(t)
 const patches=await compose(rows,{providers:await providers(),runtimeRoot})
 const missing={name:'NativeInputCompositionError',message:/会话控制器.*浏览器面/}
 // 宿主只应用了替换补丁、漏掉载体
 assert.throws(()=>assertFaces(applyPatches(rows,patches.filter(patch=>!facePatch(patch)))),missing)
 // 后续补丁停用了载体行
 assert.throws(()=>assertFaces(applyPatches(rows,[...patches,{id:'teloa-client-face-session-controller',disabled:true}])),missing)
 // 冒名同名包但没有声明浏览器面
 await writeFile(join(hostRoot,'package.json'),JSON.stringify({name:sessionControllerPackage,type:'module'}))
 await writeFile(join(hostRoot,'index.mjs'),'export function apply(){}\n')
 const impostor={insert:[{id:'impostor-face',name:pathToFileURL(join(hostRoot,'index.mjs')).href}]}
 assert.throws(()=>assertFaces(applyPatches(rows,[...patches.filter(patch=>!facePatch(patch)),impostor])),missing)
 // 官方行被重新启用后与载体并存：来源不唯一
 assert.throws(()=>assertFaces(applyPatches(rows,[...patches,{id:'session-controller',disabled:false}])),{name:'NativeInputCompositionError',message:/会话控制器.*浏览器面.*不唯一/})
})

test('载体从实际安装、已打补丁的官方包读取并逐项核对，变化时保留现场拒绝启动',async t=>{
 const rows=communityRows(),runtimeRoot=await temporary(t),compat=await providers()
 // 宿主的兼容补丁若改动官方客户端，载体随实际安装取到改动后的字节
 const patched=Buffer.concat([officialClient,Buffer.from('\n// 兼容补丁\n')])
 const resolve=await installedPackage(t,root=>writeFile(join(root,'lib/client.js'),patched))
 const patches=await compose(rows,{providers:compat,runtimeRoot,resolve}),composed=applyPatches(rows,patches)
 const face=findRow(composed,'teloa-client-face-session-controller'),directory=dirname(fileURLToPath(face?.name??''))
 assert.deepEqual(await readFile(join(directory,'client.js')),patched)
 assertFaces(composed,{resolve})
 // 已有载体被改动：拒绝并保留现场，不覆盖修复
 await writeFile(join(directory,'client.js'),'changed')
 await assert.rejects(compose(rows,{providers:compat,runtimeRoot,resolve}),{name:'NativeInputCompositionError',message:/已变化/})
 assert.equal(await readFile(join(directory,'client.js'),'utf8'),'changed')
 // 载体目录权限被放宽
 const loose=await temporary(t)
 const firstPatches=await compose(rows,{providers:compat,runtimeRoot:loose})
 const looseFace=findRow(applyPatches(rows,firstPatches),'teloa-client-face-session-controller')
 await chmod(dirname(fileURLToPath(looseFace?.name??'')),0o755)
 await assert.rejects(compose(rows,{providers:compat,runtimeRoot:loose}),NativeInputCompositionError)
 // 实际安装的官方包不符合固定版本或包形状
 const broken=[
  (root:string)=>editManifest(root,manifest=>{manifest.version='0.0.0-other'}),
  (root:string)=>editManifest(root,manifest=>{manifest.name='@deepseek-ai/other'}),
  (root:string)=>editManifest(root,manifest=>{manifest.dsh={client:{platform:'node'}}}),
  (root:string)=>editManifest(root,manifest=>{manifest.exports={...manifest.exports as object,'./client':'../outside.js'}}),
  (root:string)=>writeFile(join(root,'lib/client.chunk-1.js'),'chunk'),
 ]
 for(const mutate of broken)await assert.rejects(compose(rows,{providers:compat,runtimeRoot:await temporary(t),resolve:await installedPackage(t,mutate)}),NativeInputCompositionError)
 // 运行目录必须是规范绝对路径
 for(const root of ['relative/root',runtimeRoot+'/../'+runtimeRoot.split('/').at(-1)])await assert.rejects(compose(rows,{providers:compat,runtimeRoot:root}),NativeInputCompositionError)
})

test('行替换补丁保留原配置与父组，异常组合在启动前拒绝',async t=>{
 const compat=await providers(),runtimeRoot=await temporary(t)
 const controller={id:'session-controller',name:sessionControllerPackage,config:{nativeOpen:false},inject:['fs']}
 const subagent={id:'subagent',name:'@deepseek-ai/dsh-subagent',config:{maxDepth:2}}
 const loop={id:'agent-loop',name:'@deepseek-ai/dsh-agent-loop',config:{agents:[]}}
 const loader={id:'typert-loader',name:'@deepseek-ai/dsh-typert-loader',config:{packages:['@deepseek-ai/dsh-tools']}}
 const run=(rows:unknown[],options={})=>compose(rows,{providers:compat,runtimeRoot,...options})
 // 分组内的提供方连同载体在原父组插入；其他预设的重复子 id 不影响
 const grouped=[loop,loader,{id:'host-group',name:'cordis:group',group:true,config:[controller,subagent]},{id:'preset-a',group:true,config:[{id:'tool',name:'a'}]},{id:'preset-b',group:true,config:[{id:'tool',name:'b'}]}]
 const composed=applyPatches(grouped,await run(grouped))
 const group=findRow(composed,'host-group')?.config as Row[]
 for(const id of ['teloa-managed-session-controller','teloa-managed-subagent','teloa-client-face-session-controller'])assert.equal(group.filter(row=>row.id===id).length,1,id)
 assert.deepEqual(group.find(row=>row.id==='teloa-managed-session-controller')?.inject,['fs'])
 assert.deepEqual((findRow(composed,'typert-loader')?.config as {packages:string[]}).packages,['@deepseek-ai/dsh-tools',sessionControllerPackage,'@deepseek-ai/dsh-subagent'])
 // agent-loop 的三种依赖形态都能合并，原配置保留并强制恢复准入
 for(const [inject,expected] of [[['fs'],['fs','teloaNativeInput']],[{fs:null},{fs:null,teloaNativeInput:null}]] as const){
  const rows=[controller,subagent,loader,{...loop,inject,config:{agents:[],requireRestoreAdmission:false}}]
  const merged=findRow(applyPatches(rows,await run(rows)),'agent-loop')
  assert.deepEqual(merged?.inject,expected);assert.deepEqual(merged?.config,{agents:[],requireRestoreAdmission:true})
 }
 // 宿主可指定自己的原生输入提供方模块
 const custom=pathToFileURL(join(runtimeRoot,'input.mjs')).href,basic=[controller,subagent,loop,loader]
 assert.equal(findRow(applyPatches(basic,await run(basic,{inputProvider:custom})),'teloa-native-input')?.name,custom)
 // 缺行、被替换、停用、条件启用、重复、保留 id 冲突与无效形状都在启动前拒绝
 const invalid:unknown[][]=[
  [],[controller],
  [loop,loader,{...controller,name:'other'},subagent],
  [loop,loader,{...controller,disabled:true},subagent],
  [loop,loader,controller,{...subagent,disabled:true}],
  [loop,loader,{...controller,disabled:{__jsExpr:'true'}},subagent],
  [loop,loader,controller,controller,subagent],
  [loop,loader,controller,subagent,{id:'teloa-native-input',name:'other'}],
  [loop,loader,controller,subagent,{id:'teloa-client-face-session-controller',name:'other'}],
  [{...loop,inject:'teloaNativeInput'},loader,controller,subagent],
  [{...loop,config:[]},loader,controller,subagent],
  [loop,{...loader,config:{packages:'x'}},controller,subagent],
  [loop,controller,subagent],
  [loop,loader,{id:'host-group',group:true,config:[controller]},{id:'host-group',group:true,config:[subagent]}],
 ]
 // 组合树核对不通过时不写任何载体
 const untouched=await temporary(t)
 for(const rows of invalid)await assert.rejects(run(rows,{runtimeRoot:untouched}),NativeInputCompositionError)
 assert.deepEqual(await readdir(untouched),[])
 for(const inputProvider of ['',1])await assert.rejects(run(basic,{inputProvider}),NativeInputCompositionError)
 await assert.rejects(compose('rows' as never,{providers:compat,runtimeRoot}),NativeInputCompositionError)
})

test('启动后核对实际装配的是受管提供方实例',async()=>{
 const compat=await providers()
 const services={teloaNativeInput:Object.create(compat.input.prototype),sessionController:Object.create(compat.controller.prototype),subagents:Object.create(compat.subagent.prototype)} as Record<string,unknown>
 assert.doesNotThrow(()=>composition.assertNativeInputProviders({get:name=>services[name]},compat))
 for(const name of Object.keys(services))assert.throws(()=>composition.assertNativeInputProviders({get:key=>key===name?{}:services[key]},compat),NativeInputCompositionError)
 assert.throws(()=>composition.assertNativeInputProviders({get:name=>services[name]},{...compat}),NativeInputCompositionError)
})

test('常驻宿主的 Goal 驱动必须经固定兼容组合并实际绑定同一准入服务',async t=>{
 const complete=compatibilityAPIs(),missing=structuredClone(complete)
 delete missing['@deepseek-ai/dsh-goal-round-driver']
 await assert.rejects(load({compatibilityAPIs:missing,requireGoal:true}),NativeInputCompositionError)
 const compat=await load({compatibilityAPIs:complete,requireGoal:true}),rows=communityRows(),runtimeRoot=await temporary(t)
 const composed=applyPatches(rows,await compose(rows,{providers:compat,runtimeRoot}))
 const original=findRow(rows,'goal-round-driver'),managed=findRow(composed,'teloa-managed-goal-round-driver')
 assert.equal(findRow(composed,'goal-round-driver')?.disabled,true)
 assert.equal(managed?.name,'@teloa/harness-dsh/managed-goal-round-driver')
 assert.deepEqual(managed?.config,original?.config)
 const goal={admit:()=>{}},services={...managedServices(compat),teloaTaskRunGoal:goal,teloaManagedGoalRoundDriver:{version:1,goal}}
 assert.doesNotThrow(()=>composition.assertNativeInputProviders({get:name=>Reflect.get(services,name)},compat))
 assert.throws(()=>composition.assertNativeInputProviders({get:name=>name==='teloaManagedGoalRoundDriver'?{version:1,goal:{admit:()=>{}}}:Reflect.get(services,name)},compat),NativeInputCompositionError)
})

test('载体被改动或权限无效时，拒绝消息给出载体目录与恢复办法，删除后重新生成',async t=>{
 const compat=await providers(),rows=communityRows(),runtimeRoot=await temporary(t)
 const first=await compose(rows,{providers:compat,runtimeRoot}),directory=faceDirectory(applyPatches(rows,first)),base=dirname(directory)
 const refused=async(path:string)=>{
  const error:unknown=await compose(rows,{providers:compat,runtimeRoot}).then(()=>undefined,(caught:unknown)=>caught)
  assert.ok(error instanceof NativeInputCompositionError,String(error))
  assert.ok(error.message.includes('（'+path+'）'),error.message)
  assert.match(error.message,/确认无须留证后删除该目录并重新启动/)
 }
 const recover=async(path:string)=>{await rm(path,{recursive:true,force:true});assert.deepEqual(await compose(rows,{providers:compat,runtimeRoot}),first)}
 // 内容被改动
 await writeFile(join(directory,'client.js'),'changed');await refused(directory);await recover(directory)
 // 载体目录权限放宽（例如运行目录经复制迁移）
 await chmod(directory,0o755);await refused(directory);await recover(directory)
 // 载体目录被换成指向别处的链接
 await rm(directory,{recursive:true});await symlink(await temporary(t),directory);await refused(directory);await recover(directory)
 // 载体根目录权限放宽
 await chmod(base,0o755);await refused(base);await recover(base)
})

test('版本不符与能力缺失的拒绝消息写明实际值与缺项',async t=>{
 const compat=await providers(),rows=communityRows(),complete=compatibilityAPIs(),loop='@deepseek-ai/dsh-agent-loop'
 const resolve=await installedPackage(t,root=>editManifest(root,manifest=>{manifest.version='0.0.0-other'}))
 await assert.rejects(compose(rows,{providers:compat,runtimeRoot:await temporary(t),resolve}),{name:'NativeInputCompositionError',message:/安装为 0\.0\.0-other，核心固定 /})
 await assert.rejects(compose(rows,{providers:compat,runtimeRoot:await temporary(t),resolve}),{message:new RegExp('核心固定 '+dshVersion.replaceAll('.','\\.')+'。')})
 const partial={...complete,[loop]:(complete[loop]??[]).filter(name=>name!=='AgentLoop.requireWorkAdmission'&&name!=='AgentLoop.installRestoreAdmission')}
 await assert.rejects(load({compatibilityAPIs:partial}),{name:'NativeInputCompositionError',message:/@deepseek-ai\/dsh-agent-loop：AgentLoop\.requireWorkAdmission、AgentLoop\.installRestoreAdmission）/})
 const absent:Record<string,unknown>={...complete};delete absent['@deepseek-ai/dsh-compaction-basic']
 await assert.rejects(load({compatibilityAPIs:absent}),{message:/@deepseek-ai\/dsh-compaction-basic：BasicCompactionEngine\.summaryRequestOwner）/})
 const durable={...complete,[loop]:(complete[loop]??[]).filter(name=>name!=='AgentLoop.installProgressCheckpoint')}
 await assert.rejects(load({compatibilityAPIs:durable,requireCheckpoint:true}),{message:/@deepseek-ai\/dsh-agent-loop：AgentLoop\.installProgressCheckpoint）/})
})

test('原生输入栈实际调用的官方准入与检查点补口都在必需能力表内',()=>{
 // 从受管提供方出发沿相对导入走完本包内的原生输入栈，提取实际调用的 require*/install* 补口名称。
 const source=fileURLToPath(new URL('../src/',import.meta.url)),files=new Set<string>()
 const queue=['native-input-provider.ts','managed-session-controller.ts','managed-subagent.ts'].map(name=>join(source,name))
 for(let file=queue.pop();file!==undefined;file=queue.pop()){
  if(files.has(file))continue
  files.add(file)
  for(const match of readFileSync(file,'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+\.ts)'/g))queue.push(resolvePath(dirname(file),match[1]??''))
 }
 const text=[...files].map(file=>readFileSync(file,'utf8')).join('\n')
 // 本包自己声明的辅助函数（如 installNativeAdmission）不是官方补口
 const local=new Set([...text.matchAll(/\bfunction\s+([A-Za-z]+)/g)].map(match=>match[1]))
 const called=new Set([...text.matchAll(/\b(?:require|install)[A-Z][A-Za-z]*(?:Admission|Checkpoint)\b/g)].map(match=>match[0]).filter(name=>!local.has(name)))
 const declared=[...Object.values(composition.nativeInputRequiredAPIs),...Object.values(composition.nativeInputCheckpointAPIs)].flat()
 const covered=(name:string)=>declared.some(api=>api===name||api.endsWith('.'+name)||api.startsWith(name+'('))
 assert.ok(files.size>=5,String(files.size))
 for(const name of ['requireInputAdmission','installPromptAdmission','requireAppendAdmission','installStreamAdmission','requireRestoreAdmission','installProgressCheckpoint'])assert.ok(called.has(name),name)
 assert.deepEqual([...called].filter(name=>!covered(name)),[])
})

test('启动后核对工作台模块表含被替换官方包的浏览器面，作为第二道失败关闭',async t=>{
 const compat=await providers(),rows=communityRows(),services=managedServices(compat)
 const patches=await compose(rows,{providers:compat,runtimeRoot:await temporary(t)})
 const withFace=await clientModuleRegistry(applyPatches(rows,patches)),withoutFace=await clientModuleRegistry(applyPatches(rows,patches.filter(patch=>!facePatch(patch))))
 const ctx=(clientModules:unknown)=>({get:(name:string)=>name==='clientModules'?clientModules:services[name]})
 assert.doesNotThrow(()=>composition.assertNativeInputProviders(ctx(withFace),compat))
 // 宿主漏做组合后核对时，启动后的官方模块表仍能拦下缺面
 assert.throws(()=>composition.assertNativeInputProviders(ctx(withoutFace),compat),{name:'NativeInputCompositionError',message:/模块表缺少会话控制器的浏览器面/})
 for(const malformed of [null,{},{graph:()=>null},{graph:()=>({entries:'x'})},{graph:()=>{throw Error('x')}}])assert.throws(()=>composition.assertNativeInputProviders(ctx(malformed),compat),NativeInputCompositionError)
 // 没有浏览器组合（无 clientModules 服务）时没有浏览器面需要保留
 assert.doesNotThrow(()=>composition.assertNativeInputProviders(ctx(undefined),compat))
})

test('组合成功后清理过期的临时目录，不动当前载体、其他摘要目录、文件与链接',async t=>{
 const compat=await providers(),rows=communityRows(),runtimeRoot=await temporary(t),outside=await temporary(t)
 const patches=await compose(rows,{providers:compat,runtimeRoot}),current=faceDirectory(applyPatches(rows,patches)),base=dirname(current)
 const old=new Date(Date.now()-2*60*60*1000)
 for(const name of ['.staging-old','.staging-fresh','session-controller-0000000000000000'])await mkdir(join(base,name),{mode:0o700})
 await writeFile(join(base,'.staging-old','client.js'),'partial',{mode:0o600})
 await writeFile(join(base,'.staging-file'),'x',{mode:0o600})
 await symlink(outside,join(base,'.staging-link'))
 for(const name of ['.staging-old','.staging-file','session-controller-0000000000000000'])await utimes(join(base,name),old,old)
 await lutimes(join(base,'.staging-link'),old,old);await utimes(outside,old,old)
 assert.deepEqual(await compose(rows,{providers:compat,runtimeRoot}),patches)
 assert.deepEqual((await readdir(base)).sort(),['.staging-file','.staging-fresh','.staging-link',basename(current),'session-controller-0000000000000000'].sort())
 assert.ok((await stat(outside)).isDirectory())
})

test('浏览器面导出取值与官方 clientExportOf 逐条一致',async t=>{
 // 对照真值取自官方：同一份安装副本挂成文件入口行，交给官方 ClientModuleRegistry 发现。
 const compat=await providers(),rows=communityRows()
 const forms:Array<[string,(exports:Record<string,unknown>)=>unknown]>=[
  ['字符串',exports=>({...exports,'./client':'./lib/client.js'})],
  ['{default}',exports=>({...exports,'./client':{default:'./lib/client.js'}})],
  ['{types, default}',exports=>({...exports,'./client':{types:'./lib/types/client/index.d.ts',default:'./lib/client.js'}})],
  ['只有 browser',exports=>({...exports,'./client':{browser:'./lib/client.js'}})],
  ['只有 import',exports=>({...exports,'./client':{import:'./lib/client.js'}})],
  ['browser 与 default 指向不同文件',exports=>({...exports,'./client':{browser:'./lib/index.js',default:'./lib/client.js'}})],
  ['import 与 default 指向不同文件',exports=>({...exports,'./client':{import:'./lib/index.js',default:'./lib/client.js'}})],
  ['default 为嵌套条件',exports=>({...exports,'./client':{default:{import:'./lib/client.js'}}})],
  ['数字',exports=>({...exports,'./client':42})],
  ['null',exports=>({...exports,'./client':null})],
  ['数组',exports=>({...exports,'./client':['./lib/client.js']})],
  ['缺少 ./client',exports=>{const next={...exports};delete next['./client'];return next}],
  ['exports 整体为字符串',()=>'./lib/index.js'],
 ]
 for(const [label,edit] of forms){
  const resolve=await installedPackage(t,root=>editManifest(root,manifest=>{manifest.exports=edit(manifest.exports as Record<string,unknown>)}))
  const root=dirname(resolve(sessionControllerPackage+'/package.json'))
  const official=await clientModuleRegistry([{id:'official',name:pathToFileURL(join(root,'lib/index.js')).href}]).then(
   registry=>({accepted:true as const,path:registry.clientPath(sessionControllerPackage)}),
   (error:unknown)=>({accepted:false as const,reason:error instanceof Error?error.message:String(error)}))
  const ours=await compose(rows,{providers:compat,runtimeRoot:await temporary(t),resolve}).then(
   patches=>({accepted:true as const,directory:faceDirectory(applyPatches(rows,patches))}),
   (error:unknown)=>({accepted:false as const,error}))
  assert.equal(ours.accepted,official.accepted,label)
  if(official.accepted&&ours.accepted){
   assert.ok(official.path,label)
   assert.deepEqual(await readFile(join(ours.directory,'client.js')),await readFile(official.path),label)
  }else if(!official.accepted&&!ours.accepted){
   assert.ok(ours.error instanceof NativeInputCompositionError,label)
   // 拒绝原因与官方同类：官方“没有导出”对应“没有导出浏览器面”，官方“形态不合要求”对应“导出形态无法识别”
   const missing=official.reason.includes('exports no "./client" bundle')
   assert.ok(missing||official.reason.includes('must be a string or an object with a string default'),official.reason)
   assert.match(ours.error.message,missing?/没有导出浏览器面/:/浏览器面导出形态无法识别/,label)
  }
 }
 // 官方不检查导出是否落在包内；这是本接口另加的安全核对，形态合法时仍按位置拒绝。
 await assert.rejects(compose(rows,{providers:compat,runtimeRoot:await temporary(t),resolve:await installedPackage(t,root=>editManifest(root,manifest=>{manifest.exports={...manifest.exports as object,'./client':{default:'../outside.js'}}}))}),{name:'NativeInputCompositionError',message:/不在包内/})
})

test('公共启动入口统一受管组合；调用接口不改写官方 profile 基础树',async t=>{
 // 统一启动入口是唯一装配点，其他产品模块不复制插件行替换。
 // 跳过隐藏目录：其中只有其他测试并发创建、随即删除的临时目录与运行目录，不是源码。
 const files:string[]=[]
 const walk=async(directory:string)=>{
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name)
   if(entry.isDirectory()){if(!entry.name.startsWith('.')&&!['node_modules','lib','dist','tests'].includes(entry.name))await walk(path)}
   else if(/\.(?:ts|tsx|mts|mjs|js|json|ya?ml)$/.test(entry.name))files.push(path)
  }
 }
 for(const directory of ['packages','scripts'])await walk(join(projectRoot,directory))
 files.push(join(projectRoot,'Dockerfile'),join(projectRoot,'compose.yaml'))
 const entry=join(projectRoot,'scripts/runtime/native-runtime-entry.mjs')
 const own=new Set([fileURLToPath(new URL('../src/native-input-composition.ts',import.meta.url)),fileURLToPath(new URL('../package.json',import.meta.url)),entry])
 assert.match(await readFile(entry,'utf8'),/composeNativeInput/)
 assert.ok(files.some(path=>path.includes('/packages/backend/'))&&files.some(path=>path.includes('/packages/client/')))
 for(const path of files.filter(path=>!own.has(path)))assert.doesNotMatch(await readFile(path,'utf8'),/native-input-composition|nativeInputCompos|composeNativeInput/,path)
 // 本进程加载接口并完成多次组合后，重算的社区默认组合与加载前的基线逐字节一致。
 // 基线与重算出自同一提交，只证明接口的加载与调用不影响社区组合；跨提交的组合变化不在本用例范围内。
 const rows=communityRows()
 assert.equal(JSON.stringify(rows),baseline)
 for(const [id,name] of [['session-controller',sessionControllerPackage],['subagent','@deepseek-ai/dsh-subagent']] as const){
  const row=findRow(rows,id);assert.equal(row?.name,name);assert.equal(row?.disabled,undefined)
 }
 for(const id of ['teloa-native-input','teloa-managed-session-controller','teloa-managed-subagent','teloa-client-face-session-controller'])assert.equal(findRow(rows,id),undefined)
 assert.doesNotMatch(baseline,/@teloa\/harness-dsh\/(?:managed-|native-input-provider)/)
 // 默认组合由官方行提供浏览器面，核对只读
 assertFaces(rows);assert.equal(JSON.stringify(rows),baseline)
 // 运行目录内未写入任何载体
 const runtimeRoot=await temporary(t);assertFaces(rows);assert.deepEqual(await readdir(runtimeRoot),[])
})
