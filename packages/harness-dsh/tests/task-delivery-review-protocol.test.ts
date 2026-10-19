import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {createReviewSourceCatalog,describeReviewReferences,deliveryRevisionData,deliveryReviewProtocol,readRevisionSubmission,readVerificationSubmission,readReviewCoverage,reviewBlockRequirements,reviewCheckIds,reviewSourceDirectory,type ReviewPassage} from '../src/task-delivery-review-protocol.ts'

const catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:'三家愿意付费，已付款一家的归属未知。\n',origin:{field:'inputText',pointer:'/task/goal'}},{id:'method:1',kind:'method',title:'核对方法',text:'没有原文依据时，保留未知。',origin:{field:'skills',pointer:'/0/content'}}])
const basis=[{sourceId:'goal',passageId:'p1'}]
const revision=()=>({phase:'revise',issues:[{problem:'把未知关系写成已确认。',basis,affectedBlockIds:[1,3],coverage:{change:[1],retain:[3],unrelated:[2],unknown:[]},edits:[{blockId:1,after:'付款与意愿的重叠关系未知。'}]}]})
const context={catalog,blockCount:3,unit:{first:0,last:1},unitIndex:0}
const verification=()=>({phase:'verify',verdict:'accept',checks:reviewCheckIds.map(id=>({id,status:'pass'})),changeChecks:[{issueId:'r1:u1:i1',status:'verified',reviewedBlockIds:[1,3]}],findings:[]})
const verifyContext={catalog,blockCount:3,issueIds:['r1:u1:i1'],reviewedBlocks:[{issueId:'r1:u1:i1',blockIds:[1,3]}]}
const rejected=(value:unknown)=>assert.ok(value!==null&&typeof value==='object'&&'reason' in value)

test('source目录保全文和末尾字节、稳定摘要及不可变来源，不以名称或hash冒正文',()=>{
 assert.equal(deliveryReviewProtocol,'revise-verify/v3')
 assert.equal(catalog.sources[0]!.text,'三家愿意付费，已付款一家的归属未知。\n')
 assert.equal(catalog.sources[0]!.sha256,createHash('sha256').update(catalog.sources[0]!.text).digest('hex'))
 assert.equal(createReviewSourceCatalog(catalog.sources).sha256,catalog.sha256)
 assert.deepEqual(createReviewSourceCatalog(catalog.sources).passages,catalog.passages)
 assert.ok(Object.isFrozen(catalog)&&Object.isFrozen(catalog.sources)&&Object.isFrozen(catalog.sources[0])&&Object.isFrozen(catalog.sources[0]!.origin))
 assert.throws(()=>createReviewSourceCatalog([{...catalog.sources[0]!,sha256:'0'.repeat(64)}]))
 assert.throws(()=>createReviewSourceCatalog([catalog.sources[0]!,catalog.sources[0]!]))
})

test('编辑基线参与冻结摘要但不给事实片段，R1/R2即使收到伪造片段也不能引用旧稿作basis',()=>{
 const baseline={id:'revision-baseline',kind:'baseline' as const,title:'完整编辑基线',text:'# 清单\r\n\n## 行动\n保持的行动。\n\n## 风险\n旧 AI 无据日期 2031-04-17。 🔒\n',origin:{field:'inputText' as const,pointer:'/artifactRevision/originalText'}}
 const frozen=createReviewSourceCatalog([...catalog.sources,baseline])
 assert.equal(frozen.sources.at(-1)?.text,baseline.text)
 assert.equal(frozen.sources.at(-1)?.sha256,createHash('sha256').update(baseline.text).digest('hex'))
 assert.notEqual(createReviewSourceCatalog([...catalog.sources,{...baseline,text:baseline.text+' '}]).sha256,frozen.sha256)
 assert.equal(frozen.passages.some(row=>row.sourceId===baseline.id),false)
 assert.deepEqual(JSON.parse(reviewSourceDirectory(frozen)).find((row:{id:string})=>row.id===baseline.id).passages,[])
 const citation={sourceId:baseline.id,passageId:'p1'}
 for(const current of [frozen,{...frozen,passages:[...frozen.passages,{sourceId:baseline.id,id:'p1',start:0,end:baseline.text.length}]}]){
  rejected(readRevisionSubmission({...revision(),issues:[{...revision().issues[0],basis:[citation]}]},{...context,catalog:current}))
  rejected(readVerificationSubmission({...verification(),verdict:'reject',checks:verification().checks.map(row=>row.id==='goal'?{...row,status:'fail'}:row),findings:[{problem:'错误地引用旧稿日期。',basis:[citation],blockIds:[1]}]},{...verifyContext,catalog:current}))
  const missing=readVerificationSubmission({...verification(),verdict:'reject',checks:verification().checks.map(row=>row.id==='goal'?{...row,status:'fail'}:row),findings:[{problem:'当前完整选区丢失本人要求保留的行动部分。',basis,blockIds:[1]}]},{...verifyContext,catalog:current})
  assert.ok(!('reason'in missing),'缺节问题仍可引用本人目标，基线不用作事实依据')
 }
 assert.deepEqual(frozen.passages,catalog.passages,'已有业务来源片段身份不变')
})

test('R1按冻结片段ID引用成组，宿主按unit/index编号，依赖可全文而编辑限本单元',()=>{
 const read=readRevisionSubmission(revision(),context)
 assert.ok(!('reason' in read))
 assert.equal(read.issues[0]!.id,'r1:u1:i1')
 assert.deepEqual(read.edits,[{blockId:1,after:'付款与意愿的重叠关系未知。'}])
 assert.deepEqual(read.issues[0]!.affectedBlockIds,[1,3])
 const empty=readRevisionSubmission({...revision(),issues:[]},context)
 assert.ok(!('reason' in empty));assert.equal(empty.issues.length,0)
})

test('R1拒绝未知source或passage及旧quote，宿主填真实原文但不宣称蕴含通过',()=>{
 for(const citation of [{sourceId:'invented',passageId:'p1'},{sourceId:'goal',passageId:'unknown'},{sourceId:'goal',quote:'归属未知'},{sourceId:'goal',passageId:'p1',quote:'归属未知'},{sourceId:'goal',passageId:''}]){
  const value={...revision(),issues:[{...revision().issues[0],basis:[citation]}]};rejected(readRevisionSubmission(value,context))
 }
 const value=revision();value.issues[0]!.basis=[{sourceId:'method:1',passageId:'p1'}]
 const read=readRevisionSubmission(value,context)
 assert.ok(!('reason' in read),'宿主不实现语义蕴含裁判')
 assert.deepEqual(read.issues[0]!.basis,[{sourceId:'method:1',passageId:'p1',sourceSha256:catalog.sources[1]!.sha256,quote:catalog.sources[1]!.text}])
})

test('R1每个问题/依据/影响块/编辑非空，禁止出单元、未声明块与跨组重复编辑',()=>{
 const inputs:unknown[]=[{...revision(),issues:[{...revision().issues[0],problem:' '}]},{...revision(),issues:[{...revision().issues[0],basis:[]}]},{...revision(),issues:[{...revision().issues[0],affectedBlockIds:[]}]},{...revision(),issues:[{...revision().issues[0],edits:[]}]},{...revision(),issues:[{...revision().issues[0],edits:[{blockId:3,after:'越界'}]}]},{...revision(),issues:[{...revision().issues[0],edits:[{blockId:2,after:'未声明'}]}]},{...revision(),issues:[revision().issues[0],revision().issues[0]]}]
 for(const value of inputs)rejected(readRevisionSubmission(value,context))
})

test('单一工具按phase精确shape拒旧参数、跨阶段字段和任何嵌套额外字段',()=>{
 for(const value of [{edits:[]},{...revision(),verdict:'accept'},{...revision(),phase:'verify'},{...revision(),issues:[{...revision().issues[0],id:'model-chosen'}]},{...revision(),issues:[{...revision().issues[0],basis:[{...basis[0],after:'x'}]}]}])rejected(readRevisionSubmission(value,context))
 for(const value of [{...verification(),edits:[]},{...verification(),after:''},{...verification(),phase:'revise'},{...verification(),findings:[{problem:'错',basis,blockIds:[1],after:'改稿'}]}])rejected(readVerificationSubmission(value,verifyContext))
})

test('R2显式九项全pass与完整宿主变更核验才可accept，零编辑不构成验收',()=>{
 const read=readVerificationSubmission(verification(),verifyContext)
 assert.ok(!('reason' in read));assert.equal(read.verdict,'accept')
 for(const checks of [verification().checks.slice(1),[...verification().checks,verification().checks[0]],verification().checks.map(row=>row.id===1?{...row,status:'unknown'}:row),verification().checks.map(row=>row.id===2?{...row,status:'fail'}:row)])rejected(readVerificationSubmission({...verification(),checks},verifyContext))
 for(const changeChecks of [[],[{issueId:'foreign',status:'verified'}],[...verification().changeChecks,...verification().changeChecks],[{issueId:'r1:u1:i1',status:'unknown'}],[{issueId:'r1:u1:i1',status:'unresolved'}]])rejected(readVerificationSubmission({...verification(),changeChecks},verifyContext))
})

test('R2真实缺陷和unknown可正式reject但不可修稿，finding仍须原输入依据与真实块',()=>{
 const value={...verification(),verdict:'reject',checks:verification().checks.map(row=>row.id===5?{...row,status:'unknown'}:row),changeChecks:[{issueId:'r1:u1:i1',status:'unresolved',reviewedBlockIds:[1,3]}],findings:[{problem:'未建立续费观察资格。',basis,blockIds:[3]}]}
 const read=readVerificationSubmission(value,verifyContext)
 assert.ok(!('reason' in read));assert.equal(read.verdict,'reject')
 rejected(readVerificationSubmission({...value,verdict:'accept'},verifyContext))
 rejected(readVerificationSubmission({...value,findings:[{...value.findings[0],basis:[{sourceId:'goal',passageId:'unknown'}]}]},verifyContext))
 rejected(readVerificationSubmission({...value,findings:[{...value.findings[0],blockIds:[4]}]},verifyContext))
})

test('R2后续unit不得借旧issue继续验收或新造R1组，空R1也需显式九项验收',()=>{
 const later={...verification(),changeChecks:[]},expected={...verifyContext,issueIds:[]}
 assert.ok(!('reason' in readVerificationSubmission(later,expected)))
 rejected(readVerificationSubmission(verification(),expected))
 rejected(readVerificationSubmission({phase:'verify',verdict:'accept',checks:[],changeChecks:[],findings:[]},expected))
})


test('冻结片段完整覆盖超过256段的Unicode原文，不截断、不改空行或末尾字节',()=>{
 const original=('甲😀e\u0301\r\n'.repeat(40000))+'尾\n'
 const built=createReviewSourceCatalog([{id:'long',kind:'context',title:'长材料',text:original,origin:{field:'inputText',pointer:''}}])
 assert.ok(Array.isArray(built.passages)&&built.passages.length>256)
 let end=0
 for(const passage of built.passages){
  assert.equal(passage.sourceId,'long');assert.equal(passage.start,end)
  const chunk=original.slice(passage.start,passage.end)
  assert.ok([...chunk].length>0&&[...chunk].length<=768)
  assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk)&&!/[\uD800-\uDBFF]$/.test(chunk))
  end=passage.end
 }
 assert.equal(end,original.length)
 assert.equal(built.passages.map(p=>original.slice(p.start,p.end)).join(''),original)
 assert.equal(createReviewSourceCatalog(built.sources).sha256,built.sha256)
 assert.ok(built.passages.every(p=>Object.isFrozen(p))&&Object.isFrozen(built.passages))
 const directory=JSON.parse(reviewSourceDirectory(built)) as {id:string;passages:{id:string;preview:string}[]}[]
 assert.deepEqual(directory[0]!.passages.map(p=>p.id),built.passages.map(p=>p.id))
 for(const [index,preview] of directory[0]!.passages.entries()){
  const passage:ReviewPassage=built.passages[index]!
  const chars:string[]=[...original.slice(passage.start,passage.end)]
  assert.ok([...preview.preview].length<=96)
  assert.equal(preview.preview,chars.length<=96?chars.join(''):chars.slice(0,48).join('')+'…'+chars.slice(-47).join(''))
 }
})

test('同basis合法重复ID校验后去重，跨问题同源引用允许，非法重复不能藏在合法项后',()=>{
 const value=revision();value.issues[0]!.basis=[...basis,...basis]
 value.issues.push({...value.issues[0]!,affectedBlockIds:[2],coverage:{change:[2],retain:[],unrelated:[1,3],unknown:[]},edits:[{blockId:2,after:'另一处'}]})
 const read=readRevisionSubmission(value,context)
 assert.ok(!('reason' in read));assert.equal(read.issues.length,2)
 assert.equal(read.issues[0]!.basis.length,1);assert.equal(read.issues[1]!.basis.length,1)
 rejected(readRevisionSubmission({...revision(),issues:[{...revision().issues[0],basis:[...basis,{...basis[0],extra:true}]}]},context))
})

test('本次两处自由抄写错误改选冻结ID后由宿主还原原始分行方法与目标，不制造旧假引文',()=>{
 const goal='这是合成材料；给出一项7天内可做的最低成本验证实验。'
 const method='Output contract:\n- What additional evidence would change a grade\n'
 const frozen=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}},{id:'method:1',kind:'method',title:'原方法',text:method,origin:{field:'skills',pointer:'/0/content'}}])
 const read=readRevisionSubmission({...revision(),issues:[{...revision().issues[0],basis:[{sourceId:'goal',passageId:'p1'},{sourceId:'method:1',passageId:'p1'}]}]},{...context,catalog:frozen})
 assert.ok(!('reason' in read));assert.deepEqual(read.issues[0]!.basis.map(b=>b.quote),[goal,method])
 for(const quote of ['请给出一项7天内可做的最低成本验证实验','Output contract: ... What additional evidence would change a grade'])rejected(readRevisionSubmission({...revision(),issues:[{...revision().issues[0],basis:[{sourceId:'goal',quote}]}]},{...context,catalog:frozen}))
})

test('R2未确认问题仅列refs，跨问题重复片段原文只列一次且不超过冻结来源总字节',()=>{
 const value=revision();value.issues.push({...value.issues[0]!,affectedBlockIds:[2],coverage:{change:[2],retain:[],unrelated:[1,3],unknown:[]},edits:[{blockId:2,after:'另一处'}]})
 const read=readRevisionSubmission(value,context)
 assert.ok(!('reason' in read))
 const data=deliveryRevisionData(read.issues)
 const payload=JSON.parse(data.slice(data.indexOf('\n')+1))
 assert.deepEqual(payload.issues[0].basis,[{sourceId:'goal',passageId:'p1'}])
 assert.equal(payload.passages.length,1)
 assert.equal(payload.passages[0].quote,catalog.sources[0]!.text)
 assert.ok(payload.issues.every((issue:{basis:unknown[]})=>issue.basis.every(b=>!Object.hasOwn(b as object,'quote'))))
 assert.ok(Buffer.byteLength(payload.passages.map((p:{quote:string})=>p.quote).join(''))<=catalog.sources.reduce((sum,s)=>sum+Buffer.byteLength(s.text),0))
})

test('片段ID在冻结目录内稳定，宿主按原Unicode边界还原后段，空来源不生成虚假依据',()=>{
 const original='😀'.repeat(768)+'第二段\r\n末尾\n'
 const built=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'完整原文',text:original,origin:{field:'inputText',pointer:'/task/goal'}},{id:'empty',kind:'context',title:'空内容',text:'',origin:{field:'inputText',pointer:'/empty'}}])
 assert.deepEqual(built.passages.map(p=>p.id),['p1','p2'])
 const read=readRevisionSubmission({...revision(),issues:[{...revision().issues[0],basis:[{sourceId:'goal',passageId:'p2'}]}]},{...context,catalog:built})
 assert.ok(!('reason' in read));assert.equal(read.issues[0]!.basis[0]!.quote,'第二段\r\n末尾\n')
 const directory=JSON.parse(reviewSourceDirectory(built)) as {id:string;passages:{id:string;preview:string}[]}[]
 assert.deepEqual(directory[1]!.passages,[])
 assert.equal(directory[0]!.passages[1]!.preview,'第二段\r\n末尾\n')
 rejected(readRevisionSubmission({...revision(),issues:[{...revision().issues[0],basis:[{sourceId:'empty',passageId:'p1'}]}]},{...context,catalog:built}))
 assert.notEqual(built.sha256,createReviewSourceCatalog([{id:'goal',kind:'goal',title:'完整原文',text:original+'!',origin:{field:'inputText',pointer:'/task/goal'}}]).sha256)
})

test('候选：问题必须对宿主整稿块做完整互斥分区，漏块不能靠affected集合缩小分母',()=>{
 const {coverage:_coverage,...oldIssue}=revision().issues[0]!
 const legacy={phase:'revise',issues:[oldIssue]}
 rejected(readRevisionSubmission(legacy,context))
 const issue={...legacy.issues[0]!,coverage:{change:[1],retain:[3],unrelated:[2],unknown:[]}}
 const good=readRevisionSubmission({...legacy,issues:[issue]},context)
 assert.ok(!('reason' in good))
 for(const coverage of [{change:[1],retain:[],unrelated:[2],unknown:[]},{change:[1],retain:[3],unrelated:[2,3],unknown:[]},{change:[1],retain:[3],unrelated:[2,4],unknown:[]}])rejected(readRevisionSubmission({...legacy,issues:[{...issue,coverage}]},context))
})

test('显式unlisted retain仅展开未列编号，原四数组严格兼容且不静默补affected错误',()=>{
 const issue={...revision().issues[0]!,affectedBlockIds:[1],coverage:{change:[1],retain:[],unrelated:[2],unknown:[],unlisted:'retain'}}
 const read=readRevisionSubmission({phase:'revise',issues:[issue]},context);assert.ok(!('reason'in read))
 assert.deepEqual(read.issues[0]!.coverage,{change:[1],retain:[3],unrelated:[2],unknown:[]})
 assert.deepEqual(read.issues[0]!.affectedBlockIds,[1,3])
 assert.deepEqual(issue.coverage,{change:[1],retain:[],unrelated:[2],unknown:[],unlisted:'retain'},'不改模型原始参数')
 for(const coverage of [
  {...issue.coverage,unlisted:'unrelated'},
  {...issue.coverage,unlisted:undefined},
  {...issue.coverage,retain:[1]},
  {...issue.coverage,change:[1,1]},
  {...issue.coverage,unrelated:[2,4]},
  {...issue.coverage,extra:true},
 ])rejected(readRevisionSubmission({phase:'revise',issues:[{...issue,coverage}]},context))
 assert.deepEqual(readRevisionSubmission({phase:'revise',issues:[{...issue,affectedBlockIds:[1,3]}]},context),{reason:'coverage'},'不能把未列块先混入raw affected冒明确声明')
 assert.equal(readReviewCoverage({change:[1],retain:[],unrelated:[2],unknown:[]},3),undefined,'不声明仍漏块拒绝')
 assert.deepEqual(readReviewCoverage(revision().issues[0]!.coverage,3),revision().issues[0]!.coverage)
 const unknown=readRevisionSubmission({phase:'revise',issues:[{...issue,affectedBlockIds:[1,2],coverage:{change:[1],retain:[],unrelated:[],unknown:[2],unlisted:'retain'}}]},context);assert.ok(!('reason'in unknown))
 assert.deepEqual(reviewBlockRequirements(unknown.issues,{inputSha256:'a'.repeat(64),outputSha256:'b'.repeat(64),oldBlockCount:3,newBlockCount:3,rows:[1,2,3].map(id=>({oldBlockId:id,newBlockIds:[id]}))}),{reason:'coverage-unknown'},'显式retain不能把未知当作通过')
})

test('显式coverage作用域替代冗余IDs，双真源和未声明错误严格拒绝',()=>{
 const {affectedBlockIds:_redundant,...issue}=revision().issues[0]!
 const scoped={...issue,affectedScope:'coverage'}
 const read=readRevisionSubmission({phase:'revise',issues:[scoped]},context);assert.ok(!('reason'in read))
 assert.deepEqual(read.issues[0]!.affectedBlockIds,[1,3])
 assert.deepEqual(read.issues[0]!.coverage,issue.coverage)
 for(const raw of [
  {...scoped,affectedBlockIds:[1,3]},
  {...scoped,affectedBlockIds:[1]},
  {...scoped,affectedScope:'change'},
  {...scoped,affectedScope:undefined},
  issue,
  {...scoped,coverage:{...issue.coverage,retain:[]}},
  {...scoped,coverage:{...issue.coverage,retain:[3,3]}},
  {...scoped,coverage:{...issue.coverage,retain:[4]}},
 ])rejected(readRevisionSubmission({phase:'revise',issues:[raw]},context))
 const combined=readRevisionSubmission({phase:'revise',issues:[{...scoped,coverage:{change:[1],retain:[],unrelated:[2],unknown:[],unlisted:'retain'}}]},context);assert.ok(!('reason'in combined))
 assert.deepEqual(combined.issues[0]!.affectedBlockIds,[1,3],'显式unlisted与scope各自生效，不默认unrelated')
 assert.deepEqual(combined.issues[0]!.coverage,{change:[1],retain:[3],unrelated:[2],unknown:[]})
 const legacy=readRevisionSubmission({phase:'revise',issues:[{...issue,affectedBlockIds:[1]}]},context)
 assert.deepEqual(legacy,{reason:'coverage'},'原coverage完整但IDs漏retain的278错误仍严格拒绝')
})

test('依据或块号被拒时逐项指出不存在的段落、该来源可引用范围与越界块号；合法引用不报',()=>{
 const goal=catalog.passages.find(passage=>passage.sourceId==='goal')!
 const ids=catalog.passages.filter(passage=>passage.sourceId==='goal').map(passage=>passage.id)
 // 实跑：R2 findings 引用了来源中并不存在的段落号，一次纠正原样重交仍失败。
 const text=describeReviewReferences({phase:'verify',findings:[
  {problem:'甲',basis:[{sourceId:'goal',passageId:goal.id}],blockIds:[1]},
  {problem:'乙',basis:[{sourceId:'goal',passageId:'p98'},{sourceId:'missing',passageId:'p1'}],blockIds:[1,9]},
 ]},{catalog,blockCount:3})
 assert.ok(!text.includes('findings[0]'),'合法引用不报')
 assert.match(text,new RegExp(`findings\\[1\\]\\.basis goal / p98 不存在（该来源可引用 ${ids[0]}–${ids.at(-1)}`))
 assert.match(text,/findings\[1\]\.basis missing \/ p1 不存在（该来源不在本轮输入来源中/)
 assert.match(text,/findings\[1\]\.blockIds 9 超出全稿块号 1–3/)
 assert.equal(describeReviewReferences({phase:'revise',issues:'[{"basis":[]}]'},{catalog,blockCount:3}),'','字符串化数组另由 schema 提示，不在此误报')
})
