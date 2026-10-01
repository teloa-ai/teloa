import assert from 'node:assert/strict'
import test from 'node:test'
import {localRecoveryItems,unknownRecoveryOccurredAt} from '../src/client/attention-local-recovery.ts'
import {createArtifactApi} from '../src/client/artifact-api.ts'
import {createGroupApi} from '../src/client/group-api.ts'
import {createSkillInstallApi} from '../src/client/skill-install-api.ts'

const id='12345678-1234-4234-8234-123456789012'
const hash='a'.repeat(64)

test('真实恢复快照仅在目标目录可验证时出现，清空后消失且同一版本多项不合并',()=>{
 const snapshot={taskMaterial:{taskId:id,title:'任务',scope:'general'},artifacts:[{key:'revise:'+id+':1',artifactId:id,version:1,source:{kind:'task' as const,id},title:'修订'},{key:'feedback:'+id+':1:summary',artifactId:id,version:1,source:{kind:'task' as const,id},title:'反馈'}],artifactDirectory:[{id,source:{kind:'task',id},versions:[{number:1}]}],group:{id:'group-a'},groupDirectory:[{id:'group-a',name:'值守群',scope:'SOC',archived:false}],industryLoad:{id:'load-a',item:{id:'market-a',title:'行业包'},scope:'SOC'},skillInstall:{id:'skill-atomic',item:{id:'market-skill',title:'Skill'}}}
 const first=localRecoveryItems(snapshot),second=localRecoveryItems(snapshot)
 assert.deepEqual(first.map(item=>[item.id,item.occurredAt]),second.map(item=>[item.id,item.occurredAt]))
 assert.deepEqual(first.filter(item=>item.target.kind==='artifact').map(item=>item.id),['recovery:artifact:revise:'+id+':1','recovery:artifact:feedback:'+id+':1:summary'])
 assert.ok(first.every(item=>item.occurredAt===unknownRecoveryOccurredAt))
 assert.equal(localRecoveryItems({...snapshot,artifactDirectory:[],groupDirectory:[{id:'group-a',name:'值守群',scope:'SOC',archived:true}],taskMaterial:undefined,artifacts:[]}).length,2)
 assert.deepEqual(localRecoveryItems({...snapshot,taskMaterial:undefined,artifacts:[],group:undefined,industryLoad:undefined,skillInstall:undefined}),[])
})

test('真实 API journal 快照经目录核对后才产生稳定恢复项，并覆盖 atomic 与行业 Skill 来源',()=>{
 const source={kind:'session' as const,id:'session-a',scope:'general',version:'binding',title:'会话'}
 const artifactApi=createArtifactApi(async()=>{throw Error('本测试不读取网络')},{read:()=>JSON.stringify({schema:'teloa.artifact-save/v1',requests:[
  {key:'revise:'+id+':1',intent:'revision',requestId:'22345678-1234-4234-8234-123456789012',payload:{artifactId:id,expectedVersion:1,source,content:{title:'真实成果',sections:[{id:'summary',title:'摘要',text:'内容'}],note:'待保存',snapshotIds:[]}}},
  {key:'feedback:'+id+':1:summary',intent:'feedback',requestId:'32345678-1234-4234-8234-123456789012',payload:{requestId:'32345678-1234-4234-8234-123456789012',artifactId:id,version:1,sectionId:'summary',text:'反馈',source}}
 ]}),write:()=>{},clear:()=>{}})
 const groupApi=createGroupApi(async()=>{throw Error('本测试不读取网络')},{read:()=>JSON.stringify({schema:'teloa.groups/v1',command:{kind:'change',request:{requestId:'42345678-1234-4234-8234-123456789012',groupId:id,expectedVersion:1,fields:{name:'值守群',announcement:'更新',memberRoleIds:[],pinned:false,archived:false}}}}),write:()=>{},clear:()=>{}})
 const atomicApi=createSkillInstallApi(async()=>{throw Error('本测试不读取网络')},{read:()=>JSON.stringify({schema:'teloa.skill-install/v1',request:{requestId:'52345678-1234-4234-8234-123456789012',source:{kind:'atomic',contentId:'62345678-1234-4234-8234-123456789012'},expectedBundleHash:hash}}),write:()=>{},clear:()=>{}})
 const industryApi=createSkillInstallApi(async()=>{throw Error('本测试不读取网络')},{read:()=>JSON.stringify({schema:'teloa.skill-install/v1',request:{requestId:'72345678-1234-4234-8234-123456789012',source:{kind:'industry',loadId:'82345678-1234-4234-8234-123456789012',itemInstanceId:'92345678-1234-4234-8234-123456789012'},expectedBundleHash:hash}}),write:()=>{},clear:()=>{}})
 const artifactDirectory=[{id,source:{kind:'session',id:'session-a'},versions:[{number:1}]}]
 const groupDirectory=[{id,name:'值守群',scope:'SOC',archived:false}]
 const groupRequest=groupApi.pending()
 if(!groupRequest||groupRequest.kind==='create')throw Error('群恢复请求应为已有群写入')
 const fromApi=localRecoveryItems({artifacts:artifactApi.recoveryItems(),artifactDirectory,group:{id:groupRequest.request.groupId},groupDirectory,skillInstall:{id:atomicApi.pending()!.requestId,item:{id:'atomic-skill',title:'原子 Skill'}}})
 const industry=industryApi.pending()!
 if(industry.source.kind!=='industry')throw Error('恢复请求应保留行业 Skill 来源')
 const withIndustry=localRecoveryItems({artifacts:artifactApi.recoveryItems(),artifactDirectory,group:{id:groupRequest.request.groupId},groupDirectory,skillInstall:{id:industry.requestId,item:{id:'industry-skill',title:'行业 Skill'},source:industry.source}})
 assert.deepEqual(fromApi.map(item=>item.id),['recovery:artifact:revise:'+id+':1','recovery:artifact:feedback:'+id+':1:summary','recovery:group:'+id,'recovery:skill-install:52345678-1234-4234-8234-123456789012'])
 assert.deepEqual(withIndustry.find(item=>item.id==='recovery:skill-install:72345678-1234-4234-8234-123456789012')?.target,{kind:'industry-skill',loadId:'82345678-1234-4234-8234-123456789012',itemInstanceId:'92345678-1234-4234-8234-123456789012'})
 assert.deepEqual(localRecoveryItems({artifacts:artifactApi.recoveryItems(),artifactDirectory:[],group:{id:groupRequest.request.groupId},groupDirectory:[{...groupDirectory[0]!,archived:true}],skillInstall:undefined}),[])
})
