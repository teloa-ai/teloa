import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createProjectContextApi} from '../src/client/project-context-api.ts'
test('未知写入跨刷新重试固定身份，草稿和其他项目独立，拒绝损坏回包',async()=>{
 const id=randomUUID(),other=randomUUID(),calls:any[]=[],change={kind:'save-brief' as const,brief:'项目简报'};let stored:string|null=null
 const journal={read:()=>stored,write:(v:string)=>{stored=v},clear:()=>{stored=null}}
 const api=createProjectContextApi(async(_e,input)=>{calls.push(input);throw Error('timeout')},journal)
 api.setDraft(other,{expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'',markdown:''}})
 await assert.rejects(api.mutate(id,0,change))
 const restored=createProjectContextApi(async(_e,input:any)=>{calls.push(input);return {projectId:input.projectId,requestId:input.requestId,version:1}},journal)
 assert.equal(restored.pending(id),true);assert.equal(restored.draft(other)?.change.kind,'save-entry')
 await assert.rejects(restored.mutate(id,0,{...change,brief:'不同内容'}))
 await restored.recover(id);assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(restored.pending(id),false)
 assert.ok(restored.draft(other))
 await assert.rejects(createProjectContextApi(async()=>({projectId:other,version:0,brief:'',entries:[],shares:[]})).get(id))
})
test('明确拒绝不保留未知重试，撤回回执不携带正文',async()=>{
 const api=createProjectContextApi(async()=>{throw {rejected:true,code:'teloa/version-conflict'}}),id=randomUUID()
 await assert.rejects(api.mutate(id,0,{kind:'save-brief',brief:'保留草稿'}));assert.equal(api.pending(id),false)
})
test('空白草稿可以恢复，损坏记录经本人明确重置后可写',async()=>{
 const id=randomUUID();let stored:string|null=null;const journal={read:()=>stored,write:(v:string)=>{stored=v},clear:()=>{stored=null}}
 const api=createProjectContextApi(async()=>null,journal)
 api.setDraft(id,{expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'  ',markdown:'\n'}})
 const next=createProjectContextApi(async()=>null,journal);assert.equal(next.recoveryError(),undefined);assert.equal(next.draft(id)?.change.kind,'save-entry')
 stored='broken';const broken=createProjectContextApi(async()=>null,journal);assert.ok(broken.recoveryError());broken.resetRecovery();assert.equal(broken.recoveryError(),undefined)
})
test('旧请求恢复不删除随后编辑的草稿，多个实例写不同项目不覆盖',async()=>{
 const a=randomUUID(),b=randomUUID();let stored:string|null=null;const journal={read:()=>stored,write:(v:string)=>{stored=v},clear:()=>{stored=null}}
 const failed=createProjectContextApi(async()=>{throw Error('timeout')},journal),other=createProjectContextApi(async()=>null,journal)
 const change={kind:'save-brief' as const,brief:'第一版'}
 failed.setDraft(a,{expectedVersion:0,change});await assert.rejects(failed.mutate(a,0,change))
 other.setDraft(b,{expectedVersion:0,change:{...change,brief:'其他项目'}})
 assert.ok(createProjectContextApi(async()=>null,journal).pending(a),'其他标签页不能抹掉未知请求')
 failed.setDraft(a,{expectedVersion:0,change:{...change,brief:'后续草稿'}})
 const restored=createProjectContextApi(async(_e,input:any)=>({projectId:input.projectId,requestId:input.requestId,version:1}),journal)
 await restored.recover(a);assert.equal((restored.draft(a)?.change as any).brief,'后续草稿');assert.equal((restored.draft(b)?.change as any).brief,'其他项目')
})
test('宿主通信失败仍是未知结果，保留原请求身份',async()=>{
 const id=randomUUID(),api=createProjectContextApi(async()=>{throw {rejected:true,code:'teloa/host-unavailable'}})
 await assert.rejects(api.mutate(id,0,{kind:'save-brief',brief:'已提交但回执丢失'}));assert.equal(api.pending(id),true)
})
test('无效粘贴在持久化前拒绝，保留原草稿与其他项目待核对请求且可继续修正',async()=>{
 const id=randomUUID(),other=randomUUID();let stored:string|null=null
 const journal={read:()=>stored,write:(value:string)=>{stored=value},clear:()=>{stored=null}}
 const api=createProjectContextApi(async()=>{throw Error('timeout')},journal)
 api.setDraft(id,{expectedVersion:0,change:{kind:'save-brief',brief:'原有草稿'}})
 await assert.rejects(api.mutate(other,0,{kind:'save-brief',brief:'待核对'}))
 const previous=stored
 for(const change of [
  {kind:'save-brief' as const,brief:'第一行\u000b第二行'},
  {kind:'save-entry' as const,entryId:null,entryKind:'memory' as const,topic:'经验',markdown:'第一行\u000b第二行'},
  {kind:'save-entry' as const,entryId:null,entryKind:'rule' as const,topic:'主题\u007f',markdown:'正文'},
 ]){
  assert.throws(()=>api.setDraft(id,{expectedVersion:0,change}),{code:'teloa/invalid-input'})
  assert.equal(stored,previous);assert.equal(api.recoveryError(),undefined);assert.equal(api.pending(other),true)
 }
 api.setDraft(id,{expectedVersion:0,change:{kind:'save-brief',brief:'已修正草稿'}})
 const reopened=createProjectContextApi(async()=>null,journal)
 assert.equal((reopened.draft(id)?.change as any).brief,'已修正草稿');assert.equal(reopened.pending(other),true)
})
