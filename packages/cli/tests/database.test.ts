import assert from 'node:assert/strict'
import test from 'node:test'
const db=await import('../src/database.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
test('已有数据库仅接受无连接覆盖参数的本机 teloa 专库',()=>{
 assert.equal(typeof db.localConnection,'function','缺少连接检查')
 assert.equal(db.localConnection('postgresql://u:p@localhost:5432/teloa').hostname,'localhost')
 for(const url of ['postgresql://u:p@server/teloa','postgresql://u:p@localhost/production','postgresql://u:p@localhost/teloa?host=remote','postgresql://u:p@localhost/teloa#fragment'])assert.throws(()=>db.localConnection(url),/本机/)
})
test('识别 Docker 不同版本的不存在回包，连接错误不能冒充空资源',()=>{
 assert.equal(typeof db.dockerResourceAbsent,'function')
 assert.equal(db.dockerResourceAbsent('Error response from daemon: No such container: test'),true)
 assert.equal(db.dockerResourceAbsent('Error response from daemon: get test: no such volume\n'),true)
 assert.equal(db.dockerResourceAbsent('Cannot connect to the Docker daemon'),false)
})
