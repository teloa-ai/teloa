import {createHash} from 'node:crypto'
import {readFile,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import type {InstallState} from './contracts.ts'
import {databaseName,docker,ownContainer} from './database.ts'

const hash=(value:unknown)=>{const text=JSON.stringify(value);return typeof text==='string'?createHash('sha256').update(text).digest('hex'):null}
type Evidence={installationId:string;container:unknown;volume:unknown;environment:string}
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
function dockerConnection(config:unknown){
 if(!record(config)||Object.keys(config).join(',')!=='connectionString'||typeof config.connectionString!=='string')return
 const parts=/^(postgresql:\/\/teloa:([a-f0-9]{64})@127\.0\.0\.1:)([1-9]\d{0,4})(\/teloa)$/.exec(config.connectionString)
 if(!parts||Number(parts[3])>65535)return
 return {prefix:parts[1]!,password:parts[2]!,port:Number(parts[3]),suffix:parts[4]!}
}
/** v1 intent 已冻结完整配置 SHA；只枚举端口的有限域，不连接任何候选端口。 */
export function matchesFrozenDockerPort(config:unknown,frozen:string,evidence:Evidence):boolean{
 const url=dockerConnection(config)
 if(!url||!/^[a-f0-9]{64}$/.test(frozen))return false
 const {container:c,volume:v,installationId:id}=evidence,name='teloa-'+id
 if(!record(c)||!record(v)||c.Name!=='/'+name||c.Config?.Labels?.['ai.teloa.install']!==id||v.Name!==name+'-data'||v.Labels?.['ai.teloa.install']!==id||typeof c.State?.Running!=='boolean')return false
 const mounts=Array.isArray(c.Mounts)?c.Mounts.filter((m:unknown)=>record(m)&&m.Destination==='/var/lib/postgresql/data'):[]
 if(mounts.length!==1||mounts[0].Type!=='volume'||mounts[0].Name!==name+'-data')return false
 const lines=evidence.environment.split('\n').filter(Boolean),env=new Map<string,string>()
 for(const line of lines){const pair=/^([A-Z_]+)=(.*)$/.exec(line);if(!pair||env.has(pair[1]!))return false;env.set(pair[1]!,pair[2]!)}
 if([...env.keys()].sort().join(',')!=='POSTGRES_DB,POSTGRES_PASSWORD,POSTGRES_USER'||env.get('POSTGRES_DB')!=='teloa'||env.get('POSTGRES_USER')!=='teloa'||env.get('POSTGRES_PASSWORD')!==url.password||!Array.isArray(c.Config?.Env))return false
 for(const[key,value]of env){const rows=c.Config.Env.filter((x:unknown)=>typeof x==='string'&&x.startsWith(key+'='));if(rows.length!==1||rows[0]!==key+'='+value)return false}
 const configured=c.HostConfig?.PortBindings?.['5432/tcp']
 if(!Array.isArray(configured)||configured.length!==1||configured[0]?.HostIp!=='127.0.0.1')return false
 if(c.State.Running){
  const live=c.NetworkSettings?.Ports?.['5432/tcp']
  if(!Array.isArray(live)||live.length!==1||live[0]?.HostIp!=='127.0.0.1'||String(url.port)!==live[0]?.HostPort)return false
 }
 // 不改变旧 intent、旧 SHA 或当前配置；host/user/password/db/对象键和所有其他字节仍必须精确匹配。
 for(let port=1;port<=65535;port++)if(hash({connectionString:url.prefix+port+url.suffix})===frozen)return true
 return false
}
/** 配置原字节 SHA 相同仍走既有路径；只有 Docker 派生端口改变才需要额外归属证明。 */
export async function matchesOrdinaryDatabaseConfig(state:InstallState,config:unknown,frozen:string|null):Promise<boolean>{
 if(hash(config)===frozen)return true
 if(state.database.kind!=='docker'||typeof frozen!=='string'||!dockerConnection(config))return false
 try{
  const container=await ownContainer(state),volumes=JSON.parse(await docker(['volume','inspect',databaseName(state)+'-data']))
  if(!Array.isArray(volumes)||volumes.length!==1)return false
  const path=join(state.layout.runtimeRoot,'postgres.env'),info=await lstat(path)
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)return false
  return matchesFrozenDockerPort(config,frozen,{installationId:state.id,container,volume:volumes[0],environment:await readFile(path,'utf8')})
 }catch{return false}
}
