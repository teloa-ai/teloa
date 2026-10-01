import {readPageCreateAtomicSkillDraft} from '@teloa/contract'
import {readAtomicSkill,type AtomicSkillContent} from './atomic-skill.js'

function decodeBase64(value:string):Uint8Array{
 const text=atob(value)
 const bytes=Uint8Array.from(text,char=>char.charCodeAt(0))
 let rebuilt=''
 for(let offset=0;offset<bytes.length;offset+=0x8000)rebuilt+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000))
 if(btoa(rebuilt)!==value)throw Error('技能草案文件内容不完整。')
 return bytes
}

/**
 * 将会话草案恢复成既有原子 Skill 导入输入。这里再次调用 `readAtomicSkill`，
 * 因此 UTF-8、文件大小、入口目录和固定摘要仍只由既有读取器裁定。
 */
export async function pageCreateAtomicSkillContent(value:unknown):Promise<AtomicSkillContent>{
 const body=readPageCreateAtomicSkillDraft(value)
 return readAtomicSkill(body.files.map(file=>{
  const bytes=decodeBase64(file.base64)
  return {path:file.path,size:bytes.byteLength,read:async()=>bytes}
 }),{id:body.id,title:body.title,version:body.version,categories:body.categories})
}

/** 给页内新建回包读取器使用：只接受与确认步骤相同的正文形状。 */
export function readPageCreateAtomicSkillBody(value:unknown):unknown{
 return readPageCreateAtomicSkillDraft(value)
}
