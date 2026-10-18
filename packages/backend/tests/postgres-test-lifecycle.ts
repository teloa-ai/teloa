import {Pool as PgPool,type PoolClient,type PoolConfig} from 'pg'
export type {PoolClient,QueryResult} from 'pg'
const clients=new WeakMap<PgPool,Set<PoolClient>>()

/** pg-pool.end() 可先于连接 socket 退役回调；测试须等 remove 后再停止所属容器。 */
export class Pool extends PgPool{
 constructor(config?:PoolConfig){
  super(config)
  const open=new Set<PoolClient>();clients.set(this,open)
  this.on('connect',client=>open.add(client))
  this.on('remove',client=>open.delete(client))
 }
 override end():Promise<void>
 override end(callback:()=>void):void
 override end(callback?:()=>void):Promise<void>|void{
  const finished=super.end().then(async()=>{
   while(clients.get(this)!.size)await new Promise<void>((resolve,reject)=>{
    const removed=()=>{clearTimeout(timer);resolve()}
    const timer=setTimeout(()=>{this.off('remove',removed);reject(Error('测试数据库连接未完成退役，保留容器以免掩盖异步错误。'))},10000)
    this.once('remove',removed)
   })
  })
  if(callback){void finished.then(callback,error=>this.emit('error',error));return}
  return finished
 }
}

/** 仅重试 Docker 明确的运行中删除竞态；不强删，不吞其他错误，不触碰其他容器。 */
export async function stopTestContainer(container:{stop:()=>Promise<unknown>}|undefined):Promise<void>{
 if(!container)return
 for(let attempt=0;;attempt++)try{await container.stop();return}catch(error){
  if(attempt>=2||!(error instanceof Error)||Reflect.get(error,'statusCode')!==409||!/container is running/i.test(error.message))throw error
  await new Promise(resolve=>setTimeout(resolve,100))
 }
}
