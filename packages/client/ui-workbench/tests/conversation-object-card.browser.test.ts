import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string,server:ReturnType<typeof createServer>,origin:string
const skillText='---\nname: source-review\ndescription: 核对资料来源\n---\n# 资料核对\n只读取用户授权资料，列出来源。\n<script>window.skillBodyExecuted=true</script>\n'
const skillBase64=Buffer.from(skillText).toString('base64')
const knowledgeText='# 流程知识\n\n先核对本人资料，再记录来源。',knowledgeHash=createHash('sha256').update(knowledgeText).digest('hex')
const industryFixtures=['industry-local','industry-public'].map((kind,index)=>{
 const ownerId='local:teloa-owner',stamp='2026-10-11T00:00:00.000Z',installationId=index?'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee':'dddddddd-dddd-4ddd-8ddd-dddddddddddd',loadId='12345678-1234-4234-8234-123456789012',itemId=index?'22345678-1234-4234-8234-123456789013':'22345678-1234-4234-8234-123456789012',contentId='32345678-1234-4234-8234-123456789012',localId=index?'public-review':'local-review'
 const source={kind,loadId,itemInstanceId:itemId,contentId,contentHash:'a'.repeat(64),resourceId:localId,resourceVersion:'1.2.0',...(index?{sourceContentId:'42345678-1234-4234-8234-123456789012',sourceContentHash:'b'.repeat(64),sourceResourceId:'original-public-review',sourceResourceVersion:'3.0.0'}:{})}
 return {kind:'industry',installation:{id:installationId,ownerId,source,bundleHash:'c'.repeat(64),native:{name:localId,description:'沿原方案核对资料',modelInvocable:true,userInvocable:true,bodyHash:'d'.repeat(64)},state:'installed',version:1,createdAt:stamp,updatedAt:stamp},load:{id:loadId,ownerId,contentId,contentHash:'a'.repeat(64),templateId:'review-plan',templateVersion:'1.0.0',templateTitle:'本人核对方案',domain:'general',scope:'general',description:'核对资料',targetVersion:1,space:{id:'52345678-1234-4234-8234-123456789012',name:'本人空间',version:1,scope:'general'},items:[{localId,instanceId:itemId,kind:'skill',title:index?'公共来源核对技能':'方案内核对技能',version:'1.2.0',required:true,status:'pending-adapter'}],relations:[],entrypoints:[itemId],createdAt:stamp,mappingHash:'e'.repeat(64),status:'active'},availability:{installationId,ownerId,availability:'disabled',version:1,updatedAt:stamp},selection:{installationId,ownerId,nativeName:localId,version:1,updatedAt:stamp}}
})
const entry=`
import {personalProfile} from '${client}personal-profile.ts';import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationObjectCard,ConversationObjectTurnCards,ConversationObjectToolCard} from '${client}ConversationObjectCard.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
let locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1};const localeListeners=new Set(),runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:fn=>{localeListeners.add(fn);return()=>localeListeners.delete(fn)},getSnapshot:()=>snapshot};
let role={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:teloa-owner',version:1,state:'active',createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z',name:'小研',kind:'employee',scopes:['general'],duty:'整理资料',dataScope:'已授权资料',executionScope:'分析',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},avatarKey:'general'};
let mcp={id:'22222222-2222-4222-8222-222222222222',serverName:'test-server',status:'saved',tools:[],createdAt:role.createdAt,updatedAt:role.updatedAt};
const skillDraft={id:'33333333-3333-4333-8333-333333333333',ownerId:role.ownerId,requestId:'55555555-5555-4555-8555-555555555555',title:'资料核对技能',entity:'skill',body:JSON.stringify({id:'source-review',title:'资料核对技能',version:'1.2.3',categories:[],files:[{path:'source-review/SKILL.md',base64:${JSON.stringify(skillBase64)}},{path:'source-review/references/checklist.md',base64:'Y2hlY2tsaXN0'}]}),bodyHash:'a'.repeat(64),status:'applied',appliedRef:'skill:66666666-6666-4666-8666-666666666666',createdAt:role.createdAt,updatedAt:role.updatedAt};
const connectorDraft={...skillDraft,id:'44444444-4444-4444-8444-444444444444',title:'本人数据服务',entity:'connector',body:JSON.stringify({manifest:{title:'本人数据服务',version:'2.0.0',scope:'SOC'},resource:{format:'teloa.mcp-connection/v1',serverName:'data_service',tools:['read_data'],url:'https://user:URL_SECRET@example.com/mcp?token=QUERY_SECRET',headers:{Authorization:'HEADER_SECRET'},credentials:{key:'CREDENTIAL_SECRET'},base64:'ENCODED_PRIVATE_DATA'}}),bodyHash:'b'.repeat(64)};
let heldDraft,releaseDraft;const drafts=[skillDraft,connectorDraft],opened=[],calls=[],ports={readRole:async id=>{calls.push('role:'+id);return role},readGroup:async()=>{throw Error('unexpected')},drafts:{read:async input=>{calls.push('draft:'+input.draftId);if(heldDraft){const pending=heldDraft;heldDraft=undefined;return pending}const draft=drafts.find(row=>row.id===input.draftId);if(!draft)throw Error('unexpected');return draft},preview:async()=>{throw Error('已应用草案不得重新读取待应用预览')}},mcp:{get:async()=>mcp,connect:async id=>{calls.push('connect:'+id);mcp={...mcp,status:'connected',tools:[{name:'read_test',fullName:'test/read_test'}]};return mcp},disconnect:async id=>{calls.push('disconnect:'+id);mcp={...mcp,status:'saved',tools:[]};return mcp}},openRole:id=>opened.push(['role',id]),openGroup:id=>opened.push(['group',id]),openCapabilities:()=>opened.push(['capabilities'])};
let liveSkill={schema:'teloa.skill-result/v1',sessionId:'',operation:'get',skill:{id:'source-review',nativeName:'source-review',ownerId:role.ownerId,installationId:'66666666-6666-4666-8666-666666666666',contentId:'77777777-7777-4777-8777-777777777777',title:'资料核对技能',description:'核对本人资料并列出来源',version:'1.2.3',state:'saved',availability:'enabled',selected:false,private:true},selection:{installationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1},expectedBundleHash:'a'.repeat(64),body:'# 核对流程\\n\\n先核对 **本人资料**，再记录来源。\\n<script>window.skillBodyExecuted=true</script>'};
let missingSkill=false,heldSkill,releaseSkill,lateCaptured=false;const readLiveSkill=async id=>{calls.push('skill:'+id);if(heldSkill){const pending=heldSkill;heldSkill=undefined;lateCaptured=true;return pending}if(missingSkill)throw Error('对象已不可用');return liveSkill};
const knowledgeId='88888888-8888-4888-8888-888888888888',resource={id:'99999999-9999-4999-8999-999999999999',ownerId:role.ownerId,title:'已提交核对资料',sourceId:'knowledge_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',sourceVersion:${JSON.stringify(knowledgeHash)},scopeIds:['general'],version:1,status:'active',createdAt:role.createdAt,updatedAt:role.updatedAt};
const knowledgeVersion={knowledgeId,ownerId:role.ownerId,sourceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sourceType:'paste',version:1,contentHash:${JSON.stringify(knowledgeHash)},bytes:${Buffer.byteLength(knowledgeText)},markdown:${JSON.stringify(knowledgeText)},createdAt:role.createdAt};
const resources={directory:async()=>({resources:[resource],drafts:[]}),knowledgeTree:async()=>({space:{ownerId:role.ownerId},nodes:[{id:'page_node',type:'page',knowledgeId,title:'流程知识'}]}),listKnowledgeVersions:async()=>[{...knowledgeVersion}],readKnowledgeVersion:async()=>knowledgeVersion};
const libraryPorts={...ports,resources,openResource:id=>opened.push(['resource',id]),openResources:id=>opened.push(['library',id??null])};
const capabilityPorts={...ports,readCapability:async receipt=>{calls.push('capability:'+receipt.id);return {id:receipt.id,ownerId:role.ownerId,title:receipt.kind==='extension'?'本地检索':'业务数据连接',version:receipt.kind==='extension'?'1.0.0':2,state:receipt.kind==='extension'?'enable-pending':'needs_authorization',description:'本人保存的配置'};}};
const industryFixtures=${JSON.stringify(industryFixtures)};const industryPorts={...ports,readSkill:async id=>{calls.push('industry-read:'+id);const value=industryFixtures.find(row=>row.installation.id===id);if(!value)throw Error('缺少安装');return value},openIndustrySkill:target=>opened.push(['industry',target])};
const listeners=new Set();let history={entries:[]};const events={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},getSnapshot:()=>history};
const pair=(turn,callId,value)=>[{event:{seq:turn*2,type:'tool/call',data:{turn,name:'teloa_employees_create',callId}}},{event:{seq:turn*2+1,type:'tool/result',data:{turn,message:{toolCallId:callId,content:[{type:'text',text:JSON.stringify({schema:'teloa.employee-result/v1',sessionId:'source',operation:'create',role:value})}]}}}}];
window.objectFixture={opened,calls,drafts,twin:async()=>{await personalProfile.setDisplayName('Max Luo');role={...role,kind:'twin',name:'原存储分身名'};window.dispatchEvent(new Event('focus'))},attachKnowledgeProjection:()=>{resource.sourceId='knowledge_'+knowledgeId;window.dispatchEvent(new Event('focus'))},holdDraft:()=>{heldDraft=new Promise(done=>{releaseDraft=()=>done(skillDraft)})},releaseDraft:()=>releaseDraft(),industryFixtures,industryCorrupt:()=>{industryFixtures[0].load={...industryFixtures[0].load,scope:'foreign'};window.dispatchEvent(new Event('focus'))},holdSkill:()=>{const old=liveSkill;heldSkill=new Promise(done=>{releaseSkill=()=>done(old)});window.dispatchEvent(new Event('focus'))},releaseSkill:()=>releaseSkill(),lateCaptured:()=>lateCaptured,skillChange:()=>{liveSkill={...liveSkill,skill:{...liveSkill.skill,title:'资料核对新版',version:'1.2.4',state:'disabled',availability:'disabled',selected:true},selection:{installationId:liveSkill.skill.installationId,version:2},body:'# 新版流程\\n核对完成后交付来源。'};window.dispatchEvent(new Event('focus'))},skillMissing:()=>{missingSkill=true;window.dispatchEvent(new Event('focus'))},locale:value=>{locale=value;snapshot={...snapshot,locale,revision:snapshot.revision+1};localeListeners.forEach(fn=>fn())},complete:()=>{history={entries:pair(1,'first',role)};listeners.forEach(fn=>fn())},change:()=>{role={...role,name:'小研更新',state:'paused',version:2};history={entries:[...history.entries,...pair(2,'second',role)]};listeners.forEach(fn=>fn())}};
const planCardDraft={...skillDraft,id:'12121212-1212-4212-8212-121212121212',entity:'plan',title:'本人原计划草案',status:'draft',body:JSON.stringify({kind:'configure-work',planId:'34343434-3434-4434-8434-343434343434',expectedVersion:1,expectedConfigVersion:1,intent:'save-paused',work:{completion:{kind:'manual'},triggers:[{kind:'schedule',schedule:{kind:'schedule',cadence:'daily',weekday:1,time:'11:00',timezone:'Asia/Singapore'}}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}}),bodyHash:'f'.repeat(64)};delete planCardDraft.appliedRef;
window.objectFixture.planDraft=planCardDraft;
const planCardPorts={...ports,drafts:{...ports.drafts,read:async input=>{calls.push('plan-read:'+input.draftId);return planCardDraft},preview:async()=>({draft:planCardDraft})},openPlanDraft:draft=>opened.push(['plan-draft',draft])};
const appDefinition={schema:'teloa.mcp-server/v1',serverName:'headers',title:'本人双头应用',transport:'streamable-http',url:'https://mcp.example.test/mcp',auth:{kind:'headers',headers:[{name:'Authorization',scheme:'Bearer'},{name:'X-API-Key'}]}};
let appDraft={...skillDraft,id:'98989898-9898-4989-8989-989898989898',entity:'app',title:appDefinition.title,status:'draft',appliedRef:undefined,body:JSON.stringify({definition:appDefinition})};
let appConnection={...mcp,id:'87878787-8787-4787-8787-878787878787',custom:{title:appDefinition.title}};
const appPreview=()=>({schema:'teloa.mcp-preview/v1',definition:appDefinition,definitionHash:'c'.repeat(64),authorizationConfigured:appDraft.status==='applied',connection:appDraft.status==='applied'?appConnection:undefined});
const appPorts={...ports,drafts:{read:async()=>appDraft,preview:async()=>({draft:appDraft}),settle:async input=>{calls.push('app-settle:'+input.appliedRef);appDraft={...appDraft,status:'applied',appliedRef:input.appliedRef};return appDraft}},mcp:{...ports.mcp,previewCustom:async()=>appPreview(),getCustom:async()=>appPreview(),saveCustom:async()=>{calls.push('app-save');return appConnection},authorizeCustom:async input=>{calls.push('app-auth');if(!input.credentials.Authorization||!input.credentials['X-API-Key'])throw Error('认证不完整');return appConnection},connect:async()=>{calls.push('app-connect');appConnection={...appConnection,status:'connected',tools:[{name:'search',fullName:'headers/search',readOnly:false}]};return appConnection},disconnect:async()=>{calls.push('app-disconnect');appConnection={...appConnection,status:'saved'};return appConnection},delete:async()=>{calls.push('app-delete')}}};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><div id="app-draft"><ConversationObjectCard receipt={{kind:'draft',id:appDraft.id,title:appDraft.title,revision:'1',draftReference:{entity:'app',status:'draft'}}} {...appPorts}/></div><div id="plan-draft"><ConversationObjectCard receipt={{kind:'draft',id:planCardDraft.id,title:planCardDraft.title,revision:'1',draftReference:{entity:'plan',status:'draft'}}} {...planCardPorts}/></div><div id="tool"><ConversationObjectToolCard phase="result" block={{isError:false,content:[{type:'text',text:JSON.stringify({schema:'teloa.employee-result/v1',sessionId:'source',operation:'create',role})}]}} events={events} {...ports}/></div><div id="deferred-original"><ConversationObjectCard receipt={{kind:"draft",id:skillDraft.id,title:skillDraft.title,revision:"deferred",draftReference:{entity:"skill",status:"applied"}}} {...ports}/></div><div id="lookup-loading"><ConversationObjectToolCard phase="running" toolName="teloa_create_drafts" block={{}} events={events} {...ports}/></div><div id="lookup-directory"><ConversationObjectToolCard phase="result" toolName="teloa_create_drafts" block={{content:[{type:"text",text:JSON.stringify({schema:"teloa.page-create-draft-summaries/v1",drafts:[]})}]}} events={events} {...ports}/></div><div id="history"><ConversationObjectTurnCards turn={{turn:1,status:'closed'}} events={events} {...ports}/></div><ConversationObjectCard receipt={{kind:'mcp',id:mcp.id,title:'test-server',revision:'1'}} {...ports}/>{drafts.map(draft=><div id={draft.entity} key={draft.id}><ConversationObjectCard receipt={{kind:'draft',id:draft.id,title:draft.title,revision:'1'}} {...ports}/></div>)}<div id="skill-live"><ConversationObjectCard receipt={{kind:'skill',id:liveSkill.skill.installationId,title:liveSkill.skill.title,revision:'1'}} {...ports} readSkill={readLiveSkill}/></div><div id="applied-live"><ConversationObjectCard receipt={{kind:'draft',id:skillDraft.id,title:skillDraft.title,revision:'1'}} {...ports} readSkill={readLiveSkill}/></div><div id="knowledge-live"><ConversationObjectCard receipt={{kind:'knowledge',id:knowledgeId,title:'流程知识',revision:'1'}} {...libraryPorts}/></div><div id="resource-live"><ConversationObjectCard receipt={{kind:'work-resource',id:resource.id,title:resource.title,revision:'1'}} {...libraryPorts}/></div><div id="extension-live"><ConversationObjectCard receipt={{kind:'extension',id:'local-embedding',title:'本地检索',revision:'1'}} {...capabilityPorts}/></div><div id="connector-live"><ConversationObjectCard receipt={{kind:'connector',id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',connectorKind:'data-source',title:'业务数据连接',revision:'1'}} {...capabilityPorts}/></div>{industryFixtures.map(value=><div id={value.installation.source.kind} key={value.installation.id}><ConversationObjectCard receipt={{kind:'skill',id:value.installation.id,title:value.load.items[0].title,revision:'1',skillSource:{resourceId:value.installation.source.resourceId,contentId:value.installation.source.contentId,nativeName:value.installation.native.name}}} {...industryPorts}/></div>)}</I18nProvider>);
`
before(async()=>{temp=await mkdtemp(join(root,'.runtime-object-cards-'));await writeFile(join(temp,'fixture.tsx'),entry);const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ObjectFixture',formats:['iife']}}});const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');server=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<html><body><div id="root"></div></body></html>')});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin='http://127.0.0.1:'+String((server.address() as {port:number}).port);browser=await loadPlaywright().chromium.launch(launchOptions())})
after(async()=>{await browser?.close();if(server)await new Promise<void>(done=>server.close(()=>done()));if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){const page=await browser.newPage({viewport:{width:1000,height:800}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await page.route(origin+'/',(route:any)=>route.continue());await page.goto(origin+'/');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('button',{name:/test-server.*已保存/}).waitFor();return page}
test('完成轮回执迟到可显示，原卡片随后续修改刷新，点击员工打开原身份而非来源会话',async t=>{const page=await mount(t);assert.equal(await page.locator('#history section').count(),0);await page.evaluate(()=>(window as any).objectFixture.complete());await page.locator('#history').getByRole('button',{name:/小研.*在岗/}).waitFor();await page.evaluate(()=>(window as any).objectFixture.change());const button=page.locator('#history').getByRole('button',{name:/小研更新/});await button.waitFor();assert.match(await button.innerText(),/暂停/);const tool=page.locator('#tool').getByRole('button',{name:/小研更新/});await tool.waitFor();assert.match(await tool.innerText(),/暂停/);await button.click();assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[['role','11111111-1111-4111-8111-111111111111']])})
test('MCP卡片抽屉连接真实端口，关闭不注销，重开可断开同一身份',async t=>{const page=await mount(t),card=page.getByRole('button',{name:/test-server.*已保存/});await card.click();const drawer=page.getByRole('dialog',{name:'MCP 连接'});await drawer.getByRole('button',{name:'连接',exact:true}).click();await drawer.getByRole('button',{name:'断开连接',exact:true}).waitFor();await page.keyboard.press('Escape');await drawer.waitFor({state:'detached'});assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((x:string)=>x.startsWith('connect:')||x.startsWith('disconnect:'))),['connect:22222222-2222-4222-8222-222222222222']);await page.getByRole('button',{name:/test-server.*已连接/}).click();await drawer.getByRole('button',{name:'断开连接',exact:true}).click();await drawer.getByRole('button',{name:'连接',exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((x:string)=>x.startsWith('connect:')||x.startsWith('disconnect:'))),['connect:22222222-2222-4222-8222-222222222222','disconnect:22222222-2222-4222-8222-222222222222'])})
test('技能草案三语言详情显示版本与文件清单，正文按需只读且任何视图不显示编码',async t=>{
 for(const [locale,title,applied,read] of [['zh-CN','技能详情','已应用','查看 SKILL.md 正文'],['zh-HK','技能詳情','已套用','查看 SKILL.md 內文'],['en','Skill details','Applied','Read SKILL.md']]){
  const page=await mount(t);await page.evaluate((value:string)=>(window as any).objectFixture.locale(value),locale)
  const card=page.locator('#skill').getByRole('button');await card.waitFor();await page.waitForFunction((value:string)=>document.querySelector('#skill button')!.textContent!.includes(value),applied)
  await card.click();const drawer=page.getByRole('dialog',{name:title,exact:true});await drawer.waitFor()
  await drawer.getByText('1.2.3',{exact:true}).waitFor();assert.equal(await drawer.getByRole('list').getByText('source-review/SKILL.md',{exact:true}).count(),1);assert.equal(await drawer.getByRole('list').getByText('source-review/references/checklist.md',{exact:true}).count(),1)
  assert.equal(await drawer.locator('pre').isVisible(),false,'技能正文必须按需展开')
  assert.ok(!(await drawer.textContent())!.includes(skillBase64));assert.doesNotMatch((await drawer.textContent())!,/base64|files\[0\]/)
  await drawer.getByText(read,{exact:true}).click();assert.equal(await drawer.locator('pre').innerText(),skillText)
  assert.equal(await drawer.locator('input,textarea,script').count(),0);assert.equal(await page.evaluate(()=>(window as any).skillBodyExecuted),undefined)
  assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.drafts.map((draft:any)=>[draft.id,draft.bodyHash,draft.status])),[['33333333-3333-4333-8333-333333333333','a'.repeat(64),'applied'],['44444444-4444-4444-8444-444444444444','b'.repeat(64),'applied']])
  await page.keyboard.press('Escape');assert.equal(await card.evaluate((node:HTMLElement)=>node===document.activeElement),true)
  assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[]);assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>!call.startsWith('role:')&&!call.startsWith('draft:')&&!call.startsWith('skill:')&&!call.startsWith('capability:')&&!call.startsWith('industry-read:'))),[],'只读展开不连接、安装或执行')
 }
})
test('连接草案应用不暗示接通，按需定义隐藏凭据与文件编码',async t=>{
 const page=await mount(t);await page.locator('#connector').getByRole('button',{name:/本人数据服务.*已应用/}).click()
 const drawer=page.getByRole('dialog',{name:'草案详情',exact:true});await drawer.getByText('2.0.0',{exact:true}).waitFor();await drawer.getByText('data_service',{exact:true}).waitFor()
 assert.match(await drawer.innerText(),/是否接通需以实际连接状态为准/);assert.doesNotMatch(await drawer.innerText(),/已连接|https:/)
 await drawer.getByText('查看定义',{exact:true}).click();const definition=await drawer.locator('pre').innerText()
 assert.match(definition,/https:\/\/example\.com\/mcp/);assert.match(definition,/已隐藏/)
 assert.doesNotMatch(definition,/URL_SECRET|QUERY_SECRET|HEADER_SECRET|CREDENTIAL_SECRET|ENCODED_PRIVATE_DATA|base64/)
 assert.equal(await drawer.locator('input,textarea').count(),0);assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[])
})

test('本人技能点击中文名称读取名称描述Markdown，已应用原草案显示技能并保留原身份',async t=>{
 const page=await mount(t),card=page.locator('#skill-live').getByRole('button',{name:/资料核对技能.*已保存，未启用/});await card.waitFor();await card.click()
 const drawer=page.getByRole('dialog',{name:'技能详情',exact:true});await drawer.getByText('核对本人资料并列出来源',{exact:true}).waitFor()
 assert.equal(await drawer.getByRole('heading',{name:'核对流程'}).count(),1);assert.equal(await drawer.locator('strong').filter({hasText:'本人资料'}).count(),1)
 assert.match(await drawer.innerText(),/保存新版不会自动发布、启用或切换/);assert.doesNotMatch(await drawer.innerText(),/base64|能力草案/);assert.equal(await drawer.locator('input,textarea,script').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).skillBodyExecuted),undefined)
 await page.keyboard.press('Escape');const applied=page.locator('#applied-live').getByRole('button');assert.match(await applied.innerText(),/已保存，未启用/);assert.equal(await page.locator('#applied-live section').getAttribute('aria-label'),'技能：资料核对技能')
 await page.evaluate(()=>(window as any).objectFixture.skillChange());await page.locator('#skill-live').getByRole('button',{name:/资料核对新版.*已停用/}).waitFor()
 await page.locator('#skill-live button').click();await drawer.getByRole('heading',{name:'新版流程'}).waitFor();assert.match(await drawer.innerText(),/1.2.4/)
 await page.keyboard.press('Escape');await page.evaluate(()=>(window as any).objectFixture.skillMissing());await page.locator('#skill-live').getByRole('alert').waitFor();assert.equal(await page.locator('#skill-live button').first().isDisabled(),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[])
})
test('资料卡打开原ResourceManager，尚未提交知识只读Markdown且不触发apply授权',async t=>{
 const page=await mount(t);await page.locator('#resource-live').getByRole('button',{name:/已提交核对资料.*已提交/}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[['resource','99999999-9999-4999-8999-999999999999']])
 await Promise.race([page.locator('#knowledge-live').getByRole('button',{name:/已保存/}).waitFor(),page.locator('#knowledge-live').getByRole('alert').waitFor()]);assert.match(await page.locator('#knowledge-live').innerText(),/已保存/);await page.locator('#knowledge-live').getByRole('button',{name:/流程知识.*已保存/}).click();const drawer=page.getByRole('dialog',{name:'知识详情',exact:true});await drawer.getByRole('heading',{name:'流程知识'}).last().waitFor()
 assert.match(await drawer.innerText(),/尚未提交为工作资料/);assert.match(await drawer.innerText(),/查看不会加入员工岗位或授予任务读取权限/)
 assert.equal(await drawer.locator('input,textarea,script').count(),0);await drawer.getByRole('button',{name:'打开知识库'}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[['resource','99999999-9999-4999-8999-999999999999'],['library',null]])
})

test('知识正文已有可引用投影时仍显示已保存，通用范围不泄露内部标识',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>(window as any).objectFixture.attachKnowledgeProjection())
 const card=page.locator('#knowledge-live').getByRole('button')
 await card.getByText('通用工作',{exact:true}).waitFor()
 assert.match(await card.innerText(),/已保存/)
 assert.doesNotMatch(await card.innerText(),/general|已提交|已授权/)
 await card.click()
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[['resource','99999999-9999-4999-8999-999999999999']],'仍打开同一份原资料，不另建或授权对象')
})

test('旧技能读回包迟到不覆盖已刷新版本',async t=>{
 const page=await mount(t);await page.locator('#skill-live').getByRole('button',{name:/资料核对技能/}).waitFor()
 await page.evaluate(()=>(window as any).objectFixture.holdSkill());await page.waitForFunction(()=>(window as any).objectFixture.lateCaptured())
 await page.evaluate(()=>(window as any).objectFixture.skillChange());await page.locator('#skill-live').getByRole('button',{name:/资料核对新版.*已停用/}).waitFor()
 await page.evaluate(()=>(window as any).objectFixture.releaseSkill());await page.locator('#skill-live').getByRole('button',{name:/资料核对新版.*已停用/}).click()
 const drawer=page.getByRole('dialog',{name:'技能详情',exact:true});await drawer.getByRole('heading',{name:'新版流程'}).waitFor();assert.doesNotMatch(await drawer.innerText(),/核对流程/)
})

test('扩展与连接配置点击同上下文真实读取，待启用与未授权不误报成功且查看不执行',async t=>{
 const page=await mount(t)
 await page.locator('#extension-live').getByRole('button',{name:/本地检索.*正在启用/}).click()
 let drawer=page.getByRole('dialog',{name:'应用',exact:true});await drawer.waitFor()
 assert.match(await drawer.innerText(),/正在启用.*版本 1.0.0/);assert.doesNotMatch(await drawer.innerText(),/已启用|healthy|ownerId|installationId/)
 await page.keyboard.press('Escape')
 await page.locator('#connector-live').getByRole('button',{name:/业务数据连接.*需要本人授权/}).click()
 drawer=page.getByRole('dialog',{name:'连接能力',exact:true});await drawer.waitFor();assert.match(await drawer.innerText(),/需要本人授权/);assert.doesNotMatch(await drawer.innerText(),/已连接|healthy|credentials|base64/)
 assert.equal(await drawer.locator('input,textarea').count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>call.startsWith('connect:')||call.startsWith('disconnect:'))),[])
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[])
 // 旧「能力中心」按钮改为「打开应用」：经同一 openCapabilities 端口落到应用页，关闭抽屉后再跳转
 assert.doesNotMatch(await drawer.innerText(),/能力中心/)
 await drawer.getByRole('button',{name:'打开应用',exact:true}).click();await drawer.waitFor({state:'detached'})
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[['capabilities']])
})

test('行业本地与公共来源技能读取原安装摘要，点击定位原方案同一项且不开放正文编辑',async t=>{
 const page=await mount(t)
 for(const [kind,title,itemInstanceId] of [['industry-local','方案内核对技能','22345678-1234-4234-8234-123456789012'],['industry-public','公共来源核对技能','22345678-1234-4234-8234-123456789013']]){
  const button=page.locator('#'+kind).getByRole('button',{name:new RegExp(title+'.*已停用')});await button.waitFor();await button.click()
  const opened=await page.evaluate(()=>(window as any).objectFixture.opened)
  assert.deepEqual(opened.at(-1),['industry',{loadId:'12345678-1234-4234-8234-123456789012',itemInstanceId,scope:'general'}])
 }
 assert.equal(await page.getByRole('dialog').count(),0)
 assert.equal(await page.locator('#industry-local input,#industry-local textarea,#industry-public input,#industry-public textarea').count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>/^(connect:|disconnect:|skill-edits\/save)/.test(call))),[])
 await page.evaluate(()=>(window as any).objectFixture.industryCorrupt());await page.locator('#industry-local').getByRole('alert').waitFor();assert.equal(await page.locator('#industry-local button').first().isDisabled(),true)
})


test('只读原稿查询的工具视图准确显示读取，不把目录说成保存或待核验失败',async t=>{
 const page=await mount(t)
 assert.equal(await page.locator('#lookup-loading').innerText(),'正在读取…')
 assert.match(await page.locator('#lookup-directory').innerText(),/已读取草案目录/)
 assert.doesNotMatch(await page.locator('#lookup-directory').innerText(),/保存|需要核对|安装|启用/)
 assert.equal(await page.locator('#lookup-directory section').count(),0,'未明确命中原稿不产生猜测资源卡')
})


test('无正文原稿卡初始只显示名字状态，点击后才读取同一原稿并沿共享抽屉展示',async t=>{
 const page=await mount(t),ref=page.locator('#deferred-original')
 const before=await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>call==='draft:33333333-3333-4333-8333-333333333333').length)
 assert.equal(before,2,'只有原有两张完整回执卡读取正文，新元数据卡不读取');assert.match(await ref.innerText(),/已应用/);assert.doesNotMatch(await ref.innerText(),/正在读取/)
 await ref.getByRole('button',{name:/资料核对技能/}).click()
 const drawer=page.getByRole('dialog',{name:'技能详情'})
 await drawer.getByText('查看 SKILL.md 正文',{exact:true}).click();assert.match(await drawer.getByLabel('SKILL.md 只读正文').innerText(),/只读取用户授权资料/)
 assert.equal(await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>call==='draft:33333333-3333-4333-8333-333333333333').length),before+1)
 await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'detached'})
 assert.equal(await ref.getByRole('button',{name:/资料核对技能/}).isEnabled(),true)
 assert.equal(await page.evaluate(()=>(window as any).skillBodyExecuted),undefined)
})


test('慢读取立即显示可关闭抽屉，关闭后迟到原稿不打断另一个详情，重开重新读取',async t=>{
 const page=await mount(t),card=page.locator('#deferred-original').getByRole('button')
 await page.evaluate(()=>(window as any).objectFixture.holdDraft())
 await card.click()
 const drawer=page.getByRole('dialog',{name:'技能详情'})
 await drawer.getByRole('status').waitFor();assert.match(await drawer.getByRole('status').innerText(),/正在读取/)
 await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'detached'})
 assert.equal(await card.isEnabled(),true);assert.equal(await card.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await page.getByRole('button',{name:/test-server.*已保存/}).click()
 const other=page.getByRole('dialog',{name:'MCP 连接'});await other.waitFor()
 await page.evaluate(async()=>{(window as any).objectFixture.releaseDraft();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))})
 assert.equal(await page.locator('dialog[open]').count(),1);assert.equal(await drawer.count(),0);assert.equal(await other.isVisible(),true)
 await other.getByRole('button',{name:'关闭',exact:true}).click()
 const before=await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>call.startsWith('draft:')).length)
 await card.click();await drawer.getByText('查看 SKILL.md 正文',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>call.startsWith('draft:')).length),before+1)
 await page.keyboard.press('Escape');assert.equal(await card.evaluate((node:HTMLElement)=>node===document.activeElement),true)
})

test('自然语言分身回执使用本人缩写与统一分身名称，打开原岗位身份',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).objectFixture.twin())
 const card=page.locator('#tool'),button=card.getByRole('button',{name:/Max Luo 的分身/});await button.waitFor()
 assert.equal(await card.locator('[data-teloa-twin-avatar]').innerText(),'ML')
 assert.equal(await card.getByText('原存储分身名',{exact:true}).count(),0)
 await button.click();assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[['role','11111111-1111-4111-8111-111111111111']])
})

test('原会话计划草案明确核对才交Frame，逐字透入原owner/id/body/hash且不自动采用',async t=>{
 const page=await mount(t),card=page.locator('#plan-draft')
 await card.getByRole('button',{name:/本人原计划草案/}).click()
 const drawer=page.getByRole('dialog',{name:'草案详情',exact:true})
 await drawer.getByRole('button',{name:'核对并确认计划',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.opened),[])
 await drawer.getByRole('button',{name:'核对并确认计划',exact:true}).click()
 await drawer.waitFor({state:'hidden'})
 const opened=await page.evaluate(()=>(window as any).objectFixture.opened)
 assert.equal(opened.length,1);assert.equal(opened[0][0],'plan-draft')
 assert.deepEqual([opened[0][1].id,opened[0][1].ownerId,opened[0][1].bodyHash,opened[0][1].status],['12121212-1212-4212-8212-121212121212','local:teloa-owner','f'.repeat(64),'draft'])
 assert.deepEqual(opened[0][1],await page.evaluate(()=>(window as any).objectFixture.planDraft))
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((value:string)=>value.startsWith('connect:')||value.startsWith('disconnect:'))),[])
})


test('自定义应用原稿在同一抽屉认证并连接，关闭清空输入，落定后仍管理原连接',async t=>{
 const page=await mount(t),card=page.locator('#app-draft')
 await card.getByRole('button').click()
 let drawer=page.getByRole('dialog',{name:'草案详情',exact:true})
 const first=drawer.getByLabel('Authorization · Bearer',{exact:true}),second=drawer.getByLabel('X-API-Key',{exact:true})
 await first.fill('fixture-only');await second.fill('fixture-key')
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>call.startsWith('app-'))),[])
 await page.keyboard.press('Escape');await card.getByRole('button').click();drawer=page.getByRole('dialog',{name:'草案详情',exact:true})
 assert.equal(await drawer.getByLabel('X-API-Key',{exact:true}).inputValue(),'')
 await drawer.getByLabel('Authorization · Bearer',{exact:true}).fill('fixture-only');await drawer.getByLabel('X-API-Key',{exact:true}).fill('fixture-key')
 await drawer.getByRole('button',{name:'添加并连接 / 更新连接',exact:true}).click()
 await drawer.getByText('已保存认证；留空可沿用，填写全部字段可更新。',{exact:true}).waitFor()
 assert.equal(await drawer.getByRole('checkbox',{name:'search',exact:true}).isChecked(),false)
 assert.equal(await drawer.getByLabel('X-API-Key',{exact:true}).inputValue(),'')
 assert.equal(await drawer.getByRole('button',{name:'打开应用',exact:true}).count(),0)
 await drawer.getByRole('button',{name:'删除连接',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).objectFixture.calls.includes('app-delete')),false)
 await drawer.getByRole('button',{name:'确认删除连接与认证',exact:true}).click()
 await drawer.waitFor({state:'detached'})
 assert.deepEqual(await page.evaluate(()=>(window as any).objectFixture.calls.filter((call:string)=>call.startsWith('app-'))),['app-save','app-auth','app-connect','app-settle:87878787-8787-4787-8787-878787878787','app-delete'])
})
