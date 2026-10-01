import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createSkillUpgradeApi} from '../src/client/skill-upgrade-api.ts'
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',oldContent='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',newContent='cccccccc-cccc-4ccc-8ccc-cccccccccccc',at='2026-09-12T00:00:00.000Z'
const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),oldFiles=[{path:'SKILL.md',hash:sha('old'),size:3},{path:'old.txt',hash:sha('removed'),size:7}],newFiles=[{path:'SKILL.md',hash:sha('new'),size:3},{path:'new.txt',hash:sha('added'),size:5}]
const bundle=(files:typeof oldFiles)=>sha(JSON.stringify(files.map(file=>[file.path,file.hash])))
const source={kind:'atomic' as const,contentId:oldContent,contentHash:sha('old-source'),resourceId:'review',resourceVersion:'1.0.0'},native={name:'review',description:'核对',modelInvocable:true,userInvocable:true,bodyHash:sha('正文')}
const installation={id,ownerId:'owner',source,bundleHash:bundle(oldFiles),native,state:'installed',version:2,createdAt:at,updatedAt:at},availability={installationId:id,ownerId:'owner',availability:'enabled',version:1,updatedAt:at}
const current={installation,availability,impact:{installation:{id,version:2,bundleHash:installation.bundleHash,nativeName:'review'},availability:{value:'enabled',version:1},industryUsages:[],roles:[],plans:[],tasks:[],runs:[],ordinarySessions:{status:'unknown'}},impactDigest:sha('impact'),blockers:[]}
const target={source:{...source,contentId:newContent,contentHash:sha('new-source'),resourceVersion:'2.0.0'},bundleHash:bundle(newFiles),native,files:newFiles}
const files=[{path:'SKILL.md',change:'modified',before:{hash:oldFiles[0]!.hash,size:3},after:{hash:newFiles[0]!.hash,size:3}},{path:'new.txt',change:'added',before:null,after:{hash:newFiles[1]!.hash,size:5}},{path:'old.txt',change:'removed',before:{hash:oldFiles[1]!.hash,size:7},after:null}]
const response={current,target,files,sameResourceId:true,blockers:[]}
test('真实升级预览只调用只读入口，固定安装与目标来源',async()=>{
 const calls:unknown[]=[];const api=createSkillUpgradeApi(async(method,payload)=>{calls.push([method,payload]);return response})
 assert.deepEqual(await api.preview({installationId:id,target:{kind:'atomic',contentId:newContent}}),response)
 assert.deepEqual(calls,[['skill-upgrades/preview',{installationId:id,target:{kind:'atomic',contentId:newContent}}]])
})
test('拒绝差异遗漏、错分类、重复路径、错误摘要及跨目标回包',async()=>{
 for(const bad of [{...response,files:files.slice(0,2)},{...response,files:[{...files[0],change:'unchanged'},...files.slice(1)]},{...response,files:[...files,files[2]]},{...response,files:files.map((f,i)=>i===0?{...f,after:{hash:sha('bad'),size:3}}:f)},{...response,target:{...target,source:{...target.source,contentId:oldContent}}},{...response,current:{...current,installation:{...installation,id:oldContent}}},{...response,sameResourceId:'yes'},{...response,blockers:['fake']}])await assert.rejects(createSkillUpgradeApi(async()=>bad).preview({installationId:id,target:{kind:'atomic',contentId:newContent}}))
})
test('同字节不同固定来源不是same-source，公共alias按真实原子来源归一',async()=>{
 const oldTarget={source,native,bundleHash:installation.bundleHash,files:oldFiles},unchanged=oldFiles.map(file=>({path:file.path,change:'unchanged',before:{hash:file.hash,size:file.size},after:{size:file.size,hash:file.hash}}))
 const publicSource={kind:'industry-public',loadId:id,itemInstanceId:newContent,contentId:newContent,contentHash:sha('industry'),resourceId:'alias-review',resourceVersion:'1.0.0',sourceContentId:source.contentId,sourceContentHash:source.contentHash,sourceResourceId:source.resourceId,sourceResourceVersion:source.resourceVersion}
 const same={...response,current:{...current,installation:{...installation,source:publicSource}},target:oldTarget,files:unchanged,blockers:['same-source']}
 assert.deepEqual((await createSkillUpgradeApi(async()=>same).preview({installationId:id,target:{kind:'atomic',contentId:oldContent}})).blockers,['same-source'])
 const sameBytes={...response,target:{...oldTarget,source:{...source,contentId:newContent}},files:unchanged}
 assert.deepEqual((await createSkillUpgradeApi(async()=>sameBytes).preview({installationId:id,target:{kind:'atomic',contentId:newContent}})).blockers,[])
})
test('原生名称变化展示阻塞，后端漏报blocker不能静默呈现可用目标',async()=>{
 const mismatch={...response,target:{...target,native:{...native,name:'other'}},blockers:['native-name-mismatch']}
 assert.deepEqual((await createSkillUpgradeApi(async()=>mismatch).preview({installationId:id,target:{kind:'atomic',contentId:newContent}})).blockers,['native-name-mismatch'])
 await assert.rejects(createSkillUpgradeApi(async()=>({...mismatch,blockers:[]})).preview({installationId:id,target:{kind:'atomic',contentId:newContent}}))
})
test('确认升级先安装不可变目标再切换全局选择，并固定行业逐项迁移范围',async()=>{
 const targetInstallation={...installation,id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',source:target.source,bundleHash:target.bundleHash,version:1},usage={loadId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',itemInstanceId:'ffffffff-ffff-4fff-8fff-ffffffffffff'},selection={ownerId:'owner',nativeName:'review',installationId:id,version:1,updatedAt:at},selectionImpact={nativeName:'review',selection:{installationId:id,version:1},current:{installationId:id,installationVersion:2,bundleHash:installation.bundleHash,availability:'enabled',availabilityVersion:1},target:{installationId:targetInstallation.id,installationVersion:1,bundleHash:target.bundleHash,availability:'enabled',availabilityVersion:1},industryUsages:[usage]},selectionDigest=sha('selection-impact'),calls:Array<[string,unknown]>=[],storage={value:null as string|null}
 const api=createSkillUpgradeApi(async(method,payload)=>{calls.push([method,payload]);if(method==='skill-installations/install')return {installation:targetInstallation,source:target.source};if(method==='skill-selections/preview')return {selection,current:installation,target:targetInstallation,impact:selectionImpact,impactDigest:selectionDigest};if(method==='skill-selections/change'){const request=payload as Record<string,unknown>,result={...selection,installationId:targetInstallation.id,version:2};return {receipt:{requestId:request.requestId,nativeName:'review',before:selection,result,migratedIndustryUsages:[usage],impact:selectionImpact,impactDigest:selectionDigest,createdAt:at},current:result}}throw Error(method)},{read:()=>storage.value,write:value=>{storage.value=value},clear:()=>{storage.value=null}})
 const result=await api.apply({currentInstallationId:id,target:{kind:'atomic',contentId:newContent},expectedTargetBundleHash:target.bundleHash,industryUsages:[usage]})
 assert.equal(result.installation.id,targetInstallation.id);assert.equal(result.selection.installationId,targetInstallation.id);assert.deepEqual(result.migratedIndustryUsages,[usage]);assert.equal(storage.value,null)
 assert.deepEqual(calls.map(([method])=>method),['skill-installations/install','skill-selections/preview','skill-selections/change'])
 const change=calls[2]![1] as Record<string,unknown>;assert.equal(change.currentInstallationId,id);assert.equal(change.targetInstallationId,targetInstallation.id);assert.equal(change.expectedImpactDigest,selectionDigest);assert.deepEqual(change.industryUsages,[usage])
})
