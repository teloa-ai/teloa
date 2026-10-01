import {artifactFilePath,isRecord} from '@teloa/contract'
// 只读取 DSH 已发布的逐轮事实，不重新解析工具参数或回复正文。
export function producedPaths(data:unknown,closingSeq:number):string[]{
 if(!isRecord(data)||!Array.isArray(data.produced))return []
 return [...new Set(data.produced.flatMap(row=>isRecord(row)&&Number.isSafeInteger(row.seq)&&(row.seq as number)>=0&&(row.seq as number)<=closingSeq&&typeof row.path==='string'&&row.path?[row.path]:[]))]
}
export function producedFilePath(path:string,cwd:string|undefined):string|null{
 const root=cwd?.replace(/\/+$/,'')
 const relative=path.startsWith('/')?(root&&path.startsWith(root+'/')?path.slice(root.length+1):null):path.replace(/^\.\//,'')
 return relative&&artifactFilePath(relative)&&!relative.endsWith('/')?relative:null
}
