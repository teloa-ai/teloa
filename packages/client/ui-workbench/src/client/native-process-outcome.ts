type ProcessGroup={
 readonly members:readonly {readonly kind:string;readonly key:string}[]
 readonly data:{readonly closed:boolean;readonly summary:{readonly counts:readonly {readonly kind:string;readonly count:number}[]}}
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

/** 只认原生已配对的明确成功结果；结束、无错误文本或父调用成功都不代替子调用回执。 */
function toolSucceeded(value:unknown):boolean{
 if(!record(value)||value.kind!=='tool-result'||value.isError!==false||value.error!==undefined||typeof value.callId!=='string'||!value.callId||!record(value.call)||!value.call.name||value.call.name!==value.name||!Array.isArray(value.subCalls))return false
 return value.subCalls.every(toolSucceeded)
}

/** 官方摘要只有类别计数，缺少结果字段；不改变调用原件，只为未证实成功的关闭组采用中性类别。 */
export function verifiedProcessGroup<T extends ProcessGroup|undefined>(group:T,readNode:(key:string)=>unknown):T{
 if(!group||!group.data.closed||group.data.summary.counts.length===0)return group
 let tools=0,complete=true
 for(const member of group.members){
  const node=readNode(member.key)
  if(member.kind!=='node'||!record(node)){complete=false;continue}
  if(node.kind!=='tool-call')continue
  tools++
  if(!record(node.data)||!toolSucceeded(node.data.root))complete=false
 }
 if(complete&&tools>0)return group
 const count=group.data.summary.counts.reduce((sum,item)=>sum+item.count,0)
 return {...group,data:{...group.data,summary:{...group.data.summary,counts:[{kind:'tools',count}]}}}
}
