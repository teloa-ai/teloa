import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type ReferenceDefinition={id:string;title:string;file:string}
export type ReferenceInfo={id:string;title:string;version:string;source:string;bytes:number}
export class ReferenceError extends Error {
  readonly code:string
  constructor(code:string,message:string){super(message);this.name='ReferenceError';this.code=code}
}
const maxBytes=128*1024
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)}

export class ReferenceCatalog {
  private readonly root:string
  private readonly definitions:readonly ReferenceDefinition[]
  constructor(root:string,definitions:readonly ReferenceDefinition[]){
    this.root=resolve(root)
    this.definitions=definitions.map(item=>({...item}))
    if(new Set(definitions.map(item=>item.id)).size!==definitions.length)throw new Error('资料 ID 重复。')
  }
  async list():Promise<{schema:'teloa.reference-list/v1';references:ReferenceInfo[]}>{
    const references:ReferenceInfo[]=[]
    for(const definition of this.definitions){const {text:_,...info}=await this.load(definition);references.push(info)}
    return {schema:'teloa.reference-list/v1',references}
  }
  async read(id:string,version:string):Promise<ReferenceInfo & {schema:'teloa.reference/v1';text:string}>{
    const definition=this.definitions.find(item=>item.id===id)
    if(!definition)throw new ReferenceError('reference/not-found','未开放此资料。请先列出可读取的资料。')
    const result=await this.load(definition)
    if(result.version!==version)throw new ReferenceError('reference/version-conflict','资料版本已变化。请重新列出资料，核对新版本后读取。')
    return {schema:'teloa.reference/v1',...result}
  }
  private async load(definition:ReferenceDefinition):Promise<ReferenceInfo & {text:string}>{
    try{
      const path=resolve(this.root,definition.file)
      if(!within(this.root,path)||!within(await realpath(this.root),await realpath(path)))throw new Error('资料越界')
      // 固定来源目录由项目维护；拒绝最终路径符号链接和特殊文件，不接收调用者路径。
      const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
      try{
        const stat=await handle.stat()
        if(!stat.isFile()||stat.size>maxBytes)throw new Error('资料不是受限普通文件')
        const buffer=Buffer.alloc(maxBytes+1)
        let size=0
        while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,null);if(read.bytesRead===0)break;size+=read.bytesRead}
        if(size>maxBytes)throw new Error('资料过大')
        const bytes=buffer.subarray(0,size)
        return {id:definition.id,title:definition.title,source:definition.file,version:createHash('sha256').update(bytes).digest('hex'),bytes:size,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}
      }finally{await handle.close()}
    }catch{
      throw new ReferenceError('reference/source-unavailable','资料 '+definition.id+' 当前不可读。请检查来源、文件类型、编码或大小。')
    }
  }
}
