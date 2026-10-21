import {attachmentName,type BusinessDashboardShareSnapshot} from '@teloa/contract'

export const dashboardShareCsvMaxBytes=8*1024*1024
const fail=(code:string)=>Object.assign(Error(code),{code})
/** RFC 4180 转义；文字中的表格公式前缀加单引号，不让来源内容在表格软件里执行。 */
function cell(value:unknown):string{
 let text=value===null?'':String(value)
 if(/^[\s]*[=+@-]/.test(text)&&!/^\s*-?\d+(?:\.\d+)?\s*$/.test(text))text="'"+text
 return '"'+text.replace(/"/g,'""')+'"'
}
/** 导出宿主核验的完整原始记录；聚合图表结果绝不回退成所谓原始数据。 */
export function dashboardShareCsv(snapshot:BusinessDashboardShareSnapshot):Blob{
 if(snapshot.raw.status!=='ready')throw fail('teloa/dashboard-share-no-raw')
 const sections=snapshot.raw.sections,keys=[...new Set(sections.flatMap(section=>section.columns.map(column=>column.key)))]
 const fixed=['dashboard.scope','dashboard.id','dashboard.version','dashboard.time_range','dashboard.captured_at','dashboard.snapshot_sha256','widget.id','view.id','object_type.id']
 const target=snapshot.target,id=target.kind==='configuration'?target.pageId:target.dashboardId,version=target.kind==='configuration'?String(target.configurationVersion):target.definitionHash
 const lines=[fixed.concat(keys).map(cell).join(',')]
 let count=0
 for(const section of sections){
  if(section.rows.length!==section.recordCount||section.rows.some(row=>row.length!==section.columns.length))throw fail('teloa/invalid-host-response')
  const positions=new Map(section.columns.map((column,index)=>[column.key,index]))
  for(const row of section.rows){
   if(++count>5000)throw fail('teloa/dashboard-share-limit')
   lines.push([target.scope,id,version,target.timeRange,snapshot.capturedAt,snapshot.snapshotHash,section.widgetId,section.viewId,section.objectTypeId,...keys.map(key=>positions.has(key)?row[positions.get(key)!]??null:null)].map(cell).join(','))
  }
 }
 const blob=new Blob(['\ufeff'+lines.join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'})
 if(blob.size>dashboardShareCsvMaxBytes)throw fail('teloa/dashboard-share-limit')
 return blob
}
export function dashboardShareFilename(snapshot:BusinessDashboardShareSnapshot,extension:'png'|'csv'):string{
 const target=snapshot.target,id=target.kind==='configuration'?target.pageId:target.dashboardId
 return attachmentName('dashboard-'+id.slice(0,60)+'-'+target.timeRange+'-'+snapshot.snapshotHash.slice(0,12)+'.'+extension)
}
/** 下载只读取当前固定 Blob，不创建公开 URL。 */
export function downloadDashboardShare(blob:Blob,name:string):void{
 const url=URL.createObjectURL(blob),anchor=document.createElement('a')
 anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000)
}

