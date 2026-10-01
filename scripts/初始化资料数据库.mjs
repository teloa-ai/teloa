import {randomUUID} from 'node:crypto'
import {openResourceDatabase} from '../packages/backend/src/capabilities/database.ts'
import {initializeTeloaDatabase as initializeTeloaSchema} from '../packages/backend/src/work/initialize-database.ts'

export async function waitForTeloaDatabase(configPath,{attempts=20,intervalMs=250}={}){
  for(let attempt=0;;attempt++){
    let pool
    try{
      const connection=await openResourceDatabase(configPath,{id:randomUUID,now:()=>new Date().toISOString()})
      pool=connection.pool
      await pool.query('select 1')
      return
    }catch(error){
      if(attempt>=attempts)throw error
      await new Promise(done=>setTimeout(done,intervalMs))
    }finally{await pool?.end()}
  }
}

export async function initializeTeloaDatabase(configPath,{expectedSearchPath}={}){
  const {pool}=await openResourceDatabase(configPath,{id:randomUUID,now:()=>new Date().toISOString()})
  try{
    if(expectedSearchPath){
      const result=await pool.query('show search_path')
      if(result.rows[0]?.search_path!==expectedSearchPath)throw Error('验收数据库未进入独立 schema，已停止初始化。')
    }
    // 建表次序由后端唯一入口负责，脚本与 DSH 宿主用同一套结构。
    await initializeTeloaSchema(pool)
  }finally{await pool.end()}
}
