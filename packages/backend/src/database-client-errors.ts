import type {Pool,PoolClient} from 'pg'

/** pg 只替空闲连接监听 error；借出期间也须接住事件，查询仍由 pg 正常 reject。 */
export function observeDatabaseClientErrors(client:PoolClient){
 let error:Error|undefined
 const onError=(value:Error)=>{error??=value}
 client.on('error',onError)
 return {get error(){return error},close:()=>client.removeListener('error',onError)}
}

const protectedPools=new WeakSet<Pool>()
export function protectBorrowedDatabaseClients(pool:Pool):void{
 if(protectedPools.has(pool))return
 protectedPools.add(pool)
 const observations=new WeakMap<PoolClient,ReturnType<typeof observeDatabaseClientErrors>>()
 pool.on('acquire',client=>{observations.get(client)?.close();observations.set(client,observeDatabaseClientErrors(client))})
 const close=(client:PoolClient)=>{observations.get(client)?.close();observations.delete(client)}
 // pg-pool 先恢复 idleListener，再发 release；此处移除监听不会留下无保护窗口。
 pool.on('release',(_error,client)=>close(client))
 pool.on('remove',close)
}
