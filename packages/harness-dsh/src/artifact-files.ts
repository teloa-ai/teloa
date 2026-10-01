import { createHash } from 'node:crypto'
import { posix,win32 } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { artifactFileMaxBytes,artifactFilePath,isRecord,WorkError,type ArtifactFile,type ArtifactFileDirectory } from '@teloa/contract'
import { sessionInput } from '@teloa/backend'
export const artifactFileEndpoints=['artifacts/files/list','artifacts/files/read','artifacts/files/write']
export type ArtifactFileAccess={sessionId:string;cwd:string;fs:Pick<FileSystem,'resolve'|'contains'|'stat'|'readBytes'|'processPath'>&Partial<Pick<FileSystem,'writeText'>>;list:(query:string,signal:AbortSignal)=>Promise<ArtifactFileDirectory['items']>}
export function createArtifactFileReader(access:(sessionId:string)=>Promise<ArtifactFileAccess>,now:()=>string){
  return async function handle(endpoint:string,payload:unknown,signal:AbortSignal):Promise<ArtifactFile|ArtifactFileDirectory>{
    const writing=endpoint==='artifacts/files/write',listing=endpoint==='artifacts/files/list',field=listing?'query':'path'
    if(!artifactFileEndpoints.includes(endpoint)||!isRecord(payload)||Object.keys(payload).some(key=>!(writing?['sessionId',field,'expectedId','expectedSha256','text']:['sessionId',field]).includes(key))||!artifactFilePath(payload[field],listing))throw new WorkError('teloa/invalid-input','文件路径必须位于当前工作空间，不能指向运行数据目录。')
    if(writing&&(typeof payload.expectedId!=='string'||!(/^[a-f0-9]{64}$/).test(payload.expectedId)||typeof payload.expectedSha256!=='string'||!(/^[a-f0-9]{64}$/).test(payload.expectedSha256)||typeof payload.text!=='string'||Buffer.from(payload.text,'utf8').toString('utf8')!==payload.text||Buffer.byteLength(payload.text)>artifactFileMaxBytes||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(payload.text)))throw new WorkError('teloa/invalid-input','编辑内容或原文件版本不正确，单个文本文件最多 8 MiB。')
    const sessionId=sessionInput({sessionId:payload.sessionId}),path=payload[field] as string
    const scoped=await access(sessionId)
    if(scoped.sessionId!==sessionId)throw new WorkError('teloa/not-bound','文件来源与会话绑定不一致。')
    signal.throwIfAborted()
    if(listing){const items=await scoped.list(path,signal);return {sessionId,query:path,items:items.filter(item=>artifactFilePath(item.path)).slice(0,100)}}
    const {fs,cwd}=scoped,opts={cwd,signal}
    const root=await fs.resolve('.',opts),target=await fs.resolve(path,opts)
    const runtime=await fs.resolve('.runtime',opts),git=await fs.resolve('.git',opts)
    if(!fs.contains(root,target)||fs.contains(runtime,target)||fs.contains(git,target))throw new WorkError('teloa/file-scope','该文件不在可选产物范围内，不能读取运行数据目录或工作空间外的文件。')
    // 使用提供方公开的执行路径检查真实目标；绝不解析不透明 targetKey。
    const rootPath=fs.processPath(root),targetPath=fs.processPath(target),paths=/^[A-Za-z]:[\\/]|^\\\\/.test(rootPath)?win32:posix
    const relative=paths.relative(rootPath,targetPath).split(paths.sep).join('/')
    if(!artifactFilePath(relative))throw new WorkError('teloa/file-scope','该文件真实位置不在可选产物范围内，不能通过别名读取运行数据目录。')
    const before=await fs.stat(target,signal)
    if(!before||before.type!=='file')throw new WorkError('teloa/file-unavailable','文件不存在或不是普通文件，请刷新目录。')
    if(before.size!==undefined&&before.size>artifactFileMaxBytes)throw new WorkError('teloa/file-too-large','单个文件不能超过 8 MiB；未读取或截断内容。')
    const bytes=await fs.readBytes(target,signal,artifactFileMaxBytes)
    const after=await fs.stat(target,signal),resolved=await fs.resolve(path,opts)
    if(!after||after.type!=='file'||after.version!==before.version||resolved.targetKey!==target.targetKey)throw new WorkError('teloa/file-changed','读取期间文件发生变化，未保存快照，请重新读取。')
    if(bytes.byteLength>artifactFileMaxBytes)throw new WorkError('teloa/file-too-large','文件超过 8 MiB，未保存快照。')
    signal.throwIfAborted()
    const snapshot:ArtifactFile={schema:'teloa.file-snapshot/v1',sessionId,path,id:createHash('sha256').update(JSON.stringify([sessionId,target.targetKey])).digest('hex'),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.byteLength,capturedAt:now(),contentBase64:Buffer.from(bytes).toString('base64')}
    if(writing){
      if(payload.expectedId!==snapshot.id)throw new WorkError('teloa/file-changed','文件目标已变化，请重新读取核对。')
      try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw Error()}catch{throw new WorkError('teloa/invalid-input','只有 UTF-8 文本文件可在网页编辑。')}
      const text=payload.text as string
      // 回包丢失后仅核对目标内容；不再次覆盖，也不宣称写入者身份。
      if(snapshot.sha256===createHash('sha256').update(text).digest('hex'))return snapshot
      if(payload.expectedSha256!==snapshot.sha256)throw new WorkError('teloa/file-changed','原文件内容已变化，未覆盖；请保留草稿并重新读取核对。')
      if(!fs.writeText)throw new WorkError('teloa/file-unavailable','当前文件系统不支持网页编辑。')
      await fs.writeText(target,text,{kind:'replaceIfVersion',version:after.version},signal)
      const saved=await handle('artifacts/files/read',{sessionId,path},signal)
      if(!('sha256' in saved)||saved.sha256!==createHash('sha256').update(text).digest('hex'))throw new WorkError('teloa/file-changed','写入后文件再次变化，请重新读取核对；旧成果快照保持不变。')
      return saved
    }
    return snapshot
  }
}
