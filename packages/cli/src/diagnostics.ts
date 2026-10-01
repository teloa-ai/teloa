import {StringDecoder} from 'node:string_decoder'

export function redactLog(input:string):string{
 return input.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi,'[database URL]')
  .replace(/(authorization|proxy-authorization|set-cookie|cookie)\s*:[^\r\n]*/gi,'$1: [redacted]')
  .replace(/([?&](?:token|key|secret|password|api_key|access_token)=)[^\s&#"']*/gi,'$1[redacted]')
  .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;}"']+/gi,'$1[redacted]')
  .replace(/\bsk-[A-Za-z0-9_-]{8,}/g,'[redacted]')
  // 与 @teloa/contract 的 secret-shape.ts 前缀表保持一致；CLI 包不依赖契约，所以就地重复。
  .replace(/\b(?:sk-ant-|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|xai-|AIza)[A-Za-z0-9_-]{10,}/g,'[redacted]')
  .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,'[redacted]')
  .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,'[redacted]')
}
/** 按完整行脱敏；超长行整段丢弃，不能分片截断后漏出令牌后半段。 */
export class LogLines{
 private buffer=''
 private dropping=false
 private decoder=new StringDecoder('utf8')
 private emit:(line:string)=>void
 private observe:(line:string)=>void
 constructor(emit:(line:string)=>void,observe:(line:string)=>void=()=>{}){this.emit=emit;this.observe=observe}
 write(chunk:Buffer|string):void{
  const text=typeof chunk==='string'?chunk:this.decoder.write(chunk)
  for(const part of text.split(/(?<=\n)/)){
   if(!this.dropping){this.buffer+=part;if(this.buffer.length>65536){this.buffer='';this.dropping=true}}
   if(part.endsWith('\n')){
    if(!this.dropping)this.observe(this.buffer)
    this.emit(this.dropping?'[过长日志行已省略]\n':redactLog(this.buffer));this.buffer='';this.dropping=false
   }
  }
 }
 end():void{this.write(this.decoder.end());if(this.buffer){this.observe(this.buffer);this.emit(redactLog(this.buffer))}this.buffer=''}
}
export class RuntimeOutput{
 private streams:Record<'stdout'|'stderr',LogLines>
 constructor(emit:(line:string)=>void,observe:(line:string)=>void){this.streams={stdout:new LogLines(emit,observe),stderr:new LogLines(emit,observe)}}
 write(stream:'stdout'|'stderr',chunk:Buffer|string):void{this.streams[stream].write(chunk)}
 end():void{this.streams.stdout.end();this.streams.stderr.end()}
}
