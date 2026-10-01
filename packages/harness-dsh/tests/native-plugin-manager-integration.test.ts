import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,symlink,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {setTimeout as delay} from 'node:timers/promises'
import {Context} from '@deepseek-ai/cordis'
import type {PluginInfo,BundleInfo,ChangeResult} from '@deepseek-ai/dsh-plugin-manager'
import TeloaPluginManager from '../src/native-plugin-manager.ts'
import {PENDING_PLUGINS_FILE,pendingBundleConflicts,withProfileLock,writePendingPlugins} from '../src/pending-plugins.ts'

const require=createRequire(import.meta.url)
const officialRequire=createRequire(require.resolve('@deepseek-ai/dsh-plugin-manager/package.json'))
const {Loader,EntryTree,EntryGroup}=await import(officialRequire.resolve('@deepseek-ai/cordis-plugin-loader'))
const {remoteMethods}=await import(officialRequire.resolve('@deepseek-ai/dsh-typert-protocol'))
const gatewayRequire=createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
const {default:TypertGateway}=await import(gatewayRequire.resolve('@deepseek-ai/dsh-api-gateway'))
const {default:TypertRegistry}=await import(createRequire(gatewayRequire.resolve('@deepseek-ai/dsh-api-gateway/package.json')).resolve('@deepseek-ai/dsh-typert-registry'))

/** 真实 Loader、Gateway、PluginManager；仅包管理器执行端换成本地夹具，绝不安装包或联网。 */
class MemoryLoader extends Loader {write(){}}
const pendingName='@fixture/pending'
const optionalName='@fixture/optional'
const officialName='@teloa/im-gateway'
const originalLock='lockfileVersion: fixture-original\n'
const bundleManifest=(name:string)=>({name,version:'1.0.0',engines:{dsh:'0.1.7-rc.1'},exports:{'./package.json':'./package.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}})

async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-manager-')))
 const dir=join(root,'profile'),home=join(root,'home'),anchor=join(root,'installation/package.json')
 for(const path of [dir,home,join(root,'installation')])await mkdir(path,{recursive:true})
 // 随附官方扩展：profile 依赖以 link: 指向程序目录，与 optionalNativeBundleSpecs 登记方式一致。
 const official=join(root,'program/packages/im-gateway')
 await mkdir(official,{recursive:true})
 await writeFile(join(official,'package.json'),JSON.stringify(bundleManifest(officialName)))
 await writeFile(join(official,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'teloa-im-gateway',name:'cordis:pin'}]}]))
 const profile={name:'fixture',private:true,dependencies:{[pendingName]:'1.0.0',[optionalName]:'1.0.0',[officialName]:'link:'+official},dsh:{profile:{bundles:[] as string[]}}}
 await writeFile(join(dir,'package.json'),JSON.stringify(profile))
 await writeFile(join(dir,'pnpm-lock.yaml'),originalLock)
 await mkdir(join(dir,'node_modules/@teloa'),{recursive:true})
 await symlink(official,join(dir,'node_modules',officialName))
 await writeFile(anchor,JSON.stringify({name:'fixture-installation',private:true,dependencies:{}}))
 for(const name of [pendingName,optionalName]){
  const path=join(dir,'node_modules',name)
  await mkdir(path,{recursive:true})
  await writeFile(join(path,'package.json'),JSON.stringify(bundleManifest(name)))
  await writeFile(join(path,'cordis.patch.yml'),JSON.stringify([{insert:[{id:name.split('/')[1]+'-row',name:'cordis:pin'}]}]))
 }
 const rows=[{id:'sandbox-policy',name:'cordis:pin'},{id:'browser-use',name:'cordis:pin'}]
 const patchPath=join(dir,'cordis.patch.yml')
 await writeFile(patchPath,JSON.stringify([{insert:rows}]))
 await writeFile(join(dir,PENDING_PLUGINS_FILE),JSON.stringify({[pendingName+'@1.0.0']:'a'.repeat(64)}))
 const executable=join(root,'package-executor.mjs')
 await writeFile(executable,`import {readFileSync,writeFileSync,appendFileSync,existsSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync('executor-calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='config'){console.log('https://registry.npmjs.org/');process.exit(0)}
if(args[0]==='view'){console.log(JSON.stringify(${JSON.stringify(bundleManifest(pendingName))}));process.exit(0)}
const manifest=JSON.parse(readFileSync('package.json','utf8'));
// 冒名夹具：tarball 包名是 @teloa/im-gateway，或以别名装入一个清单 name 为 @Teloa/ 的包；都会改写 lock 与 node_modules。
const planted=(name,packageName)=>{rmSync('node_modules/'+name,{recursive:true,force:true});mkdirSync('node_modules/'+name,{recursive:true});writeFileSync('node_modules/'+name+'/package.json',JSON.stringify({...${JSON.stringify(bundleManifest('placeholder'))},name:packageName,version:'6.6.6'}));writeFileSync('node_modules/'+name+'/cordis.patch.yml','[]');writeFileSync('pnpm-lock.yaml','lockfileVersion: tampered\\n')};
if(args[0]==='add'&&args[1].endsWith('evil.tgz')){manifest.dependencies['@teloa/im-gateway']='file:evil.tgz';planted('@teloa/im-gateway','@teloa/im-gateway')}
if(args[0]==='add'&&args[1].endsWith('alias.tgz')){manifest.dependencies.innocent='file:alias.tgz';planted('innocent','@Teloa/im-gateway')}
// install：按 lock 重建直接依赖的实链并清掉清单里没有的条目；lock 被改坏或有 fail-install 标记时失败。
if(args[0]==='install'){
 if(existsSync('fail-install')||readFileSync('pnpm-lock.yaml','utf8')!==${JSON.stringify(originalLock)})process.exit(1);
 for(const [name,spec] of Object.entries(manifest.dependencies))if(spec.startsWith('link:')){rmSync('node_modules/'+name,{recursive:true,force:true});symlinkSync(spec.slice(5),'node_modules/'+name)}
 if(!('innocent' in manifest.dependencies))rmSync('node_modules/innocent',{recursive:true,force:true});
 process.exit(0)}
if(args[0]==='remove')delete manifest.dependencies[args[1]];
if(args[0]!=='add'&&args[0]!=='remove')process.exit(2);
writeFileSync('package.json',JSON.stringify(manifest));
`)
 const ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 ctx.provide('profileContext',{name:'fixture',dir,home,patchPath,installAnchor:anchor,cwd:dir,startedBundles:[],overlays:[],packageManager:{command:process.execPath,args:[executable]}})
 await ctx.plugin(MemoryLoader)
 ctx.loader.builtins.pin={apply(){}}
 ctx.loader.builtins.include={
  [EntryGroup.key]:true,
  async apply(child:Context,config:unknown[]){
   const tree=new EntryTree(child)
   tree.write=()=>{}
   child.effect(()=>()=>tree.root.stop())
   await tree.root.update(config)
  },
 }
 await ctx.loader.root.update([{id:'include',name:'cordis:include',group:true,config:rows}])
 await ctx.plugin(TeloaPluginManager,{fallbackRegistries:[]})
 await ctx.plugin(TypertRegistry)
 await ctx.plugin(TypertGateway)
 // Gateway 是官方 peer 依赖，动态加载处只收窄本夹具消费的公开 invoke 端口。
 const gateway=Reflect.get(ctx,'typertGateway') as {invoke(request:{namespace:string;method:string;args:Record<string,unknown>}):Promise<unknown>}
 const rpc=<T>(method:string,args:Record<string,unknown>={}):Promise<T>=>gateway.invoke({namespace:'pluginManager',method,args}) as Promise<T>
 const readProfile=async()=>JSON.parse(await readFile(join(dir,'package.json'),'utf8')) as typeof profile
 return {ctx,dir,patchPath,rpc,readProfile,official}
}

test('真实 Gateway 发现父类 Remote 方法并派发到 Teloa override',async t=>{
 const {ctx,rpc}=await fixture(t)
 const methods=remoteMethods(ctx.pluginManager).map((row:{method:string})=>row.method)
 for(const method of ['listPlugins','listBundles','installBundle','setPluginEnabled','setBundleEnabled','removeBundle'])assert.ok(methods.includes(method),method)
 const rows=await rpc<PluginInfo[]>('listPlugins')
 assert.equal(rows.find(row=>row.entryId==='include:sandbox-policy')?.readOnlyReason,'management-required')
 assert.equal(rows.find(row=>row.entryId==='include:browser-use')?.patchId,'browser-use')
 const bundles=await rpc<BundleInfo[]>('listBundles')
 assert.equal(bundles.find(row=>row.name===pendingName)?.readOnlyReason,'management-required')
 assert.equal(bundles.find(row=>row.name===optionalName)?.removable,true)
})

test('真实远程启停拒绝必需行，允许可选行落盘且返回需要重启',async t=>{
 const {rpc,patchPath}=await fixture(t)
 const before=await readFile(patchPath,'utf8')
 const blocked=await rpc<ChangeResult>('setPluginEnabled',{id:'include:sandbox-policy',enabled:false})
 assert.equal(blocked.application,'failed')
 assert.equal(blocked.error?.code,'management-required')
 assert.equal(await readFile(patchPath,'utf8'),before)
 const allowed=await rpc<ChangeResult>('setPluginEnabled',{id:'include:browser-use',enabled:false})
 assert.equal(allowed.application,'restart-required')
 assert.equal(allowed.changed,true)
 assert.match(await readFile(patchPath,'utf8'),/disabled: true/)
})

test('旧 pending 的启用与卸载经远程调用均被拒绝，可选 bundle 的选择和卸载沿用官方实现',async t=>{
 const {rpc,readProfile}=await fixture(t)
 for(const [method,args] of [['setBundleEnabled',{name:pendingName,enabled:true}],['removeBundle',{name:pendingName}],['setBundleEnabled',{name:'@teloa/bundle',enabled:false}],['removeBundle',{name:'@teloa/bundle'}]] as const){
  const result=await rpc<ChangeResult>(method,args)
  assert.equal(result.application,'failed')
  assert.equal(result.error?.code,'management-required')
  assert.equal(result.changed,false)
 }
 assert.equal((await rpc<ChangeResult>('setBundleEnabled',{name:optionalName,enabled:true})).application,'restart-required')
 assert.deepEqual((await readProfile()).dsh.profile.bundles,[optionalName])
 assert.equal((await rpc<ChangeResult>('setBundleEnabled',{name:optionalName,enabled:false})).application,'restart-required')
 assert.deepEqual((await readProfile()).dsh.profile.bundles,[])
 assert.equal((await rpc<ChangeResult>('removeBundle',{name:optionalName})).application,'restart-required')
 assert.equal(Object.hasOwn((await readProfile()).dependencies,optionalName),false)
})

test('原生重装旧 pending 包不得绕过市场启用核对',async t=>{
 const {rpc,dir}=await fixture(t)
 for(const options of [{},{enabled:false},{enabled:true}]){
  const result=await rpc<ChangeResult>('installBundle',{spec:pendingName+'@1.0.0',options})
  assert.equal(result.application,'failed',JSON.stringify(result))
  assert.equal(result.error?.code,'management-required')
  assert.equal(result.changed,false)
 }
 await assert.rejects(readFile(join(dir,'executor-calls.jsonl'),'utf8'),{code:'ENOENT'},'拒绝必须发生在包解析、下载或改写之前')
 assert.deepEqual(await pendingBundleConflicts(dir),[])
})

test('没有旧 pending 时，原生安装关闭与完成后的立即启用保持分开',async t=>{
 const {rpc,dir,readProfile}=await fixture(t)
 await writeFile(join(dir,PENDING_PLUGINS_FILE),'{}')
 const result=await rpc<ChangeResult>('installBundle',{spec:pendingName+'@1.0.0',options:{enabled:false}})
 assert.equal(result.application,'restart-required')
 assert.deepEqual((await readProfile()).dsh.profile.bundles,[])
 assert.equal((await rpc<ChangeResult>('setBundleEnabled',{name:pendingName,enabled:true})).application,'restart-required')
 assert.deepEqual((await readProfile()).dsh.profile.bundles,[pendingName])
})

for(const method of ['setBundleEnabled','removeBundle','installBundle'])test(`市场持锁写入 pending 时，原生 ${method} 等待并复核记录`,async t=>{
 const {rpc,dir,readProfile}=await fixture(t)
 await writeFile(join(dir,PENDING_PLUGINS_FILE),'{}')
 let release=()=>{},entered=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve})
 const acquired=new Promise<void>(resolve=>{entered=resolve})
 // 与市场 installLocked 相同的写序：全程持锁，先写 pending，包操作在锁内完成。
 const market=withProfileLock(dir,async()=>{
  entered()
  await held
  await writePendingPlugins(dir,{[pendingName+'@1.0.0']:'a'.repeat(64)})
 })
 await acquired
 const args=method==='installBundle'?{spec:pendingName+'@1.0.0',options:{enabled:false}}:{name:pendingName,...method==='setBundleEnabled'?{enabled:true}:{}}
 const native=rpc<ChangeResult>(method,args)
 try{
  assert.equal(await Promise.race([native.then(()=>'finished'),delay(75,'waiting')]),'waiting','市场事务结束前不得启用或删除正在安装的包')
 }finally{release();await market}
 const result=await native
 assert.equal(result.application,'failed')
 assert.equal(result.error?.code,'management-required')
 assert.equal(result.changed,false)
 assert.equal((await readProfile()).dependencies[pendingName],'1.0.0')
 assert.deepEqual(await pendingBundleConflicts(dir),[])
})

test('IM 通道 bundle 与大小写变体、未登记的 @teloa/ 名都不能经原生页启停或移除',async t=>{
 const {rpc,readProfile}=await fixture(t)
 const before=await readProfile()
 assert.equal((await rpc<BundleInfo[]>('listBundles')).find(row=>row.name===officialName)?.readOnlyReason,'management-required')
 for(const name of [officialName,'@Teloa/im-gateway','@TELOA/IM-GATEWAY','@Teloa/bundle'])for(const [method,args] of [['setBundleEnabled',{name,enabled:true}],['setBundleEnabled',{name,enabled:false}],['removeBundle',{name}]] as const){
  const result=await rpc<ChangeResult>(method,args)
  assert.equal(result.application,'failed',name+' '+method)
  assert.equal(result.error?.code,'management-required',name+' '+method)
  assert.equal(result.changed,false,name+' '+method)
 }
 assert.deepEqual(await readProfile(),before)
})

test('原生安装 @teloa/ 规格在解析和包管理器之前拒收',async t=>{
 const {rpc,dir,readProfile}=await fixture(t)
 await writeFile(join(dir,PENDING_PLUGINS_FILE),'{}')
 const before=await readProfile()
 for(const spec of ['@teloa/im-gateway@0.2.0','npm:@Teloa/im-gateway','alias@npm:@TELOA/x']){
  const result=await rpc<ChangeResult>('installBundle',{spec,options:{enabled:true}})
  assert.equal(result.application,'failed',spec)
  assert.equal(result.error?.code,'management-required',spec)
 }
 await assert.rejects(readFile(join(dir,'executor-calls.jsonl'),'utf8'),{code:'ENOENT'})
 assert.deepEqual(await readProfile(),before)
})

for(const [label,spec,planted] of [['tarball 冒名 @teloa/im-gateway','./evil.tgz',officialName],['别名装入清单 name 为 @Teloa/ 的包','innocent@file:./alias.tgz','innocent']] as const)test(`${label}：拒收并恢复清单、lock 与实链，不选入 bundles`,async t=>{
 const {rpc,dir,readProfile,official}=await fixture(t)
 await writeFile(join(dir,PENDING_PLUGINS_FILE),'{}')
 const before=await readProfile()
 const result=await rpc<ChangeResult>('installBundle',{spec,options:{enabled:true}})
 assert.equal(result.application,'failed',JSON.stringify(result))
 assert.equal(result.error?.code,'management-required')
 assert.match(result.error?.diagnostic??'',/已拒收并恢复 package\.json、pnpm-lock\.yaml 与 node_modules/)
 assert.deepEqual(await readProfile(),before)
 assert.equal(await readFile(join(dir,'pnpm-lock.yaml'),'utf8'),originalLock)
 assert.equal(await realpath(join(dir,'node_modules',officialName)),await realpath(official))
 if(planted!==officialName)await assert.rejects(lstat(join(dir,'node_modules',planted)),{code:'ENOENT'})
 const calls=(await readFile(join(dir,'executor-calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[])
 assert.ok(calls.some(args=>args[0]==='install'&&args.includes('--frozen-lockfile')),'须按安装前的 lock 重装')
})

test('冒名安装回滚后重装失败：清单与 lock 恢复，冒名依赖目录被移除，不留指向第三方的官方包名',async t=>{
 const {rpc,dir,readProfile}=await fixture(t)
 await writeFile(join(dir,PENDING_PLUGINS_FILE),'{}')
 await writeFile(join(dir,'fail-install'),'')
 const before=await readProfile()
 const result=await rpc<ChangeResult>('installBundle',{spec:'./evil.tgz',options:{enabled:true}})
 assert.equal(result.application,'failed')
 assert.equal(result.error?.code,'management-required')
 assert.match(result.error?.diagnostic??'',/未能重装依赖目录/)
 assert.deepEqual(await readProfile(),before)
 assert.equal(await readFile(join(dir,'pnpm-lock.yaml'),'utf8'),originalLock)
 await assert.rejects(lstat(join(dir,'node_modules',officialName)),{code:'ENOENT'})
})
