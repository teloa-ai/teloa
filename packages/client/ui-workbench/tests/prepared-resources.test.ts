import test from 'node:test'
import assert from 'node:assert/strict'
import {PromptPreparation,type PreparedInputSnapshot} from '../src/client/prompt-preparation.ts'
const resource={id:'11111111-1111-4111-8111-111111111111',version:1,title:'工作手册'}
const prepare=()=>{const queue=new PromptPreparation();queue.prepare({id:'p',sourceId:'home:w',sourceKind:'home',sourceVersion:1,sessionId:'s',title:'目标',text:'核对手册',resources:[resource]});return queue}
const native=()=>{
 let snapshot:PreparedInputSnapshot={draft:'',draftRev:0,phase:'plain',attachmentIds:[],running:false};const writes:string[]=[];let fail=true
 return {writes,get snapshot(){return snapshot},allow:()=>{fail=false},read:()=>snapshot,
 async text(value:string,revision:number){assert.equal(revision,snapshot.draftRev);writes.push('text');snapshot={...snapshot,draft:value,draftRev:revision+1};return snapshot},
 async reference(value:typeof resource,revision:number){assert.equal(revision,snapshot.draftRev);if(fail)throw Error('暂时无法插入');writes.push(value.id);snapshot={...snapshot,draft:snapshot.draft+'[资料]',draftRev:revision+1};return snapshot}}
}
test('部分带入保留未完成项，重试不覆盖或重复目标文字',async()=>{
 const queue=prepare(),port=native()
 await assert.rejects(()=>queue.insertResources('p','s',async()=>[resource],port),/无法插入/)
 assert.deepEqual(port.writes,['text']);assert.equal(queue.getSnapshot()[0]?.status,'pending')
 port.allow();await queue.insertResources('p','s',async()=>[resource],port)
 assert.deepEqual(port.writes,['text',resource.id]);assert.equal(queue.getSnapshot()[0]?.status,'inserted')
})
test('目标会话查不到固定版本时不写输入，查询期间撤回准备也不写',async()=>{
 const queue=prepare(),port=native()
 await assert.rejects(()=>queue.insertResources('p','s',async()=>[{...resource,version:2}],port),/版本/)
 assert.deepEqual(port.writes,[])
 await assert.rejects(()=>queue.insertResources('p','s',async()=>{queue.dismiss('p');return [resource]},port),/状态/)
 assert.deepEqual(port.writes,[])
})
const skill={name:'research',source:'/workspace/SKILL.md',provider:'local'}
test('首页 Skill 必须在目标目录核对来源，失败不写入，成功采用原生斜线形式',async()=>{
 const queue=new PromptPreparation(),port=native()
 queue.prepare({id:'k',sourceId:'home:k',sourceKind:'home',sourceVersion:1,sessionId:'s',title:'研究',text:'调查线索',skills:[skill]})
 await assert.rejects(()=>queue.insertResources('k','s',async()=>[],port,async()=>[{...skill,source:'/other/SKILL.md',userInvocable:true}]),/技能/)
 assert.deepEqual(port.writes,[])
 await queue.insertResources('k','s',async()=>[],port,async()=>[{...skill,userInvocable:true}])
 assert.equal(port.snapshot.draft,'/research \n调查线索')
 assert.equal(queue.getSnapshot()[0]?.status,'inserted')
})
test('禁止绕过 Skill 核验，禁止 Agent 专用及同名歧义的 Skill',async()=>{
 const queue=new PromptPreparation(),port=native()
 queue.prepare({id:'k',sourceId:'home:k',sourceVersion:1,sessionId:'s',title:'研究',text:'调查',skills:[skill]})
 assert.throws(()=>queue.insert('k','s',port.snapshot,false,{setDraft(){throw Error('不应写入')}}),/核验/)
 await assert.rejects(()=>queue.insertResources('k','s',async()=>[],port,async()=>[{...skill,userInvocable:false}]),/技能/)
 await assert.rejects(()=>queue.insertResources('k','s',async()=>[],port,async()=>[{...skill,userInvocable:true},{...skill,source:'other',userInvocable:true}]),/技能/)
 assert.deepEqual(port.writes,[])
})
