/**
 * IM 本机审计（规格 §5.5）：追加写 `<dir>/im-audit.jsonl`（目录 0o700、文件 0o600），不外发、不进日志与会话。
 * text 为 IM 指令全文；配对行（pair／pair-rejected）的码数字一律替换为 *；
 * 任一字段出现凭据形态时只把命中片段替换为 [redacted] 并在 result 后缀 +redacted 照常写入（整行拒写会被借来规避审计）。
 */
import {join} from 'node:path'
import {appendJsonl} from './store.ts'

export type ImAuditRow={
 at:string;channelId:string;chatId:string;imUserId:string
 action:'message'|'command'|'approval-click'|'question-answer'|'pair'|'pair-rejected'|'unbind'|'disable'|'enable'|'remove'|'group-bind'|'group-unbind'|'ignored-unbound'|'unauthorized-click'|'channel-save'|'binding-change'
 messageId?:string;targetId?:string;text?:string;result:string
}

/**
 * 凭据形态检测，口径同 packages/harness-dsh/src/market-session-tools.ts 的 secretLikePrefix／secretLikeKey／secretLikeValue
 * （该模块依赖 dsh-tools 等宿主包，不宜被插件直接引入，故在此对齐一份并补 IM 平台的令牌形态）：
 * 0. PEM 块（-----BEGIN … -----END …，含嵌套 JSON 转义 \n、缩进形态）先于其他规则整块遮蔽——否则 `"private_key":"-----BEGIN` 会先被规则 2 吃掉头部，
 *    PEM 匹配失败、末行与 END 行外发（审查 R1-M1）；
 * 1. 已知前缀且后随令牌体：sk-、ghp_、github_pat_、xox?-、xapp-、AKIA、Bearer／Basic、飞书 t-/u- 访问令牌、Telegram bot token、飞书 App ID；
 *    Bearer／Basic 后随的令牌须含非字母字符或 ≥16 位（「Bearer of news」这类英文不误伤），只遮令牌、保留 Bearer／Basic 字样（遮蔽之外不缺原文）；
 * 2. `key=value`／`key: value` 里 key 含 token/secret/password/auth/cookie 等的值；命令行 `-u user:pass`、`-pPASS`（find 的 -path/-print 等除外）、URL 的 `user:pass@`；
 *    规则 1、2 的值一律只取单个「值令牌」（见 valueChar），遇空白、引号、反引号、`$`、`,;|&<>(){}[]\` 即止，绝不吞掉后续命令或 JSON 字段（审查 R1-H1）；
 *    值须紧贴分隔符：`=` 后不隔空白（`KEY= cmd` 是 shell 环境变量前缀，后面是命令不是值），`:`／` = ` 两侧只容行内空格，Bearer／Basic 与令牌之间
 *    只容行内空格且前面不接 `=`（`X=Bearer cmd`），`-u` 同理；`$` 是 shell 展开起点，不算值字符（审查 R2-H1）；
 *    因此片段遮蔽的范围恰为一个值令牌，其余原文可见，这类卡片仍可批准（设计约束）；
 * 3. 高熵串：按空白与引号（`"'` 与反引号）切分成串——JSON 字符串的键名与值各自独立，草案 JSON 的键名与标点不再凑成一串被误判；
 *    `:;,(){}[]` 不作分隔，带全符号集的长口令仍整串计熵（审查 R1-M2）。串（去掉首尾括号与标点后）≥32 位（常见随机 API 密钥的最短长度）
 *    且香农熵 ≥3.5 比特／字符（32 位随机 base62 约 4.5 以上，英文词与标识符多在其下）才遮蔽；链接、十六进制指纹、uuid、小写 id、
 *    下划线／连字符与驼峰可读标识、飞书 o?_ id 除外。无空格的长命令串可能因此整串遮蔽而只给「拒绝」，属失败偏安全。
 */
/** 值令牌字符：遮蔽只覆盖一个值，不越过这些结构字符。 */
const valueChar=String.raw`[^\s"'\x60,;|&<>(){}\[\]\\$]`
const valueNonLetter=String.raw`[^\sA-Za-z"'\x60,;|&<>(){}\[\]\\$]`
const credentialPrefix=new RegExp(String.raw`(^|[^A-Za-z0-9_])(?:(?:sk-|ghp_|github_pat_|xox[a-z]-|xapp-)[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|(?<!=)((?:Bearer|Basic)[ \t]+)(?:(?=${valueChar}*${valueNonLetter})${valueChar}{6,}|[A-Za-z]{16,})|[tu]-[A-Za-z0-9]{20,}|\d{6,}:[A-Za-z0-9_-]{30,}|cli_[0-9a-f]{16}(?![A-Za-z0-9_]))`,'g')
const urlUserinfo=new RegExp(String.raw`\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'\x60,;|&<>(){}\[\]\\$]+:[^\s/@"'\x60,;|&<>(){}\[\]\\$]+@`,'gi')
const cliUserPass=new RegExp(String.raw`(^|\s)(-u[ \t]+)${valueChar}+:${valueChar}+`,'g')
const cliPassword=new RegExp(String.raw`(^|\s)-p(?!(?:ath|erm|rune|rint|rint0|rintf)(?:\s|$))${valueChar}{4,}`,'g')
/** 凭据键名：`key=value` 的 key、审批参数 JSON 的键名命中即遮值。 */
export const secretKeyName=/token|secret|password|passwd|pwd|authorization|auth|cookie|private[-_]?key|api[-_]?key|credential/i
const credentialAssignment=new RegExp(`(^|[^A-Za-z0-9])([A-Za-z0-9_.-]*(?:${secretKeyName.source})[A-Za-z0-9_.-]*["']?(?:[ \\t]*:[ \\t]*|[ \\t]+=[ \\t]*|=)["']?)(?!(?:Bearer|Basic)[ \\t])${valueChar}{4,}`,'gi')
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function shannonEntropy(value:string):number{
 const counts=new Map<string,number>()
 for(const char of value)counts.set(char,(counts.get(char)??0)+1)
 let entropy=0
 for(const count of counts.values()){const p=count/value.length;entropy-=p*Math.log2(p)}
 return entropy
}
function structuredValue(value:string):boolean{
 return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)||UUID.test(value)||/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)
  ||/^[A-Za-z]+(?:[_-][A-Za-z]+)+$/.test(value)||/^[A-Za-z][a-z]+(?:[A-Z][a-z]+)+$/.test(value)||/^https?:\/\//.test(value)||/^o[a-z]_[0-9a-f]{32}$/.test(value)
}
export const redacted='[redacted]'
/** 卡片上看不见的字符：Unicode 格式字符（Cf：零宽、软连字符、双向控制、BOM 等）与默认可忽略字符（另含韩文填充符、变体选择符）。 */
const invisibleChar=/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u
const invisibleChars=/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
/**
 * 常见同形字 → 拉丁骨架。来源：Unicode UTS #39 confusables.txt 中映射到单个 ASCII 字母的西里尔与希腊字母（大小写）子集；
 * 范围：覆盖遮蔽标记 redacted 的全部字母及审查探针用到的写法，不求穷举——全角与数学字母由 NFKC 归一。
 */
const homoglyphs:Readonly<Record<string,string>>={
 'а':'a','с':'c','ԁ':'d','е':'e','һ':'h','і':'i','ј':'j','ӏ':'l','о':'o','р':'p','ԛ':'q','г':'r','ѕ':'s','у':'y','х':'x','ԝ':'w',
 'А':'A','В':'B','С':'C','Е':'E','Н':'H','І':'I','Ј':'J','К':'K','М':'M','О':'O','Р':'P','Ѕ':'S','Т':'T','Х':'X','У':'Y',
 'α':'a','ι':'i','ν':'v','ο':'o','ρ':'p','υ':'u','χ':'x',
 'Α':'A','Β':'B','Ε':'E','Ζ':'Z','Η':'H','Ι':'I','Κ':'K','Μ':'M','Ν':'N','Ο':'O','Ρ':'P','Τ':'T','Υ':'Y','Χ':'X',
}
const skeleton=(value:string)=>Array.from(value.normalize('NFKC').replace(invisibleChars,''),char=>homoglyphs[char]??char).join('')
/**
 * 字母白名单（审查 R6-M1，设计约束）：NFKC 后只允许 ASCII 与中日韩文字（Han、Hiragana、Katakana、Hangul、Bopomofo，按 Script_Extensions，
 * 含兼容区与假名长音等共用符号）的字母；其余字母（西里尔、希腊、带重音拉丁、拉丁小型大写、切罗基……）与任何组合附加符一律视为可冒充。
 * 同形字表是列举，总有漏网；白名单按原则判定。代价：俄文、带重音拉丁字母等命令在 IM 只给「拒绝」。
 */
/**
 * 空白类或空白外观字符（审查 R7，设计约束）：除 ASCII 空格、制表、换行外，\s 与 \p{Zs}（含全角空格 U+3000、NBSP）、行／段分隔符、NEL，
 * 以及显示为空白的 U+2800 盲文空白、U+3164／U+FFA0／U+115F／U+1160 韩文填充、U+1D159。按原文判定（NFKC 会把部分空白折成 ASCII 空格）。
 */
const blankLike=/(?![ \t\n])[\s\p{Zs}\p{Zl}\p{Zp}\u0085\u2800\u3164\uFFA0\u115F\u1160\u{1D159}]/u
const foreignLetter=/(?![\p{ASCII}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}])\p{L}|\p{M}/u
/**
 * 命令类完整码位白名单（审查 R8、R9、R10，设计约束；白名单外任何码位即判可冒充，不再按类别列举；只收窄、不扩大）：
 * - ASCII 可打印 U+0020–007E 与 \t \n；
 * - 中日韩**字母本体**（\p{L}）：Script 为 Han、Hiragana、Katakana 的字母——不含半角片假名整段 U+FF61–FF9F（半角长音 ｰ 与 '-' 同形，
 *   可伪造 -i／--dry-run，审查 R9-M1），也不含康熙部首、〇 等非字母码位；
 * - Hangul 只收音节 U+AC00–D7A3（兼容字母 U+3131–318E、连写字母、半角韩文、带圈／带括号韩文不在内）；Bopomofo 整段不在内——
 *   兼容字母与注音在命令里几乎不用，且含 ㅡ ㄧ 这类与横线形近的字符（审查 R10）。已知残余：汉字「一」保留（极常用，形态明显长于 '-'）；
 * - 已列标点：、。U+3001–3002、「」『』 U+300C–300F、！（），：；？ U+FF01／FF08／FF09／FF0C／FF1A／FF1B／FF1F、・ U+30FB。
 *   〃 U+3003（外形像 "）与长音 ー U+30FC（与 '-' 形近）已移出（审查 R9）。
 * 按原文判定。
 */
const cjkLetter=String.raw`(?=\p{L})(?![\uFF61-\uFF9F])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]`
const hangulLetter=String.raw`[\uAC00-\uD7A3]`
const cjkPunctuation=String.raw`[\u3001\u3002\u300C-\u300F\uFF01\uFF08\uFF09\uFF0C\uFF1A\uFF1B\uFF1F\u30FB]`
const commandCodePoints=new RegExp(String.raw`^(?:[\t\n\x20-\x7E]|${cjkLetter}|${hangulLetter}|${cjkPunctuation})*$`,'u')
/** ANSI-C 引号 $'…' 的转义解码（\xHH、\uHHHH、\UHHHHHHHH、\NNN 八进制、\n、\t，其余 \X → X）。 */
const ansiC=(body:string)=>body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g,(_,escape:string)=>{
 if(/^x/.test(escape))return String.fromCodePoint(parseInt(escape.slice(1),16))
 if(/^[uU]/.test(escape)){const code=parseInt(escape.slice(1),16);return code<=0x10FFFF?String.fromCodePoint(code):''}
 if(/^[0-7]/.test(escape))return String.fromCodePoint(parseInt(escape,8))
 return escape==='n'?'\n':escape==='t'?'\t':escape
})
/**
 * 按 shell 规则近似去除引号与转义（审查 R9）：$'…' 按 ANSI-C 解码，${…} 展开视为空，去掉反斜杠续行，再去掉全部引号与反斜杠。
 * 只用于 redacted 骨架判定——多去不少去，偏向判为可冒充。
 */
const shellUnquote=(value:string)=>value.replace(/\$'((?:[^'\\]|\\[\s\S])*)'/g,(_,body:string)=>ansiC(body)).replace(/\$\{[^}]*\}/g,'').replace(/\\\n/g,'').replace(/["'\\]/g,'')
const redactedWord=/r\s*e\s*d\s*a\s*c\s*t\s*e\s*d/i
/**
 * 命令类审批内容是否可能在 IM 卡片上藏字或冒充遮蔽（审查 R4-M1、R5-M1、R6-M1、R7、R8），按原则判定、不逐个列举变体：
 * 首先须全部落在完整码位白名单（commandCodePoints）内；以下各项作冗余保留：
 * 含任何看不见的字符；NFKC 后含白名单外字母或组合附加符；或骨架（NFKC + 去不可见字符 + 同形映射）含 redacted
 * （不分大小写、字母间允许空白，全角【】［］等括号变体随之覆盖；另对按 shell 规则去除引号与转义后的文本再判一次）；或含 ASCII 空格／制表／换行以外的空白（blankLike）。骨架与不可见两项在白名单之外作冗余保留。
 */
export function deceptiveText(value:string):boolean{
 return !commandCodePoints.test(value)||invisibleChar.test(value)||blankLike.test(value)||foreignLetter.test(value.normalize('NFKC'))||redactedWord.test(skeleton(value))||redactedWord.test(skeleton(shellUnquote(value)))
}
const pemBlock=/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g
/** 规则 3：高熵串（按空白与引号切分的可见 ASCII 串）。 */
const redactEntropy=(value:string)=>value.replace(/[\x21\x23-\x26\x28-\x5f\x61-\x7e]{32,}/g,run=>{
 const token=run.replace(/^[(\[{<\\]+|[)\]}>,.;:!?\\]+$/g,'')
 return token.length>=32&&!structuredValue(token)&&shannonEntropy(token)>=3.5?run.replace(token,redacted):run
})
/**
 * 遮蔽规则元数据（审查 R3）：kind 决定套用顺序 block（规则 0）→ pattern（规则 1、2）→ entropy（规则 3）；
 * samples 是能单独命中本规则的最小样例，审批兜底不变式测试据此自动覆盖每条规则——新增规则必须带样例。
 */
export type RedactionRule={name:string;kind:'block'|'pattern'|'entropy';apply:(value:string)=>string;samples:readonly string[]}
export const redactionRules:readonly RedactionRule[]=[
 {name:'pem-block',kind:'block',apply:value=>value.replace(pemBlock,redacted),samples:['-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END PRIVATE KEY-----']},
 {name:'url-userinfo',kind:'pattern',apply:value=>value.replace(urlUserinfo,(_,scheme:string)=>`${scheme}${redacted}@`),samples:['https://max:s3cret@github.com/x.git']},
 {name:'cli-user-pass',kind:'pattern',apply:value=>value.replace(cliUserPass,(_,lead:string,flag:string)=>lead+flag+redacted),samples:['-u admin:pw12','-u a:/x.sh']},
 {name:'cli-password',kind:'pattern',apply:value=>value.replace(cliPassword,(_,lead:string)=>`${lead}-p${redacted}`),samples:['-pS3cret1']},
 {name:'credential-prefix',kind:'pattern',apply:value=>value.replace(credentialPrefix,(_,lead:string,scheme:string|undefined)=>lead+(scheme??'')+redacted),
  samples:['sk-proj-abcdefgh12345678','ghp_abcdefghijklmnopqrstuvwxyz0123456789','github_pat_11ABCDEFG0abcdefghijk','xoxb-1234567890-abcdefghij','xapp-1-A0123-4567-abcdef','AKIAIOSFODNN7EXAMPLE','Bearer abc.def-123456','Basic dXNlcjpwYXNzd29yZA==','t-g1044ghJRUIJJ5ELPNWT6KB2ZX','u-4Hx8TtS3F5QbTrLQwZkPAbcd','123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw','cli_a1b2c3d4e5f60718']},
 {name:'credential-assignment',kind:'pattern',apply:value=>value.replace(credentialAssignment,(_,lead:string,key:string)=>lead+key+redacted),
  samples:['token=abcd1234','apiKey: abcd1234','api_key = abcd1234','"password":"hunter22"','cookie: sessionid=abc','token: abcd1234','a.secret:\tabcd1234','pwd: "abcd1234"']},
 {name:'high-entropy',kind:'entropy',apply:redactEntropy,samples:['Kp9vT2qLx7Rm4Nw8Zs1Yb6Hc3Jd5Fg0A','Y3VybCBodHRwOi8vZXZpbC5leGFtcGxlL3ggfCBzaA==']},
]
const applyKind=(value:string,kind:RedactionRule['kind'])=>redactionRules.reduce((text,rule)=>rule.kind===kind?rule.apply(text):text,value)
/** 凭据形态片段替换为 [redacted]；审批卡与提问外发前按同一口径脱敏。 */
export function redact(value:string):string{
 return applyKind(applyKind(applyKind(value,'block'),'pattern'),'entropy')
}
/** 是否命中 PEM 或高熵串规则（审查 L1：审批卡据此只给「拒绝」，编码后的内容看不清）。 */
export function entropyHit(value:string):boolean{
 if(applyKind(value,'block')!==value)return true
 const masked=applyKind(value,'pattern')
 return applyKind(masked,'entropy')!==masked
}

/** 个人信息（审查 M2）：邮箱、中国大陆手机号、18 位身份证号。只用于本机审计落盘；审批卡保留原文，免得看不清要批准的对象。 */
const personal=[
 /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
 /(?<!\d)1[3-9]\d{9}(?!\d)/g,
 /(?<![0-9A-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g,
]
const redactPersonal=(value:string)=>personal.reduce((text,pattern)=>text.replace(pattern,redacted),value)

export function createAudit(dir:string){
 const path=join(dir,'im-audit.jsonl')
 let tail:Promise<unknown>=Promise.resolve()
 return {
  record(row:ImAuditRow):Promise<void>{
   // 配对码不落盘：码与空格分隔的变体都逐位遮蔽。
   const masked:ImAuditRow=(row.action==='pair'||row.action==='pair-rejected')&&row.text!==undefined?{...row,text:row.text.replace(/\d/g,'*')}:row
   const line:Record<string,string>={}
   let hit=false
   for(const key of ['at','channelId','chatId','imUserId','action','messageId','targetId','text','result'] as const){
    const value=masked[key]
    if(value===undefined)continue
    const safe=redactPersonal(redact(value))
    hit||=safe!==value
    line[key]=safe
   }
   if(hit)line.result+='+redacted'
   // 串行追加：并发调用按调用顺序落盘。
   const run=tail.then(()=>appendJsonl(path,line))
   tail=run.catch(()=>{})
   return run
  },
 }
}
