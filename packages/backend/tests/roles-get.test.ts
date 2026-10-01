import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool} from 'pg'
import {randomUUID} from 'node:crypto'
import {RoleService} from '../src/work/roles.ts'

test('岗位按本人和固定 ID 查询；缺失及跨本人不回传定义',async()=>{
 const id=randomUUID(),owner='local:owner',calls:unknown[][]=[]
 const row={id,owner_id:owner,definition:{name:'研判同事',kind:'employee',scopes:['general'],duty:'核对告警',dataScope:'已授权资料',executionScope:'只读',skills:[],knowledge:[]},version:2,state:'active',created_at:new Date('2026-10-01T00:00:00.000Z'),updated_at:new Date('2026-10-01T00:00:00.000Z')}
 const pool={query:async(sql:string,args:unknown[])=>{calls.push([sql,args]);return {rows:args[0]===owner&&args[1]===id?[row]:[]}}} as unknown as Pool
 const service=new RoleService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 assert.equal((await service.get(owner,id))?.version,2)
 assert.equal(await service.get('local:other',id),null)
 const missing=randomUUID()
 assert.equal(await service.get(owner,missing),null)
 assert.deepEqual(calls.map(call=>call[1]),[[owner,id],['local:other',id],[owner,missing]])
 assert.ok(calls.every(call=>String(call[0]).includes('owner_id=$1')&&String(call[0]).includes('id=$2')))
 await assert.rejects(()=>service.get(owner,'bad'),{code:'teloa/invalid-input'})
})
