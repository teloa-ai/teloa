import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

type NativeState={rows:readonly WorkspaceView[];ready:boolean;error:string|undefined}
export interface WorkspaceManagementPort{
  state():NativeState
  subscribe(listener:()=>void):()=>void
  create(path:string):Promise<WorkspaceView>
  rename(id:string,title:string):Promise<WorkspaceView>
  remove(id:string):Promise<void>
  move(id:string,before:string|undefined):Promise<void>
}
type Draft={baseTitle:string;value:string}
export type WorkspaceManagementMessage={key:
  'workspaceSettings.error.connection'|'workspaceSettings.error.removed'|'workspaceSettings.error.pathRequired'|
  'workspaceSettings.error.nameChanged'|'workspaceSettings.error.nameInvalid'|'workspaceSettings.error.identityMismatch'|
  'workspaceSettings.error.removeConfirmation'|'workspaceSettings.notice.added'|'workspaceSettings.notice.nameSaved'|
  'workspaceSettings.notice.removed'|'workspaceSettings.notice.orderSaved';params?:Readonly<Record<string,string|number>>}
type Snapshot={rows:readonly WorkspaceView[];ready:boolean;sourceError:string|undefined;pending:{kind:string;id:string|undefined}|undefined;path:string;editing:string|undefined;drafts:Readonly<Record<string,Draft>>;error:unknown;notice:WorkspaceManagementMessage|undefined}

const message=(key:WorkspaceManagementMessage['key'],params?:WorkspaceManagementMessage['params']):WorkspaceManagementMessage=>params?{key,params}:{key}
export function isWorkspaceManagementMessage(value:unknown):value is WorkspaceManagementMessage{return !!value&&typeof value==='object'&&'key' in value&&typeof value.key==='string'&&value.key.startsWith('workspaceSettings.')}

/** 只保留界面草稿与请求状态；目录、顺序和操作结果以 DSH 为准。 */
export class WorkspaceManagement{
  private readonly port:WorkspaceManagementPort
  private readonly off:()=>void
  private readonly listeners=new Set<()=>void>()
  private disposed=false
  private state:Snapshot
  constructor(port:WorkspaceManagementPort){
    this.port=port
    const native=port.state()
    this.state={rows:native.rows,ready:native.ready,sourceError:native.error,pending:undefined,path:'',editing:undefined,drafts:{},error:undefined,notice:undefined}
    this.off=port.subscribe(()=>{const next=port.state();this.publish({rows:next.rows,ready:next.ready,sourceError:next.error})})
  }
  getSnapshot=()=>this.state
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
  dispose(){this.off();this.publish({ready:false});this.disposed=true;this.listeners.clear()}
  private publish(patch:Partial<Snapshot>){if(this.disposed)return;this.state={...this.state,...patch};for(const listener of this.listeners)listener()}
  setPath(path:string){this.publish({path})}
  edit(id:string){const row=this.state.rows.find(row=>row.workspaceId===id);if(!row)return;this.publish({editing:id,drafts:{...this.state.drafts,[id]:this.state.drafts[id]??{baseTitle:row.title,value:row.title}},error:undefined,notice:undefined})}
  closeEditor(){this.publish({editing:undefined})}
  setTitle(value:string){const id=this.state.editing,draft=id?this.state.drafts[id]:undefined;if(id&&draft)this.publish({drafts:{...this.state.drafts,[id]:{...draft,value}}})}
  acceptCurrentTitle(id:string){const row=this.state.rows.find(row=>row.workspaceId===id),draft=this.state.drafts[id];if(row&&draft)this.publish({drafts:{...this.state.drafts,[id]:{...draft,baseTitle:row.title}},error:undefined})}
  private requireRow(rows:readonly WorkspaceView[],id:string){const row=rows.find(row=>row.workspaceId===id);if(!row)throw message('workspaceSettings.error.removed');return row}
  private async perform(kind:string,id:string|undefined,operation:(rows:readonly WorkspaceView[])=>Promise<void>){
    if(this.disposed||this.state.pending)return
    this.publish({error:undefined,notice:undefined})
    try{
      const native=this.port.state()
      if(!native.ready)throw message('workspaceSettings.error.connection')
      this.publish({pending:{kind,id}})
      await operation(native.rows)
    }catch(error){this.publish({error})}
    finally{this.publish({pending:undefined})}
  }
  create(){return this.perform('create',undefined,async()=>{
    const draft=this.state.path,path=draft.trim()
    if(!path)throw message('workspaceSettings.error.pathRequired')
    const row=await this.port.create(path)
    if(this.state.path===draft)this.publish({path:''})
    this.publish({notice:message('workspaceSettings.notice.added',{title:row.title})})
  })}
  rename(id:string){return this.perform('rename',id,async rows=>{
    const row=this.requireRow(rows,id),draft=this.state.drafts[id]
    if(!draft||draft.baseTitle!==row.title)throw message('workspaceSettings.error.nameChanged')
    const title=draft.value.trim()
    if(!title||title.length>200)throw message('workspaceSettings.error.nameInvalid')
    const saved=await this.port.rename(id,title)
    if(saved.workspaceId!==id)throw message('workspaceSettings.error.identityMismatch')
    if(this.state.drafts[id]===draft)this.publish({drafts:{...this.state.drafts,[id]:{baseTitle:saved.title,value:saved.title}}})
    this.publish({notice:message('workspaceSettings.notice.nameSaved',{title:saved.title})})
  })}
  remove(id:string,confirmed:boolean){return this.perform('remove',id,async rows=>{
    const row=this.requireRow(rows,id)
    if(!confirmed)throw message('workspaceSettings.error.removeConfirmation')
    await this.port.remove(id)
    this.publish({notice:message('workspaceSettings.notice.removed',{title:row.title}),...(this.state.editing===id?{editing:undefined}:{})})
  })}
  move(id:string,direction:'up'|'down'){return this.perform('move',id,async rows=>{
    this.requireRow(rows,id)
    const index=rows.findIndex(row=>row.workspaceId===id)
    if(direction==='up'&&index===0||direction==='down'&&index===rows.length-1)return
    const anchor=direction==='up'?rows[index-1]:rows[index+2]
    await this.port.move(id,anchor?.workspaceId)
    this.publish({notice:message('workspaceSettings.notice.orderSaved')})
  })}
}
