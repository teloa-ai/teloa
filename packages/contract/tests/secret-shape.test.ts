import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {detectSecrets,encodedForms,isSecretRejection,promptSecretMessage,redactSecrets,secretKindsIn} from '../src/secret-shape.ts'

const rand=(n:number)=>{let out='';while(out.length<n)out+=randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g,'');return out.slice(0,n)}
const positives:[string,string][]=[
 ['openai','sk-'+'proj-'+rand(40)],
 ['anthropic','sk-'+'ant-'+'api03-'+rand(80)],
 ['github','gh'+'p_'+rand(36)],
 ['github','github'+'_pat_'+rand(60)],
 ['gitlab','gl'+'pat-'+rand(20)],
 ['slack','xo'+'xb-'+rand(24)],
 ['aws','AK'+'IA'+rand(16).toUpperCase().replace(/[^A-Z0-9]/g,'Q')],
 ['google','AI'+'za'+rand(35)],
 ['xai','xa'+'i-'+rand(40)],
 ['bearer','Authorization: Bearer '+rand(40)],
 ['jwt','ey'+'J'+rand(20)+'.ey'+'J'+rand(30)+'.'+rand(30)],
 ['private-key','-----BEGIN '+'OPENSSH PRIVATE KEY-----\n'+rand(64)+'\n-----END OPENSSH PRIVATE KEY-----'],
 ['assignment','api_key = "'+rand(32)+'"'],
]
const negatives=[
 createHash('sha1').update('x').digest('hex'),
 createHash('sha256').update('x').digest('hex'),
 randomUUID(),
 'data:image/png;base64,'+randomBytes(3000).toString('base64'),
 'sk-'+'x'.repeat(40),
 'sk-your-api-key-here-xxxxxxxxxxxxxxxx',
 '请把风险评估框架 risk-assessment-framework-2026 发给我',
 'https://example.com/a/b/c?page=2&sort=desc',
 'password = "changeme"',
 'task-'+rand(30),
]

test('已知前缀且随机度够高时按类别报出，不带命中值',()=>{
 for(const [kind,sample] of positives){
  const found=detectSecrets('前文 '+sample+' 后文')
  assert.equal(found.length,1,kind)
  assert.equal(found[0]!.kind,kind)
  assert.deepEqual(Object.keys(found[0]!).sort(),['end','kind','start'])
 }
})

test('误报语料：SHA、UUID、base64 图片、占位符、普通文本都不报',()=>{
 for(const sample of negatives)assert.deepEqual(detectSecrets(sample),[],sample.slice(0,40))
})

test('与已存值精确比对，短于 8 的已存值忽略',()=>{
 const stored=rand(24)
 assert.deepEqual(detectSecrets('值是 '+stored+' 。',[stored]).map(item=>item.kind),['stored'])
 assert.deepEqual(detectSecrets('abc1234',['abc1234']),[])
})

test('脱敏覆盖已存值的原文、base64、base64url、十六进制、URL 编码、JSON 转义形态',()=>{
 const stored='k/'+rand(20)+'+"q'
 for(const form of encodedForms(stored)){
  const out=redactSecrets('x '+form+' y',[stored])
  assert.equal(out,'x [已隐藏] y',form)
 }
 assert.ok(encodedForms(stored).includes(Buffer.from(stored).toString('hex').toUpperCase()))
})

test('重叠命中合并，脱敏后不残留前后缀',()=>{
 const token=rand(40),text='Bearer sk-'+'proj-'+token
 assert.equal(redactSecrets(text),'[已隐藏]')
})

test('secretKindsIn 去重，提示文案只含类别不含值',()=>{
 const stored=rand(30)
 const kinds=secretKindsIn(['gh'+'p_'+rand(36),stored,'gh'+'o_'+rand(36)],[stored])
 assert.deepEqual(kinds,['github','stored'])
 const message=promptSecretMessage(kinds)
 assert.match(message,/GitHub/);assert.match(message,/已保存的凭据/);assert.ok(!message.includes(stored))
 assert.match(promptSecretMessage([]),/无法完成密钥检查/)
})

test('isSecretRejection 识别两种拒收，不误认其他错误',()=>{
 assert.equal(isSecretRejection({code:'teloa/invalid-input',details:{reason:'secret-in-message'}}),true)
 assert.equal(isSecretRejection({code:'gateway/bad-request',message:promptSecretMessage(['github'])}),true)
 assert.equal(isSecretRejection({code:'gateway/bad-request',message:promptSecretMessage([])}),true)
 assert.equal(isSecretRejection({code:'gateway/bad-request',message:'bad'}),false)
 assert.equal(isSecretRejection(new Error('x')),false);assert.equal(isSecretRejection(undefined),false)
})

test('误报语料：代码片段里引用变量、成员表达式、常量名与 .env 空模板不报；slug、CSS 类名、占位符不按 OpenAI 报',()=>{
 const samples=[
  'const client=new OpenAI({apiKey: process.env.OPENAI_API_KEY})',
  "model=getModel('openrouter',{apiKey: process.env.OPENROUTER_API_KEY})",
  'api_key=settings.OPENAI_API_KEY_VALUE',
  'password=args.password_from_cli',
  'secret: config.sessionSecretFromEnv',
  'access_token = refreshedAccessToken.token',
  'const password = entry.getPassword()',
  "const secret=entry.connector.auth.kind==='oauth'?a:b",
  'api_key = OPENAI_API_KEY_FROM_ENVIRONMENT',
  'API_KEY=\nSECRET=\nPASSWORD=changeme',
  'sk-your-openai-api-key-here',
  'https://news.example.com/sk-hynix-semiconductor-earnings-2026',
  '<button class="sk-button-primary-large-rounded">',
 ]
 for(const sample of samples)assert.deepEqual(detectSecrets(sample),[],sample)
})

test('调整误报后真实形态检出不降：OpenAI 各前缀与字面量赋值逐个命中',()=>{
 for(let i=0;i<500;i++){
  for(const prefix of ['sk-','sk-'+'proj-','sk-'+'svcacct-','sk-'+'admin-'])assert.deepEqual(detectSecrets('key '+prefix+rand(40+i%20)).map(item=>item.kind),['openai'],prefix)
  assert.deepEqual(detectSecrets('api_key = "'+rand(32)+'"').map(item=>item.kind),['assignment'])
  assert.deepEqual(detectSecrets("password: '"+rand(24)+"'").map(item=>item.kind),['assignment'])
 }
 assert.deepEqual(detectSecrets('OPENAI_API_KEY='+'sk-'+'proj-'+rand(48)).map(item=>item.kind),['openai'])
})

test('全大写字母数字的字面量密钥照常检出（≥99%），只有不含数字的常量名与成员表达式按引用跳过',()=>{
 const upper=(n:number)=>{const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';return Array.from(randomBytes(n),byte=>chars[byte%36]).join('')}
 let hit=0
 const total=2000
 for(let i=0;i<total;i++)if(detectSecrets('password='+upper(24)).some(item=>item.kind==='assignment'))hit++
 assert.ok(hit/total>=0.99,'检出率 '+(hit/total))
 for(const sample of ['api_key=OPENAI_API_KEY_FROM_ENVIRONMENT','secret: process.env.SESSION_SECRET_VALUE','password=config.databasePasswordFromEnv'])assert.deepEqual(detectSecrets(sample),[],sample)
 assert.deepEqual(detectSecrets('secret=cfg.k8sTokenAb12Cd34Ef56Gh').map(item=>item.kind),['assignment'],'成员表达式里含数字按候选检测')
})

test('encodedForms 含 JSON \\/ 转义形态',()=>{
 const value='xai-'+'aBcDeF/ghIJ+kLmNoP0123'
 assert.ok(encodedForms(value).includes(JSON.stringify(value).slice(1,-1).replace(/\//g,'\\/')))
 assert.doesNotMatch(redactSecrets(JSON.stringify({u:value}).replace(/\//g,'\\/'),[value]),/aBcDeF/)
})
