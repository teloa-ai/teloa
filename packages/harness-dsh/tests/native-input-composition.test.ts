import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire,registerHooks} from 'node:module'
import {chmod,cp,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,relative} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {applyPatches,communityRows,compatibilityAPIs,discoveredClientModules,dshVersion,findRow,officialManifestPath,projectRoot,sessionControllerPackage,type Row} from './fixtures/native-input-composition.ts'

// 基线取自尚未加载组合接口的进程：后面的默认组合用例逐字节对照它。
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

test('社区版默认组合不调用该接口、结果与现状逐字节一致',async t=>{
 // 社区版自身的组合入口都不引用该接口：bundle 补丁、启动脚本、CLI 与 harness 内其他源码
 const files:string[]=[]
 const walk=async(directory:string)=>{
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name)
   if(entry.isDirectory()){if(!['node_modules','lib'].includes(entry.name))await walk(path)}
   else if(/\.(?:ts|mts|mjs|js|json|ya?ml)$/.test(entry.name))files.push(path)
  }
 }
 for(const directory of ['packages/bundle','packages/cli/src','packages/harness-dsh/src','scripts'])await walk(join(projectRoot,directory))
 files.push(join(projectRoot,'Dockerfile'),join(projectRoot,'compose.yaml'))
 const self=fileURLToPath(new URL('../src/native-input-composition.ts',import.meta.url))
 assert.ok(files.length>50)
 for(const path of files.filter(path=>path!==self))assert.doesNotMatch(await readFile(path,'utf8'),/native-input-composition|nativeInputCompos|composeNativeInput/,path)
 // 本进程已加载接口并完成多次组合，社区版默认组合仍与加载前逐字节一致
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
