import {mkdir} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {prepareContainerSecret,writeContainerDatabase} from './容器配置.mjs'
import {waitForTeloaDatabase,initializeTeloaDatabase} from './初始化资料数据库.mjs'
import {startContainerProxy} from './容器端口转发.mjs'
import {stripCredentialEnv,warnRemoved} from './runtime/credential-env.mjs'
import {imCredentialFields} from '../packages/contract/src/im-channels.ts'

try{
  if(process.argv[2]==='init'){
    await prepareContainerSecret('/data/secrets/postgres-password')
    await prepareContainerSecret('/data/credentials-secret/key')
    console.log('容器数据库身份已准备；口令保留在独立数据卷中。')
  }else{
    await mkdir('/data/teloa',{recursive:true,mode:0o700})
    await writeContainerDatabase('/run/teloa-secrets/postgres-password','/data/teloa/database.json')
    await waitForTeloaDatabase('/data/teloa/database.json',{attempts:60,intervalMs:1000})
    await initializeTeloaDatabase('/data/teloa/database.json')
    const proxy=await startContainerProxy()
    // 容器是正式部署：显式开启使用统计与在线市场；外部显式值及宿主的 CI / 验收 / 开发排除规则优先。
    // 凭据形变量不进宿主（规格 §4 启动器），凭据验收开关在正式部署一律丢弃。剔除名单在这里提示：
    // 子进程 启动DSH.mjs 收到的已是剔除后的环境，不会再提示一次。
    const stripped=stripCredentialEnv(process.env,{acceptance:false})
    warnRemoved(stripped.removed,Object.values(imCredentialFields).flat().map(field=>field.key))
    const child=spawn(process.execPath,['scripts/启动DSH.mjs'],{stdio:'inherit',env:{TELOA_USAGE_STATS:'on',TELOA_MARKET_REMOTE:'on',...stripped.env}})
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
    child.once('error',()=>{console.error('容器宿主启动失败。');void proxy.stop();process.exitCode=1})
    child.once('exit',(code,signal)=>{void proxy.stop();process.exitCode=code??(signal?1:0)})
  }
}catch{
  console.error('容器初始化失败。请检查数据卷权限、数据库健康状态与原有口令；未输出敏感配置。')
  process.exitCode=1
}
