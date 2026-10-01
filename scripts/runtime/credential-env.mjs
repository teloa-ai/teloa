/**
 * 宿主子进程环境剔除凭据形变量（规格 §4 启动器）；只返回被剔除的变量名，不输出值。
 * 名字按 `_` 分段（段内再按 camelCase 切开），整段命中才剔：`TELOA_OAUTH_PUBLIC_CALLBACK_URL`、`KEYBOARD_LAYOUT`、`PWD` 不误剔。
 * 凭据验收开关（`TELOA_CREDENTIALS_KEYRING`、`TELOA_CREDENTIALS_KEY_DIR`）只随浏览器验收宿主透传，正式启动一律丢弃；
 * 容器是正式部署，调用方传 `{acceptance:false}` 强制丢弃。
 */
const credentialSegment=/^(?:KEY|KEYS|APIKEY|PASSWORD|PASSWD|SECRET|SECRETS|TOKEN|TOKENS|CREDENTIAL|CREDENTIALS|PASSPHRASE|AUTH|AUTHTOKEN|COOKIE)$/
const keepName=/^(?:TELOA_CREDENTIALS_(?:KEY_FILE|STORE|KEYRING|KEY_DIR)|CREDENTIALS_DIRECTORY|SSH_AUTH_SOCK|XAUTHORITY|[A-Za-z][A-Za-z0-9_]*_FILE)$/
const acceptanceSwitch=/^TELOA_CREDENTIALS_(?:KEYRING|KEY_DIR)$/
// 用户名段可空：`redis://:口令@host` 同样算带口令 URL。
const passwordUrl=/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i
const proxyName=/^(?:https?|all|no)_proxy$/i
const credentialName=name=>name.split('_').flatMap(part=>part.replace(/([a-z0-9])([A-Z])/g,'$1_$2').split('_')).some(segment=>credentialSegment.test(segment.toUpperCase()))
export function stripCredentialEnv(source,{acceptance=source.TELOA_BROWSER_ACCEPTANCE==='1'}={}){
 const env={},removed=[]
 for(const [name,value] of Object.entries(source)){
  if(value===undefined)continue
  if(acceptanceSwitch.test(name)&&!acceptance)continue
  if(!keepName.test(name)&&(credentialName(name)||passwordUrl.test(value))){removed.push(name);continue}
  env[name]=value
 }
 return {env,removed:removed.sort()}
}
/**
 * 每次启动打印一次，只含变量名：总提示一行；IM 通道凭据（从来只读设置页保存的记录，环境变量与 `_FILE` 都不生效）、
 * 带口令的代理地址（没有 `_FILE` 形式）各另加一行。`imKeys`：IM 渠道凭据键名（契约 imCredentialFields），由调用方传入。
 */
export function warnRemoved(removed,imKeys=[]){
 if(!removed.length)return
 console.warn('已从宿主环境剔除凭据形变量：'+removed.join(', ')+'。请改在设置中录入，或用 <变量名>_FILE 指向密钥文件。')
 const im=removed.filter(name=>imKeys.includes(name))
 if(im.length)console.warn('其中 '+im.join(', ')+' 是 IM 通道凭据：它们只能在「设置 > IM 通道」中保存，环境变量与 _FILE 均不生效。')
 const proxies=removed.filter(name=>proxyName.test(name))
 if(proxies.length)console.warn('其中 '+proxies.join(', ')+' 是带口令的代理地址，没有 _FILE 形式：请改用无需口令的本机代理转发。')
}
