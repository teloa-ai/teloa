import assert from 'node:assert/strict'
import test from 'node:test'
const {stripCredentialEnv}=await import('../../../scripts/runtime/credential-env.mjs') as any

test('剔除凭据形变量与带口令 URL，保留 _FILE、钥匙串与 SSH 代理变量',()=>{
 const {env,removed}=stripCredentialEnv({PATH:'/bin',DEEPSEEK_API_KEY:'x',GITHUB_TOKEN:'y',DATABASE_URL:'postgres://u:p@h/db',PLAIN_URL:'https://example.com',DEEPSEEK_API_KEY_FILE:'/run/k',TELOA_CREDENTIALS_KEY_FILE:'/run/m',SSH_AUTH_SOCK:'/tmp/s',XAUTHORITY:'/x',NPM_CONFIG__AUTH:'z'})
 assert.deepEqual(removed,['DATABASE_URL','DEEPSEEK_API_KEY','GITHUB_TOKEN','NPM_CONFIG__AUTH'])
 assert.deepEqual(Object.keys(env).sort(),['DEEPSEEK_API_KEY_FILE','PATH','PLAIN_URL','SSH_AUTH_SOCK','TELOA_CREDENTIALS_KEY_FILE','XAUTHORITY'])
})

test('名字按 _ 分段整段匹配：OAUTH、KEYBOARD、PWD 不误剔，AWS_SECRET_ACCESS_KEY、npm_config__authToken 照剔',()=>{
 const {env,removed}=stripCredentialEnv({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_OAUTH_PUBLIC_CALLBACK_URL:'http://127.0.0.1:3100/oauth/callback',KEYBOARD_LAYOUT:'us',PWD:'/w',MONKEY_MODE:'1',AWS_SECRET_ACCESS_KEY:'s',npm_config__authToken:'t',TELOA_SECURITY_ACTION_TOKEN:'u',TELOA_CREDENTIALS_KEYRING:'off',TELOA_CREDENTIALS_KEY_DIR:'/k',TELOA_CREDENTIALS_STORE:'auto',CREDENTIALS_DIRECTORY:'/c'})
 assert.deepEqual(removed,['AWS_SECRET_ACCESS_KEY','TELOA_SECURITY_ACTION_TOKEN','npm_config__authToken'])
 for(const name of ['TELOA_OAUTH_PUBLIC_CALLBACK_URL','KEYBOARD_LAYOUT','PWD','MONKEY_MODE','TELOA_CREDENTIALS_KEYRING','TELOA_CREDENTIALS_KEY_DIR','TELOA_CREDENTIALS_STORE','CREDENTIALS_DIRECTORY'])assert.ok(name in env,name)
})

test('验收开关只随浏览器验收宿主透传：正式启动（含容器强制 acceptance:false）一律丢弃',()=>{
 const source={PATH:'/bin',TELOA_CREDENTIALS_KEYRING:'off',TELOA_CREDENTIALS_KEY_DIR:'/k',TELOA_CREDENTIALS_STORE:'file'}
 for(const {env,removed} of [stripCredentialEnv(source),stripCredentialEnv({...source,TELOA_BROWSER_ACCEPTANCE:'1'},{acceptance:false})]){
  assert.equal(env.TELOA_CREDENTIALS_KEYRING,undefined);assert.equal(env.TELOA_CREDENTIALS_KEY_DIR,undefined)
  assert.equal(env.TELOA_CREDENTIALS_STORE,'file');assert.deepEqual(removed,[])
 }
})

test('剔除警告只列变量名；IM 通道凭据另给一条设置页提示',async t=>{
 const {warnRemoved}=await import('../../../scripts/runtime/credential-env.mjs')
 const lines:string[]=[],warn=t.mock.method(console,'warn',(line:string)=>{lines.push(line)})
 warnRemoved([],['SLACK_BOT_TOKEN']);assert.equal(warn.mock.callCount(),0)
 warnRemoved(['DEEPSEEK_API_KEY'],['SLACK_BOT_TOKEN']);assert.equal(lines.length,1)
 warnRemoved(['FEISHU_APP_SECRET','SLACK_BOT_TOKEN'],['FEISHU_APP_SECRET','SLACK_BOT_TOKEN'])
 assert.equal(lines.length,3);assert.match(lines[2]!,/FEISHU_APP_SECRET, SLACK_BOT_TOKEN.*IM 通道/)
})

test('带口令 URL 用户名段可空（redis://:口令@host）；带口令的代理另给一行提示',async t=>{
 const {warnRemoved}=await import('../../../scripts/runtime/credential-env.mjs')
 const {removed,env}=stripCredentialEnv({CACHE_URL:'redis://:p4ss@cache:6379/0',HTTPS_PROXY:'http://u:p@proxy:8080',HTTP_PROXY:'http://proxy:8080',PLAIN:'redis://cache:6379'})
 assert.deepEqual(removed,['CACHE_URL','HTTPS_PROXY']);assert.equal(env.HTTP_PROXY,'http://proxy:8080');assert.equal(env.PLAIN,'redis://cache:6379')
 const lines:string[]=[];t.mock.method(console,'warn',(line:string)=>{lines.push(line)})
 warnRemoved(removed,[])
 assert.equal(lines.length,2);assert.match(lines[1]!,/HTTPS_PROXY.*代理/);assert.ok(!lines.join('').includes('p4ss'))
})

test('容器入口：剔除后保留名单并打印一次性提示（含 IM 键），子进程只拿剔除后的环境',async()=>{
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../../../scripts/启动容器.mjs',import.meta.url),'utf8')
 assert.match(source,/const stripped=stripCredentialEnv\(process\.env,\{acceptance:false\}\)/)
 assert.match(source,/warnRemoved\(stripped\.removed,Object\.values\(imCredentialFields\)\.flat\(\)\.map\(field=>field\.key\)\)/)
 assert.match(source,/env:\{TELOA_USAGE_STATS:'on',TELOA_MARKET_REMOTE:'on',\.\.\.stripped\.env\}/)
 assert.ok(source.indexOf('warnRemoved(stripped.removed')<source.indexOf("spawn(process.execPath,['scripts/启动DSH.mjs']"))
})
