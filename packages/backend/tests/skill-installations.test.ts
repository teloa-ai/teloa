import test,{after,before,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {initializeSkillInstallations,SkillInstallationService,type NativeSkillMetadata,type SkillInstallationFilesPort} from '../src/market/skill-installations.ts'
import {readSkillSelection} from '../src/market/skill-selections.ts'
import {readInstalledSkillBinding} from '../src/market/skill-availability.ts'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import type {SkillInstallSourceBundle,SkillInstallSourceInput} from '../src/market/skill-install-source.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-12T12:00:00.000Z',identity={id:randomUUID,now:()=>now},owner=randomUUID(),hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const atomicId=randomUUID(),bundleHash=hash('bundle'),native:NativeSkillMetadata={name:'research-brief',description:'形成研究简报',modelInvocable:true,userInvocable:true,bodyHash:hash('body')}
const atomicSource={kind:'atomic' as const,contentId:atomicId,contentHash:hash('atomic'),resourceId:'research-brief',resourceVersion:'1.0.0'}
const bundle=(source:import('../src/market/skill-install-source.ts').SkillInstallSourceIdentity=atomicSource):SkillInstallSourceBundle=>({ownerId:owner,source,entryPath:'SKILL.md',files:[{path:'SKILL.md',hash:hash('skill'),bytes:new TextEncoder().encode('skill')}],bundleHash})
const trust={publisher:'Teloa Labs',repository:{host:'github.com' as const,owner:'teloa-ai',repo:'research'},license:{status:'declared' as const,value:'Apache-2.0'},signature:{status:'unverified' as const,signer:null},compatibility:{teloa:'>=0.0.1 <1.0.0',dsh:'>=0.1.2-alpha.3 <0.2.0'},plugins:[{id:'research-renderer',version:'1.0.0',required:false}],externalCapabilities:[{id:'knowledge-search',kind:'mcp' as const,required:true}],permissions:[{id:'knowledge.read',description:'读取获准知识',required:true}],review:{conclusion:'needs-review' as const,summary:'签名尚未验证'}}
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const trustedBundle=(status:'verified'|'unverified'|'invalid'='unverified'):SkillInstallSourceBundle=>{const fixed={...trust,signature:{status,signer:status==='verified'?'teloa-release':null}};return {...bundle(),trust:fixed,trustHash:hash(stable(fixed))}}
class Reader{values=new Map<string,SkillInstallSourceBundle>();calls=0;async read(who:string,input:SkillInstallSourceInput){this.calls++;if(who!==owner)throw new WorkError('teloa/forbidden','wrong owner');const value=this.values.get(JSON.stringify(input));if(!value)throw new WorkError('teloa/source-unavailable','missing');return structuredClone(value)}}
class Files implements SkillInstallationFilesPort{published:string[]=[];verified:string[]=[];lose=false;slow=false;active=0;maxActive=0;metadata:NativeSkillMetadata=native;async inspect(){return this.metadata}async publish(id:string){this.active++;this.maxActive=Math.max(this.maxActive,this.active);try{this.published.push(id);if(this.slow)await new Promise(resolve=>setTimeout(resolve,30));if(this.lose){this.lose=false;throw new WorkError('teloa/storage-unavailable','lost')}}finally{this.active--}}async verify(id:string){this.active++;this.maxActive=Math.max(this.maxActive,this.active);try{this.verified.push(id);if(this.slow)await new Promise(resolve=>setTimeout(resolve,30))}finally{this.active--}}}
const setup=(reader=new Reader(),files=new Files())=>({reader,files,service:new SkillInstallationService(pool,identity,reader,files)})

before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeSkillInstallations(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
beforeEach(async()=>{await pool.query('truncate teloa_skill_selection_requests,teloa_skill_install_maintenance_requests,teloa_skill_install_availability,teloa_skill_install_usages,teloa_skill_install_requests,teloa_skill_selections,teloa_skill_installations')})

test('预览仅检查固定bundle并返回无字节文件清单',async()=>{const {reader,service}=setup(),input={kind:'atomic' as const,contentId:atomicId};reader.values.set(JSON.stringify(input),bundle());const value=await service.preview(owner,{source:input});assert.deepEqual(value,{source:atomicSource,bundleHash,native,files:[{path:'SKILL.md',hash:hash('skill'),size:5}]});assert.deepEqual(await service.list(owner,{}),{items:[],usages:[]})})

test('安装预览如实列出 Skill、独立插件、MCP 连接和权限，invalid 签名拒装',async()=>{
 const {reader,service}=setup(),input={kind:'atomic' as const,contentId:atomicId},unverified=trustedBundle()
 reader.values.set(JSON.stringify(input),unverified)
 const preview=await service.preview(owner,{source:input})
 assert.equal(preview.trust?.signature.status,'unverified')
 assert.deepEqual(preview.installationPlan,{skills:[{id:'research-brief',version:'1.0.0',path:'SKILL.md'}],plugins:trust.plugins,connections:trust.externalCapabilities,permissions:trust.permissions})
 reader.values.set(JSON.stringify(input),trustedBundle('invalid'))
 await assert.rejects(service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:bundleHash,expectedTrustHash:trustedBundle('invalid').trustHash}),{code:'teloa/source-unavailable'})
})

test('旧安装回执在来源信任声明变化后仍可读，新安装必须按新预览摘要重新核对',async()=>{
 const {reader,service}=setup(),input={kind:'atomic' as const,contentId:atomicId},first=trustedBundle('verified')
 reader.values.set(JSON.stringify(input),first)
 const installed=(await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:first.bundleHash,expectedTrustHash:first.trustHash})).installation
 const changed=trustedBundle();reader.values.set(JSON.stringify(input),changed)
 assert.equal(changed.bundleHash,first.bundleHash);assert.notEqual(changed.trustHash,first.trustHash)
 assert.equal((await service.get(owner,{installationId:installed.id})).trust?.signature.status,'verified')
 await assert.rejects(service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:first.bundleHash,expectedTrustHash:first.trustHash}),{code:'teloa/source-unavailable'})
 const replacement=(await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:changed.bundleHash,expectedTrustHash:changed.trustHash})).installation
 assert.notEqual(replacement.id,installed.id);assert.equal(replacement.trustHash,changed.trustHash);assert.equal(replacement.trust?.signature.status,'unverified')
 assert.equal((await service.get(owner,{installationId:installed.id})).trustHash,first.trustHash)
})

test('行业来源信任更新创建新安装，并把同一 usage 原子迁移到新信任身份',async()=>{
 const {reader,service}=setup(),input={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()},fixed={...atomicSource,kind:'industry-local' as const,loadId:input.loadId,itemInstanceId:input.itemInstanceId},first=trustedBundle('verified')
 reader.values.set(JSON.stringify(input),{...first,source:fixed})
 const old=(await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:first.bundleHash,expectedTrustHash:first.trustHash})).installation
 const changed=trustedBundle();reader.values.set(JSON.stringify(input),{...changed,source:fixed})
 const current=(await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:changed.bundleHash,expectedTrustHash:changed.trustHash})).installation
 assert.notEqual(current.id,old.id);assert.equal(current.trustHash,changed.trustHash)
 assert.deepEqual((await service.list(owner,{})).usages,[{loadId:input.loadId,itemInstanceId:input.itemInstanceId,installationId:current.id}])
})

test('升级前含信任快照的旧 sourceKey 安装仍可读，同信任新请求复用并迁移身份键',async()=>{
 const {reader,service}=setup(),input={kind:'atomic' as const,contentId:atomicId},fixed=trustedBundle('verified')
 reader.values.set(JSON.stringify(input),fixed)
 const installed=(await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:fixed.bundleHash,expectedTrustHash:fixed.trustHash})).installation
 const legacyKey=hash(stable(['atomic',atomicSource.contentId,atomicSource.contentHash,atomicSource.resourceId,atomicSource.resourceVersion]))
 await pool.query('update teloa_skill_installations set source_key=$2 where id=$1',[installed.id,legacyKey])
 assert.equal((await service.get(owner,{installationId:installed.id})).trustHash,fixed.trustHash)
 const replayed=(await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:fixed.bundleHash,expectedTrustHash:fixed.trustHash})).installation
 assert.equal(replayed.id,installed.id);assert.notEqual((await pool.query('select source_key from teloa_skill_installations where id=$1',[installed.id])).rows[0].source_key,legacyKey)
})

test('发布回包未知保留preparing并由同请求恢复，installed重试实际verify',async()=>{const {reader,files,service}=setup(),source={kind:'atomic' as const,contentId:atomicId},requestId=randomUUID();reader.values.set(JSON.stringify(source),bundle());files.lose=true;await assert.rejects(service.install(owner,{requestId,source,expectedBundleHash:bundleHash}),{code:'teloa/storage-unavailable'});const preparing=(await service.list(owner,{})).items.at(-1)!;assert.equal(preparing.state,'preparing');assert.equal(preparing.version,1);const restored=await service.install(owner,{requestId,source,expectedBundleHash:bundleHash}),installed=restored.installation;assert.equal(installed.id,preparing.id);assert.equal(installed.state,'installed');assert.equal(installed.version,2);const retry=await service.install(owner,{requestId,source,expectedBundleHash:bundleHash});assert.equal(retry.installation.id,installed.id);assert.deepEqual(files.verified,[installed.id])})

test('行业公共别名跨load复用真实原子安装并分别保存usage',async()=>{const {reader,service}=setup(),loadA=randomUUID(),loadB=randomUUID(),itemA=randomUUID(),itemB=randomUUID(),publicSource=(loadId:string,itemInstanceId:string,alias:string)=>({kind:'industry-public' as const,loadId,itemInstanceId,contentId:randomUUID(),contentHash:hash(loadId),sourceContentId:atomicId,sourceContentHash:atomicSource.contentHash,sourceResourceId:'research-brief',sourceResourceVersion:'1.0.0',resourceId:alias,resourceVersion:'1.0.0'}),inputA={kind:'industry' as const,loadId:loadA,itemInstanceId:itemA},inputB={kind:'industry' as const,loadId:loadB,itemInstanceId:itemB};reader.values.set(JSON.stringify(inputA),bundle(publicSource(loadA,itemA,'alias-a')));reader.values.set(JSON.stringify(inputB),bundle(publicSource(loadB,itemB,'alias-b')));const a=await service.install(owner,{requestId:randomUUID(),source:inputA,expectedBundleHash:bundleHash}),b=await service.install(owner,{requestId:randomUUID(),source:inputB,expectedBundleHash:bundleHash});assert.equal(a.installation.id,b.installation.id);assert.equal(b.source.kind,'industry-public');assert.equal(b.source.resourceId,'alias-b');assert.deepEqual((await service.list(owner,{})).usages.map(x=>[x.loadId,x.itemInstanceId,x.installationId]).sort(),[[loadA,itemA,a.installation.id],[loadB,itemB,a.installation.id]].sort())})

test('行业本地相同包资源跨load复用，异来源同原生名保留不可变安装且不自动切换',async()=>{const {reader,service}=setup(),make=(loadId:string,itemInstanceId:string,contentId:string)=>({kind:'industry-local' as const,loadId,itemInstanceId,contentId,contentHash:hash(contentId),resourceId:'brief',resourceVersion:'1.0.0'}),a={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()},b={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()},contentId=randomUUID();reader.values.set(JSON.stringify(a),bundle(make(a.loadId,a.itemInstanceId,contentId)));reader.values.set(JSON.stringify(b),bundle(make(b.loadId,b.itemInstanceId,contentId)));const first=await service.install(owner,{requestId:randomUUID(),source:a,expectedBundleHash:bundleHash}),second=await service.install(owner,{requestId:randomUUID(),source:b,expectedBundleHash:bundleHash});assert.equal(first.installation.id,second.installation.id);const other={kind:'atomic' as const,contentId:randomUUID()};reader.values.set(JSON.stringify(other),bundle({...atomicSource,contentId:other.contentId,contentHash:hash('other')}));const target=await service.install(owner,{requestId:randomUUID(),source:other,expectedBundleHash:bundleHash});assert.notEqual(target.installation.id,first.installation.id);assert.equal((await service.list(owner,{})).items.filter(x=>x.native.name===native.name).length,2);const db=await pool.connect();try{assert.equal((await readSkillSelection(db,owner,native.name))?.installationId,first.installation.id)}finally{db.release()}})

test('请求参数、本人边界和固定数据库摘要损坏均显式失败',async()=>{const {reader,service}=setup(),source={kind:'atomic' as const,contentId:randomUUID()},requestId=randomUUID();reader.values.set(JSON.stringify(source),bundle({...atomicSource,contentId:source.contentId}));const installed=(await service.install(owner,{requestId,source,expectedBundleHash:bundleHash})).installation;await assert.rejects(service.install(owner,{requestId,source,expectedBundleHash:hash('changed')}),{code:'teloa/conflict'});await assert.rejects(service.get(randomUUID(),{installationId:installed.id}),{code:'teloa/forbidden'});await pool.query('update teloa_skill_installations set bundle_hash=$2 where id=$1',[installed.id,hash('corrupt')]);await assert.rejects(service.get(owner,{installationId:installed.id}),{code:'teloa/storage-corrupt'})})

test('两个服务实例并发同一来源时文件发布按数据库锁串行且只发布一次',async()=>{const reader=new Reader(),files=new Files(),source={kind:'atomic' as const,contentId:atomicId};reader.values.set(JSON.stringify(source),bundle());files.slow=true;const a=new SkillInstallationService(pool,identity,reader,files),b=new SkillInstallationService(pool,identity,reader,files),[first,second]=await Promise.all([a.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash}),b.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash})]);assert.equal(first.installation.id,second.installation.id);assert.equal(files.published.length,1);assert.equal(files.maxActive,1)})

test('请求解析来源和原生元数据的合法形状篡改均不能通过读取',async()=>{const {reader,service}=setup(),input={kind:'atomic' as const,contentId:atomicId},requestId=randomUUID();reader.values.set(JSON.stringify(input),bundle());const installed=(await service.install(owner,{requestId,source:input,expectedBundleHash:bundleHash})).installation;await pool.query("update teloa_skill_install_requests set resolved_source=jsonb_set(resolved_source,'{resourceId}','\"other-skill\"') where owner_id=$1 and request_id=$2",[owner,requestId]);await assert.rejects(service.install(owner,{requestId,source:input,expectedBundleHash:bundleHash}),{code:'teloa/storage-corrupt'});await pool.query("update teloa_skill_installations set native=jsonb_set(native,'{modelInvocable}','false') where id=$1",[installed.id]);await assert.rejects(service.get(owner,{installationId:installed.id}),{code:'teloa/storage-corrupt'})})

test('安装记录本人和行业usage合法UUID改写均由固定摘要拒绝',async()=>{const {reader,service}=setup(),industry={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()},industrySource={kind:'industry-local' as const,loadId:industry.loadId,itemInstanceId:industry.itemInstanceId,contentId:randomUUID(),contentHash:hash('industry-owner'),resourceId:'brief',resourceVersion:'1.0.0'};reader.values.set(JSON.stringify(industry),bundle(industrySource));const first=(await service.install(owner,{requestId:randomUUID(),source:industry,expectedBundleHash:bundleHash})).installation;const otherInput={kind:'atomic' as const,contentId:randomUUID()},otherFiles=new Files();otherFiles.metadata={...native,name:'other-skill'};reader.values.set(JSON.stringify(otherInput),bundle({...atomicSource,contentId:otherInput.contentId,contentHash:hash('other-usage'),resourceId:'other-skill'}));const other=(await new SkillInstallationService(pool,identity,reader,otherFiles).install(owner,{requestId:randomUUID(),source:otherInput,expectedBundleHash:bundleHash})).installation;await pool.query('update teloa_skill_install_usages set installation_id=$2 where installation_id=$1',[first.id,other.id]);await assert.rejects(service.list(owner,{}),{code:'teloa/storage-corrupt'});const changedOwner=randomUUID();await pool.query('alter table teloa_skill_install_availability drop constraint teloa_skill_install_availability_installation_id_owner_id_fkey');await pool.query('alter table teloa_skill_selections drop constraint teloa_skill_selections_installation_id_owner_id_fkey');try{await pool.query('update teloa_skill_installations set owner_id=$2 where id=$1',[first.id,changedOwner]);await assert.rejects(service.get(changedOwner,{installationId:first.id}),{code:'teloa/storage-corrupt'})}finally{await pool.query('update teloa_skill_installations set owner_id=$2 where id=$1',[first.id,owner]);await pool.query('alter table teloa_skill_install_availability add foreign key(installation_id,owner_id) references teloa_skill_installations(id,owner_id)');await pool.query('alter table teloa_skill_selections add foreign key(installation_id,owner_id) references teloa_skill_installations(id,owner_id)')}})

test('两个服务实例并发不同来源同原生名时保留两项安装但只有一个初始选择',async()=>{const reader=new Reader(),files=new Files(),a={kind:'atomic' as const,contentId:randomUUID()},b={kind:'atomic' as const,contentId:randomUUID()};reader.values.set(JSON.stringify(a),bundle({...atomicSource,contentId:a.contentId,contentHash:hash('same-name-a')}));reader.values.set(JSON.stringify(b),bundle({...atomicSource,contentId:b.contentId,contentHash:hash('same-name-b')}));files.slow=true;const results=await Promise.all([new SkillInstallationService(pool,identity,reader,files).install(owner,{requestId:randomUUID(),source:a,expectedBundleHash:bundleHash}),new SkillInstallationService(pool,identity,reader,files).install(owner,{requestId:randomUUID(),source:b,expectedBundleHash:bundleHash})]);assert.notEqual(results[0].installation.id,results[1].installation.id);assert.equal(files.published.length,2);const db=await pool.connect();try{const selected=await readSkillSelection(db,owner,native.name);assert.ok(results.some(result=>result.installation.id===selected?.installationId));assert.equal(selected?.version,1)}finally{db.release()}})

test('准备事务COMMIT成功但回包丢失时原请求恢复同一记录再发布',async()=>{const reader=new Reader(),files=new Files(),input={kind:'atomic' as const,contentId:atomicId},requestId=randomUUID();reader.values.set(JSON.stringify(input),bundle());let lose=true;const unreliable={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();return new Proxy(db,{get(target,key){if(key==='query')return async(sql:unknown,...args:unknown[])=>{const result=await (target.query as (...values:unknown[])=>Promise<unknown>).call(target,sql,...args);if(lose&&typeof sql==='string'&&sql.toLowerCase()==='commit'){lose=false;throw Error('lost commit reply')}return result};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}} as unknown as Pool,service=new SkillInstallationService(unreliable,identity,reader,files);await assert.rejects(service.install(owner,{requestId,source:input,expectedBundleHash:bundleHash}),{code:'teloa/storage-unavailable'});assert.equal(files.published.length,0);const preparing=(await new SkillInstallationService(pool,identity,reader,files).list(owner,{})).items[0]!;assert.equal(preparing.state,'preparing');const restored=await service.install(owner,{requestId,source:input,expectedBundleHash:bundleHash});assert.equal(restored.installation.id,preparing.id);assert.equal(restored.installation.state,'installed');assert.equal(files.published.length,1)})

test('Skill 可用状态具有独立服务与版本',async()=>{
 const module=await import('../src/market/skill-availability.ts').catch(()=>({}))
 assert.equal(typeof Reflect.get(module,'SkillAvailabilityService'),'function')
})

test('readInstalledSkillBinding 三态：目录来源回条目 id；GitHub 来源已安装但无条目；industry-public 按 sourceContentId 解析；未安装/他人为未安装',async()=>{
 await initializeMarketContents(pool)
 const store=new MarketContentStore(pool,identity),actor={ownerId:owner,kind:'human' as const}
 const files=[{path:'x-search/SKILL.md',bytes:new TextEncoder().encode('---\nname: x-search\ndescription: d\n---\nbody')}]
 const source={kind:'catalog' as const,catalog:'teloa-official' as const,catalogVersion:'2026.9.27',entryId:'clawhub.other.x-search',entryVersion:'1.0.0',treeHash:hash('tree')}
 const fromCatalog=await store.import(actor,{kind:'atomic-skill',requestId:randomUUID(),source,metadata:{id:'x-search',title:'X',version:'1.0.0',categories:[]},files})
 const fromGithub=await store.import(actor,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'github',owner:'acme',repo:'skills',requestedRef:'main',resolvedCommit:'c'.repeat(40),archiveHash:hash('archive'),path:'x-search'},metadata:{id:'gh-search',title:'G',version:'1.0.0',categories:[]},files:[{path:'gh-search/SKILL.md',bytes:new TextEncoder().encode('---\nname: gh-search\ndescription: d\n---\nbody')}]})
 const {reader,service,files:port}=setup()
 for(const [content,name] of [[fromCatalog.content,'x-search'],[fromGithub.content,'gh-search']] as const){
  const input={kind:'atomic' as const,contentId:content.id}
  port.metadata={...native,name}
  reader.values.set(JSON.stringify(input),bundle({...atomicSource,contentId:content.id,contentHash:hash(name),resourceId:name}))
  await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:bundleHash})
 }
 // 行业公共来源：source.contentId 是方案模板，sourceContentId 才是目录技能内容（另一条目导入的内容，避免与上面的原子安装共用 source_key）
 const pubContent=await store.import(actor,{kind:'atomic-skill',requestId:randomUUID(),source:{...source,entryId:'clawhub.pub.pub-search'},metadata:{id:'pub-search',title:'P',version:'1.0.0',categories:[]},files:[{path:'pub-search/SKILL.md',bytes:new TextEncoder().encode('---\nname: pub-search\ndescription: d\n---\nbody')}]})
 const industry={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()}
 port.metadata={...native,name:'pub-search'}
 reader.values.set(JSON.stringify(industry),bundle({kind:'industry-public',loadId:industry.loadId,itemInstanceId:industry.itemInstanceId,contentId:randomUUID(),contentHash:hash('template'),sourceContentId:pubContent.content.id,sourceContentHash:hash('pub-search'),sourceResourceId:'pub-search',sourceResourceVersion:'1.0.0',resourceId:'pub-search',resourceVersion:'1.0.0'}))
 await service.install(owner,{requestId:randomUUID(),source:industry,expectedBundleHash:bundleHash})
 const client=await pool.connect()
 try{
  assert.deepEqual(await readInstalledSkillBinding(client,owner,'x-search'),{installed:true,entryId:'clawhub.other.x-search'})
  assert.deepEqual(await readInstalledSkillBinding(client,owner,'gh-search'),{installed:true},'GitHub 来源：已安装但没有目录条目')
  assert.deepEqual(await readInstalledSkillBinding(client,owner,'pub-search'),{installed:true,entryId:'clawhub.pub.pub-search'},'industry-public 按 sourceContentId 解析到目录条目')
  assert.deepEqual(await readInstalledSkillBinding(client,owner,'not-installed'),{installed:false})
  assert.deepEqual(await readInstalledSkillBinding(client,randomUUID(),'x-search'),{installed:false},'不跨本人')
 }finally{client.release()}
})
