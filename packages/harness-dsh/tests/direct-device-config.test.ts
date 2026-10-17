import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {readDirectDeviceConfig,readDevicePairingHelper} from '../src/direct-device-config.ts'

test('直连默认关闭；本人显式配置才加载，世界可读及符号链接配置拒绝',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-direct-config-'));t.after(()=>rm(root,{recursive:true,force:true}))
 assert.equal(await readDirectDeviceConfig(root),null)
 const path=join(root,'direct-device.json'),config={enabled:true,listen:{host:'127.0.0.1',port:32101},tlsKeyFile:join(root,'private.key'),tlsCertFile:join(root,'public.crt'),vadModelPath:join(root,'vad.onnx'),devices:[{id:randomUUID(),assistantSessionId:randomUUID(),contextVersion:1,credentialDigest:'a'.repeat(64)}]}
 await writeFile(path,JSON.stringify(config),{mode:0o600});assert.equal((await readDirectDeviceConfig(root))?.devices.length,1)
 await chmod(path,0o644);await assert.rejects(readDirectDeviceConfig(root));await chmod(path,0o600)
 await writeFile(path,JSON.stringify({...config,tlsKeyFile:'relative.key'}));await assert.rejects(readDirectDeviceConfig(root))
 await writeFile(path,JSON.stringify({enabled:false}));assert.equal(await readDirectDeviceConfig(root),null)
 const source=join(root,'linked.json');await writeFile(source,JSON.stringify(config),{mode:0o600});await rm(path);await symlink(source,path);await assert.rejects(readDirectDeviceConfig(root))
})

test('配对命令只在固定项目路径确有普通脚本时可用，缺失、目录或符号链接均不冒可执行入口',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-pairing-helper-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const socket=join(root,'pairing.sock'),script=join(root,'firmware/esp32/tools/pair.py')
 assert.equal(await readDevicePairingHelper(root,socket),null,'npm包缺固件目录时不能返回不存在的配对命令')
 await mkdir(script,{recursive:true});assert.equal(await readDevicePairingHelper(root,socket),null,'目录不是脚本')
 await rm(script,{recursive:true});await writeFile(script,'# synthetic pairing helper fixture\n')
 assert.deepEqual(await readDevicePairingHelper(root,socket),{script,socket},'保留真实源码安装原固定脚本与原IPC身份')
 const other=join(root,'other.py');await writeFile(other,'# synthetic linked helper\n');await rm(script);await symlink(other,script)
 assert.equal(await readDevicePairingHelper(root,socket),null,'符号链接不能冒固定脚本')
})
