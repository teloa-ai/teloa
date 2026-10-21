import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createContinuousFormJournal,type PlanFormDraft} from '../src/client/continuous-form-journal.ts'
const id='11111111-1111-4111-8111-111111111111'
const role='22222222-2222-4222-8222-222222222222'
const fresh=(revision?:number):PlanFormDraft=>({id,...(revision===undefined?{}:{revision}),fields:{title:'',scope:'general',goal:'',dataScope:'已授权资料',delivery:'未发送草稿',roleId:'',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}}})
const storage=()=>{const values=new Map<string,string>();let fail=false;return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{if(fail)throw Error('QuotaExceededError');values.set(k,v)},removeItem:(k:string)=>{values.delete(k)},fail:(next:boolean)=>{fail=next}}}
const open=(journal:ReturnType<typeof createContinuousFormJournal>,entry='new',draft=fresh())=>journal.setForms(current=>({...current,[entry]:draft}))

test('restores partial user inputs and the original draft identity only for the same person and entry',()=>{
 const s=storage(),first=createContinuousFormJournal({namespace:'person-a',storage:s});open(first)
 first.setForms(current=>({...current,new:{...current.new!,fields:{...current.new!.fields,title:'agent-business 未完成',goal:'待补充',roleId:role,notificationPolicy:'failure',trigger:{...current.new!.fields.trigger,kind:'schedule',cadence:'weekly',weekday:1,time:'',timezone:'Asia/Singapore'}}}}))
 first.setGoal('new','原来的自然语言目标')
 const restored=createContinuousFormJournal({namespace:'person-a',storage:s});open(restored);restored.loadGoal('new')
 assert.equal(restored.getSnapshot().forms.new!.id,id);assert.equal(restored.getSnapshot().forms.new!.fields.title,'agent-business 未完成');assert.equal(restored.getSnapshot().forms.new!.fields.trigger.kind,'schedule');assert.equal(restored.getSnapshot().goals.new,'原来的自然语言目标')
 const other=createContinuousFormJournal({namespace:'person-b',storage:s});open(other);other.loadGoal('new');assert.equal(other.getSnapshot().forms.new!.fields.title,'');assert.equal(other.getSnapshot().goals.new,undefined)
 const entry=createContinuousFormJournal({namespace:'person-a',storage:s});open(entry,'new:another-business');assert.equal(entry.getSnapshot().forms['new:another-business']!.fields.title,'')
})

test('an edit from another fixed plan revision never receives the previous revision inputs',()=>{
 const s=storage(),first=createContinuousFormJournal({namespace:'person-a',storage:s});open(first,id,fresh(1));first.setForms(current=>({...current,[id]:{...current[id]!,fields:{...current[id]!.fields,title:'旧版本未保存'}}}))
 const newer=createContinuousFormJournal({namespace:'person-a',storage:s});open(newer,id,fresh(2));assert.equal(newer.getSnapshot().forms[id]!.fields.title,'');assert.equal(newer.getSnapshot().forms[id]!.revision,2)
 const old=createContinuousFormJournal({namespace:'person-a',storage:s});open(old,id,fresh(1));assert.equal(old.getSnapshot().forms[id]!.fields.title,'旧版本未保存','old inputs remain under their original fixed revision')
})

test('template and pinned content versions keep independent inputs and retain the original fixed source',()=>{
 const s=storage(),seed:PlanFormDraft={...fresh(),template:{key:'template:v1',itemId:id,templateId:'weekly-review',title:'每周复核',version:'1',scope:'general',hash:'a'.repeat(64),example:false,source:'固定来源',author:'owner',license:'MIT',description:'复核本轮资料',requirements:[],output:'未发送草稿',skills:[]},source:{kind:'market-content',contentId:id,contentHash:'a'.repeat(64),resourceId:'weekly-review',resourceVersion:'1'}}
 const original=createContinuousFormJournal({namespace:'person-a',storage:s});open(original,'template',seed);original.setForms(current=>({...current,template:{...current.template!,fields:{...current.template!.fields,title:'原模板未保存输入'}}}))
 const changedTemplate=createContinuousFormJournal({namespace:'person-a',storage:s});open(changedTemplate,'template',{...seed,template:{...seed.template!,key:'template:v2',version:'2'}});assert.equal(changedTemplate.getSnapshot().forms.template!.fields.title,'')
 const changedSource=createContinuousFormJournal({namespace:'person-a',storage:s});open(changedSource,'template',{...seed,source:{kind:'market-content',contentId:id,contentHash:'b'.repeat(64),resourceId:'weekly-review',resourceVersion:'2'}});assert.equal(changedSource.getSnapshot().forms.template!.fields.title,'')
 const recovered=createContinuousFormJournal({namespace:'person-a',storage:s});open(recovered,'template',seed);assert.equal(recovered.getSnapshot().forms.template!.fields.title,'原模板未保存输入');assert.deepEqual(recovered.getSnapshot().forms.template!.source,seed.source)
})

test('quota failure keeps the latest input in memory and marks it unsaved until that entry is written',()=>{
 const s=storage(),journal=createContinuousFormJournal({namespace:'person-a',storage:s});open(journal);s.fail(true)
 journal.setForms(current=>({...current,new:{...current.new!,fields:{...current.new!.fields,title:'不能丢的当前输入'}}}))
 assert.equal(journal.getSnapshot().forms.new!.fields.title,'不能丢的当前输入');assert.equal(journal.getSnapshot().warning,'write')
 s.fail(false);journal.setForms(current=>({...current,new:{...current.new!,fields:{...current.new!.fields,goal:'存储恢复后继续'}}}));assert.equal(journal.getSnapshot().warning,undefined)
 const reopened=createContinuousFormJournal({namespace:'person-a',storage:s});open(reopened);assert.equal(reopened.getSnapshot().forms.new!.fields.title,'不能丢的当前输入')
})

test('corrupt recovery data is retained and cannot be silently replaced by empty or newly typed inputs',()=>{
 const s=storage(),first=createContinuousFormJournal({namespace:'person-a',storage:s});open(first);const key=[...s.values.keys()][0]!;s.values.set(key,'{broken')
 const reopened=createContinuousFormJournal({namespace:'person-a',storage:s});assert.doesNotThrow(()=>open(reopened));assert.equal(reopened.getSnapshot().warning,'read')
 reopened.setForms(current=>({...current,new:{...current.new!,fields:{...current.new!.fields,title:'仍可复制的当前输入'}}}))
 assert.equal(reopened.getSnapshot().forms.new!.fields.title,'仍可复制的当前输入');assert.equal(s.values.get(key),'{broken')
})

test('tampered journal identity, unknown keys and invalid draft ids fail closed without deleting evidence',()=>{
 for(const mutation of [(r:any)=>{r.namespace='another-person'},(r:any)=>{r.extra=true},(r:any)=>{r.id='not-a-uuid'},(r:any)=>{r.fields.untrusted=true},(r:any)=>{r.fields.notificationPolicy=['failure']},(r:any)=>{r.fields.trigger.cadence=['daily']}]){
  const s=storage(),first=createContinuousFormJournal({namespace:'person-a',storage:s});open(first);const key=[...s.values.keys()][0]!,row=JSON.parse(s.values.get(key)!);mutation(row);const raw=JSON.stringify(row);s.values.set(key,raw)
  const next=createContinuousFormJournal({namespace:'person-a',storage:s});open(next);assert.equal(next.getSnapshot().warning,'read');assert.equal(s.values.get(key),raw)
 }
})

test('confirmed completion clears only that entry while other unsent drafts and goals remain recoverable',()=>{
 const s=storage(),journal=createContinuousFormJournal({namespace:'person-a',storage:s});open(journal,'new:a');open(journal,'new:b');journal.setGoal('new:b','另一入口的目标')
 journal.setForms(current=>{const next={...current};delete next['new:a'];return next})
 const next=createContinuousFormJournal({namespace:'person-a',storage:s});open(next,'new:a');next.loadGoal('new:b');assert.equal(next.getSnapshot().goals['new:b'],'另一入口的目标');assert.equal(s.values.size,3)
})
