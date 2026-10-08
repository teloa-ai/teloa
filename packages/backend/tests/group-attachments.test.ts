import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,groupAttachmentFileMaxBytes,groupAttachmentImageMaxBytes,groupAttachmentTotalBytes,isGroupAttachment,isGroupAttachmentBytes} from '@teloa/contract'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeRoles} from '../src/work/roles.ts'
import {GroupAttachmentService,initializeGroupAttachments,readActiveAttachment,type GroupAttachmentBytePorts} from '../src/work/group-attachments.ts'

const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
const disconnected:Promise<void>[]=[]
let connectedClients=0
// 可推进的时钟：复活件要能按「这次上传的时间」排到列表顶部，固定时钟看不出这件事。
let clock=Date.parse('2026-09-21T09:00:00.000Z')
const identity={id:randomUUID,now:()=>new Date(clock+=1000).toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 pool.on('connect',client=>{
  connectedClients++
  disconnected.push(new Promise<void>(done=>client.once('end',()=>{connectedClients--;done()})))
 })
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAttachments(pool)
})
after(async()=>{
 try{
  await pool?.end()
  // pg-pool 的 end 先移除池内客户端；socket 关闭后才安全停止 PostgreSQL。
  await Promise.all(disconnected)
  assert.equal(connectedClients,0,'停止数据库前必须等所有客户端连接关闭')
 }finally{await container?.stop()}
})

/** 图片归一化前缀：宿主会重编码图片，桩端口照样改字节，保证「sha256 算原字节」这条判据有锚。 */
const normalizedPrefix=Buffer.from('归一化')

/** 内存桩端口：文件按原字节内容寻址，图片模拟宿主归一化（字节与 mediaType 都变）。真端口在 T9／T13 接。 */
function stubPorts(overrides:Partial<GroupAttachmentBytePorts>={}):GroupAttachmentBytePorts&{store:Map<string,Buffer>}{
 const store=new Map<string,Buffer>()
 const ports={
  store,
  async saveImage(dataBase64:string,_mime:string,_name:string){
   const normalized=Buffer.concat([normalizedPrefix,Buffer.from(dataBase64,'base64')])
   const attachmentId='sha256:'+createHash('sha256').update(normalized).digest('hex')
   store.set(attachmentId,normalized)
   return {attachmentId,bytes:normalized.length,width:128,height:96,mediaType:'image/webp'}
  },
  async saveFile(dataBase64:string,name:string){
   const bytes=Buffer.from(dataBase64,'base64')
   const attachmentId='sha256:'+createHash('sha256').update(bytes).digest('hex')
   store.set(attachmentId,bytes)
   return {attachmentId,bytes:bytes.length,name:'清洗_'+name}
  },
  async readBytes(row:{attachmentId:string}){
   const found=store.get(row.attachmentId)
   if(!found)throw new WorkError('teloa/source-unavailable','附件内容已不可读取。')
   return new Uint8Array(found)
  },
  ...overrides
 }
 return ports as GroupAttachmentBytePorts&{store:Map<string,Buffer>}
}

async function fixture(ports:GroupAttachmentBytePorts=stubPorts()){
 const owner=randomUUID(),groups=new CollaborationService(pool,identity)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'附件测试群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[]}})
 return {owner,group,groups,ports,attachments:new GroupAttachmentService(pool,identity,ports)}
}

const base64=(value:Buffer|string)=>Buffer.isBuffer(value)?value.toString('base64'):Buffer.from(value).toString('base64')
const upload=(group:{id:string;version:number},overrides:Record<string,unknown>={})=>({requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,mime:'text/markdown',name:'说明.md',dataBase64:base64('# 验收说明\n'),...overrides})
const png=(group:{id:string;version:number},overrides:Record<string,unknown>={})=>upload(group,{mime:'image/png',name:'验收.png',dataBase64:base64('伪 PNG 原始字节'),...overrides})

test('上传 PNG：14 键过判定器、kind 为 image、尺寸非空、sha256 算的是原字节而不是 attachmentId',async()=>{
 const {owner,group,attachments}=await fixture()
 const original=Buffer.from('伪 PNG 原始字节')
 const saved=await attachments.upload(owner,png(group))
 assert.equal(isGroupAttachment(saved),true)
 assert.equal(saved.kind,'image')
 assert.equal(saved.version,1)
 assert.equal(saved.width,128)
 assert.equal(saved.height,96)
 assert.equal(saved.state,'active')
 assert.equal(saved.withdrawnAt,null)
 assert.equal(saved.uploadedInGroupId,group.id)
 // 第 3 条的锚：图片的 attachmentId 覆盖归一化后的字节，摘要覆盖上传原字节，两者必须不同。
 assert.equal(saved.sha256,createHash('sha256').update(original).digest('hex'))
 assert.notEqual(saved.sha256,saved.attachmentId.slice('sha256:'.length))
 // mime 与 bytes 取回执：归一化把 PNG 变成 webp，字节数也变了。
 assert.equal(saved.mime,'image/webp')
 assert.equal(saved.bytes,normalizedPrefix.length+original.length)
})

test('上传 GIF 走文件通道：kind 为 file、宽高为 null',async()=>{
 const {owner,group,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group,{mime:'image/gif',name:'动画验收.gif',dataBase64:base64('伪 GIF 字节')}))
 assert.equal(saved.kind,'file')
 assert.equal(saved.width,null)
 assert.equal(saved.height,null)
 assert.equal(saved.mime,'image/gif')
})

test('上传 Markdown：kind 为 file、sha256 等于对原字节算的值',async()=>{
 const {owner,group,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group))
 assert.equal(saved.kind,'file')
 assert.equal(saved.sha256,createHash('sha256').update(Buffer.from('# 验收说明\n')).digest('hex'))
})

test('落库的 bytes 与 name 取端口回执而不是入参',async()=>{
 const ports=stubPorts({async saveFile(dataBase64:string,name:string){
  const bytes=Buffer.from(dataBase64,'base64')
  return {attachmentId:'sha256:'+createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length+7,name:'清洗后的'+name}
 }})
 const {owner,group,attachments}=await fixture(ports)
 const saved=await attachments.upload(owner,upload(group))
 assert.equal(saved.bytes,Buffer.byteLength('# 验收说明\n')+7)
 assert.equal(saved.name,'清洗后的说明.md')
})

test('同 requestId 重放同内容回同一行；换内容判 teloa/conflict',async()=>{
 const {owner,group,attachments}=await fixture()
 const input=upload(group)
 const first=await attachments.upload(owner,input)
 assert.deepEqual(await attachments.upload(owner,{...input}),first)
 await assert.rejects(attachments.upload(owner,{...input,dataBase64:base64('换了内容\n')}),{code:'teloa/conflict'})
})

test('同字节换 requestId 仍是同一行，uploadedInGroupId 不被第二个群覆盖',async()=>{
 const {owner,group,groups,attachments}=await fixture()
 const second=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'另一个群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[]}})
 const first=await attachments.upload(owner,upload(group))
 const again=await attachments.upload(owner,upload(second,{}))
 assert.equal(again.attachmentId,first.attachmentId)
 assert.equal(again.uploadedInGroupId,group.id)
 assert.equal((await pool.query('select count(*) as count from teloa_attachments where owner_id=$1',[owner])).rows[0].count,'1')
})

test('总量到顶判 teloa/conflict；撤回一件后额度回收可再传',async()=>{
 const {owner,group,attachments}=await fixture()
 const placeholder='sha256:'+'b'.repeat(64)
 await pool.query("insert into teloa_attachments(attachment_id,owner_id,version,request_id,request_spec,kind,mime,bytes,sha256,name,uploaded_in_group_id,state,created_at) values($1,$2,1,$3,'{}'::jsonb,'file','application/pdf',$4,$5,'占位.pdf',$6,'active',$7)",[placeholder,owner,randomUUID(),groupAttachmentTotalBytes-1,'a'.repeat(64),group.id,identity.now()])
 const big=upload(group,{dataBase64:base64(Buffer.alloc(1024,7))})
 await assert.rejects(attachments.upload(owner,big),(error:WorkError)=>error.code==='teloa/conflict'&&error.message==='附件总量已达上限，请先撤回不再需要的附件。')
 await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:placeholder})
 const saved=await attachments.upload(owner,upload(group,{dataBase64:base64(Buffer.alloc(1024,7))}))
 assert.equal(saved.bytes,1024)
})

test('文件档上限：16 MiB PDF 落盘后读回逐字节一致、摘要与元数据行相等；多 1 字节与超图片档的 PNG 在落盘前被拒',async()=>{
 const ports=stubPorts(),{owner,group,attachments}=await fixture(ports)
 const original=Buffer.alloc(groupAttachmentFileMaxBytes,0x25)
 original.write('%PDF-1.4\n',0);original.write('%%EOF\n',original.length-6)
 const saved=await attachments.upload(owner,upload(group,{mime:'application/pdf',name:'大文件.pdf',dataBase64:base64(original)}))
 assert.equal(saved.kind,'file')
 assert.equal(saved.bytes,groupAttachmentFileMaxBytes)
 assert.equal(saved.sha256,createHash('sha256').update(original).digest('hex'))
 const back=await attachments.read(owner,{attachmentId:saved.attachmentId})
 assert.equal(back.bytes,groupAttachmentFileMaxBytes)
 assert.equal(back.sha256,saved.sha256)
 assert.equal(Buffer.from(back.dataBase64,'base64').equals(original),true)
 const stored=ports.store.size
 await assert.rejects(attachments.upload(owner,upload(group,{mime:'application/pdf',name:'超限.pdf',dataBase64:base64(Buffer.alloc(groupAttachmentFileMaxBytes+1,1))})),{code:'teloa/invalid-input'})
 await assert.rejects(attachments.upload(owner,png(group,{dataBase64:base64(Buffer.alloc(groupAttachmentImageMaxBytes+1,2))})),{code:'teloa/invalid-input'})
 assert.equal(ports.store.size,stored,'被拒的上传一个字节都没落盘')
})

test('总量 512 MiB 规则不变：满额文件恰好卡在上限时可传，多 1 字节即判 teloa/conflict',async()=>{
 const {owner,group,attachments}=await fixture()
 // 占位行只占额度不占字节：已用量 = 上限 − 文件档 + 1，再传一件满额文件恰好越界 1 字节。
 await pool.query("insert into teloa_attachments(attachment_id,owner_id,version,request_id,request_spec,kind,mime,bytes,sha256,name,uploaded_in_group_id,state,created_at) values($1,$2,1,$3,'{}'::jsonb,'file','application/pdf',$4,$5,'占位.pdf',$6,'active',$7)",['sha256:'+'c'.repeat(64),owner,randomUUID(),groupAttachmentTotalBytes-groupAttachmentFileMaxBytes+1,'a'.repeat(64),group.id,identity.now()])
 const big=Buffer.alloc(groupAttachmentFileMaxBytes,3)
 await assert.rejects(attachments.upload(owner,upload(group,{mime:'application/pdf',name:'满额.pdf',dataBase64:base64(big)})),(error:WorkError)=>error.code==='teloa/conflict'&&error.message==='附件总量已达上限，请先撤回不再需要的附件。')
 await pool.query('update teloa_attachments set bytes=$2 where owner_id=$1',[owner,groupAttachmentTotalBytes-groupAttachmentFileMaxBytes])
 const saved=await attachments.upload(owner,upload(group,{mime:'application/pdf',name:'满额.pdf',dataBase64:base64(big)}))
 assert.equal(saved.bytes,groupAttachmentFileMaxBytes)
})

test('群判据：已归档判 conflict、版本过期判 version-conflict、非本人群判 forbidden',async()=>{
 const {owner,group,groups,attachments}=await fixture()
 await assert.rejects(attachments.upload(owner,upload(group,{expectedVersion:group.version+1})),{code:'teloa/version-conflict'})
 await assert.rejects(attachments.upload(randomUUID(),upload(group)),{code:'teloa/forbidden'})
 const archived=await groups.change(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,fields:{name:'附件测试群',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[],pinned:false,archived:true}})
 await assert.rejects(attachments.upload(owner,upload(archived)),{code:'teloa/conflict'})
})

test('read 的三种不可见情形回同一个码与同一句话，不构成存在性探测口',async()=>{
 const {owner,group,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group))
 await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:saved.attachmentId})
 const other=await fixture()
 const alive=await other.attachments.upload(other.owner,upload(other.group))
 const answers:Array<{code:string;message:string}>=[]
 for(const attempt of [
  ()=>attachments.read(owner,{attachmentId:'sha256:'+'c'.repeat(64)}),
  ()=>attachments.read(owner,{attachmentId:alive.attachmentId}),
  ()=>attachments.read(owner,{attachmentId:saved.attachmentId})
 ]){
  const error=await attempt().then(()=>undefined,(reason:WorkError)=>reason)
  assert.ok(error instanceof WorkError)
  answers.push({code:error.code,message:error.message})
 }
 assert.deepEqual(answers[1],answers[0])
 assert.deepEqual(answers[2],answers[0])
 assert.deepEqual(answers[0],{code:'teloa/forbidden',message:'附件不存在、已撤回或不属于当前本人。'})
})

test('read 文件类逐字节等于上传原字节；回包的 sha256 恒等于本次回传字节的摘要',async()=>{
 const {owner,group,attachments}=await fixture()
 const file=await attachments.upload(owner,upload(group))
 const bytes=await attachments.read(owner,{attachmentId:file.attachmentId})
 assert.equal(isGroupAttachmentBytes(bytes),true)
 assert.deepEqual(Buffer.from(bytes.dataBase64,'base64'),Buffer.from('# 验收说明\n'))
 assert.equal(bytes.name,file.name)
 assert.equal(bytes.mime,file.mime)
 assert.equal(bytes.sha256,file.sha256,'文件类落盘即上传原字节，两个 sha256 本来就相等')
 const image=await attachments.upload(owner,png(group))
 const imageBytes=await attachments.read(owner,{attachmentId:image.attachmentId})
 assert.equal(imageBytes.bytes,image.bytes)
 // 归一化改过字节：回包给的是落盘字节，不是上传原字节。
 assert.deepEqual(Buffer.from(imageBytes.dataBase64,'base64'),Buffer.concat([normalizedPrefix,Buffer.from('伪 PNG 原始字节')]))
 // 回包自洽：sha256 覆盖 dataBase64 解码后的字节；图片上它必然不等于元数据行的上传原字节摘要。
 assert.equal(imageBytes.sha256,createHash('sha256').update(Buffer.from(imageBytes.dataBase64,'base64')).digest('hex'))
 assert.notEqual(imageBytes.sha256,image.sha256)
})

test('withdraw 幂等：行不删、withdrawnAt 非空、再撤一次回同一行',async()=>{
 const {owner,group,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group))
 const withdrawn=await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:saved.attachmentId})
 assert.equal(withdrawn.state,'withdrawn')
 assert.ok(withdrawn.withdrawnAt)
 assert.deepEqual(await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:saved.attachmentId}),withdrawn)
 assert.equal((await pool.query('select count(*) as count from teloa_attachments where owner_id=$1 and attachment_id=$2',[owner,saved.attachmentId])).rows[0].count,'1')
})

test('撤回后重传同一份字节即复活：回同一行、state 回 active、可再被引用',async()=>{
 const {owner,group,groups,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group))
 const neighbour=await attachments.upload(owner,upload(group,{dataBase64:base64('同群的另一件\n')}))
 await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:saved.attachmentId})
 const second=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'复活群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[]}})
 const revived=await attachments.upload(owner,upload(second))
 assert.equal(revived.attachmentId,saved.attachmentId)
 assert.equal(revived.state,'active')
 assert.equal(revived.withdrawnAt,null)
 assert.equal(revived.version,1)
 // 复活按这次上传刷新归类与时间：侧栏要把它算进重传所在的群，并排到那个群的最前。
 assert.equal(revived.uploadedInGroupId,second.id)
 assert.ok(Date.parse(revived.createdAt)>Date.parse(saved.createdAt))
 assert.ok(Date.parse(revived.createdAt)>Date.parse(neighbour.createdAt))
 assert.deepEqual((await attachments.list(owner,{groupId:second.id})).map(item=>item.attachmentId),[revived.attachmentId])
 // 原群只剩没被撤回的那件：复活把归类搬走了。
 assert.deepEqual((await attachments.list(owner,{groupId:group.id})).map(item=>item.attachmentId),[neighbour.attachmentId])
 // name 与 mime 是首次落盘时宿主给的事实，复活有意不刷新。
 assert.equal(revived.name,saved.name)
 assert.equal(revived.mime,saved.mime)
 assert.equal((await pool.query('select count(*) as count from teloa_attachments where owner_id=$1',[owner])).rows[0].count,'2')
 // 复活后 T6 的引用判据与 read 都重新放行——字节自始至终没删过。
 const client=await pool.connect()
 try{assert.deepEqual(await readActiveAttachment(client,owner,saved.attachmentId),revived)}finally{client.release()}
 assert.deepEqual(Buffer.from((await attachments.read(owner,{attachmentId:saved.attachmentId})).dataBase64,'base64'),Buffer.from('# 验收说明\n'))
})

test('撤回后不重传：read 仍判 forbidden，引用判据仍不放行',async()=>{
 const {owner,group,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group))
 await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:saved.attachmentId})
 await assert.rejects(attachments.read(owner,{attachmentId:saved.attachmentId}),{code:'teloa/forbidden',message:'附件不存在、已撤回或不属于当前本人。'})
 const client=await pool.connect()
 try{assert.equal(await readActiveAttachment(client,owner,saved.attachmentId),undefined)}finally{client.release()}
})

test('list 只回本群的在用附件，撤回后不再出现',async()=>{
 const {owner,group,groups,attachments}=await fixture()
 const other=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'别的群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[]}})
 const mine=await attachments.upload(owner,upload(group))
 await attachments.upload(owner,upload(other,{dataBase64:base64('别的群的文件\n')}))
 assert.deepEqual((await attachments.list(owner,{groupId:group.id})).map(item=>item.attachmentId),[mine.attachmentId])
 await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:mine.attachmentId})
 assert.deepEqual(await attachments.list(owner,{groupId:group.id}),[])
 await assert.rejects(attachments.list(randomUUID(),{groupId:group.id}),{code:'teloa/forbidden'})
})

test('行被改坏后读出 teloa/storage-corrupt',async()=>{
 const {owner,group,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group))
 // state 与 sha256 都有表级判据挡着改不脏，mime 没有，用它当损坏锚。
 await pool.query("update teloa_attachments set mime='' where owner_id=$1 and attachment_id=$2",[owner,saved.attachmentId])
 await assert.rejects(attachments.read(owner,{attachmentId:saved.attachmentId}),{code:'teloa/storage-corrupt'})
 await assert.rejects(attachments.list(owner,{groupId:group.id}),{code:'teloa/storage-corrupt'})
})

test('readActiveAttachment 只认本人在用的原件，撤回后回 undefined',async()=>{
 const {owner,group,attachments}=await fixture()
 const saved=await attachments.upload(owner,upload(group))
 const client=await pool.connect()
 try{
  assert.deepEqual(await readActiveAttachment(client,owner,saved.attachmentId),saved)
  assert.equal(await readActiveAttachment(client,randomUUID(),saved.attachmentId),undefined)
 }finally{client.release()}
 await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:saved.attachmentId})
 const after=await pool.connect()
 try{assert.equal(await readActiveAttachment(after,owner,saved.attachmentId),undefined)}finally{after.release()}
})

test('并发：两条同 requestId 同内容的上传只落一行',async()=>{
 const {owner,group,attachments}=await fixture()
 const input=upload(group)
 const [first,second]=await Promise.all([attachments.upload(owner,{...input}),attachments.upload(owner,{...input})])
 assert.deepEqual(second,first)
 assert.equal((await pool.query('select count(*) as count from teloa_attachments where owner_id=$1',[owner])).rows[0].count,'1')
})

test('并发：两条不同 requestId 同字节的上传都不抛，仍只落一行，各自有回执',async()=>{
 const {owner,group,attachments}=await fixture()
 const content=base64('并发同字节\n')
 const [first,second]=await Promise.all([
  attachments.upload(owner,upload(group,{dataBase64:content})),
  attachments.upload(owner,upload(group,{dataBase64:content}))
 ])
 assert.equal(second.attachmentId,first.attachmentId)
 assert.equal((await pool.query('select count(*) as count from teloa_attachments where owner_id=$1',[owner])).rows[0].count,'1')
 // 去重命中的那一次也要留回执，否则它的 requestId 重放会绕过幂等再判一次总量。
 assert.equal((await pool.query('select count(*) as count from teloa_attachment_requests where owner_id=$1',[owner])).rows[0].count,'2')
})

test('去重命中在用行的那一次也可按 requestId 重放，回同一结果',async()=>{
 const {owner,group,attachments}=await fixture()
 await attachments.upload(owner,upload(group))
 const again=upload(group)
 const deduped=await attachments.upload(owner,again)
 assert.deepEqual(await attachments.upload(owner,{...again}),deduped)
 await assert.rejects(attachments.upload(owner,{...again,dataBase64:base64('换了内容\n')}),{code:'teloa/conflict'})
})

test('近上限时重传已有的同一份文件不判 conflict，换新内容才判',async()=>{
 const {owner,group,attachments}=await fixture()
 const content=base64(Buffer.alloc(1024,7))
 const saved=await attachments.upload(owner,upload(group,{dataBase64:content}))
 await pool.query("insert into teloa_attachments(attachment_id,owner_id,version,request_id,request_spec,kind,mime,bytes,sha256,name,uploaded_in_group_id,state,created_at) values($1,$2,1,$3,'{}'::jsonb,'file','application/pdf',$4,$5,'占位.pdf',$6,'active',$7)",['sha256:'+'d'.repeat(64),owner,randomUUID(),groupAttachmentTotalBytes-1024-1,'a'.repeat(64),group.id,identity.now()])
 // 在用总量已是上限减一：重传已有的那份不新增字节，不该被闸挡住。
 assert.equal((await attachments.upload(owner,upload(group,{dataBase64:content}))).attachmentId,saved.attachmentId)
 await assert.rejects(attachments.upload(owner,upload(group,{dataBase64:base64(Buffer.alloc(1024,9))})),{code:'teloa/conflict'})
})

test('读回的字节与记录对不上判 teloa/storage-corrupt：等长脏字节也要拦住',async()=>{
 const ports=stubPorts({async readBytes(row:{bytes:number}){return new Uint8Array(Buffer.alloc(row.bytes,1))}})
 const {owner,group,attachments}=await fixture(ports)
 const saved=await attachments.upload(owner,upload(group))
 await assert.rejects(attachments.read(owner,{attachmentId:saved.attachmentId}),{code:'teloa/storage-corrupt'})
})

test('端口报附件不可读时原样透传 teloa/source-unavailable，不改判成别的码',async()=>{
 const ports=stubPorts({async readBytes(){throw new WorkError('teloa/source-unavailable','附件内容已不可读取。')}})
 const {owner,group,attachments}=await fixture(ports)
 const saved=await attachments.upload(owner,upload(group))
 await assert.rejects(attachments.read(owner,{attachmentId:saved.attachmentId}),{code:'teloa/source-unavailable',message:'附件内容已不可读取。'})
})
