import {spawn} from 'node:child_process'

/** 不使用 shell；失败信息不回显可能含凭据的参数或子进程输出。 */
export function command(executable:string,args:string[],options:{env?:NodeJS.ProcessEnv;cwd?:string;input?:string;timeout?:number}={}):Promise<{code:number;stdout:string;stderr:string}>{
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{env:options.env,cwd:options.cwd,stdio:['pipe','pipe','pipe']})
  let stdout='',stderr='',overflow=false
  const timer=setTimeout(()=>{child.kill('SIGKILL')},options.timeout??30_000)
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>16*1024*1024){overflow=true;child.kill('SIGKILL')}})
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536)})
  child.once('error',()=>{clearTimeout(timer);reject(Error('无法运行 '+executable+'；请检查是否安装及 PATH。'))})
  child.once('close',code=>{clearTimeout(timer);if(overflow)reject(Error('命令输出超过允许范围。'));else resolve({code:code??1,stdout,stderr})})
  child.stdin.on('error',()=>{})
  child.stdin.end(options.input)
 })
}
