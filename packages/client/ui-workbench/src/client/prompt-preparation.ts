import { restoreRecoveredText } from './resource-recovery.ts'
import type { HomeResourceSelection } from './home-resource-selection.ts'
import { encodeResourceReference } from '@teloa/contract'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
export type HomeSkillSelection={name:string;source:string;provider:string}
export type PreparedSkillCandidate=HomeSkillSelection&{userInvocable:boolean}
export type PreparedInputSnapshot=Pick<InputState,'draft'|'draftRev'|'phase'|'attachmentIds'>&{running:boolean}
export type PreparedInputPort={read:()=>PreparedInputSnapshot;text:(text:string,revision:number)=>Promise<PreparedInputSnapshot>;reference:(resource:HomeResourceSelection,revision:number)=>Promise<PreparedInputSnapshot>}
export type PreparedPrompt={id:string;sourceId:string;sourceKind?:'home'|'task';taskSnapshot?:string;sourceVersion:number;sessionId:string;title:string;text:string;resources?:HomeResourceSelection[];skills?:HomeSkillSelection[];transfer?:{textInserted:boolean;resourceIds:string[]};status:'pending'|'inserted'|'stale'|'dismissed'}
export class PromptPreparation{
  private rows:PreparedPrompt[]=[]
  private listeners=new Set<()=>void>()
  private transferring=new Set<string>()
  getSnapshot=()=>this.rows
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  private publish(rows:PreparedPrompt[]){this.rows=rows;for(const listener of this.listeners)listener()}
  prepare(input:Omit<PreparedPrompt,'status'>){if(input.skills&&(input.skills.length>8||new Set(input.skills.map(skill=>skill.name)).size!==input.skills.length||input.skills.some(skill=>!skill.name||/[\s/]/.test(skill.name)||!skill.source||!skill.provider)))throw Error('技能选择无效，最多选择8个不同名称的技能。');if(this.rows.some(row=>row.id===input.id))throw Error('准备记录编号冲突。');if(input.resources){if(input.resources.length>8||new Set(input.resources.map(row=>row.id)).size!==input.resources.length)throw Error('最多选择8份不同资料。');for(const resource of input.resources)encodeResourceReference(resource)}this.publish([...this.rows,structuredClone({...input,status:'pending' as const})])}
  invalidate(sourceId:string){this.publish(this.rows.map(row=>row.sourceId===sourceId&&row.status==='pending'?{...row,status:'stale'}:row))}
  dismiss(id:string){this.publish(this.rows.map(row=>row.id===id?{...row,status:'dismissed'}:row))}
  removeResource(id:string,resourceId:string){
    if(this.transferring.has(id))throw Error('正在带入资料，请稍后再移除。')
    this.publish(this.rows.map(row=>row.id===id&&row.status==='pending'&&!row.transfer?.resourceIds.includes(resourceId)?{...row,resources:(row.resources||[]).filter(value=>value.id!==resourceId)}:row))
  }
  removeSkill(id:string,name:string){if(this.transferring.has(id))throw Error('正在带入，请稍后移除。');this.publish(this.rows.map(row=>row.id===id&&row.status==='pending'&&!row.transfer?.textInserted?{...row,skills:(row.skills||[]).filter(skill=>skill.name!==name)}:row))}
  async insertResources(id:string,sessionId:string,candidates:()=>Promise<readonly HomeResourceSelection[]>,port:PreparedInputPort,skills?:()=>Promise<readonly PreparedSkillCandidate[]>){
    if(this.transferring.has(id))throw Error('正在带入，请勿重复操作。')
    const current=()=>{const row=this.rows.find(value=>value.id===id);if(!row||row.sessionId!==sessionId||row.status!=='pending')throw Error('准备记录或目标会话状态已变化。');return row}
    const check=(snapshot:PreparedInputSnapshot)=>{if(snapshot.running||snapshot.phase!=='plain'||snapshot.attachmentIds.length)throw Error('原生输入状态已变化，请稍后核对。')}
    const row=current(),initial=port.read();check(initial)
    if(!row.transfer?.textInserted&&initial.draft)throw Error('原生输入已有草稿，请先处理现有内容。')
    this.transferring.add(id)
    try{
      const available=await candidates();current()
      if(row.skills?.length){
        if(!skills)throw Error('技能核验接口不可用。')
        const catalog=await skills();current()
        for(const skill of row.skills){const matches=catalog.filter(value=>value.name===skill.name);if(matches.length!==1||!matches[0]!.userInvocable||matches[0]!.source!==skill.source||matches[0]!.provider!==skill.provider)throw Error(skill.name+'：技能在目标会话不可用、同名歧义或来源变化，请移除后重新选择。')}
      }
      let snapshot=port.read();check(snapshot)
      if(snapshot.draftRev!==initial.draftRev)throw Error('核验期间输入已变化，请重新核对后带入。')
      const remaining=(row.resources||[]).filter(value=>!row.transfer?.resourceIds.includes(value.id))
      for(const resource of remaining)if(!available.some(value=>value.id===resource.id&&value.version===resource.version))throw Error(resource.title+'：目标会话不可用或版本已变化，请移除后重新选择。')
      const progress=(textInserted:boolean,resourceIds:string[])=>this.publish(this.rows.map(value=>value.id===id?{...value,transfer:{textInserted,resourceIds}}:value))
      const inserted=[...(row.transfer?.resourceIds||[])]
      if(!row.transfer?.textInserted){snapshot=await port.text((row.skills?.length?row.skills.map(skill=>'/'+skill.name+' ').join('')+'\n':'')+row.text,snapshot.draftRev);progress(true,inserted)}
      for(const resource of [...remaining].reverse()){
        current();const latest=port.read();check(latest)
        if(latest.draftRev!==snapshot.draftRev)throw Error('输入已被修改，已带入内容保留，其余资料等待继续。')
        snapshot=await port.reference(resource,latest.draftRev);inserted.push(resource.id);progress(true,[...inserted])
      }
      current();this.publish(this.rows.map(value=>value.id===id?{...value,status:'inserted'}:value))
    }finally{this.transferring.delete(id)}
  }
  insert(id:string,sessionId:string,input:Pick<InputState,'draft'|'attachmentIds'|'phase'>,running:boolean,actions:{setDraft(text:string):void}){
    const row=this.rows.find(item=>item.id===id)
    if(!row||row.sessionId!==sessionId)throw Error('目标会话不匹配。')
    if(row.status!=='pending')throw Error('准备记录状态已变化，不能重复插入。')
    if(row.resources?.length||row.skills?.length)throw Error('请通过资料与技能核验流程带入原生输入。')
    restoreRecoveredText({id:row.id,text:row.text,otherContentCount:0},input,running,actions)
    this.publish(this.rows.map(item=>item.id===id?{...item,status:'inserted'}:item))
  }
}
