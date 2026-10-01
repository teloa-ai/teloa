import {writeFile,rename} from 'node:fs/promises'
import {resolve} from 'node:path'

/** 晚于 exit 订阅也要结算；快速失败不得把验收清理永远挂住。 */
export const waitForExit=child=>new Promise((done,fail)=>{
 const finish=(code,signal)=>{
  child.removeListener('error',onError);child.removeListener('exit',finish)
  if(code===0)done();else fail(Error('子进程 '+(signal?'被 '+signal+' 中止':'退出码 '+code)))
 }
 const onError=error=>{child.removeListener('exit',finish);fail(error)}
 child.once('error',onError);child.once('exit',finish)
 if(child.exitCode!==null||child.signalCode!==null)finish(child.exitCode,child.signalCode)
})

/** 每个端口独立且原子替换，避免并行宿主串证据或读到半份 JSON。 */
export async function writeRestartMarker(directory,marker){
 const port=new URL(marker.origin).port
 if(!port||port==='3100')throw Error('重启证据必须属于隔离验收端口。')
 const path=resolve(directory,'重启验收代次-'+port+'.json'),temporary=path+'.'+marker.launcher+'.tmp'
 await writeFile(temporary,JSON.stringify(marker),{mode:0o600})
 await rename(temporary,path)
}
