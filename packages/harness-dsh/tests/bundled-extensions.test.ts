import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {bundledExtensionState,createBundledExtensionHandler} from '../src/bundled-extensions.ts'

const projectRoot=resolve(fileURLToPath(new URL('../../../',import.meta.url)))
test('五态判定',()=>{
 assert.equal(bundledExtensionState({inBundles:false,atStart:false,loaded:false}),'available')
 assert.equal(bundledExtensionState({inBundles:true,atStart:false,loaded:false}),'enable-pending')
 assert.equal(bundledExtensionState({inBundles:true,atStart:true,loaded:true}),'active')
 assert.equal(bundledExtensionState({inBundles:true,atStart:true,loaded:false}),'failed')
 assert.equal(bundledExtensionState({inBundles:false,atStart:true,loaded:true}),'disable-pending')
})
test('启动时不在 bundles 里，即使有挂接也不算 active（防第三方抢先挂接）',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-bundled-foreign-')),profileDir=join(home,'profile')
 await mkdir(profileDir,{recursive:true})
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{'@teloa/im-gateway':'link:'+join(projectRoot,'packages/im-gateway')},dsh:{profile:{bundles:['@teloa/bundle']}}}))
 const handler=createBundledExtensionHandler({profileDir,programRoot:projectRoot,runtimeRoot:join(home,'runtime'),bundlesAtStart:['@teloa/bundle'],loaded:()=>true,version:async()=>'0.2.0-alpha.6'})
 assert.equal(((await handler('bundled-extensions/list',{})) as {state:string}[])[0]?.state,'available')
})
test('list/set：启用写入 bundles 回 enable-pending；来源不符回 teloa/forbidden；未知端点 not-found',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-bundled-handler-')),profileDir=join(home,'profile'),runtimeRoot=join(home,'runtime')
 await mkdir(profileDir,{recursive:true})
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{'@teloa/im-gateway':'link:'+join(projectRoot,'packages/im-gateway')},dsh:{profile:{bundles:['@teloa/bundle']}}}))
 const handler=createBundledExtensionHandler({profileDir,programRoot:projectRoot,runtimeRoot,bundlesAtStart:['@teloa/bundle'],loaded:()=>false,version:async()=>'0.2.0-alpha.6',totalMemoryBytes:48*1024**3})
 assert.deepEqual(await handler('bundled-extensions/list',{}),[{id:'im-gateway',packageName:'@teloa/im-gateway',version:'0.2.0-alpha.6',state:'available',configuredChannels:0},{id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.6',state:'available',configuredChannels:0,memoryRisk:false}])
 assert.equal(((await handler('bundled-extensions/set',{extensionId:'im-gateway',enabled:true})) as {state:string}).state,'enable-pending')
 assert.ok(JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dsh.profile.bundles.includes('@teloa/im-gateway'))
 await assert.rejects(handler('bundled-extensions/set',{extensionId:'im-gateway',enabled:false}),{code:'teloa/forbidden'})
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{'@teloa/im-gateway':'link:'+tmpdir()},dsh:{profile:{bundles:[]}}}))
 await assert.rejects(handler('bundled-extensions/set',{extensionId:'im-gateway',enabled:true}),{code:'teloa/forbidden'})
 await assert.rejects(handler('bundled-extensions/set',{extensionId:'x',enabled:true}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('bundled-extensions/other',{}),{code:'teloa/not-found'})
})
test('本地中文检索：available → enable-pending → active → disable-pending；各扩展按包名判定加载；停用后运行时目录与模型缓存不变',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-bundled-embedding-')),profileDir=join(home,'profile'),runtimeRoot=join(home,'runtime')
 const runtimeDir=join(runtimeRoot,'packages','onnxruntime-node@1.30.0'),cacheDir=join(home,'dsh-home','teloa-models','embedding','qwen3-embedding-0.6b','r','fp32')
 await mkdir(profileDir,{recursive:true})
 await mkdir(runtimeDir,{recursive:true});await writeFile(join(runtimeDir,'.teloa-install.json'),'{}')
 await mkdir(cacheDir,{recursive:true});await writeFile(join(cacheDir,'tokenizer.json'),'{}')
 const manifest=(bundles:string[])=>JSON.stringify({dependencies:{'@teloa/im-gateway':'link:'+join(projectRoot,'packages/im-gateway'),'@teloa/local-embedding':'link:'+join(projectRoot,'packages/local-embedding')},dsh:{profile:{bundles}}})
 await writeFile(join(profileDir,'package.json'),manifest(['@teloa/bundle']))
 const state=async(handler:ReturnType<typeof createBundledExtensionHandler>)=>((await handler('bundled-extensions/list',{})) as {id:string;state:string}[]).find(row=>row.id==='local-embedding')?.state
 const loadedPackages:string[]=[]
 const before=createBundledExtensionHandler({profileDir,programRoot:projectRoot,runtimeRoot,bundlesAtStart:['@teloa/bundle'],loaded:()=>false,version:async()=>'0.2.0-alpha.6'})
 assert.equal(await state(before),'available')
 assert.equal(((await before('bundled-extensions/set',{extensionId:'local-embedding',enabled:true})) as {state:string}).state,'enable-pending')
 const bundles=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dsh.profile.bundles as string[]
 assert.deepEqual(bundles,['@teloa/bundle','@teloa/local-embedding'])
 // 重启后：本进程已加载 teloaEmbedding；IM 未加载不影响本扩展
 const after=createBundledExtensionHandler({profileDir,programRoot:projectRoot,runtimeRoot,bundlesAtStart:bundles,loaded:name=>{loadedPackages.push(name);return name==='@teloa/local-embedding'},version:async()=>'0.2.0-alpha.6'})
 assert.equal(await state(after),'active')
 assert.equal(((await after('bundled-extensions/list',{})) as {id:string;state:string}[]).find(row=>row.id==='im-gateway')?.state,'available')
 assert.equal(((await after('bundled-extensions/set',{extensionId:'local-embedding',enabled:false})) as {state:string}).state,'disable-pending')
 assert.deepEqual(JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dsh.profile.bundles,['@teloa/bundle'])
 assert.ok(existsSync(join(runtimeDir,'.teloa-install.json')),'停用不删运行时目录')
 assert.ok(existsSync(join(cacheDir,'tokenizer.json')),'停用不删模型缓存')
 assert.deepEqual([...new Set(loadedPackages)],['@teloa/local-embedding'],'loaded 按包名查询，只问启动时已在组合里的扩展')
 // 来源不是本程序随附目录：拒绝启用
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{'@teloa/local-embedding':'link:'+tmpdir()},dsh:{profile:{bundles:[]}}}))
 await assert.rejects(after('bundled-extensions/set',{extensionId:'local-embedding',enabled:true}),{code:'teloa/forbidden'})
})
test('本地中文检索内存风险：宿主物理内存 ≤ 8 GiB 时 memoryRisk=true（默认 fp32），否则 false；IM 行不带该字段',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-bundled-memory-')),profileDir=join(home,'profile')
 await mkdir(profileDir,{recursive:true})
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{},dsh:{profile:{bundles:['@teloa/bundle']}}}))
 for(const [bytes,risk] of [[8*1024**3,true],[8*1024**3+1,false]] as const){
  const handler=createBundledExtensionHandler({profileDir,programRoot:projectRoot,runtimeRoot:join(home,'runtime'),bundlesAtStart:[],loaded:()=>false,version:async()=>'0.2.0-alpha.6',totalMemoryBytes:bytes})
  const rows=(await handler('bundled-extensions/list',{})) as {id:string;memoryRisk?:boolean}[]
  assert.equal(rows.find(row=>row.id==='local-embedding')?.memoryRisk,risk)
  assert.equal('memoryRisk' in rows.find(row=>row.id==='im-gateway')!,false)
 }
})

// ---- 即时启停（apply）：热套用成功直接回 active/available；不能热套用回待重启；失败恢复 bundles ----
const hotFixture=async(apply:NonNullable<Parameters<typeof createBundledExtensionHandler>[0]['apply']>)=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-bundled-hot-')),profileDir=join(home,'profile')
 await mkdir(profileDir,{recursive:true})
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{'@teloa/im-gateway':'link:'+join(projectRoot,'packages/im-gateway'),'@teloa/local-embedding':'link:'+join(projectRoot,'packages/local-embedding')},dsh:{profile:{bundles:['@teloa/bundle']}}}))
 const loaded=new Set<string>()
 const handler=createBundledExtensionHandler({profileDir,programRoot:projectRoot,runtimeRoot:join(home,'runtime'),bundlesAtStart:['@teloa/bundle'],loaded:name=>loaded.has(name),version:async()=>'0.2.0-alpha.6',apply:async change=>{const result=await apply(change);if(result==='applied'){if(change.enabled)loaded.add(change.packageName);else loaded.delete(change.packageName)}return result}})
 const bundles=async()=>JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dsh.profile.bundles as string[]
 return {handler,bundles}
}
test('即时启停：热套用成功时启用直接回 active、停用直接回 available，再启用仍回 active',async()=>{
 const changes:unknown[]=[]
 const {handler,bundles}=await hotFixture(async change=>{changes.push(change);return 'applied'})
 assert.equal(((await handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true})) as {state:string}).state,'active')
 assert.deepEqual(await bundles(),['@teloa/bundle','@teloa/local-embedding'])
 assert.equal(((await handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:false})) as {state:string}).state,'available')
 assert.deepEqual(await bundles(),['@teloa/bundle'])
 assert.equal(((await handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true})) as {state:string}).state,'active')
 assert.equal(((await handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true})) as {state:string}).state,'active')
 assert.deepEqual(changes,[{packageName:'@teloa/local-embedding',rowId:'teloa-local-embedding',enabled:true},{packageName:'@teloa/local-embedding',rowId:'teloa-local-embedding',enabled:false},{packageName:'@teloa/local-embedding',rowId:'teloa-local-embedding',enabled:true},{packageName:'@teloa/local-embedding',rowId:'teloa-local-embedding',enabled:true}])
})
test('即时启停：不能热套用时保留写入、回 enable-pending / disable-pending（失败回退）',async()=>{
 const {handler,bundles}=await hotFixture(async()=>'restart-required')
 assert.equal(((await handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true})) as {state:string}).state,'enable-pending')
 assert.deepEqual(await bundles(),['@teloa/bundle','@teloa/local-embedding'])
})
test('即时启停：热套用失败时 bundles 恢复原样、状态不变；安全核对不符回 forbidden，其余回 dependency-unavailable',async()=>{
 const {BundledHotApplyError}=await import('../src/bundled-extensions-apply.ts')
 let kind:'refused'|'failed'='refused'
 const {handler,bundles}=await hotFixture(async()=>{throw new BundledHotApplyError('启用后的运行配置没有通过安全检查，已恢复为调用前的状态。',kind,true)})
 await assert.rejects(handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true}),{code:'teloa/forbidden',message:/没有通过安全检查/})
 assert.deepEqual(await bundles(),['@teloa/bundle'])
 kind='failed'
 await assert.rejects(handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true}),{code:'teloa/dependency-unavailable'})
 assert.deepEqual(await bundles(),['@teloa/bundle'])
 assert.equal(((await handler('bundled-extensions/list',{})) as {id:string;state:string}[]).find(row=>row.id==='local-embedding')?.state,'available')
})
test('即时启停：并发点击串行执行，热套用之间不重叠，最终状态与 bundles 一致',async()=>{
 let running=0,overlap=false
 const {handler,bundles}=await hotFixture(async()=>{running+=1;if(running>1)overlap=true;await new Promise(done=>setTimeout(done,20));running-=1;return 'applied'})
 const results=await Promise.all([true,false,true,false,true].map(enabled=>handler('bundled-extensions/set',{extensionId:'local-embedding',enabled}) as Promise<{state:string}>))
 assert.equal(overlap,false)
 assert.equal(results.at(-1)!.state,'active')
 assert.deepEqual(await bundles(),['@teloa/bundle','@teloa/local-embedding'])
})
