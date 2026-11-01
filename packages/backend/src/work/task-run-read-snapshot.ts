import type {Pool,PoolClient,QueryResult} from 'pg'
import {serialize,deserialize} from 'node:v8'

/** 只供本次目录读快照使用；不缓存授权，不跨事务保留查询结果。SQL 去重不是数据库权限边界。 */
export async function withTaskRunReadSnapshot<T>(pool:Pool,read:(db:PoolClient,fresh:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect(),memo=new Map<string,Promise<QueryResult>>()
 let active=true
 const clone=(value:QueryResult):QueryResult=>({...value,rows:deserialize(serialize(value.rows)),fields:value.fields.map(field=>({...field}))})
 const query=async(sql:string,values?:unknown[])=>{
  // 不猜测任意 SQL 是否稳定：只有单条 SELECT，且函数均在本读链的纯读名单内，才去重。
  if(!active)throw Error('目录读快照已结束。')
  if(typeof sql!=='string'||values!==undefined&&!Array.isArray(values))throw Error('目录快照只接受参数化只读查询。')
  const plain=sql.replace(/'(?:''|[^'])*'/g,"''").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,' ').trim().replace(/;$/,'')
  if(!/^select\b/i.test(plain)||plain.includes(';')||/\b(insert|update|delete|merge|copy|create|alter|drop|truncate|grant|revoke|call|do)\b/i.test(plain))throw Error('目录快照不能执行写入或多条语句。')
  const functions=[...plain.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)].map(match=>match[1]!.toLowerCase())
  const stable=new Set(['in','not','exists','any','all','select','where','and','or','to_regclass','count','min','max','coalesce','jsonb_typeof'])
  // 未知/volatile/advisory/执行函数保留原调用语义，但绝不命中或写入缓存。
  if(functions.some(name=>!stable.has(name)))return client.query(sql,values)
  const parameter=(value:unknown):unknown=>value===undefined?['undefined']:value===null?['null']:value instanceof Date?['date',value.toISOString()]:Buffer.isBuffer(value)?['buffer',value.toString('hex')]:Array.isArray(value)?['array',value.map(parameter)]:[typeof value,value]
  const key=JSON.stringify([sql,(values??[]).map(parameter)])
  let pending=memo.get(key)
  if(!pending){pending=client.query(sql,values);memo.set(key,pending)}
  return clone(await pending)
 }
 const cached=new Proxy(client,{get:(target,key)=>key==='query'?query:Reflect.get(target,key,target)})
 try{
  // FOR SHARE 是原身份校验的一部分；只读权限由此内部调用链保证，不改成无锁读取。
  await client.query('begin isolation level repeatable read')
  const result=await read(cached,client)
  await client.query('commit');return result
 }catch(error){await client.query('rollback');throw error}finally{active=false;memo.clear();client.release()}
}
