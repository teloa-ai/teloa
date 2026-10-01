/**
 * 凭据形态检测与脱敏（规格 2026-09-26-凭据存储加固 §5）。只按「已知前缀 + 主体随机度」判定，
 * 再与已存凭据值精确比对；不单凭高熵报警，以免误伤 git SHA、UUID、sha256 与 base64 图片。
 * 结果只含类别与位置，不回传命中值。脱敏不是安全边界：拼接、截断、自定义编码都能绕过。
 */
export type SecretKind='private-key'|'anthropic'|'openai'|'github'|'gitlab'|'slack'|'aws'|'google'|'xai'|'jwt'|'bearer'|'assignment'|'stored'
export type SecretFinding={kind:SecretKind;start:number;end:number}

type Rule={kind:SecretKind;pattern:RegExp;minEntropy:number;skip?:(body:string)=>boolean}
/**
 * 值是明确的引用而不是字面量时跳过：不含数字的成员表达式（`process.env.X`、`config.sessionSecret`）或不含数字的常量名（`OPENAI_API_KEY`）。
 * 含数字的一律仍按候选检测：随机的全大写字母数字密钥几乎必含数字（24 位不含数字的概率约 0.04%）。尾随 `=` 是比较运算符的残留。
 */
const reference=(body:string)=>{const value=body.replace(/=+$/,'');return /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)+$/.test(value)||/^[A-Z][A-Z_]*$/.test(value)}
/** 第 1 捕获组是判随机度的主体；顺序即同起点时的优先级（anthropic 先于 openai）。 */
const rules:readonly Rule[]=[
 {kind:'private-key',pattern:/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,minEntropy:0},
 {kind:'anthropic',pattern:/\bsk-ant-(?:[a-z]+\d{2}-)?([A-Za-z0-9_-]{20,})/g,minEntropy:3},
 // 真实键主体是大小写混合的 base62；只有单一大小写的 slug、CSS 类名、占位符不报。
 {kind:'openai',pattern:/\bsk-(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{20,})/g,minEntropy:3,skip:body=>!/[a-z]/.test(body)||!/[A-Z]/.test(body)},
 {kind:'github',pattern:/\b(?:gh[pousr]_|github_pat_)([A-Za-z0-9_]{22,})/g,minEntropy:3},
 {kind:'gitlab',pattern:/\bglpat-([A-Za-z0-9_-]{20,})/g,minEntropy:3},
 {kind:'slack',pattern:/\bxox[baprs]-([A-Za-z0-9-]{10,})/g,minEntropy:3},
 {kind:'aws',pattern:/\b(?:AKIA|ASIA)([0-9A-Z]{16})\b/g,minEntropy:2.5}, // 主体仅 16 位（base32），阈值 3 会漏掉约 0.3% 的真实键
 {kind:'google',pattern:/\bAIza([0-9A-Za-z_-]{35})/g,minEntropy:3},
 {kind:'xai',pattern:/\bxai-([A-Za-z0-9]{20,})/g,minEntropy:3},
 {kind:'jwt',pattern:/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})/g,minEntropy:3},
 {kind:'bearer',pattern:/\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g,minEntropy:3},
 // 只在同一行内取值（`[ \t]*`），不把 .env 空模板的下一行当值；值是引用时不报。
 {kind:'assignment',pattern:/\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd)["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-+/=.]{16,})/gi,minEntropy:3.5,skip:reference},
]
export const minKnownSecretLength=8

/** 每字符香农熵（bit）。 */
export function shannonEntropy(text:string):number{
 if(!text.length)return 0
 const counts=new Map<string,number>()
 for(const char of text)counts.set(char,(counts.get(char)??0)+1)
 let bits=0
 for(const count of counts.values()){const share=count/text.length;bits-=share*Math.log2(share)}
 return bits
}

export function detectSecrets(text:string,known:readonly string[]=[]):SecretFinding[]{
 const found:SecretFinding[]=[]
 for(const rule of rules){
  for(const match of text.matchAll(rule.pattern)){
   const start=match.index??0
   if(shannonEntropy(match[1]??match[0])<rule.minEntropy)continue
   if(rule.skip&&match[1]!==undefined&&rule.skip(match[1]))continue
   found.push({kind:rule.kind,start,end:start+match[0].length})
  }
 }
 for(const value of [...new Set(known)].sort((a,b)=>b.length-a.length)){
  if(value.length<minKnownSecretLength)continue
  for(let at=text.indexOf(value);at!==-1;at=text.indexOf(value,at+value.length))found.push({kind:'stored',start:at,end:at+value.length})
 }
 found.sort((a,b)=>a.start-b.start)
 const merged:SecretFinding[]=[]
 for(const item of found){
  const last=merged.at(-1)
  if(last&&item.start<last.end){if(item.end>last.end)last.end=item.end;continue}
  merged.push({...item})
 }
 return merged
}

export function secretKindsIn(texts:readonly string[],known:readonly string[]):SecretKind[]{
 return [...new Set(texts.flatMap(text=>detectSecrets(text,known).map(item=>item.kind)))]
}

/** 已存值的常见编码形态：原文、base64（含去填充）、base64url、十六进制大小写、URL 编码、JSON 转义（含 `\/` 写法）。 */
export function encodedForms(value:string):string[]{
 const bytes=new TextEncoder().encode(value)
 let binary=''
 for(const byte of bytes)binary+=String.fromCharCode(byte)
 const base64=btoa(binary),hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('')
 const forms=[value,base64,base64.replace(/=+$/,''),base64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),hex,hex.toUpperCase(),encodeURIComponent(value),JSON.stringify(value).slice(1,-1),JSON.stringify(value).slice(1,-1).replace(/\//g,'\\/')]
 return [...new Set(forms)].filter(form=>form.length>=minKnownSecretLength)
}

export function redactSecrets(text:string,known:readonly string[]=[],mask='[已隐藏]'):string{
 const findings=detectSecrets(text,known.flatMap(encodedForms))
 let out=text
 for(const item of findings.reverse())out=out.slice(0,item.start)+mask+out.slice(item.end)
 return out
}

const kindLabels:Readonly<Record<SecretKind,string>>={'private-key':'私钥',anthropic:'Anthropic',openai:'OpenAI',github:'GitHub',gitlab:'GitLab',slack:'Slack',aws:'AWS',google:'Google',xai:'xAI',jwt:'JWT',bearer:'Bearer 令牌',assignment:'密钥赋值',stored:'已保存的凭据'}
/** 宿主拒收提示：只说类别与去处，不回显命中值；kinds 为空表示检测本身失败。 */
export function promptSecretMessage(kinds:readonly SecretKind[]):string{
 if(!kinds.length)return '无法完成密钥检查，本条消息未发送，请稍后重试。'
 return `检测到疑似密钥（${[...new Set(kinds.map(kind=>kindLabels[kind]))].join('、')}），本条消息未发送。请到设置里的模型或连接页保存凭据，不要贴进对话。`
}

const secretRejectionPrefixes=['检测到疑似密钥','无法完成密钥检查'] as const
/** 贴密钥闸的两种拒收（群聊 WorkError、个人会话 RemoteError）：结构判定，跨模块实例可用。 */
export function isSecretRejection(error:unknown):boolean{
 if(error===null||typeof error!=='object')return false
 const {code,message,details}=error as {code?:unknown;message?:unknown;details?:unknown}
 if(details!==null&&typeof details==='object'&&(details as {reason?:unknown}).reason==='secret-in-message')return true
 return code==='gateway/bad-request'&&typeof message==='string'&&secretRejectionPrefixes.some(prefix=>message.startsWith(prefix))
}
