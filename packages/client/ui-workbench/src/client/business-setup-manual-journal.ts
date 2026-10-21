import {WorkError,isRecord,readBusinessSetupManual,readBusinessSetupRoleEdit,type BusinessSetupManual} from '@teloa/contract'
export type BusinessSetupManualEdit=Pick<BusinessSetupManual,'candidate'|'description'|'roleEdits'>
export type BusinessSetupManualInput={snapshot:BusinessSetupManual;edit:BusinessSetupManualEdit}
const corrupt=()=>new WorkError('teloa/storage-corrupt','手动编辑恢复内容不完整，请保留当前输入并读取服务端原稿。')
const keys=(r:unknown,allowed:string[])=>{if(!isRecord(r)||Object.keys(r).length!==allowed.length||Object.keys(r).some(k=>!allowed.includes(k)))throw corrupt();return r}
/** 草稿允许尚未填写完的字符串；只校验展示结构，真正采用仍走完整契约和引用校验。 */
export function readBusinessSetupManualInput(raw:string):BusinessSetupManualInput{
 if(raw.length>3*1024*1024)throw corrupt()
 try{
  const row=keys(JSON.parse(raw),['schema','snapshot','edit']);if(row.schema!=='teloa.business-setup-editor/v1')throw corrupt()
  const snapshot=readBusinessSetupManual(row.snapshot),edit=keys(row.edit,['candidate','description','roleEdits']),candidate=edit.candidate
  if(typeof edit.description!=='string'||edit.description.length>2000||!Array.isArray(edit.roleEdits)||edit.roleEdits.length>100||!isRecord(candidate)||candidate.format!=='teloa.business-configuration/v2'||candidate.scope!==snapshot.candidate.scope||typeof candidate.title!=='string'||!Array.isArray(candidate.definitions)||candidate.definitions.length>256||!Array.isArray(candidate.pages)||candidate.pages.length>24||JSON.stringify(candidate.sources)!==JSON.stringify(snapshot.candidate.sources))throw corrupt()
  for(const d of candidate.definitions){if(!isRecord(d)||!['object-type','view','source-mapping','widget','dashboard'].includes(String(d.kind))||!isRecord(d.definition)||typeof d.definition.id!=='string'||typeof d.definition.title!=='string')throw corrupt();const definition=d.definition;if(d.kind==='object-type'&&(!Array.isArray(definition.fields)||definition.fields.length>50||definition.fields.some(f=>!isRecord(f)||typeof f.name!=='string'||typeof f.label!=='string'||typeof f.type!=='string'||typeof f.required!=='boolean'||f.values!==undefined&&(!Array.isArray(f.values)||f.values.some(v=>typeof v!=='string')))))throw corrupt();if(d.kind==='dashboard'&&(!Array.isArray(definition.widgets)||definition.widgets.some(v=>typeof v!=='string')||!Array.isArray(definition.layout)||definition.layout.some(v=>!isRecord(v)||typeof v.widget!=='string'||['x','y','w','h'].some(k=>typeof v[k]!=='number'))))throw corrupt()}
  for(const p of candidate.pages)if(!isRecord(p)||typeof p.id!=='string'||typeof p.title!=='string'||p.kind!=='records'&&p.kind!=='dashboard'||p.kind==='records'&&(typeof p.objectType!=='string'||!Array.isArray(p.fields)||p.fields.some(f=>typeof f!=='string'))||p.kind==='dashboard'&&typeof p.dashboardId!=='string')throw corrupt()
  for(const role of edit.roleEdits){if(!isRecord(role)||typeof role.duty!=='string'||!isRecord(role.responsibility))throw corrupt();const responsibility=Object.fromEntries(Object.entries(role.responsibility).map(([key,value])=>{if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw corrupt();return [key,value.map(v=>String(v).trim()).filter(Boolean)]}));readBusinessSetupRoleEdit({...role,duty:role.duty.trim()?role.duty:'待填写',responsibility});if(!snapshot.employees.some(e=>e.roleId===role.roleId&&e.expectedVersion===role.expectedVersion))throw corrupt()}
  return {snapshot,edit:edit as BusinessSetupManualEdit}
 }catch{throw corrupt()}
}
export function serializeBusinessSetupManualInput(value:BusinessSetupManualInput):string{
 const raw=JSON.stringify({schema:'teloa.business-setup-editor/v1',...value});readBusinessSetupManualInput(raw);return raw
}
