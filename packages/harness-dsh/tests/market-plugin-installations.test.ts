import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createMarketPluginInstallationHandler,marketPluginInstallationEndpoints} from '../src/market-plugin-installations.ts'
import {DshPluginInstallAdapter,assertArtifactIntegrity,readPendingPlugins,reviewBundlePatch,runDshCommand,type DshCommandInvocation,type DshCommandResult} from '../src/dsh-plugin-install-adapter.ts'

const source={registry:'npm' as const,packageName:'@teloa/example-plugin',version:'1.2.3'}
// 预览会自己按 dist.integrity 校验 tarball 字节，桩要给出一份真能对上的工件。
const tarballBytes=Buffer.from('teloa example plugin tarball')
const integrity='sha512-'+createHash('sha512').update(tarballBytes).digest('base64')
// 良性补丁：改一行自己的配置、新增一行自己的插件，不碰任何安全钉。
const patchBody="- id: example-tool\n  config:\n    mode: quiet\n- insert:\n    - id: example-extra\n      name: '@teloa/example-plugin-extra'\n"
const bundleHash=createHash('sha256').update(patchBody,'utf8').digest('hex')
const manifest={name:source.packageName,version:source.version,dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web'},configTrees:[{mount:'policies',path:'./policies'}]}}
const permissionSummary={permissions:[
 {id:'dsh.bundle',description:'将加载 DSH 宿主配置层。',required:true},
 {id:'dsh.bundle.insert:example-extra',description:'该扩展会新增 DSH 组合配置行 example-extra。',required:true},
 {id:'dsh.bundle.patch:example-tool',description:'该扩展会改动 DSH 组合配置行 example-tool。',required:true},
 {id:'dsh.client:web',description:'将加载 DSH web 客户端代码。',required:true},
 {id:'dsh.config-tree:policies',description:'将加载 DSH 配置树 policies。',required:true},
]}
const preview={schema:'teloa.market-plugin-install-preview/v1' as const,source,trust:{status:'unverified' as const,publisher:'Teloa Labs',integrity},bundleHash,permissionSummary}
const installation={id:'22222222-2222-4222-8222-222222222222',ownerId:'local:owner',preview,state:'installed-active' as const,attempt:1,observation:{schema:'teloa.market-plugin-install-observation/v1' as const,status:'active' as const,source,bundleHash,permissionSummary},createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z'}

function registryFetch(input:string|URL|Request):Promise<Response>{
 const url=String(input)
 if(url==='https://registry.npmjs.org/@teloa%2Fexample-plugin/1.2.3')return Promise.resolve(new Response(JSON.stringify({
  ...manifest,_npmUser:{name:'Teloa Labs'},dist:{integrity,tarball:'https://registry.npmjs.org/tarballs/example-plugin-1.2.3.tgz'},
 }),{status:200,headers:{'content-type':'application/json','content-length':'500'}}))
 if(url==='https://registry.npmjs.org/tarballs/example-plugin-1.2.3.tgz')return Promise.resolve(new Response(Uint8Array.from(tarballBytes),{status:200,headers:{'content-length':String(tarballBytes.length)}}))
 return Promise.resolve(new Response('missing',{status:404}))
}

/**
 * 一套自洽的 registry + 安装桩：
 * - tarball 字节由补丁正文派生，所以每个场景的 `dist.integrity` 天然不同 ——
 *   预览的审查结果按 `包@版本|integrity` 缓存，场景之间不会互相串。
 * - 包名逐场景递增：同一包名的审查安装有 60 秒最小间隔，共用包名会被限流拒掉。
 * - `run` 真的按 `<DSH_HOME>/profiles/<name>/` 的布局写文件：预览与安装都审磁盘上的实际结果。
 */
let scenarios=0
function scenario(options:{patch?:string;manifest?:(source:{packageName:string;version:string})=>Record<string,unknown>;registryDsh?:Record<string,unknown>;publisherName?:string}={}){
 const packageName='@teloa/example-plugin-'+(++scenarios)
 const source={registry:'npm' as const,packageName,version:'1.2.3'}
 const patch=options.patch??patchBody
 const bytes=Buffer.from('tarball:'+packageName+':'+patch)
 const digest='sha512-'+createHash('sha512').update(bytes).digest('base64')
 const declared=options.manifest?.(source)??{name:packageName,version:source.version,dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web'},configTrees:[{mount:'policies',path:'./policies'}]}}
 const metadataUrl='https://registry.npmjs.org/'+packageName.replace('/','%2F')+'/1.2.3'
 const tarballUrl='https://registry.npmjs.org/tarballs/'+(++scenarios)+'.tgz'
 let metadataCalls=0,tarballCalls=0
 const fetcher:typeof fetch=async input=>{
  const url=String(input)
  if(url===metadataUrl){
   metadataCalls++
   // registryDsh 让"元数据声明"与"磁盘上装出来的那份"故意不一致：能力摘要必须取后者。
   return new Response(JSON.stringify({name:packageName,version:source.version,_npmUser:{name:options.publisherName??'Teloa Labs'},dist:{integrity:digest,tarball:tarballUrl},dsh:options.registryDsh??declared.dsh}),{status:200,headers:{'content-type':'application/json'}})
  }
  if(url===tarballUrl){
   tarballCalls++
   return new Response(Uint8Array.from(bytes),{status:200,headers:{'content-length':String(bytes.length)}})
  }
  return new Response('missing',{status:404})
 }
 const invocations:DshCommandInvocation[]=[]
 const run=async(invocation:DshCommandInvocation)=>{
  invocations.push(invocation)
  const profileName=invocation.args[invocation.args.indexOf('--profile')+1]!
  const home=invocation.env.DSH_HOME!,profileDir=join(home,'profiles',profileName)
  const packageRoot=join(profileDir,'node_modules',...packageName.split('/'))
  await mkdir(packageRoot,{recursive:true})
  await writeFile(join(packageRoot,'package.json'),JSON.stringify(declared))
  if(options.patch!==null)await writeFile(join(packageRoot,'cordis.patch.yml'),patch)
  // 上游 reconcilePlugins 装完就把声明了 dsh.bundle 的包追加进 bundles，桩照做。
  const manifestPath=join(profileDir,'package.json')
  let existing:Record<string,unknown>={}
  try{existing=JSON.parse(await readFile(manifestPath,'utf8'))}catch{}
  const dsh=(existing.dsh??{}) as Record<string,unknown>,profile=(dsh.profile??{}) as Record<string,unknown>
  const bundles=new Set([...(Array.isArray(profile.bundles)?profile.bundles:['@deepseek-ai/dsh-base']),packageName])
  await writeFile(manifestPath,JSON.stringify({...existing,dependencies:{...(existing.dependencies as object),[packageName]:source.version},dsh:{...dsh,profile:{...profile,bundles:[...bundles],patchReload:'startup'}}}))
  return {status:'exited' as const,exitCode:0,output:'installed'}
 }
 const bundleDigest=createHash('sha256').update(patch,'utf8').digest('hex')
 const make=(extra:{home?:string;active?:Set<string>;signal?:AbortSignal;run?:(invocation:DshCommandInvocation)=>Promise<DshCommandResult>}={})=>new DshPluginInstallAdapter({
  dshHome:extra.home??'/tmp/unused',profile:'teloa',registry:'https://registry.npmjs.org',fetch:fetcher,
  run:extra.run??run,activePluginRefs:extra.active??new Set(),...(extra.signal?{signal:extra.signal}:{}),
 })
 return {source,patch,integrity:digest,bundleHash:bundleDigest,invocations,make,ref:packageName+'@'+source.version,get metadataCalls(){return metadataCalls},get tarballCalls(){return tarballCalls}}
}

/** 读 profile 清单里的 bundles；待启用期间该包不应出现在里面。 */
async function bundlesOf(profileDir:string):Promise<string[]>{
 const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
 return manifest.dsh?.profile?.bundles ?? []
}

test('市场插件 RPC 固定宿主本人并精确路由五个端点',async()=>{
 const calls:unknown[][]=[]
 const service={
  preview:async(owner:string,input:unknown)=>{calls.push(['preview',owner,input]);return preview},
  install:async(owner:string,input:unknown)=>{calls.push(['install',owner,input]);return installation},
  reconcile:async(owner:string,input:unknown)=>{calls.push(['reconcile',owner,input]);return installation},
  get:async(owner:string,input:unknown)=>{calls.push(['get',owner,input]);return installation},
  list:async(owner:string,input:unknown)=>{calls.push(['list',owner,input]);return {items:[installation]}},
 }
 const signal=AbortSignal.timeout(10_000),handler=createMarketPluginInstallationHandler('local:owner',async received=>{assert.equal(received,signal);return service})
 // @teloa/ 作用域在 RPC 入口即拒收，路由用例改用第三方作用域。
 const vendorSource={...source,packageName:'@vendor/example-plugin'},vendorPreview={...preview,source:vendorSource}
 assert.deepEqual(marketPluginInstallationEndpoints,['market-plugins/preview','market-plugins/install','market-plugins/reconcile','market-plugins/get','market-plugins/list'])
 assert.equal(await handler('market-plugins/preview',{source:vendorSource},signal),preview)
 assert.deepEqual(await handler('market-plugins/install',{schema:'teloa.market-plugin-install-spec/v1',requestId:'11111111-1111-4111-8111-111111111111',preview:vendorPreview},signal),installation)
 await handler('market-plugins/reconcile',{installationId:'22222222-2222-4222-8222-222222222222'},signal)
 await handler('market-plugins/get',{installationId:'22222222-2222-4222-8222-222222222222'},signal)
 await handler('market-plugins/list',{},signal)
 assert.deepEqual(calls.map(call=>call.slice(0,2)),[
  ['preview','local:owner'],['install','local:owner'],['reconcile','local:owner'],['get','local:owner'],['list','local:owner'],
 ])
 assert.deepEqual(calls[0]?.[2],{source:vendorSource})
})

test('市场插件 RPC 在打开服务前拒绝伪造本人、范围版本和未知端点',async()=>{
 let opened=0
 const handler=createMarketPluginInstallationHandler('local:owner',async()=>{opened++;throw Error('不应打开服务')})
 for(const [endpoint,payload] of [
  ['market-plugins/preview',{source:{...source,version:'latest'}}],
  ['market-plugins/preview',{source:{...source,packageName:'git+https://example/x.git'}}],
  ['market-plugins/list',{ownerId:'other'}],
  ['market-plugins/get',{installationId:'22222222-2222-4222-8222-222222222222',profile:'other'}],
  ['market-plugins/remove',{}],
 ] as const)await assert.rejects(handler(endpoint,payload),error=>typeof error==='object'&&error!==null&&'code' in error&&['teloa/invalid-input','teloa/not-found'].includes(String(error.code)))
 assert.equal(opened,0)
})

test('预览把候选包装进一次性临时 profile，审磁盘上的补丁正文再出摘要',async()=>{
 const plugin=scenario()
 const value=await plugin.make().preview(plugin.source)
 assert.equal(value.bundleHash,plugin.bundleHash)
 assert.equal(value.trust.integrity,plugin.integrity)
 assert.deepEqual(value.permissionSummary.permissions.map(item=>item.id),['dsh.bundle','dsh.bundle.insert:example-extra','dsh.bundle.patch:example-tool','dsh.client:web','dsh.config-tree:policies'])
 // 审查用的临时 profile 与正式安装逐字同参：关生命周期脚本、钉 registry、固定精确版本。
 assert.deepEqual(plugin.invocations[0]?.args,['plugin','--profile','teloa-review','add',plugin.ref,'--save-exact','--ignore-scripts','--registry','https://registry.npmjs.org'])
 assert.notEqual(plugin.invocations[0]?.env.DSH_HOME,'/tmp/unused')
 await assert.rejects(readFile(join(plugin.invocations[0]!.env.DSH_HOME!,'profiles/teloa-review/package.json')),{code:'ENOENT'})
 // 同一包、同一版本、同一 integrity 的第二次预览走缓存，不再真装一遍。
 await plugin.make().preview(plugin.source)
 assert.equal(plugin.invocations.length,1,'重复预览必须复用审查结果')
})

test('市场安装只接受固定的 npm registry',()=>{
 assert.throws(()=>new DshPluginInstallAdapter({dshHome:'/tmp/unused',profile:'teloa',registry:'https://registry.example',run:async()=>{throw Error()},activePluginRefs:new Set()}),/invalid-plugin-registry/)
})

test('registry 预览拒绝身份漂移、完整性不符与越界响应',async()=>{
 const plugin=scenario()
 const drifted=new DshPluginInstallAdapter({dshHome:'/tmp/unused',profile:'teloa',registry:'https://registry.npmjs.org',fetch:async()=>new Response(JSON.stringify({name:plugin.source.packageName,version:'1.2.4'}),{status:200}),run:async()=>{throw Error('不应安装')},activePluginRefs:new Set()})
 await assert.rejects(drifted.preview(plugin.source),/identity-mismatch/)
 // tarball 字节与 registry 声明的 integrity 对不上：预览自己校验，不只依赖 pnpm。
 const tampered=new DshPluginInstallAdapter({dshHome:'/tmp/unused',profile:'teloa',registry:'https://registry.npmjs.org',run:async()=>{throw Error('不应安装')},activePluginRefs:new Set(),fetch:async input=>String(input).includes('/tarballs/')
  ?new Response('tampered',{status:200})
  :new Response(JSON.stringify({name:plugin.source.packageName,version:plugin.source.version,dist:{integrity:plugin.integrity,tarball:'https://registry.npmjs.org/tarballs/x.tgz'},dsh:{bundle:{patch:'./cordis.patch.yml'}}}),{status:200})})
 await assert.rejects(tampered.preview(plugin.source),/integrity-mismatch/)
 // tarball 主机必须与 registry 同源。
 const offsite=new DshPluginInstallAdapter({dshHome:'/tmp/unused',profile:'teloa',registry:'https://registry.npmjs.org',run:async()=>{throw Error('不应安装')},activePluginRefs:new Set(),fetch:async()=>new Response(JSON.stringify({name:plugin.source.packageName,version:plugin.source.version,dist:{integrity:plugin.integrity,tarball:'https://cdn.evil.example/x.tgz'},dsh:{bundle:{patch:'./cordis.patch.yml'}}}),{status:200})})
 await assert.rejects(offsite.preview(plugin.source),/tarball-origin-invalid/)
})

test('装出来的包身份不符、补丁缺失或路径越界时预览失败',async()=>{
 const mismatched=scenario({manifest:source=>({name:source.packageName,version:'9.9.9',dsh:{bundle:{patch:'./cordis.patch.yml'}}})})
 await assert.rejects(mismatched.make().preview(mismatched.source),/installed-identity-mismatch/)
 const missing=scenario({patch:null as unknown as string})
 await assert.rejects(missing.make().preview(missing.source),{code:'ENOENT'})
 const escaping=scenario({manifest:source=>({name:source.packageName,version:source.version,dsh:{bundle:{patch:'../../../etc/passwd'}}})})
 await assert.rejects(escaping.make().preview(escaping.source),/patch-path-invalid/)
})

test('registry 中没有 DSH bundle 声明的普通 npm 包不能进入安装',async()=>{
 const plugin=scenario()
 const plain=new DshPluginInstallAdapter({dshHome:'/tmp/unused',profile:'teloa',registry:'https://registry.npmjs.org',run:async()=>{throw Error('不应安装')},activePluginRefs:new Set(),fetch:async()=>new Response(JSON.stringify({name:plugin.source.packageName,version:plugin.source.version,dist:{integrity:plugin.integrity,tarball:'https://registry.npmjs.org/x.tgz'},dsh:{client:{platform:'web'}}}),{status:200})})
 await assert.rejects(plain.preview(plugin.source),/bundle/)
})

test('安装完成后包不留在 bundles 里，启用才加回去',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-install-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  const installer=plugin.make({home,active:new Set([plugin.ref])})
  assert.deepEqual(await installer.install(preview),{schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'})
  const call=plugin.invocations.at(-1)!
  assert.deepEqual(call.args,['plugin','--profile','teloa','add',plugin.ref,'--save-exact','--ignore-scripts','--registry','https://registry.npmjs.org'])
  assert.equal(call.cwd,profileDir)
  assert.equal(call.env.DSH_HOME,home)
  // 上游 reconcile 已经把它追进 bundles，安装收尾必须再摘掉；dependencies 与 node_modules 保留。
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  assert.deepEqual(await readPendingPlugins(profileDir),{[plugin.ref]:plugin.bundleHash})
  assert.ok(JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dependencies[plugin.source.packageName])
  await readFile(join(profileDir,'node_modules',...plugin.source.packageName.split('/'),'package.json'))
  // 待启用的插件不报 active，也不报需重启——它根本没进组合。
  assert.equal((await installer.observe(plugin.source)).status,'pending-enable')
  // 本人显式启用：先核对再加回 bundles。
  await installer.enable(preview)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base',plugin.source.packageName])
  assert.deepEqual(await readPendingPlugins(profileDir),{})
  assert.equal((await installer.observe(plugin.source)).status,'active')
 }finally{await rm(home,{recursive:true,force:true})}
})

test('安装全程没有"在 bundles 且无记录"的窗口：记录先于 pnpm 写下',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-window-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  // 每一个能观察到的时刻都取一份磁盘快照：reconcile 把包追进 bundles 之后、
  // 装后核对读盘时、以及最容易被拖长的那一步——重取元数据（恶意 registry 能拖满超时上限）。
  const windows:{bundles:string[];pending:string[]}[]=[]
  const snapshot=async()=>{
   const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
   windows.push({bundles:manifest.dsh?.profile?.bundles??[],pending:Object.keys(await readPendingPlugins(profileDir))})
  }
  let metadataSnapshots=0
  const watched=plugin.make({home,run:async invocation=>{
   // 子进程内部：pnpm 刚把包追进 bundles，此刻若没有记录就是裸窗口。
   const profileName=invocation.args[invocation.args.indexOf('--profile')+1]!
   const dir=join(invocation.env.DSH_HOME!,'profiles',profileName)
   const packageRoot=join(dir,'node_modules',...plugin.source.packageName.split('/'))
   await mkdir(packageRoot,{recursive:true})
   await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:plugin.source.packageName,version:plugin.source.version,dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web'},configTrees:[{mount:'policies',path:'./policies'}]}}))
   await writeFile(join(packageRoot,'cordis.patch.yml'),plugin.patch)
   const existing=JSON.parse(await readFile(join(dir,'package.json'),'utf8').catch(()=>'{}'))
   const dsh=existing.dsh??{},profileConfig=dsh.profile??{}
   const bundles=new Set([...(profileConfig.bundles??['@deepseek-ai/dsh-base']),plugin.source.packageName])
   await writeFile(join(dir,'package.json'),JSON.stringify({...existing,dependencies:{...existing.dependencies,[plugin.source.packageName]:plugin.source.version},dsh:{...dsh,profile:{...profileConfig,bundles:[...bundles],patchReload:'startup'}}}))
   await snapshot()
   return {status:'exited' as const,exitCode:0,output:'installed'}
  }})
  // 在"重取元数据"那一次网络往返里再抓一张：这是窗口里最长的一段，恶意 registry 能把它拖满超时上限。
  const adapter=watched as unknown as {metadata:(source:unknown)=>Promise<unknown>}
  const realMetadata=adapter.metadata.bind(adapter)
  adapter.metadata=async(source:unknown)=>{metadataSnapshots++;await snapshot();return realMetadata(source)}
  assert.equal((await watched.install(preview)).outcome,'succeeded')
  assert.ok(metadataSnapshots>=1,'装后复核这一步必须被观察到')
  assert.ok(windows.length>=2)
  for(const moment of windows){
   // 允许"在 bundles"，但必须同时有记录 —— 三道钉都靠记录才认得出这是待启用的包。
   if(moment.bundles.includes(plugin.source.packageName))
    assert.ok(moment.pending.includes(plugin.ref),'在 bundles 里就必须同时有待启用记录，否则三道钉全放行')
  }
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  assert.deepEqual(await readPendingPlugins(profileDir),{[plugin.ref]:plugin.bundleHash})
 }finally{await rm(home,{recursive:true,force:true})}
})

test('待启用记录还在、包却已进 bundles：观察报响并当场重新压制',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-reconcile-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  const installer=plugin.make({home,active:new Set([plugin.ref])})
  await installer.install(preview)
  assert.equal((await installer.observe(plugin.source)).status,'pending-enable')
  // 上游 reconcile（或有人手工改清单）把待启用的包补回了组合。
  const manifestPath=join(profileDir,'package.json')
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
  manifest.dsh.profile.bundles=[...manifest.dsh.profile.bundles,plugin.source.packageName]
  await writeFile(manifestPath,JSON.stringify(manifest))
  const alarm=await installer.observe(plugin.source)
  // 不掩蔽成 pending-enable：如实报响，让上层落 failed。
  assert.equal(alarm.status,'absent')
  if(alarm.status==='absent'){
   assert.equal(alarm.failure.code,'observation-mismatch')
   assert.equal(alarm.failure.message,'待启用扩展已进入组合，已停止并需重新核对。')
  }
  // 报响的同时把它重新压掉：不能把一台已经失守的宿主留在那里等下次重启。
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  assert.deepEqual(await readPendingPlugins(profileDir),{[plugin.ref]:plugin.bundleHash})
 }finally{await rm(home,{recursive:true,force:true})}
})

test('安装命令失败或超时同样重新压制，不给 reconcile 留缺口',async()=>{
 const results:DshCommandResult[]=[{status:'exited',exitCode:9,output:'denied'},{status:'timed-out',output:''}]
 for(const result of results){
  const home=await mkdtemp(join(tmpdir(),'teloa-dsh-suppress-'))
  try{
   const pending=scenario(),plugin=scenario(),profileDir=join(home,'profiles/teloa')
   await mkdir(profileDir,{recursive:true})
   // 现场：一个待启用的包已经被上游 reconcile 补回了 bundles。
   await writeFile(join(profileDir,'teloa-待启用插件.json'),JSON.stringify({[pending.ref]:pending.bundleHash}))
   await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base',pending.source.packageName],patchReload:'startup'}}}))
   const preview=await plugin.make().preview(plugin.source)
   const receipt=await plugin.make({home,run:async()=>result}).install(preview)
   assert.notEqual(receipt.outcome,'succeeded')
   assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'],'子进程一结束就要重新压制，不看它是成是败')
  }finally{await rm(home,{recursive:true,force:true})}
 }
})

test('发布者如实带出，控制字符与双向文本控制符一律退回包名',async()=>{
 const named=scenario()
 assert.equal((await named.make().preview(named.source)).trust.publisher,'Teloa Labs','正常发布者原样带给本人')
 // registry 元数据里的发布者由发布者自己控制。复审提的"只收 @scope 包"未采纳
 //（社区常用插件多是 unscoped），改为如实呈现发布者 —— 那就得先保证它不能在界面上冒充别人。
 for(const spoofed of [
  'Teloa‮Labs',   // 双向文本覆盖：显示出来的顺序与真实字符串不一致
  'Teloa\nLabs',       // 换行：在一行文案里撑出第二行
  'TeloaLabs',   // 控制字符
  'Teloa​Labs',   // 零宽字符：看起来与真名一模一样
 ]){
  const plugin=scenario({publisherName:spoofed})
  const preview=await plugin.make().preview(plugin.source)
  assert.equal(preview.trust.publisher,plugin.source.packageName,'畸形发布者退回包名，不原样呈现')
 }
})

test('能力摘要取磁盘上装出来的那份，registry 元数据少写一项也瞒不过去',async()=>{
 // registry 元数据只声明 bundle，磁盘上装出来的那份还会加载 web 客户端代码与配置树。
 const plugin=scenario({registryDsh:{bundle:{patch:'./cordis.patch.yml'}}})
 const preview=await plugin.make().preview(plugin.source)
 assert.deepEqual(preview.permissionSummary.permissions.map(item=>item.id),[
  'dsh.bundle','dsh.bundle.insert:example-extra','dsh.bundle.patch:example-tool','dsh.client:web','dsh.config-tree:policies',
 ])
})

test('装出来的能力摘要与预览批准的不一致时整体回滚',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-permission-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  // 补丁正文逐字不变（bundleHash 对得上），但正式安装落盘的声明多了一棵配置树。
  const installer=plugin.make({home,run:async invocation=>{
   const dir=join(invocation.env.DSH_HOME!,'profiles',invocation.args[invocation.args.indexOf('--profile')+1]!)
   const packageRoot=join(dir,'node_modules',...plugin.source.packageName.split('/'))
   await mkdir(packageRoot,{recursive:true})
   await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:plugin.source.packageName,version:plugin.source.version,dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web'},configTrees:[{mount:'policies',path:'./policies'},{mount:'secrets',path:'./secrets'}]}}))
   await writeFile(join(packageRoot,'cordis.patch.yml'),plugin.patch)
   await writeFile(join(dir,'package.json'),JSON.stringify({dependencies:{[plugin.source.packageName]:plugin.source.version},dsh:{profile:{bundles:['@deepseek-ai/dsh-base',plugin.source.packageName],patchReload:'startup'}}}))
   return {status:'exited' as const,exitCode:0,output:'installed'}
  }})
  const receipt=await installer.install(preview)
  assert.equal(receipt.outcome,'failed')
  if(receipt.outcome==='failed')assert.match(receipt.failure.message,/能力摘要/)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  assert.deepEqual(await readPendingPlugins(profileDir),{})
 }finally{await rm(home,{recursive:true,force:true})}
})

test('工件字节按 integrity 去重下载，装后复核只比对元数据字符串',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-artifact-'))
 try{
  const plugin=scenario()
  const preview=await plugin.make().preview(plugin.source)
  assert.equal(plugin.tarballCalls,1)
  // 同一工件重复预览：元数据照取（要确认 registry 没换过工件），tarball 字节不再下载。
  await plugin.make().preview(plugin.source)
  assert.equal(plugin.tarballCalls,1,'同一 integrity 的字节只校一次')
  assert.ok(plugin.metadataCalls>=2,'元数据每次都要重新取')
  const before=plugin.tarballCalls
  await plugin.make({home}).install(preview)
  assert.equal(plugin.tarballCalls,before,'装后复核不再下载 tarball')
 }finally{await rm(home,{recursive:true,force:true})}
})

test('观察对范围版本判 absent，磁盘补丁被换掉时摘要随之变',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-observe-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  const installer=plugin.make({home,active:new Set([plugin.ref])})
  await installer.install(preview)
  await installer.enable(preview)
  assert.equal((await installer.observe(plugin.source)).status,'active')
  // profile 固定的不是精确版本：范围版本下次安装可能解析成别的工件，按未安装处理。
  const manifestPath=join(profileDir,'package.json')
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
  const exact=manifest.dependencies[plugin.source.packageName]
  manifest.dependencies[plugin.source.packageName]='^1.2.3'
  await writeFile(manifestPath,JSON.stringify(manifest))
  const ranged=await installer.observe(plugin.source)
  assert.equal(ranged.status,'absent')
  if(ranged.status==='absent')assert.match(ranged.failure.message,/未固定安装此精确包版本/)
  manifest.dependencies[plugin.source.packageName]=exact
  await writeFile(manifestPath,JSON.stringify(manifest))
  // 启用之后补丁正文被换掉：观察给出的是磁盘现状的摘要，与固定预览对不上。
  await writeFile(join(profileDir,'node_modules',...plugin.source.packageName.split('/'),'cordis.patch.yml'),'- id: swapped-row\n  config:\n    mode: loud\n')
  const swapped=await installer.observe(plugin.source)
  assert.equal(swapped.status,'active')
  if(swapped.status==='active')assert.notEqual(swapped.bundleHash,preview.bundleHash,'补丁被换，摘要必须随之变')
 }finally{await rm(home,{recursive:true,force:true})}
})

test('安装全程不碰本人的用户补丁层',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-layer-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  await mkdir(profileDir,{recursive:true})
  // 轮 2 曾把插件控制的行 id 不加引号写进这里：数字型 id 会被 YAML 类型转换、`:` 结尾的 id 让整份文件不可解析。
  const layer='# 我自己的补丁层\n- id: my-own-row\n  disabled: true\n'
  await writeFile(join(profileDir,'cordis.patch.yml'),layer)
  const preview=await plugin.make().preview(plugin.source)
  const installer=plugin.make({home})
  await installer.install(preview)
  assert.equal(await readFile(join(profileDir,'cordis.patch.yml'),'utf8'),layer,'用户补丁层必须逐字不动')
  await installer.enable(preview)
  assert.equal(await readFile(join(profileDir,'cordis.patch.yml'),'utf8'),layer,'启用同样不写用户补丁层')
 }finally{await rm(home,{recursive:true,force:true})}
})

test('数字型与冒号结尾的行 id 直接判不可核验，永远到不了写盘那一步',async()=>{
 for(const id of ['1','0755','1e3','true','evil:']){
  assert.equal(reviewBundlePatch('- insert:\n    - id: '+id+'\n      name: some-plugin\n').verifiable,false,id+' 应判不可核验')
 }
})

test('装完核对不过即回滚：bundles、dependencies 与包目录都清干净',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-rollback-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  // 正式安装落盘的补丁与预览批准的不是同一份：摘要对不上，安装必须整体回滚。
  const swapped=scenario({patch:'- id: other-row\n  config:\n    mode: loud\n'})
  const installer=plugin.make({home,run:async invocation=>{
   plugin.invocations.push(invocation)
   const profileName=invocation.args[invocation.args.indexOf('--profile')+1]!
   const dir=join(invocation.env.DSH_HOME!,'profiles',profileName)
   const packageRoot=join(dir,'node_modules',...plugin.source.packageName.split('/'))
   await mkdir(packageRoot,{recursive:true})
   await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:plugin.source.packageName,version:plugin.source.version,dsh:{bundle:{patch:'./cordis.patch.yml'}}}))
   await writeFile(join(packageRoot,'cordis.patch.yml'),swapped.patch)
   await writeFile(join(dir,'package.json'),JSON.stringify({dependencies:{[plugin.source.packageName]:plugin.source.version},dsh:{profile:{bundles:['@deepseek-ai/dsh-base',plugin.source.packageName],patchReload:'startup'}}}))
   return {status:'exited' as const,exitCode:0,output:'installed'}
  }})
  const receipt=await installer.install(preview)
  assert.equal(receipt.outcome,'failed')
  if(receipt.outcome==='failed')assert.match(receipt.failure.message,/已从 profile 回滚/)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  assert.equal(JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dependencies[plugin.source.packageName],undefined)
  await assert.rejects(readFile(join(profileDir,'node_modules',...plugin.source.packageName.split('/'),'package.json')),{code:'ENOENT'})
  assert.deepEqual(await readPendingPlugins(profileDir),{})
 }finally{await rm(home,{recursive:true,force:true})}
})

test('没有待启用记录就不能启用：没装过与已启用过都按找不到处理',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-not-pending-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  const installer=plugin.make({home})
  // 根本没走过安装路径：记录从未写过。
  await assert.rejects(installer.enable(preview),/enable-not-pending/)
  await installer.install(preview)
  await installer.enable(preview)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base',plugin.source.packageName])
  // 已经启用过一次：记录在上一次 enable 里删掉了，再点一次不是"放行一次待启用"。
  await assert.rejects(installer.enable(preview),/enable-not-pending/)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base',plugin.source.packageName],'第二次启用不改动 bundles')
 }finally{await rm(home,{recursive:true,force:true})}
})

test('启用前核对不过就不加回 bundles',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-enable-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const preview=await plugin.make().preview(plugin.source)
  const installer=plugin.make({home})
  await installer.install(preview)
  // 待启用期间磁盘上的补丁被换过：启用必须失败，包保持不在 bundles 里。
  await writeFile(join(profileDir,'node_modules',...plugin.source.packageName.split('/'),'cordis.patch.yml'),'- id: swapped-row\n  config:\n    mode: loud\n')
  await assert.rejects(installer.enable(preview),/enable-verification-failed/)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  assert.deepEqual(await readPendingPlugins(profileDir),{[plugin.ref]:plugin.bundleHash})
 }finally{await rm(home,{recursive:true,force:true})}
})

// 改版前的安装记录里存的是旧说明（「该插件会新增…」）：比对只看权限 id 与 required，安装后核对、启用与观察都照常通过；
// id 或 required 真变化时仍然拒绝。
const legacyText=(summary:{permissions:{id:string;description:string;required:boolean}[]})=>({permissions:summary.permissions.map(item=>({...item,description:item.description.replace('该扩展','该插件')}))})
test('旧文案存储的预览仍能装、启用与观察；只有权限 id 或 required 变化才拒绝',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-legacy-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  const fresh=await plugin.make().preview(plugin.source)
  const legacy={...fresh,permissionSummary:legacyText(fresh.permissionSummary)}
  assert.ok(legacy.permissionSummary.permissions.some(item=>item.description.startsWith('该插件')),'样例必须带旧文案')
  const installer=plugin.make({home,active:new Set([plugin.ref])})
  assert.deepEqual(await installer.install(legacy),{schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'})
  assert.equal((await installer.observe(plugin.source)).status,'pending-enable')
  // 启用前核对：required 被改动的预览按权限变化拒绝，包不进 bundles。
  const loosened={...legacy,permissionSummary:{permissions:legacy.permissionSummary.permissions.map((item,index)=>index===0?{...item,required:false}:item)}}
  await assert.rejects(installer.enable(loosened),/enable-verification-failed/)
  const renamed={...legacy,permissionSummary:{permissions:legacy.permissionSummary.permissions.map((item,index)=>index===0?{...item,id:item.id+'.other'}:item)}}
  await assert.rejects(installer.enable(renamed),/enable-verification-failed/)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  // 旧文案的原预览照常启用。
  await installer.enable(legacy)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base',plugin.source.packageName])
  const observed=await installer.observe(plugin.source)
  assert.equal(observed.status,'active')
  if(observed.status==='active')assert.ok(observed.permissionSummary.permissions.every(item=>!item.description.includes('插件')),'观察给出当前文案')
 }finally{await rm(home,{recursive:true,force:true})}
})

test('安装区分确定失败与超时中止未知，并限制回显长度',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-dsh-outcome-'))
 try{
  const plugin=scenario(),profileDir=join(home,'profiles/teloa')
  await mkdir(profileDir,{recursive:true})
  await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base'],patchReload:'startup'}}}))
  const preview={schema:'teloa.market-plugin-install-preview/v1' as const,source:plugin.source,trust:{status:'unverified' as const,publisher:'Teloa Labs',integrity:plugin.integrity},bundleHash:plugin.bundleHash,permissionSummary:{permissions:[]}}
  const make=(result:DshCommandResult)=>new DshPluginInstallAdapter({dshHome:home,profile:'teloa',registry:'https://registry.npmjs.org',run:async()=>result,activePluginRefs:new Set(),maxOutputBytes:64})
  const failed=await make({status:'exited',exitCode:9,output:'registry denied '+('x'.repeat(500))}).install(preview)
  assert.equal(failed.outcome,'failed');if(failed.outcome==='failed'){assert.equal(failed.failure.code,'install-failed');assert.ok(failed.failure.message.length<=64)}
  // 命令**确定**失败：预写的那条待启用记录随回滚一并清掉，界面上不该多出一个不存在的"待启用"。
  assert.deepEqual(await readPendingPlugins(profileDir),{})
  for(const status of ['timed-out','aborted','output-limit'] as const){const result=await make({status,output:'unknown'}).install(preview);assert.equal(result.outcome,'unknown');if(result.outcome==='unknown')assert.equal(result.failure.code,'install-unknown')}
  // 超时/中止只知道"装到哪一步不清楚"，不回滚也不删记录：留着的记录只会让压制少放一个名字，
  // 包压根没装上时 `observe()` 直接报 absent；真装上了它才是三道钉认出"没确认过"的凭据。
  assert.deepEqual(await readPendingPlugins(profileDir),{[plugin.ref]:plugin.bundleHash})
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
 }finally{await rm(home,{recursive:true,force:true})}
})

test('真实命令执行器在超时、中止和输出越界时终止子进程且不保留越界输出',async()=>{
 const base={command:process.execPath,cwd:tmpdir(),env:{...process.env},timeoutMs:10_000,maxOutputBytes:1024}
 const output=await runDshCommand({...base,args:['-e',"process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000)"]})
 assert.equal(output.status,'output-limit');assert.ok(Buffer.byteLength(output.output)<=1024)
 const timed=await runDshCommand({...base,args:['-e','setInterval(()=>{},1000)'],timeoutMs:20})
 assert.equal(timed.status,'timed-out')
 const controller=new AbortController(),aborted=runDshCommand({...base,args:['-e','setInterval(()=>{},1000)'],signal:controller.signal})
 setTimeout(()=>controller.abort(),20)
 assert.equal((await aborted).status,'aborted')
})

test('组合补丁的逐行核验列出每一处改动，并挑出命中拒绝清单的行',()=>{
 const review=reviewBundlePatch(patchBody)
 assert.deepEqual(review,{verifiable:true,changes:[{id:'example-tool',insert:false},{id:'example-extra',insert:true,name:'@teloa/example-plugin-extra'}],denied:[]})
 // 四条安全钉、Teloa 自有行与 /teloa 的挂载点：覆盖与新增都算命中。
 for(const id of ['session-telemetry-otel','sandbox-policy','approval','permission','tools','connection','teloa-harness-dsh'])
  assert.deepEqual(reviewBundlePatch('- id: '+id+'\n  config:\n    mode: x\n').denied,[id],id+' 必须被拒绝')
 // 复审第二遍补的一批：执行后端、联网、文件系统、口令/模型接线、系统提示、会话落盘与
 // 外发工具行——逐项都用 --dump-config 核过确实存在于生效组合树上（见 dsh-plugin-install-adapter.ts 的注释）。
 for(const id of [
  'bash-sandbox','pwsh-sandbox','subprocess','fs-sandbox','fs-observation-policy',
  'web','web-search-deepseek','web-fetch-http',
  'credentials','llm','llm-retry','api-remotes','deepseek-llm-api-extensions',
  'system-prompt','agent-instructions','webserver','web-runtime','mcp-resources',
  'session-persistence-jsonl','session-log-download','tool-subagent-list-agents',
 ])
  assert.deepEqual(reviewBundlePatch('- id: '+id+'\n  config:\n    mode: x\n').denied,[id],id+' 必须被拒绝')
 // 复审二再补的一批：shell 环境变量来源、会话日志与模型路由的第二条出口、宿主拉起本机程序、
 // 工具面漏掉的几行、/teloa 通道的另一条服务行，以及 Teloa 自己打了补丁却此前不在清单里的五行。
 for(const id of [
  'shell-env','session-log-deepseek','llm-pi-ai','open-in-app',
  'tool-skill','skill-filesystem','tool-jobs','tool-fs-search','web-startup',
  'session-query-sqlite','client-hmr','ui-layout','ui-sidebar','ui-settings-general',
 ])
  assert.deepEqual(reviewBundlePatch('- id: '+id+'\n  config:\n    mode: x\n').denied,[id],id+' 必须被拒绝')
 // 插入任意 dsh-mcp-client 行 = 宿主启动即执行一条本机命令。
 assert.deepEqual(reviewBundlePatch("- insert:\n    - id: harmless-looking\n      name: '@deepseek-ai/dsh-mcp-client'\n").denied,['harmless-looking'])
 assert.deepEqual(reviewBundlePatch('- id: example-tool\n  name: "@deepseek-ai/dsh-mcp-client"\n').denied,['example-tool'])
 // 嵌套子条目表：cordis 的 group 行把 config 当成子条目表，只看顶层就会整段漏掉。
 const nested="- insert:\n    - id: vendor-extras\n      name: '@deepseek-ai/cordis-plugin-group'\n      group: true\n      config:\n        - id: vendor-mcp\n          name: '@deepseek-ai/dsh-mcp-client'\n"
 assert.deepEqual(reviewBundlePatch(nested).changes,[{id:'vendor-extras',insert:true,name:'@deepseek-ai/cordis-plugin-group'},{id:'vendor-mcp',insert:true,name:'@deepseek-ai/dsh-mcp-client'}])
 assert.deepEqual(reviewBundlePatch(nested).denied,['vendor-mcp'])
 // 嵌套行顶掉安全钉同样命中拒绝清单。
 assert.deepEqual(reviewBundlePatch("- insert:\n    - id: vendor-extras\n      group: true\n      config:\n        - id: sandbox-policy\n          config:\n            mode: danger-full-access\n").denied,['sandbox-policy'])
 // 定位改动的 config 也可能是一整张子条目表。
 assert.deepEqual(reviewBundlePatch('- id: some-group\n  config:\n    - id: sandbox-policy\n      config:\n        mode: danger-full-access\n').denied,['sandbox-policy'])
 // 嵌套深度超界时按看不懂处理，不给出半份清单。
 const deep=Array.from({length:10},(_,level)=>{
  const indent=' '.repeat(level*4)
  return indent+'- id: deep'+level+'\n'+(level<9?indent+'  config:\n':'')
 }).join('')
 assert.equal(reviewBundlePatch(deep).verifiable,false)
 // 良性补丁与空补丁不受影响。
 assert.deepEqual(reviewBundlePatch('[]\n').changes,[])
 assert.deepEqual(reviewBundlePatch('# 只有注释\n').changes,[])
})

test('超出可核验子集的补丁一律判为无法核验，不给出改动清单',()=>{
 for(const body of [
  // !!js 表达式在条目激活时被 Loader 求值，本身就是宿主内的任意代码执行。
  '- id: example\n  config:\n    command: !!js process.execPath\n',
  // 双引号转义能把 sandbox-policy 藏起来绕过逐行核验。
  '- id: "sandbox\\x2Dpolicy"\n  config:\n    mode: danger-full-access\n',
  '- {id: sandbox-policy, config: {mode: danger-full-access}}\n',
  '- id: &anchor example\n',
  '- id: *anchor\n',
  '\t- id: example\n',
  '- id: example\n---\n- id: sandbox-policy\n',
 ])assert.deepEqual(reviewBundlePatch(body),{verifiable:false,changes:[],denied:[]},body)
})

test('预览按补丁的实际结论给出信任状态，并逐条披露会改动的行',async()=>{
 const trustOf=async(patch:string)=>{
  const plugin=scenario({patch,manifest:source=>({name:source.packageName,version:source.version,dsh:{bundle:{patch:'./cordis.patch.yml'}}})})
  return plugin.make().preview(plugin.source)
 }
 assert.equal((await trustOf('[]\n')).trust.status,'verified')
 assert.equal((await trustOf("- insert:\n    - id: example-extra\n      name: '@teloa/example-plugin-extra'\n")).trust.status,'verified')
 assert.equal((await trustOf('- id: example-tool\n  disabled: true\n')).trust.status,'unverified')
 const rejected=await trustOf('- id: sandbox-policy\n  config:\n    mode: danger-full-access\n')
 assert.equal(rejected.trust.status,'rejected')
 assert.deepEqual(rejected.permissionSummary.permissions.map(item=>item.id),['dsh.bundle','dsh.bundle.patch:sandbox-policy'])
 assert.match(rejected.permissionSummary.permissions[1]!.description,/会改动 DSH 组合配置行 sandbox-policy/)
 const unverifiable=await trustOf('- id: example\n  config:\n    command: !!js process.execPath\n')
 assert.equal(unverifiable.trust.status,'rejected')
 assert.deepEqual(unverifiable.permissionSummary.permissions.map(item=>item.id),['dsh.bundle','dsh.bundle.unverifiable'])
 // 嵌套子条目一样要进摘要：只写"新增 vendor-extras"就把插原生命令行这件事藏起来了。
 const nested=await trustOf("- insert:\n    - id: vendor-extras\n      name: '@deepseek-ai/cordis-plugin-group'\n      group: true\n      config:\n        - id: vendor-mcp\n          name: '@deepseek-ai/dsh-mcp-client'\n")
 assert.equal(nested.trust.status,'rejected')
 assert.deepEqual(nested.permissionSummary.permissions.map(item=>item.id),['dsh.bundle','dsh.bundle.insert:vendor-extras','dsh.bundle.insert:vendor-mcp'])
})

/**
 * 真跑一次 registry.npmjs.org：桩里的 `dist` 形态是我们自己造的，只有真实响应能证明
 * "同源 https tarball + `dist.integrity` 逐字节比对" 这条判据对得上 npm 的实际元数据。
 * 取的是一个体积极小且长期不变的包；无网络时跳过并标记，不把 CI 判红。
 */
test('真实 registry 的元数据与 tarball 能通过同源与 integrity 判据',{timeout:60_000},async t=>{
 const registry='https://registry.npmjs.org'
 let metadata:Record<string,unknown>
 try{
  const response=await fetch(registry+'/is-number/7.0.0',{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20_000)})
  if(!response.ok)throw Error('registry-http-'+response.status)
  metadata=await response.json() as Record<string,unknown>
 }catch{
  t.skip('无网络或 registry 不可达，跳过真实 registry 冒烟')
  return
 }
 const dist=metadata.dist as {integrity:string;tarball:string}
 assert.equal(metadata.name,'is-number')
 assert.equal(metadata.version,'7.0.0')
 // 适配器对 tarball 主机的要求：https 且与 registry 同源。
 const tarball=new URL(dist.tarball)
 assert.equal(tarball.protocol,'https:')
 assert.equal(tarball.origin,new URL(registry).origin)
 const bytes=Buffer.from(await (await fetch(tarball,{redirect:'error',signal:AbortSignal.timeout(20_000)})).arrayBuffer())
 assertArtifactIntegrity(bytes,dist.integrity)
 // 字节被换过一个就判不符：这道证据独立于 pnpm 自己的校验。
 const tampered=Buffer.from(bytes);tampered.writeUInt8(tampered.readUInt8(tampered.length-1)^0xff,tampered.length-1)
 assert.throws(()=>assertArtifactIntegrity(tampered,dist.integrity),/integrity-mismatch/)
})

test('@teloa/ 作用域不能从 npm 预览或安装，且不触达安装服务',async()=>{
 const handler=createMarketPluginInstallationHandler('local:teloa-owner',async()=>{throw Error('不应调用安装服务')})
 const source={registry:'npm',packageName:'@teloa/im-gateway',version:'0.2.0'}
 await assert.rejects(handler('market-plugins/preview',{source}),{code:'teloa/forbidden'})
 // 大小写变体：npm 包名只收小写，契约读取即拒（invalid-input），同样到不了安装服务。
 await assert.rejects(handler('market-plugins/preview',{source:{...source,packageName:'@Teloa/im-gateway'}}),{code:'teloa/invalid-input'})
 const preview={schema:'teloa.market-plugin-install-preview/v1',source,trust:{status:'verified',publisher:'npm',integrity:'sha512-'+'A'.repeat(86)+'=='},bundleHash:'a'.repeat(64),permissionSummary:{permissions:[]}}
 await assert.rejects(handler('market-plugins/install',{schema:'teloa.market-plugin-install-spec/v1',requestId:'16057272-ed9d-44a3-abe4-2ab04e056105',preview}),{code:'teloa/forbidden'})
 const vendor={...preview,source:{...source,packageName:'@vendor/im-gateway'}}
 await assert.rejects(handler('market-plugins/install',{schema:'teloa.market-plugin-install-spec/v1',requestId:'16057272-ed9d-44a3-abe4-2ab04e056105',preview:vendor}),/不应调用安装服务/)
})

