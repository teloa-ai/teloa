import test from 'node:test'
import assert from 'node:assert/strict'

const module = await import('../src/maintenance-retention.ts').catch(() => ({}))
const select = (input: any) => {
 assert.equal(typeof (module as any).selectMaintenanceRetention, 'function', '缺少维护备份保留筛选')
 return (module as any).selectMaintenanceRetention(input)
}
const now = Date.parse('2026-10-08T00:00:00Z')
const entry = (id: string, changes = {}) => ({id,createdAt:'2026-09-01T00:00:00Z',completedAt:'2026-09-01T01:00:00Z',status:'completed',ownerVerified:true,recoveryVerified:true,independentReadyStarts:2,bytes:100,...changes})

test('永久保护最近核实恢复点和明确保护项，其他成功备份满足两个门槛后才可清理', () => {
 const result = select({entries:[entry('old'),entry('explicit'),entry('latest',{createdAt:'2026-10-01T00:00:00Z'})],protectedIds:['explicit'],now})
 assert.deepEqual(result.eligible.map((row:any)=>row.id),['old'])
 assert.deepEqual(result.keep.map((row:any)=>row.id),['explicit','latest'])
})
test('未完成、失败、未知、损坏、他人和缺证明档案始终留存', () => {
 const rows=[entry('prepared',{status:'prepared'}),entry('failed',{status:'failed'}),entry('unknown',{status:'unknown'}),entry('corrupt',{recoveryVerified:false}),entry('other',{ownerVerified:false}),entry('no-ready',{independentReadyStarts:undefined}),entry('latest',{createdAt:'2026-10-07T00:00:00Z'})]
 assert.equal(select({entries:rows,now}).eligible.length,0)
})
test('7天和完成后两次独立就绪均须满足，不能用较弱策略放宽保护', () => {
 const result=select({entries:[entry('under-seven',{completedAt:'2026-10-01T00:00:00.001Z'}),entry('one-start',{independentReadyStarts:1}),entry('eligible',{completedAt:'2026-10-01T00:00:00Z'}),entry('latest',{createdAt:'2026-10-07T00:00:00Z'})],now,policy:{minimumAgeMs:1,minimumReadyStarts:0}})
 assert.deepEqual(result.eligible.map((row:any)=>row.id),['eligible'])
})
test('无核实恢复点、重复ID及非法时间不能产生候选', () => {
 assert.equal(select({entries:[entry('only',{recoveryVerified:false})],now}).eligible.length,0)
 assert.equal(select({entries:[entry('duplicate'),entry('duplicate'),entry('latest',{createdAt:'2026-10-07T00:00:00Z'})],now}).eligible.length,0)
 assert.equal(select({entries:[entry('bad',{completedAt:'not-a-date'}),entry('latest',{createdAt:'2026-10-07T00:00:00Z'})],now}).eligible.length,0)
})
