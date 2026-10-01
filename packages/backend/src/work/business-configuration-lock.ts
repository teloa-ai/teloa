import type {PoolClient} from 'pg'

/** 同一本人、同一业务范围内所有定义写入共享的事务锁。 */
export async function lockBusinessConfiguration(db:PoolClient,ownerId:string,scope:string,mode:'exclusive'|'shared'='exclusive'):Promise<void>{
 const operation=mode==='shared'?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock'
 await db.query('select '+operation+'(hashtextextended($1,0))',[JSON.stringify(['teloa.business-configuration',ownerId,scope])])
}
