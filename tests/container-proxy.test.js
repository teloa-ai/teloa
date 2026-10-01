import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,connect} from 'node:net'
import {once} from 'node:events'
import {startContainerProxy} from '../scripts/容器端口转发.mjs'

test('容器转发透明传输双向字节，关闭时结束连接且释放监听',async()=>{
  const echo=createServer(socket=>socket.pipe(socket))
  echo.listen(0,'127.0.0.1');await once(echo,'listening')
  const proxy=await startContainerProxy({port:0,targetPort:echo.address().port})
  try{
    const socket=connect(proxy.server.address().port,'127.0.0.1')
    await once(socket,'connect')
    socket.write('upgrade-and-payload')
    assert.equal(String((await once(socket,'data'))[0]),'upgrade-and-payload')
    const ended=once(socket,'close')
    await proxy.stop();await ended
    assert.equal(proxy.server.listening,false)
  }finally{await proxy.stop();await new Promise(resolve=>echo.close(resolve))}
})
