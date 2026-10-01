import { lstat,mkdir,readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { WorkError,isRecord } from '@teloa/contract'
import { createPublicReferenceCatalog } from '@teloa/mcp-reference/local'
import { ResourceService } from './resources.ts'
import { IndustryReferenceCatalog,combineReferenceCatalogs } from './industry-reference-catalog.ts'
import { MarketContentStore } from '../market/content-store.ts'
import { IndustryLoadService } from '../work/industry-loads.ts'
import { createIndustryLoadSource } from '../work/industry-load-source.ts'
import {dirname,resolve} from 'node:path'
import {MarkdownKnowledgeService} from './markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog} from './markdown-knowledge-catalog.ts'
import {KnowledgeResourceService} from './knowledge-resources.ts'
import {KnowledgeTreeService} from './knowledge-tree.ts'
import {RetrievalIndexService} from './retrieval-index.ts'

export function databaseConnectionAllowed(connectionString:string,deployment?:string):boolean{
  let url:URL
  try{url=new URL(connectionString)}catch{return false}
  const hosts=deployment==='compose'?['127.0.0.1','localhost','db']:['127.0.0.1','localhost']
  return ['postgres:','postgresql:'].includes(url.protocol)&&hosts.includes(url.hostname)&&url.pathname==='/teloa'
}

/** `options.deployment`：宿主传入只读启动快照里的 TELOA_DEPLOYMENT（工作区 .env 不能借它放宽主机白名单）；缺省读 process.env 只给脚本用。 */
export async function openResourceDatabase(path:string,identity:{id:()=>string;now:()=>string},options:{deployment?:string|undefined}={deployment:process.env.TELOA_DEPLOYMENT}):Promise<{pool:Pool;dispatchLocks:Pool;close:()=>Promise<void>;service:ResourceService;knowledge:MarkdownKnowledgeService;knowledgeTree:KnowledgeTreeService;knowledgeResources:KnowledgeResourceService;retrieval:RetrievalIndexService;sources:ReturnType<typeof combineReferenceCatalogs>}>{
  let config:unknown
  try{
    const entry=await lstat(path)
    if(entry.isSymbolicLink()||!entry.isFile())throw new WorkError('teloa/storage-unavailable','工作资料数据库尚未配置或配置不可读，请运行本项目的 setup:database。')
    if((entry.mode&0o077)!==0)throw new WorkError('teloa/storage-unavailable','工作资料数据库配置文件权限过宽，请运行本项目的 setup:database。')
    config=JSON.parse(await readFile(path,'utf8'))
  }catch(error){
    if(error instanceof WorkError)throw error
    throw new WorkError('teloa/storage-unavailable','工作资料数据库尚未配置或配置不可读，请运行本项目的 setup:database。')
  }
  if(!isRecord(config)||typeof config.connectionString!=='string')throw new WorkError('teloa/storage-unavailable','工作资料数据库配置格式不正确。')
  if(!databaseConnectionAllowed(config.connectionString,options.deployment))throw new WorkError('teloa/storage-unavailable','只接受本机数据库或 Compose 内网 db 服务的独立 teloa 数据库。')
  const knowledgeRoot=resolve(dirname(path),'data')
  try{
    await mkdir(knowledgeRoot,{recursive:true,mode:0o700})
    const entry=await lstat(knowledgeRoot)
    if(entry.isSymbolicLink()||!entry.isDirectory())throw new WorkError('teloa/storage-corrupt','知识内容仓目录身份不正确，已停止打开。')
    if((entry.mode&0o077)!==0)throw new WorkError('teloa/storage-corrupt','知识内容仓目录权限过宽，已停止打开。')
  }catch(error){
    if(error instanceof WorkError)throw error
    throw new WorkError('teloa/storage-unavailable','知识内容仓目录无法准备。')
  }
  const pool=new Pool({connectionString:config.connectionString,max:6,connectionTimeoutMillis:5000,statement_timeout:15000})
  pool.on('error',()=>{/* 下次业务请求通过显式失败报告，不暴露连接凭据。 */})
  // 锁等待不能占用业务事务的连接额度；Pool在首次借用之前不会建立连接。
  const dispatchLocks=new Pool({connectionString:config.connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:15000})
  dispatchLocks.on('error',()=>{/* 已借出的锁连接由服务中止lockSignal；空闲连接由pg回收。 */})
  let closing:Promise<void>|undefined
  const close=()=>closing??=(async()=>{try{await dispatchLocks.end()}finally{await pool.end()}})()
  const market=new MarketContentStore(pool,identity)
  const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
  const knowledge=new MarkdownKnowledgeService(pool,knowledgeRoot,'default',identity)
  const sources=combineReferenceCatalogs(createPublicReferenceCatalog(),new IndustryReferenceCatalog(pool,market,loads),new MarkdownKnowledgeCatalog(knowledge))
  const service=new ResourceService(pool,sources,identity)
  return {pool,dispatchLocks,close,service,knowledge,knowledgeTree:new KnowledgeTreeService(pool,'default',identity),knowledgeResources:new KnowledgeResourceService(pool,knowledge,service),retrieval:new RetrievalIndexService(pool,service,identity),sources}
}
