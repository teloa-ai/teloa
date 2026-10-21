import {createHash} from 'node:crypto'

export const deliveryReviewProtocol='revise-verify/v3' as const
/** 仅一次有依据的拒绝后修订；原二轮历史继续使用 v3。来源目录不因复核意见而改变。 */
export const deliveryRepairProtocol='revise-verify/v4' as const
/** 新验收输入只投影当前稿与宿主依赖；旧R1意见仍留原生审计，不进入验收模型上下文。 */
export const currentDraftReviewProjection='current-draft/v1' as const
export const legacyDeliveryReviewProtocol='revise-verify/v1' as const
export const passageDeliveryReviewProtocol='revise-verify/v2' as const
export type ReviewProtocol=typeof deliveryReviewProtocol|typeof deliveryRepairProtocol|typeof legacyDeliveryReviewProtocol|typeof passageDeliveryReviewProtocol
export const reviewCheckIds=['goal',1,2,3,4,5,6,7,8] as const
export type ReviewCheckId=typeof reviewCheckIds[number]
export type ReviewPhase='revise'|'verify'
export type ReviewSourceInput=Readonly<{id:string;kind:'goal'|'method'|'knowledge'|'context'|'baseline';title:string;text:string;sha256?:string;origin:Readonly<{field:'inputText'|'skills'|'knowledge'|'workRequest'|'toolResults'|'assistantDrafts';pointer:string}>}>
export type ReviewSource=Readonly<Omit<ReviewSourceInput,'sha256'>&{sha256:string}>
/** start/end只供宿主切原字符串，模型仅选择目录中的ID，不提交偏移或抄写引文。 */
export type ReviewPassage=Readonly<{sourceId:string;id:string;start:number;end:number}>
export type ReviewSourceCatalog=Readonly<{sources:readonly ReviewSource[];passages:readonly ReviewPassage[];sha256:string}>
export type ReviewPassageRef=Readonly<{sourceId:string;passageId:string}>
export type ReviewQuote=Readonly<ReviewPassageRef&{sourceSha256:string;quote:string}>
export type ReviewEdit=Readonly<{blockId:number;after:string}>
export type ReviewCoverage=Readonly<{change:readonly number[];retain:readonly number[];unrelated:readonly number[];unknown:readonly number[]}>
export type ReviewBlockMap=Readonly<{inputSha256:string;outputSha256:string;oldBlockCount:number;newBlockCount:number;rows:readonly Readonly<{oldBlockId:number;newBlockIds:readonly number[]}>[]}>
export type RevisionIssue=Readonly<{id:string;problem:string;basis:readonly ReviewQuote[];affectedBlockIds:readonly number[];coverage?:ReviewCoverage;edits:readonly ReviewEdit[]}>
export type RevisionSubmission=Readonly<{issues:readonly RevisionIssue[];edits:readonly ReviewEdit[]}>
export type ReviewCheck=Readonly<{id:ReviewCheckId;status:'pass'|'fail'|'unknown'}>
export type ReviewChangeCheck=Readonly<{issueId:string;status:'verified'|'unresolved'|'unknown';reviewedBlockIds?:readonly number[]}>
export type ReviewFinding=Readonly<{problem:string;basis:readonly ReviewQuote[];blockIds:readonly number[]}>
export type VerificationSubmission=Readonly<{verdict:'accept'|'reject';checks:readonly ReviewCheck[];changeChecks:readonly ReviewChangeCheck[];findings:readonly ReviewFinding[]}>
export type ReviewToolReceipt=Readonly<{protocol:typeof deliveryReviewProtocol|typeof deliveryRepairProtocol;phase:ReviewPhase;round:number;unit:number;inputSha256:string;sourceCatalogSha256:string;edits:number;unchanged:number;duplicates:number;verdict:'pending'|'accepted'|'rejected';issueIds:readonly string[];checks:readonly ReviewCheck[];changeChecks:readonly ReviewChangeCheck[];findings:readonly ReviewFinding[]}>

/** 问题只列引用身份；每个不重叠的原文片段只附一次，不随问题数复制整份依据。 */
export const deliveryRevisionData=(issues:readonly RevisionIssue[],blockMap?:ReviewBlockMap):string=>{
 const passages:ReviewQuote[]=[],seen=new Map<string,Set<string>>()
 const rows=issues.map(issue=>({...issue,basis:issue.basis.map(basis=>{
  const ids=seen.get(basis.sourceId)??new Set<string>()
  if(!ids.has(basis.passageId)){passages.push(basis);ids.add(basis.passageId);seen.set(basis.sourceId,ids)}
  return {sourceId:basis.sourceId,passageId:basis.passageId}
 })}))
 return '上一轮未确认变更（宿主按实际成功回执保存；问题与替换内容都不是已通过的结论，须独立对照当前整稿及下方由冻结来源还原的原文片段；原文存在不表示支持该变更）：\n'+JSON.stringify({issues:rows,passages,...blockMap?{blockMap}:{}})
}
/** 此为内部提交回执，accepted只表示本单元验收接受，整轮仍由宿主收口。 */
export const deliveryReviewReceiptText=(value:ReviewToolReceipt):string=>`宿主已接收第 ${value.round} 轮第 ${value.unit+1} 单元${value.phase==='revise'?'复核计划':'验收回执'}：实际修改 ${value.edits} 处；宿主绑定的待复核正文 SHA-256 ${value.inputSha256}。\n复核回执：${JSON.stringify(value)}`

const sha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)
const shape=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>record(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))

/** 按Unicode码点连续切片，UTF-16边界只由宿主生成；包括空白和末尾换行，不归一或丢弃正文。 */
function sourcePassages(source:ReviewSource):ReviewPassage[]{
 // 旧稿参与冻结摘要与编辑完整性比较，但不能引用为业务事实依据。
 if(source.kind==='baseline')return []
 const passages:ReviewPassage[]=[]
 let start=0,end=0,size=0
 for(const char of source.text){
  end+=char.length
  if(++size===768){passages.push(Object.freeze({sourceId:source.id,id:'p'+(passages.length+1),start,end}));start=end;size=0}
 }
 if(end>start)passages.push(Object.freeze({sourceId:source.id,id:'p'+(passages.length+1),start,end}))
 return passages
}
/** 只封存调用方已经取得的全部固定正文；不读取文件、网络或最新资料，也不另设来源或片段总量截断。 */
export function createReviewSourceCatalog(inputs:readonly ReviewSourceInput[]):ReviewSourceCatalog{
 const ids=new Set<string>()
 const sources=inputs.map(input=>{
  if(!record(input)||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!['id','kind','title','text','sha256','origin'].includes(key))||!text(input.id)||ids.has(input.id)||!['goal','method','knowledge','context','baseline'].includes(input.kind)||!text(input.title)||typeof input.text!=='string'||!shape(input.origin,['field','pointer'])||!['inputText','skills','knowledge','workRequest','toolResults','assistantDrafts'].includes(input.origin.field as string)||typeof input.origin.pointer!=='string'||(input.origin.pointer!==''&&!input.origin.pointer.startsWith('/')))throw Error('Invalid frozen review source.')
  const digest=sha256(input.text)
  if(input.sha256!==undefined&&input.sha256!==digest)throw Error('Frozen review source hash mismatch.')
  ids.add(input.id)
  return Object.freeze({...input,sha256:digest,origin:Object.freeze({...input.origin})})
 })
 const passages=Object.freeze(sources.flatMap(sourcePassages))
 return Object.freeze({sources:Object.freeze(sources),passages,sha256:sha256(JSON.stringify({protocol:deliveryReviewProtocol,sources,passages}))})
}

/** 目录只增加线性大小的身份与短预览；长片段首尾共96码点（含省略号），不是让模型复述的引文。 */
export function reviewSourceDirectory(catalog:ReviewSourceCatalog):string{
 const grouped=new Map<string,{id:string;preview:string}[]>()
 const sources=new Map(catalog.sources.map(source=>[source.id,source]))
 for(const passage of catalog.passages){
  const chars=[...sources.get(passage.sourceId)!.text.slice(passage.start,passage.end)]
  const preview=chars.length<=96?chars.join(''):chars.slice(0,48).join('')+'…'+chars.slice(-47).join('')
  const rows=grouped.get(passage.sourceId)??[]
  rows.push({id:passage.id,preview});grouped.set(passage.sourceId,rows)
 }
 return JSON.stringify(catalog.sources.map(({id,kind,title,sha256})=>({id,kind,title,sha256,passages:grouped.get(id)??[]})))
}

type PassageResolver=(sourceId:string,passageId:string)=>ReviewQuote|undefined
function passageResolver(catalog:ReviewSourceCatalog):PassageResolver{
 const sources=new Map(catalog.sources.map(source=>[source.id,source]))
 const grouped=new Map<string,Map<string,ReviewPassage>>()
 for(const passage of catalog.passages){
  const rows=grouped.get(passage.sourceId)??new Map<string,ReviewPassage>()
  rows.set(passage.id,passage);grouped.set(passage.sourceId,rows)
 }
 return (sourceId,passageId)=>{
  const source=sources.get(sourceId),passage=grouped.get(sourceId)?.get(passageId)
  if(!source||source.kind==='baseline'||!passage)return
  return {sourceId,passageId,sourceSha256:source.sha256,quote:source.text.slice(passage.start,passage.end)}
 }
}
function quotes(value:unknown,resolve:PassageResolver):ReviewQuote[]|undefined{
 if(!Array.isArray(value)||!value.length)return
 const rows:ReviewQuote[]=[],seen=new Map<string,Set<string>>()
 for(const raw of value){
  if(!shape(raw,['sourceId','passageId'])||!text(raw.sourceId)||!text(raw.passageId))return
  const basis=resolve(raw.sourceId,raw.passageId)
  if(!basis)return
  const ids=seen.get(raw.sourceId)??new Set<string>()
  if(!ids.has(raw.passageId)){rows.push(basis);ids.add(raw.passageId);seen.set(raw.sourceId,ids)}
 }
 return rows
}
/**
 * 依据或块号被拒时逐项指出哪一处引用不存在、哪个块号越界，以及该来源实际可引用的段落范围，
 * 供唯一一次纠正据此改正；只读回执原文，不放宽任何校验。
 */
export function describeReviewReferences(value:unknown,context:Readonly<{catalog:ReviewSourceCatalog;blockCount:number}>):string{
 const resolve=passageResolver(context.catalog),problems:string[]=[]
 const available=(sourceId:string)=>{const ids=context.catalog.passages.filter(passage=>passage.sourceId===sourceId).map(passage=>passage.id);return ids.length?`该来源可引用 ${ids[0]}–${ids.at(-1)!}（共 ${ids.length} 段）`:'该来源不在本轮输入来源中或没有可引用段落'}
 for(const [key,field] of [['issues','affectedBlockIds'],['findings','blockIds']] as const){
  const items=value&&typeof value==='object'?Reflect.get(value,key):undefined
  if(!Array.isArray(items))continue
  items.forEach((item:unknown,index:number)=>{
   const basis=item&&typeof item==='object'?Reflect.get(item,'basis'):undefined
   if(!Array.isArray(basis)||!basis.length)problems.push(`${key}[${index}].basis 须为非空数组`)
   else for(const ref of basis){
    const sourceId=ref&&typeof ref==='object'?Reflect.get(ref,'sourceId'):undefined,passageId=ref&&typeof ref==='object'?Reflect.get(ref,'passageId'):undefined
    if(typeof sourceId!=='string'||typeof passageId!=='string')problems.push(`${key}[${index}].basis 每项只含字符串 sourceId 与 passageId`)
    else if(!resolve(sourceId,passageId))problems.push(`${key}[${index}].basis ${sourceId} / ${passageId} 不存在（${available(sourceId)}）`)
   }
   const ids=item&&typeof item==='object'?Reflect.get(item,field):undefined
   if(Array.isArray(ids)){const bad=ids.filter(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<1||id>context.blockCount);if(bad.length)problems.push(`${key}[${index}].${field} ${bad.map(id=>JSON.stringify(id)).join('、')} 超出全稿块号 1–${context.blockCount}`)}
  })
 }
 return problems.slice(0,8).join('；')
}
function blockIds(value:unknown,count:number):number[]|undefined{
 if(!Array.isArray(value)||!value.length||value.some(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<1||id>count)||new Set(value).size!==value.length)return
 return [...value] as number[]
}

/** wire块号从1开始，unit范围沿原块解析器从0开始；问题组编号完全由宿主生成。 */
export function readRevisionSubmission(value:unknown,context:Readonly<{catalog:ReviewSourceCatalog;blockCount:number;unit:Readonly<{first:number;last:number}>;unitIndex:number;round?:1|3}>):RevisionSubmission|{reason:string}{
 if(!shape(value,['phase','issues'])||value.phase!=='revise'||!Array.isArray(value.issues))return {reason:'shape'}
 const issues:RevisionIssue[]=[],edits:ReviewEdit[]=[],written=new Set<number>(),resolve=passageResolver(context.catalog)
 for(const raw of value.issues){
  if((!shape(raw,['problem','basis','affectedBlockIds','coverage','edits'])&&!shape(raw,['problem','basis','affectedScope','coverage','edits']))||!text(raw.problem)||!Array.isArray(raw.edits)||!raw.edits.length)return {reason:'issue-shape'}
  const scoped=Object.hasOwn(raw,'affectedScope'),basis=quotes(raw.basis,resolve),affected=scoped?undefined:blockIds(raw.affectedBlockIds,context.blockCount),group:ReviewEdit[]=[]
  if(!basis)return {reason:'basis'}
  if(!scoped&&!affected)return {reason:'affected-blocks'}
  const declared=readRevisionCoverage(raw.coverage,affected,context.blockCount,scoped?raw.affectedScope:undefined)
  if(!declared)return {reason:'coverage'}
  const {coverage,affectedBlockIds}=declared
  for(const edit of raw.edits){
   if(!shape(edit,['blockId','after'])||typeof edit.blockId!=='number'||!Number.isSafeInteger(edit.blockId)||typeof edit.after!=='string')return {reason:'edit-shape'}
   const position=edit.blockId-1
   if(position<context.unit.first||position>context.unit.last||(!coverage.change.includes(edit.blockId)&&!coverage.retain.includes(edit.blockId)))return {reason:'edit-range'}
   if(written.has(edit.blockId))return {reason:'block-conflict'}
   written.add(edit.blockId);group.push({blockId:edit.blockId,after:edit.after})
  }
  issues.push({id:`r${context.round??1}:u${context.unitIndex+1}:i${issues.length+1}`,problem:raw.problem,basis,affectedBlockIds,coverage,edits:group});edits.push(...group)
 }
 return {issues,edits}
}

/** R2只验收宿主持有的当前整稿，不接收任何改稿字段；unknown永不作为通过。 */
export function readVerificationSubmission(value:unknown,context:Readonly<{catalog:ReviewSourceCatalog;blockCount:number;issueIds:readonly string[];protocol?:ReviewProtocol;reviewedBlocks?:readonly Readonly<{issueId:string;blockIds:readonly number[]}>[]}>):VerificationSubmission|{reason:string}{
 if(!shape(value,['phase','verdict','checks','changeChecks','findings'])||value.phase!=='verify'||!['accept','reject'].includes(value.verdict as string)||!Array.isArray(value.checks)||!Array.isArray(value.changeChecks)||!Array.isArray(value.findings))return {reason:'shape'}
 const active=context.protocol===undefined||context.protocol===deliveryReviewProtocol||context.protocol===deliveryRepairProtocol
 const checks:ReviewCheck[]=[],changes:ReviewChangeCheck[]=[],findings:ReviewFinding[]=[],seenChecks=new Set<ReviewCheckId>(),seenIssues=new Set<string>(),resolve=passageResolver(context.catalog)
 for(const raw of value.checks){
  if(!shape(raw,['id','status'])||!reviewCheckIds.some(id=>id===raw.id)||!['pass','fail','unknown'].includes(raw.status as string)||seenChecks.has(raw.id as ReviewCheckId))return {reason:'checks'}
  seenChecks.add(raw.id as ReviewCheckId);checks.push({id:raw.id as ReviewCheckId,status:raw.status as ReviewCheck['status']})
 }
 if(seenChecks.size!==reviewCheckIds.length)return {reason:'checks'}
 for(const raw of value.changeChecks){
  if(!shape(raw,active?['issueId','status','reviewedBlockIds']:['issueId','status'])||!text(raw.issueId)||!context.issueIds.includes(raw.issueId)||seenIssues.has(raw.issueId)||!['verified','unresolved','unknown'].includes(raw.status as string))return {reason:'change-checks'}
  const expected=context.reviewedBlocks?.find(row=>row.issueId===raw.issueId)?.blockIds
  if(active&&(!expected||!Array.isArray(raw.reviewedBlockIds)||JSON.stringify(raw.reviewedBlockIds)!==JSON.stringify(expected)))return {reason:'change-blocks'}
  seenIssues.add(raw.issueId);changes.push({issueId:raw.issueId,status:raw.status as ReviewChangeCheck['status'],...active?{reviewedBlockIds:[...expected!]}:{}})
 }
 if(seenIssues.size!==context.issueIds.length)return {reason:'change-checks'}
 for(const raw of value.findings){
  if(!shape(raw,['problem','basis','blockIds'])||!text(raw.problem))return {reason:'finding-shape'}
  const basis=quotes(raw.basis,resolve),ids=blockIds(raw.blockIds,context.blockCount)
  if(!basis||!ids)return {reason:'finding-basis'}
  findings.push({problem:raw.problem,basis,blockIds:ids})
 }
 if(value.verdict==='accept'&&(checks.some(check=>check.status!=='pass')||changes.some(check=>check.status!=='verified')||findings.length))return {reason:'verdict-conflict'}
 return {verdict:value.verdict as VerificationSubmission['verdict'],checks,changeChecks:changes,findings}
}

/** 分母由宿主冻结块数决定；只有显式 unlisted:retain 才把未列编号补入相关保留，四集合仍完整互斥。 */
export function readReviewCoverage(value:unknown,count:number):ReviewCoverage|undefined{
 if(!shape(value,['change','retain','unrelated','unknown'])&&!shape(value,['change','retain','unrelated','unknown','unlisted']))return
 if(Object.hasOwn(value,'unlisted')&&value.unlisted!=='retain')return
 const all:number[]=[]
 for(const key of ['change','retain','unrelated','unknown'] as const){
  const ids=value[key]
  if(!Array.isArray(ids)||ids.some(id=>!Number.isSafeInteger(id)||id<1||id>count))return
  all.push(...ids)
 }
 const listed=new Set(all)
 if(listed.size!==all.length||(!Object.hasOwn(value,'unlisted')&&all.length!==count))return
 const omitted=Object.hasOwn(value,'unlisted')?Array.from({length:count},(_,index)=>index+1).filter(id=>!listed.has(id)):[]
 return {change:[...value.change as number[]],retain:[...value.retain as number[],...omitted],unrelated:[...value.unrelated as number[]],unknown:[...value.unknown as number[]]}
}
/** 活动提交与冷读共用同一展开；显式列出的相关块仍须精确声明，未列 retain 一并纳入后续依赖核对。 */
export function readRevisionCoverage(value:unknown,affectedValue:unknown,count:number,scope?:unknown):{coverage:ReviewCoverage;affectedBlockIds:number[]}|undefined{
 const coverage=readReviewCoverage(value,count)
 if(!coverage||!record(value))return
 if(scope!==undefined){
  if(scope!=='coverage'||affectedValue!==undefined)return
  return {coverage,affectedBlockIds:[...coverage.change,...coverage.retain,...coverage.unknown]}
 }
 const affected=blockIds(affectedValue,count)
 if(!affected)return
 const retained=value.retain as number[],omitted=coverage.retain.filter(id=>!retained.includes(id))
 const declared=[...coverage.change,...retained,...coverage.unknown]
 if(JSON.stringify([...affected].sort((a,b)=>a-b))!==JSON.stringify(declared.sort((a,b)=>a-b)))return
 return {coverage,affectedBlockIds:[...affected,...omitted]}
}
/** 从宿主旧→新映射导出每问题必须核对的当前块；不让模型把旧编号当新编号。 */
export function reviewBlockRequirements(issues:readonly RevisionIssue[],map:ReviewBlockMap):{issueId:string;blockIds:number[]}[]|{reason:string}{
 if(!shape(map,['inputSha256','outputSha256','oldBlockCount','newBlockCount','rows'])||![map.inputSha256,map.outputSha256].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))||!Number.isSafeInteger(map.oldBlockCount)||map.oldBlockCount<1||!Number.isSafeInteger(map.newBlockCount)||map.newBlockCount<1||!Array.isArray(map.rows)||map.rows.length!==map.oldBlockCount)return {reason:'block-map'}
 const covered=new Set<number>();let previous=0
 for(const [index,row]of map.rows.entries()){
  if(!shape(row,['oldBlockId','newBlockIds'])||row.oldBlockId!==index+1||!Array.isArray(row.newBlockIds))return {reason:'block-map'}
  const ids=row.newBlockIds
  if(ids.some((id,position)=>!Number.isSafeInteger(id)||id<1||id>map.newBlockCount||(position>0&&id!==ids[position-1]!+1)))return {reason:'block-map'}
  if(row.newBlockIds.length){
   if(row.newBlockIds[0]!<previous)return {reason:'block-map'}
   previous=row.newBlockIds.at(-1)!
   for(const id of row.newBlockIds)covered.add(id)
  }
 }
 if(covered.size!==map.newBlockCount)return {reason:'block-map'}
 const result:{issueId:string;blockIds:number[]}[]=[]
 for(const issue of issues){
  const coverage=readReviewCoverage(issue.coverage,map.oldBlockCount)
  if(!coverage||coverage.unknown.length)return {reason:'coverage-unknown'}
  result.push({issueId:issue.id,blockIds:[...new Set([...coverage.change,...coverage.retain].flatMap(id=>map.rows[id-1]!.newBlockIds))].sort((a,b)=>a-b)})
 }
 return result
}
