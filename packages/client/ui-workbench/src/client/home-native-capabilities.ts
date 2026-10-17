import {encodeResourceReference} from '@teloa/contract'
import type {InputState,InsertTextRequest,InsertReferenceRequest} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {HomeResourceSelection} from './home-resource-selection.ts'
import type {HomeSkillSelection} from './prompt-preparation.ts'
type Selection={resources:HomeResourceSelection[];skills:HomeSkillSelection[]}
type Port={state:{getSnapshot:()=>InputState;subscribe:(listener:()=>void)=>()=>void};verify:()=>Promise<void>;text:(request:InsertTextRequest)=>true|undefined;reference:(request:InsertReferenceRequest)=>true|undefined}

/** 复用原生 CAS 插入口；不替换正文，不读取或迁移浏览器附件。 */
export async function insertHomeCapabilities(selection:Selection,port:Port):Promise<void>{
 const before=port.state.getSnapshot()
 if(before.phase!=='plain')throw Error('输入正在提交，请稍后再添加。')
 await port.verify()
 if(port.state.getSnapshot().draftRev!==before.draftRev||port.state.getSnapshot().phase!=='plain')throw Error('核验期间输入已变化，请重新选择。')
 let revision=before.draftRev
 const insert=(apply:(revision:number)=>true|undefined)=>new Promise<void>((resolve,reject)=>{
  if(port.state.getSnapshot().draftRev!==revision||port.state.getSnapshot().phase!=='plain'){reject(Error('输入已变化，已添加的引用保留，请核对后继续。'));return}
  let off=()=>{},settled=false
  const finish=(error?:Error)=>{if(settled)return;settled=true;off();clearTimeout(timer);error?reject(error):resolve()}
  const check=()=>{const next=port.state.getSnapshot();if(next.draftRev===revision)return;if(next.draftRev!==revision+1||next.phase!=='plain'){finish(Error('输入已变化，请核对已添加的引用。'));return}revision=next.draftRev;finish()}
  const timer=setTimeout(()=>finish(Error('引用插入结果尚待核对，请查看输入后继续。')),3000)
  off=port.state.subscribe(check)
  try{if(apply(revision)!==true)finish(Error('原生输入拒绝本次插入。'));else check()}catch(error){finish(error instanceof Error?error:Error('引用插入失败。'))}
 })
 const skills=selection.skills.filter(skill=>!port.state.getSnapshot().draft.split(/\s+/).includes('/'+skill.name))
 if(skills.length)await insert(draftRev=>port.text({text:skills.map(skill=>'/'+skill.name+' ').join(''),span:{start:0,end:0,draftRev}}))
 for(const resource of [...selection.resources].reverse()){
  const ref=encodeResourceReference(resource)
  if(port.state.getSnapshot().occurrences.some(row=>row.source==='teloa-resources'&&row.ref===ref&&!row.invalid))continue
  await insert(draftRev=>port.reference({reference:{source:'teloa-resources',ref,label:resource.title,appearance:'file',clipboardText:ref},span:{start:0,end:0,draftRev}}))
 }
}

/** 留言仅追加原生草稿；CAS 保留正文、附件与引用，绝不 submit。 */
export async function insertAssistantVoiceDraft(text:string,port:Omit<Port,'reference'>):Promise<void>{
 if(!text.trim())return
 const before=port.state.getSnapshot()
 if(before.phase!=='plain')throw Error('输入正在提交，请稍后再添加。')
 await port.verify()
 const current=port.state.getSnapshot()
 if(current.draftRev!==before.draftRev||current.phase!=='plain')throw Error('核验期间输入已变化，请重新添加留言。')
 const addition=(before.draft&&!before.draft.endsWith('\n')?'\n':'')+text
 await new Promise<void>((resolve,reject)=>{
  let off=()=>{},settled=false
  const finish=(error?:Error)=>{if(settled)return;settled=true;off();clearTimeout(timer);error?reject(error):resolve()}
  const check=()=>{const next=port.state.getSnapshot();if(next.draftRev===before.draftRev)return;finish(next.draftRev===before.draftRev+1&&next.phase==='plain'&&next.draft===before.draft+addition?undefined:Error('输入已变化，请核对留言草稿。'))}
  const timer=setTimeout(()=>finish(Error('留言插入尚待核对，请查看原会话草稿。')),3000)
  off=port.state.subscribe(check)
  try{if(port.text({text:addition,span:{start:before.draft.length,end:before.draft.length,draftRev:before.draftRev}})!==true)finish(Error('原生输入未接受留言。'));else check()}catch(error){finish(error instanceof Error?error:Error('留言插入失败。'))}
 })
}
