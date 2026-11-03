import test from 'node:test'
import assert from 'node:assert/strict'
import {encodeEmployeeMention,type DigitalRole} from '@teloa/contract'
import {resolveConversationEmployeeMention,bindEmployeeMentionDispatch,assertEmployeeMentionExistingTarget,employeeMentionOverridesPreference} from '../src/work/conversation-work-employee-mention.ts'
const roleId='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',marker=encodeEmployeeMention({roleId,roleVersion:1})
function fixture(){
 let role={id:roleId,ownerId:'owner',version:1,kind:'employee',state:'active',scopes:['security'],name:'研判员',skills:[],knowledge:[]} as unknown as DigitalRole
 let scope='security',revision=1,availableScopes:readonly string[]|undefined
 const ports={owner:'owner',role:async()=>role,context:async(sessionId:string)=>({sessionId,scopeId:scope,eligible:true,fingerprint:JSON.stringify([sessionId,scope,revision,availableScopes??null]),...(availableScopes?{availableScopes}:{})})}
 return {ports,setRole:(fields:Partial<DigitalRole>)=>role={...role,...fields},setScope:(value:string)=>scope=value,reviseContext:()=>revision++,setAvailable:(values:readonly string[])=>{availableScopes=values;revision++}}
}
test('角色名称不授身份；当前引用完整固定owner/版本/业务，正常dispatch不得隐式改派',async()=>{
 const f=fixture();assert.equal(await resolveConversationEmployeeMention(f.ports,'parent','@研判员 你好'),null)
 const selection=await resolveConversationEmployeeMention(f.ports,'parent',marker+' 请调查这条新告警');assert.ok(selection)
 assert.deepEqual(await bindEmployeeMentionDispatch(selection,{}),{roleId,expectedRoleVersion:1,scope:'security'})
 for(const input of [{roleId:other},{scope:'sales'},{expectedRoleVersion:2},{executor:'general'}])await assert.rejects(()=>bindEmployeeMentionDispatch(selection,input))
 await assert.rejects(()=>assertEmployeeMentionExistingTarget(selection,{roleId:other,roleVersion:1,scope:'security'}))
 f.setRole({version:2});await assert.rejects(()=>selection.assertCurrent());await assert.rejects(()=>bindEmployeeMentionDispatch(selection,{}))
})
test('同业务的真实上下文版本变化也使原选择失效，不能仅比较业务名称',async()=>{
 const f=fixture(),selection=await resolveConversationEmployeeMention(f.ports,'parent',marker);assert.ok(selection)
 f.reviseContext();await assert.rejects(()=>selection.assertCurrent())
})
test('通用入口唯一业务自动采用，多业务先沟通且派活才要求选择，明确业务不跨域',async()=>{
 const f=fixture();f.setScope('general')
 await assert.rejects(()=>resolveConversationEmployeeMention(f.ports,'parent',marker),/授权尚未核对/)
 f.setAvailable(['general','security']);const selected=await resolveConversationEmployeeMention(f.ports,'parent',marker);assert.ok(selected)
 assert.equal(selected.scopeId,'security');assert.equal((await bindEmployeeMentionDispatch(selected,{})).scope,'security')
 f.setAvailable(['general','sales']);await assert.rejects(()=>selected.assertCurrent())
 f.setRole({scopes:['security','sales']});f.setAvailable(['general','security','sales'])
 const chatting=await resolveConversationEmployeeMention(f.ports,'parent',marker+' 你能做什么');assert.ok(chatting);assert.equal(chatting.scopeId,'general')
 await assert.rejects(()=>bindEmployeeMentionDispatch(chatting,{}),/业务选择/)
 f.setScope('security');assert.equal((await resolveConversationEmployeeMention(f.ports,'parent',marker))?.scopeId,'security')
 f.setRole({scopes:['sales']});await assert.rejects(()=>resolveConversationEmployeeMention(f.ports,'parent',marker),/不支持当前业务/)
})
test('general事务范围覆盖仍需同canonical、唯一本人授权业务和真实employee范围',()=>{
 const input={kind:'task' as const,scope:'security',roleId,expectedRoleVersion:1,sourceText:marker},available={role:{kind:'employee' as const,scopes:['security']},scopes:['general','security']}
 assert.equal(employeeMentionOverridesPreference(input,'general',available),true)
 assert.equal(employeeMentionOverridesPreference(input,'general'),false)
 assert.equal(employeeMentionOverridesPreference({kind:input.kind,scope:input.scope,roleId:input.roleId,expectedRoleVersion:input.expectedRoleVersion},'general',available),false)
 assert.equal(employeeMentionOverridesPreference({...input,expectedRoleVersion:2},'general',available),false)
 assert.equal(employeeMentionOverridesPreference({...input,scope:'sales'},'security',available),false)
 assert.equal(employeeMentionOverridesPreference(input,'general',{...available,role:{kind:'twin',scopes:['security']}}),false)
 assert.throws(()=>employeeMentionOverridesPreference(input,'general',{...available,scopes:['general']}),/没有本人可用/)
 const multiple={role:{kind:'employee' as const,scopes:['security','sales']},scopes:['general','security','sales']}
 assert.equal(employeeMentionOverridesPreference(input,'general',multiple),false,'多业务不猜某个专属业务')
 assert.throws(()=>employeeMentionOverridesPreference({...input,scope:'general'},'general',multiple),/业务选择/)
 assert.equal(employeeMentionOverridesPreference({...input,scope:'general'},'general',{role:{kind:'employee',scopes:['general','security']},scopes:['general','security']}),true,'明确支持general的岗位仍可创建general任务')
 assert.throws(()=>employeeMentionOverridesPreference({...input,sourceText:marker+' '+encodeEmployeeMention({roleId:other,roleVersion:1})},'general',available),/一位员工/)
})
test('真实reserve偏好覆盖只认原source精确单员工和版本，不接受缺源、多员工或跨业务',()=>{
 const selectedB=encodeEmployeeMention({roleId:other,roleVersion:2})
 const input={kind:'task' as const,scope:'security',roleId:other,expectedRoleVersion:2,sourceText:selectedB+' 请接手这条新工作'}
 assert.equal(employeeMentionOverridesPreference(input,'security'),true,'会话偏好A不会阻止明确@B的新工作')
 assert.equal(employeeMentionOverridesPreference({kind:input.kind,scope:input.scope,roleId:input.roleId,expectedRoleVersion:input.expectedRoleVersion},'security'),false)
 assert.equal(employeeMentionOverridesPreference({...input,sourceText:'@另一位员工 请接手'},'security'),false)
 assert.equal(employeeMentionOverridesPreference({...input,roleId},'security'),false)
 assert.equal(employeeMentionOverridesPreference({...input,expectedRoleVersion:3},'security'),false)
 assert.equal(employeeMentionOverridesPreference(input,'sales'),false)
 assert.equal(employeeMentionOverridesPreference({...input,scope:'sales'},'security'),false)
 assert.equal(employeeMentionOverridesPreference({...input,kind:'report'},'security'),false)
 assert.equal(employeeMentionOverridesPreference({...input,executor:'general'},'security'),false)
 assert.throws(()=>employeeMentionOverridesPreference({...input,sourceText:selectedB+' '+marker},'security'),/一位员工/)
 assert.throws(()=>employeeMentionOverridesPreference({...input,sourceText:selectedB+' '+selectedB.replace(':2]',':3]')},'security'),/一位员工/)
 assert.equal(employeeMentionOverridesPreference({...input,sourceText:selectedB+' '+selectedB},'security'),true,'重复同一固定引用不构成第二名员工')
})
test('暂停可沟通不接新工作；退役/错本人/错业务/多员工拒绝，确认期间变化再核',async()=>{
 const f=fixture();f.setRole({state:'paused'});const selection=await resolveConversationEmployeeMention(f.ports,'parent',marker);assert.ok(selection);await assert.rejects(()=>bindEmployeeMentionDispatch(selection,{}))
 f.setRole({state:'retired'});await assert.rejects(()=>resolveConversationEmployeeMention(f.ports,'parent',marker))
 f.setRole({state:'active',ownerId:'other'});await assert.rejects(()=>resolveConversationEmployeeMention(f.ports,'parent',marker))
 f.setRole({ownerId:'owner'});f.setScope('sales');await assert.rejects(()=>resolveConversationEmployeeMention(f.ports,'parent',marker))
 f.setScope('security');const current=await resolveConversationEmployeeMention(f.ports,'parent',marker);assert.ok(current);f.setScope('sales');await assert.rejects(()=>current.assertCurrent())
 await assert.rejects(()=>resolveConversationEmployeeMention(f.ports,'parent',marker+' '+encodeEmployeeMention({roleId:other,roleVersion:1})))
})
