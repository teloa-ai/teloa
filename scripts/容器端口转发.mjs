import {createServer,connect} from 'node:net'

// 仅容器入口调用。上游保持回环监听；Compose 只把本端口映射到宿主回环。
export async function startContainerProxy({port=8080,targetPort=3100}={}){
  const sockets=new Set()
  const server=createServer(socket=>{
    const upstream=connect(targetPort,'127.0.0.1')
    sockets.add(socket);sockets.add(upstream)
    const close=()=>{socket.destroy();upstream.destroy();sockets.delete(socket);sockets.delete(upstream)}
    socket.on('error',close);upstream.on('error',close)
    socket.on('close',close);upstream.on('close',close)
    socket.pipe(upstream).pipe(socket)
  })
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'0.0.0.0',done)})
  return {server,stop:()=>new Promise(done=>{for(const socket of sockets)socket.destroy();server.close(()=>done())})}
}
