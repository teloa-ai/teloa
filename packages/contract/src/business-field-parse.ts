/**
 * number、duration 与 boolean 字段的共用解析。
 * 契约（校验筛选字面量）与服务端（`parseField` / `compare`）共用这一份，不抄两份；
 * 解析不出来一律返回 undefined，由调用方按"缺失"处理，不猜、不回退零值。
 */

/**
 * ISO 8601 时长子集：`PnW`，或 `PnDTnHnMn(.n)S`（各段可缺省但至少一段，小数只允许出现在秒）。
 * 年、月长度不确定，`P1Y` / `P1M` 一律解析不出；周不与其他段混写（ISO 8601 原文如此）。
 */
const isoDuration=/^P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?)$/
/** 纯秒数只认十进制小数写法：不收正负号、科学计数法、前后空白与残缺小数点。 */
const plainSeconds=/^\d+(?:\.\d+)?$/
/** 上限 1e12 秒（约 31,700 年）：与 number 字段守 1e15 一样是字面量常量，不做设置项。 */
const MAX_DURATION_SECONDS=1e12

/** ISO 8601 时长（PT4H30M、P1DT2H、P2W）或纯秒数（"270"、"270.5"）→ 秒数；解析失败返回 undefined。上限 1e12 秒。 */
export function parseDurationSeconds(raw:string):number|undefined{
 let seconds:number
 if(plainSeconds.test(raw))seconds=Number.parseFloat(raw)
 else{
  const match=isoDuration.exec(raw)
  if(!match)return undefined
  const [,weeks,days,hours,minutes,secs]=match
  if(weeks===undefined&&days===undefined&&hours===undefined&&minutes===undefined&&secs===undefined)return undefined
  seconds=(weeks?Number.parseInt(weeks,10)*604800:0)
   +(days?Number.parseInt(days,10)*86400:0)
   +(hours?Number.parseInt(hours,10)*3600:0)
   +(minutes?Number.parseInt(minutes,10)*60:0)
   +(secs?Number.parseFloat(secs):0)
 }
 return Number.isFinite(seconds)&&seconds<=MAX_DURATION_SECONDS?seconds:undefined
}

/** 大小写不敏感 true/false、是/否、1/0；其余 undefined。不做 trim：快照取值带空白就是带空白，按缺失处理。 */
export function parseBooleanValue(raw:string|boolean):boolean|undefined{
 if(typeof raw==='boolean')return raw
 const value=raw.toLowerCase()
 if(value==='true'||value==='是'||value==='1')return true
 if(value==='false'||value==='否'||value==='0')return false
 return undefined
}

/** 对齐有效十进制位比较下限，不构造巨大指数的幂，也不先舍入原文。 */
function belowNumberMinimum(raw:string,minimum:number):boolean{
 const parts=(text:string)=>{
  const [mantissa,exponent='0']=text.toLowerCase().split('e'),unsigned=mantissa!.replace(/^[+-]/,''),digits=unsigned.replace('.','').replace(/^0+/,'')
  return {negative:!!digits&&mantissa![0]==='-',digits:digits||'0',order:digits?digits.length+Number(exponent)-(unsigned.split('.')[1]?.length??0):-Infinity}
 }
 const a=parts(raw),b=parts(String(minimum))
 if(a.negative!==b.negative)return a.negative
 const width=Math.max(a.digits.length,b.digits.length),left=a.digits.padEnd(width,'0'),right=b.digits.padEnd(width,'0')
 const compared=a.order<b.order?-1:a.order>b.order?1:left<right?-1:left>right?1:0
 return a.negative?compared>0:compared<0
}

/** 数字原值共用校验；整数性和下限按十进制原文判断，防止浮点舍入或下溢。 */
export function parseBusinessNumberValue(raw:string|number,rule:{integer?:true;minimum?:number;decimalScale?:number}={}):number|undefined{
 if(typeof raw==='number')raw=String(raw)
 const match=/^([+-]?)(\d+(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(raw)
 if(!match)return undefined
 const value=Number(raw)
 if(!Number.isFinite(value)||Math.abs(value)>1e15)return undefined
 const digits=match[2]!.replace('.',''),nonzero=/[1-9]/.test(digits)
 if(rule.integer&&nonzero){
  const decimals=match[2]!.split('.')[1]?.length??0,trailing=digits.length-digits.replace(/0+$/,'').length
  if(Number(match[3]??0)<decimals-trailing)return undefined
 }
 if(rule.decimalScale!==undefined&&nonzero){
  const decimals=match[2]!.split('.')[1]?.length??0,trailing=digits.length-digits.replace(/0+$/,'').length
  if(Number(match[3]??0)<decimals-trailing-rule.decimalScale)return undefined
 }
 if(rule.minimum!==undefined&&belowNumberMinimum(raw,rule.minimum))return undefined
 return value
}
