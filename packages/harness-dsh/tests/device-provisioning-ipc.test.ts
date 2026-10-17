import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,lstat,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createConnection} from 'node:net'
import {randomUUID} from 'node:crypto'
import {startDeviceProvisioningIpc} from '../src/device-provisioning-ipc.ts'

test('本机 IPC 权限受限，未知操作与额外字段拒绝，关闭回收自己创建的 socket',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-pair-ipc-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const service={status:async(id:string)=>({id,state:'awaiting-device'}),provision:async()=>({configuration:'secret-only-to-usb'}),complete:async()=>({state:'paired'}),cancel:async()=>({state:'cancelled'})}
 const ipc=await startDeviceProvisioningIpc(root,service as never)
 assert.equal((await lstat(join(root,'device-pairing'))).mode&0o777,0o700);assert.equal((await lstat(ipc.path)).mode&0o777,0o600)
 const call=(value:unknown)=>new Promise<Record<string,unknown>>((resolve,reject)=>{const socket=createConnection(ipc.path);let bytes='';socket.on('connect',()=>socket.write(JSON.stringify(value)+'\n'));socket.on('data',chunk=>bytes+=chunk);socket.on('end',()=>resolve(JSON.parse(bytes)));socket.on('error',reject)})
 assert.equal((await call({operation:'status',id:randomUUID()})).ok,true)
 assert.equal((await call({operation:'begin',id:randomUUID()})).ok,false)
 assert.equal((await call({operation:'status',id:randomUUID(),port:'/dev/arbitrary'})).ok,false)
 await ipc.close();await assert.rejects(lstat(ipc.path),{code:'ENOENT'})
 await chmod(join(root,'device-pairing'),0o755);await assert.rejects(startDeviceProvisioningIpc(root,service as never))
})
