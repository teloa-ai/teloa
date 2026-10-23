import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateProjectExtraction,projectExtractionProposalMemorable,readProjectExtractionProposals,readProjectMemorySourceKind,type ProjectExtractionEvent,type ProjectExtractionPolicy,type ProjectExtractionProposal} from '../src/work/project-memory-extraction.ts'

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

test('提炼来源区分可记忆事实与提问/检索/寒暄，纯提问不再形成候选',()=>{
 for(const fact of [
  '决定：本项目内部代号为 PX-204',
  '请记住：本项目采用方案 C（先完成社区版 Web 工作台）',
  '不要调用任何工具…请把这条内容记入项目记忆：本项目内部代号是 PX-909。只回复：收到',
  '请把这条内容作为项目记忆候选保存：备用代号是 PX-111，但尚未确定。',
  '从现在开始，在这个项目会话里只做文字回答，不要调用任何工具，也不要修改项目字段。只回复：好的',
  '本项目采用方案 C，先完成社区版 Web 工作台。',
 ])assert.equal(readProjectMemorySourceKind(fact),'fact',fact)
 for(const [text,kind] of [
  ['本项目采用哪个技术方案？如果项目记忆里没有方案记录，请明确说没有依据。','question'],
  ['本项目内部代号是什么？请只依据项目上下文回答，并说明依据来源。','question'],
  ['QA-MEM-项目甲 的内部代号 PX-204 是什么？你当前能读取到那个项目的记忆吗？只依据你可用的项目上下文回答。','question'],
  ['请列出本项目项目记忆中已保存的全部条目标题与正文；没有就说明没有。','retrieval'],
  ['请核对一下项目记忆里是否已有这条决策。','retrieval'],
  ['好的','greeting'],
  ['收到。','greeting'],
  ['好的，收到！','greeting'],
  ['谢谢！','greeting'],
  ['','greeting'],
 ] as const)assert.equal(readProjectMemorySourceKind(text),kind,text)
 const questionEvent:ProjectExtractionEvent={...event,evidence:[{id:'owner-decision',kind:'decision',text:'本项目采用哪个技术方案？'}]}
 const questionProposal:ProjectExtractionProposal={kind:'memory',topic:'项目技术方案',markdown:'本项目采用哪个技术方案？',evidence:[{evidenceId:'owner-decision',quote:'本项目采用哪个技术方案？'}]}
 assert.equal(projectExtractionProposalMemorable(questionEvent,questionProposal),false)
 assert.equal(projectExtractionProposalMemorable(event,proposal),true,'带宿主断言的决定仍可提炼')
 const verified:ProjectExtractionEvent={...questionEvent,evidence:[...questionEvent.evidence,{id:'verified:check',kind:'verified',text:'工具结果：技术方案 C 已核实',assertion:'技术方案 C 已核实',verificationSourceId:'artifact:check'}]}
 const verifiedProposal:ProjectExtractionProposal={...questionProposal,markdown:'技术方案 C 已核实',evidence:[{evidenceId:'verified:check',quote:'技术方案 C 已核实'}]}
 assert.equal(projectExtractionProposalMemorable(verified,verifiedProposal),true,'提问轮次里带assertion的已核实证据仍可提炼')
})
