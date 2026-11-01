import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chmod,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises'
import {release} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('..',import.meta.url)),output=join(root,'libexec')
const binary=join(output,'maintenance-process'),manifest=join(output,'support.json')
const osRelease=release(),osMajor=Number(osRelease.split('.')[0])
const base={schema:'teloa.maintenance-process-support/v1',platform:process.platform,arch:process.arch,osRelease,osMajor,
 abi:{procPidUniqueIdentifierInfo:17,procUniqueIdentifierInfoSize:56,auditTokenPidIndex:5,auditTokenPidVersionIndex:7}}
await mkdir(output,{recursive:true})
// 私有 ABI 只开放已经用真实生命周期验证的组合；扩平台必须先补对应原生验证。
const supported=process.platform==='darwin'&&process.arch==='arm64'&&osMajor===25
await writeFile(manifest,JSON.stringify({...base,supported:false,reason:'构建未完成，维护进程 API 不可用'},null,2)+'\n')
if(!supported){
 await rm(binary,{force:true})
 await writeFile(manifest,JSON.stringify({...base,supported:false,reason:'尚未验证此平台的维护进程 ABI；仅支持 Darwin 25 arm64'},null,2)+'\n')
}else{
 const temporary=binary+'.build-'+process.pid
 try{
  execFileSync('xcrun',['clang','-std=c11','-O2','-Wall','-Wextra','-Werror','-DTELOA_OS_MAJOR='+osMajor,'-DTELOA_BUILD_ARCH="'+process.arch+'"',join(root,'native/maintenance-process.c'),'-o',temporary],{stdio:'inherit'})
  await chmod(temporary,0o755)
  // 构建时验证本机 ABI 和读取权限；发布后不在用户机器编译。
  const identity=JSON.parse(execFileSync(temporary,['inspect',String(process.pid)],{encoding:'utf8'}))
  if(identity.pid!==process.pid||identity.uid!==process.getuid()||!identity.uniqueId||!identity.pidVersion)throw Error('维护 helper 的进程身份自检失败')
  await rename(temporary,binary)
  const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex')
  await writeFile(manifest,JSON.stringify({...base,supported:true,binarySha256},null,2)+'\n')
 }finally{await rm(temporary,{force:true})}
}
