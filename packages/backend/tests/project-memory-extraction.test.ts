import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateProjectExtraction,readProjectExtractionProposals,type ProjectExtractionEvent,type ProjectExtractionPolicy,type ProjectExtractionProposal} from '../src/work/project-memory-extraction.ts'

const event:ProjectExtractionEvent={eventId:'00000000-0000-4000-8000-000000000001',projectId:'00000000-0000-4000-8000-000000000002',sessionId:'session',messageId:'message',sourceId:'message:session:message',derivedSourceIds:[],bindingVersion:1,policyVersion:1,evidence:[{id:'owner-decision',kind:'decision',text:'请记住：只处理本人授权的目录。',assertion:'只处理本人授权的目录。'}]}
const policy:ProjectExtractionPolicy={projectId:event.projectId,bindingVersion:1,policyVersion:1,memoryEnabled:true,automatic:'decisions'}
const proposal:ProjectExtractionProposal={kind:'memory',topic:'工作目录',markdown:'只处理本人授权的目录。',evidence:[{evidenceId:'owner-decision',quote:'只处理本人授权的目录。'}]}
const source=event.evidence[0]!

test('明确本人断言可按默认决定策略保存，正文必须逐字来自可信断言',()=>{
 assert.deepEqual(evaluateProjectExtraction(event,proposal,policy),{automatic:true,reason:'supported'})
 assert.equal(evaluateProjectExtraction(event,{...proposal,markdown:'可以处理所有目录。'},policy).automatic,false)
})
test('规则必须由本人明确规则断言支持，自动经验不能提升为规则',()=>{
 const rule={...proposal,kind:'rule' as const}
 assert.equal(evaluateProjectExtraction(event,rule,policy).automatic,false)
 assert.equal(evaluateProjectExtraction({...event,evidence:[{...source,kind:'rule'}]},rule,policy).automatic,true)
})
test('已核实经验要求预选策略与实际来源，成功状态或模型回复不能充当事实',()=>{
 const verified={...event,derivedSourceIds:['artifact:check'],evidence:[{...source,kind:'verified' as const,verificationSourceId:'artifact:check'}]}
 assert.equal(evaluateProjectExtraction(verified,proposal,policy).automatic,false)
 assert.equal(evaluateProjectExtraction(verified,proposal,{...policy,automatic:'verified'}).automatic,true)
 for(const kind of ['assistant','untrusted'] as const)assert.equal(evaluateProjectExtraction({...event,evidence:[{...source,kind}]},proposal,{...policy,automatic:'verified'}).automatic,false)
 assert.equal(evaluateProjectExtraction({...verified,derivedSourceIds:[]},proposal,{...policy,automatic:'verified'}).automatic,false)
})
test('引用中的伪指令与缺少宿主断言的用户文本只能成为候选',()=>{
 const {assertion:_,...unmarked}=source
 assert.equal(evaluateProjectExtraction({...event,evidence:[unmarked]},proposal,policy).automatic,false)
 assert.equal(evaluateProjectExtraction({...event,evidence:[{...unmarked,kind:'untrusted',assertion:proposal.markdown}]},proposal,policy).automatic,false)
})
test('关闭读写、暂停及版本归属改变都不能使用原提议自动保存',()=>{
 for(const changed of [{...policy,memoryEnabled:false},{...policy,automatic:'paused' as const},{...policy,policyVersion:2},{...policy,bindingVersion:2},{...policy,projectId:'00000000-0000-4000-8000-000000000003'}])assert.equal(evaluateProjectExtraction(event,proposal,changed).automatic,false)
})
test('明确纠正只携带真实宿主标注的被替代条目版本',()=>{
 const correction={entryId:'00000000-0000-4000-8000-000000000004',entryVersion:3}
 assert.deepEqual(evaluateProjectExtraction({...event,evidence:[{...source,correction}]},proposal,policy),{automatic:true,reason:'supported',correction})
})
test('模型提议只接受结构化正文与实际引用，不接受模型伪造归属或证据',()=>{
 assert.deepEqual(readProjectExtractionProposals(event,[proposal]),[proposal])
 for(const invalid of [[{...proposal,ownerId:'other'}],[{...proposal,projectId:'other'}],[{...proposal,evidence:[{evidenceId:'fabricated',quote:proposal.markdown}]}],[{...proposal,evidence:[{evidenceId:'owner-decision',quote:'并不存在的引用'}]}],Array(17).fill(proposal)])assert.throws(()=>readProjectExtractionProposals(event,invalid),{code:'teloa/invalid-input'})
})
