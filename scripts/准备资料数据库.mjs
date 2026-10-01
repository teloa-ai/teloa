import { spawnSync } from 'node:child_process'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {initializeTeloaDatabase,waitForTeloaDatabase} from './初始化资料数据库.mjs'

const root=fileURLToPath(new URL('../',import.meta.url)),directory=resolve(root,'.runtime/teloa'),configPath=resolve(directory,'database.json')
const name='teloa-postgres',image='postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
// 遵循 Docker CLI 的当前 context / DOCKER_CONTEXT / DOCKER_HOST，不绑定供应商。
const invokeDocker=(args)=>spawnSync('docker',args,{encoding:'utf8'})
const dockerFailure=(result)=>Error('Docker 操作失败：'+(result.error?.message||result.stderr?.trim()||'未知错误')+'（请安装并启动 Docker，并用 `docker info` 验证连接；远程 daemon 不适用于此本机安装脚本）')
const docker=(args)=>{const result=invokeDocker(args);if(result.status!==0)throw dockerFailure(result);return result.stdout.trim()}
const inspect=(args)=>{const result=invokeDocker(args);if(result.status===0)return JSON.parse(result.stdout)[0];if(result.status===1&&/No such (?:object|container|volume):/i.test(result.stderr||''))return null;throw dockerFailure(result)}
try{
  docker(['info'])
  await mkdir(directory,{recursive:true,mode:0o700})
  let info=inspect(['inspect',name])
  if(info){
    if(info.Config.Labels?.['teloa.project']!==root)throw Error('同名容器不属于当前 Teloa 项目，已停止。')
    if(!info.State.Running){docker(['start',name]);info=JSON.parse(docker(['inspect',name]))[0]}
  }else{
    const password=randomBytes(24).toString('hex')
    const envPath=resolve(directory,'postgres.env')
    try{await writeFile(envPath,'POSTGRES_DB=teloa\nPOSTGRES_USER=teloa\nPOSTGRES_PASSWORD='+password+'\n',{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}
    const volume=inspect(['volume','inspect','teloa-postgres-data'])
    if(volume){if(volume.Labels?.['teloa.project']!==root)throw Error('同名数据卷不属于当前 Teloa 项目，已停止。')}
    else docker(['volume','create','--label','teloa.project='+root,'teloa-postgres-data'])
    docker(['run','--detach','--name',name,'--label','teloa.project='+root,'--env-file',envPath,'--publish','127.0.0.1::5432','--mount','type=volume,source=teloa-postgres-data,target=/var/lib/postgresql/data',image])
    info=JSON.parse(docker(['inspect',name]))[0]
  }
  const env=await readFile(resolve(directory,'postgres.env'),'utf8'),password=/^POSTGRES_PASSWORD=(.+)$/m.exec(env)?.[1]
  const port=info.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort
  if(!password||!port)throw Error('缺少本项目的数据库身份或端口。')
  const connectionString='postgresql://teloa:'+encodeURIComponent(password)+'@127.0.0.1:'+port+'/teloa'
  await writeFile(configPath,JSON.stringify({connectionString},null,2)+'\n',{mode:0o600})
  await waitForTeloaDatabase(configPath)
  await initializeTeloaDatabase(configPath)
  console.log('Teloa 独立资料数据库已就绪，容器 '+name+'，本机端口 '+port+'。凭据仅保存在 .runtime/teloa。')
}catch(error){console.error(error.message?.replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[数据库连接]'));process.exitCode=1}
