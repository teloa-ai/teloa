import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachmentBase64,
  attachmentName,
  groupAttachmentExtensions,
  groupAttachmentFileMediaTypes,
  groupAttachmentImageMediaTypes,
  groupAttachmentFileMaxBytes,
  groupAttachmentImageMaxBytes,
  groupAttachmentMaxBytes,
  groupAttachmentMaxBytesFor,
  groupAttachmentTotalBytes,
  groupAttachmentUploadMaxBodyBytes,
  groupAttachmentUploadRoutePath,
  groupAttachmentListInput,
  groupAttachmentReadInput,
  groupAttachmentUploadInput,
  groupAttachmentWithdrawInput,
  isGroupAttachment,
  isGroupAttachmentBytes,
} from '../src/group-attachments.ts'

const requestId='22222222-2222-4222-8222-222222222222'
const groupId='11111111-1111-4111-8111-111111111111'
const ownerId='local:owner'
const attachmentId='attachment-1'
const createdAt='2026-09-21T00:00:00.000Z'
const sha256='a'.repeat(64)

const base64Of=(bytes:number)=>Buffer.alloc(bytes,'a').toString('base64')

const uploadFields=(overrides:Partial<Record<'requestId'|'groupId'|'expectedVersion'|'mime'|'name'|'dataBase64',unknown>>={})=>({
  requestId,groupId,expectedVersion:1,mime:'application/pdf',name:'x.pdf',dataBase64:base64Of(3),...overrides,
})

test('groupAttachmentImageMediaTypes 不含 image/gif，image/gif 只落在文件白名单里（编排者裁定 1）',()=>{
  assert.equal((groupAttachmentImageMediaTypes as readonly string[]).includes('image/gif'),false)
  assert.equal((groupAttachmentFileMediaTypes as readonly string[]).includes('image/gif'),true)
})

test('isMessageReference 依赖的 attachmentBase64 八条边界：空、非四倍数、非法字符、=在中间、三个等号、解码±1、正例',()=>{
  assert.throws(()=>attachmentBase64('',3),/群/)
  assert.throws(()=>attachmentBase64('YWJ',3),/群/)
  assert.throws(()=>attachmentBase64('Y!Jj',3),/群/)
  assert.throws(()=>attachmentBase64('Y=Jj',1),/群/)
  assert.throws(()=>attachmentBase64('Y===',1),/群/)
  // 声明 2 字节，实际内容解码为 3 字节（+1）。
  assert.throws(()=>attachmentBase64('YWJj',2),/群/)
  // 声明 3 字节，实际内容因末尾 1 个填充只解码出 2 字节（-1）。
  assert.throws(()=>attachmentBase64('YWI=',3),/群/)
  assert.equal(attachmentBase64('YWJj',3),'YWJj')
})

test('attachmentName：越界拒绝、去斜杠、去单个前导点、剔除控制字符、超长按扩展名截断、全控制字符拒绝',()=>{
  assert.throws(()=>attachmentName('../../etc/passwd'),/群/)
  assert.equal(attachmentName('a/b.png'),'ab.png')
  assert.equal(attachmentName('.hidden.md'),'hidden.md')
  assert.equal(attachmentName('ab\x00c.txt'),'abc.txt')
  const longName='a'.repeat(127)+'.md'
  assert.equal(longName.length,130)
  const truncated=attachmentName(longName)
  assert.equal(truncated.length<=120,true)
  assert.equal(truncated.endsWith('.md'),true)
  assert.throws(()=>attachmentName('\x00\x01\x02'),/群/)
})

test('groupAttachmentUploadInput：未知键拒、白名单外 MIME 拒、扩展名与 MIME 不一致拒、大小写扩展名过、图片 8 MiB 整过、9 MiB 拒',()=>{
  assert.throws(()=>groupAttachmentUploadInput({...uploadFields(),extra:'forged'}),/群/)
  for(const mime of ['image/svg+xml','application/zip','text/html'])
    assert.throws(()=>groupAttachmentUploadInput(uploadFields({mime,name:'x.bin'})),/群/)
  // 格式验收.jpg 改名成 x.png 上传：真实内容仍是 jpeg，声明的扩展名与 MIME 不一致 → 拒。
  assert.throws(()=>groupAttachmentUploadInput(uploadFields({mime:'image/jpeg',name:'x.png'})),/群/)
  const jpeg=groupAttachmentUploadInput(uploadFields({mime:'image/jpeg',name:'x.JPEG'}))
  assert.equal(jpeg.name,'x.JPEG')
  const exact=groupAttachmentUploadInput(uploadFields({mime:'image/png',name:'x.png',dataBase64:base64Of(groupAttachmentImageMaxBytes)}))
  assert.equal(exact.dataBase64.length,base64Of(groupAttachmentImageMaxBytes).length)
  assert.throws(()=>groupAttachmentUploadInput(uploadFields({mime:'image/png',name:'x.png',dataBase64:base64Of(groupAttachmentImageMaxBytes+1024*1024)})),/群/)
})

test('单件上限按类型分两档：图片 8 MiB、文件 16 MiB（GIF 走文件档），总量 512 MiB 不变；旧名是图片档的别名',()=>{
  assert.equal(groupAttachmentImageMaxBytes,8*1024*1024)
  assert.equal(groupAttachmentFileMaxBytes,16*1024*1024)
  assert.equal(groupAttachmentMaxBytes,groupAttachmentImageMaxBytes)
  assert.equal(groupAttachmentTotalBytes,512*1024*1024)
  for(const mime of groupAttachmentImageMediaTypes)assert.equal(groupAttachmentMaxBytesFor(mime),groupAttachmentImageMaxBytes,mime)
  for(const mime of groupAttachmentFileMediaTypes)assert.equal(groupAttachmentMaxBytesFor(mime),groupAttachmentFileMaxBytes,mime)
})

test('groupAttachmentUploadInput 按 MIME 判单件上限：PDF 16 MiB 整过、多 1 字节拒；PNG 多 1 字节拒；GIF 走文件档；9 MiB 文本过',()=>{
  const pdf=groupAttachmentUploadInput(uploadFields({dataBase64:base64Of(groupAttachmentFileMaxBytes)}))
  assert.equal(pdf.dataBase64.length,base64Of(groupAttachmentFileMaxBytes).length)
  assert.throws(()=>groupAttachmentUploadInput(uploadFields({dataBase64:base64Of(groupAttachmentFileMaxBytes+1)})),/群/)
  assert.throws(()=>groupAttachmentUploadInput(uploadFields({mime:'image/png',name:'x.png',dataBase64:base64Of(groupAttachmentImageMaxBytes+1)})),/群/)
  for(const mime of ['image/jpeg','image/webp'])assert.throws(()=>groupAttachmentUploadInput(uploadFields({mime,name:mime==='image/jpeg'?'x.jpg':'x.webp',dataBase64:base64Of(groupAttachmentImageMaxBytes+1)})),/群/,mime)
  assert.equal(groupAttachmentUploadInput(uploadFields({mime:'image/gif',name:'x.gif',dataBase64:base64Of(groupAttachmentFileMaxBytes)})).mime,'image/gif')
  assert.throws(()=>groupAttachmentUploadInput(uploadFields({mime:'image/gif',name:'x.gif',dataBase64:base64Of(groupAttachmentFileMaxBytes+1)})),/群/)
  assert.equal(groupAttachmentUploadInput(uploadFields({mime:'text/plain',name:'x.txt',dataBase64:base64Of(9*1024*1024)})).mime,'text/plain')
})

test('MIME 白名单只认自有键：constructor／toString 这类原型键判 invalid-input，不抛 TypeError（审查 L1）',()=>{
  for(const mime of ['constructor','toString','__proto__','hasOwnProperty'])
    assert.throws(()=>groupAttachmentUploadInput(uploadFields({mime,name:'x.pdf'})),(error:{code?:string})=>error.code==='teloa/invalid-input',mime)
})

test('上传专用路由：路径在 /api 之下且以端点名结尾；请求体上限 = 满额文件档的 base64 长度＋64 KiB 字段余量（审查 M1）',()=>{
  assert.equal(groupAttachmentUploadRoutePath,'/api/teloa/groups/attachments/upload')
  assert.equal(groupAttachmentUploadMaxBodyBytes,4*Math.ceil(groupAttachmentFileMaxBytes/3)+64*1024)
  const envelope=JSON.stringify(uploadFields({name:'文'.repeat(120)+'.pdf',dataBase64:base64Of(groupAttachmentFileMaxBytes)}))
  assert.ok(Buffer.byteLength(envelope)<=groupAttachmentUploadMaxBodyBytes,'满额合法请求必须装得下')
})

test('groupAttachmentListInput／groupAttachmentReadInput／groupAttachmentWithdrawInput 拒未知字段与伪造身份',()=>{
  assert.deepEqual(groupAttachmentListInput({groupId}),{groupId})
  assert.throws(()=>groupAttachmentListInput({groupId,ownerId:'forged'}),/群/)
  assert.deepEqual(groupAttachmentReadInput({attachmentId}),{attachmentId})
  assert.throws(()=>groupAttachmentReadInput({attachmentId:'blob:forged'}),/群/)
  assert.deepEqual(groupAttachmentWithdrawInput({requestId,attachmentId}),{requestId,attachmentId})
  assert.throws(()=>groupAttachmentWithdrawInput({requestId,attachmentId,groupId}),/群/)
})

const attachment=(overrides:Partial<Record<string,unknown>>={})=>({
  attachmentId,ownerId,version:1 as const,kind:'file' as const,mime:'application/pdf',bytes:3,sha256,name:'x.pdf',width:null,height:null,uploadedInGroupId:null,state:'active' as const,createdAt,withdrawnAt:null,...overrides,
})

test('isGroupAttachment 14 键正反例；image 缺 width/height 判假；withdrawn 缺 withdrawnAt 判假；version!==1 判假',()=>{
  assert.equal(isGroupAttachment(attachment()),true)
  assert.equal(isGroupAttachment({...attachment(),extra:'forged'}),false)
  assert.equal(isGroupAttachment({...attachment(),kind:'image',mime:'image/png',width:null,height:null}),false)
  assert.equal(isGroupAttachment({...attachment(),kind:'image',mime:'image/png',width:10,height:10}),true)
  assert.equal(isGroupAttachment({...attachment(),state:'withdrawn',withdrawnAt:null}),false)
  assert.equal(isGroupAttachment({...attachment(),state:'withdrawn',withdrawnAt:createdAt}),true)
  assert.equal(isGroupAttachment({...attachment(),version:2}),false)
})

test('isGroupAttachmentBytes 7 键正反例，dataBase64 必须与 bytes 一致',()=>{
  const bytes={attachmentId,version:1 as const,mime:'application/pdf',bytes:3,sha256,name:'x.pdf',dataBase64:'YWJj'}
  assert.equal(isGroupAttachmentBytes(bytes),true)
  assert.equal(isGroupAttachmentBytes({...bytes,extra:'forged'}),false)
  assert.equal(isGroupAttachmentBytes({...bytes,version:2}),false)
  assert.equal(isGroupAttachmentBytes({...bytes,dataBase64:'YWJjZA=='}),false)
})

test('groupAttachmentExtensions 只含九个白名单 MIME，与图片＋文件两个集合的并集一致',()=>{
  const combined=[...groupAttachmentImageMediaTypes,...groupAttachmentFileMediaTypes]
  assert.deepEqual(Object.keys(groupAttachmentExtensions).sort(),[...combined].sort())
})
