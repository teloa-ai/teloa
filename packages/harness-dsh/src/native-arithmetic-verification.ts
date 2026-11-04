/** 仅核对明确的算术推导和成功工具输出；不推断日期、版本、编号或业务事实。 */
export type ArithmeticReceipt=Readonly<{name:string;arguments:unknown;text:string}>
const expressionLimit=256
type Fraction={n:bigint;d:bigint}
type Expression={value:Fraction;op?:string;left?:Expression;right?:Expression}
const valueKey=(value:Fraction)=>value.n+'/'+value.d
const absolute=(n:bigint)=>n<0n?-n:n
function fraction(n:bigint,d=1n):Fraction{
 if(d===0n||absolute(n).toString().length>128||absolute(d).toString().length>128)throw Error('unsupported arithmetic')
 if(d<0n){n=-n;d=-d}
 let a=absolute(n),b=d;while(b){const r=a%b;a=b;b=r}
 return {n:n/(a||1n),d:d/(a||1n)}
}
/** 有界十进制/四则/括号解释器；不接受标识符、指数或任何可执行代码。 */
function parseArithmetic(expression:string):Expression|undefined{
 try{
  if(expression.length>expressionLimit||!/^[\d.\s()+*/×÷−-]+$/.test(expression))return
  const tokens=expression.replaceAll('×','*').replaceAll('÷','/').replaceAll('−','-').match(/\d+(?:\.\d+)?|[()+*/-]/g)??[]
  if(tokens.length>80||tokens.join('')!==expression.replaceAll('×','*').replaceAll('÷','/').replaceAll('−','-').replace(/\s/g,''))return
  let i=0,depth=0
  const atom=():Expression=>{
   if(++depth>16)throw Error('depth')
   const sign=tokens[i]==='-'?(i++,-1n):1n
   let v:Expression
   if(tokens[i]==='('){i++;v=sum();if(tokens[i++]!==')')throw Error('parenthesis')}
   else{const token=tokens[i++];if(!token||!/^\d+(?:\.\d+)?$/.test(token)||token.length>40)throw Error('number');const [whole,decimal='']=token.split('.');v={value:fraction(BigInt(whole!+decimal),10n**BigInt(decimal.length))}}
   depth--;return sign===1n?v:{value:fraction(-v.value.n,v.value.d),op:'negate',left:v}
  }
  const product=():Expression=>{let a=atom();while(tokens[i]==='*'||tokens[i]==='/'){const op=tokens[i++]!,b=atom(),av=a.value,bv=b.value;a={value:op==='*'?fraction(av.n*bv.n,av.d*bv.d):fraction(av.n*bv.d,av.d*bv.n),op,left:a,right:b}}return a}
  const sum=():Expression=>{let a=product();while(tokens[i]==='+'||tokens[i]==='-'){const op=tokens[i++]!,b=product(),av=a.value,bv=b.value;a={value:fraction(av.n*bv.d+(op==='+'?1n:-1n)*bv.n*av.d,av.d*bv.d),op,left:a,right:b}}return a}
  const result=sum();if(i!==tokens.length)return
  return result
 }catch{return}
}
export function arithmeticValue(expression:string):string|undefined{
 const parsed=parseArithmetic(expression);return parsed?valueKey(parsed.value):undefined
}
/** 只折叠真实已核验算式的子树；同结果的其他运算不构成来源证明。 */
function foldedFrom(actual:Expression,source:Expression):boolean{
 if(valueKey(actual.value)!==valueKey(source.value))return false
 if(!actual.op||actual.op==='negate'&&!actual.left?.op)return true
 return actual.op===source.op&&!!actual.left&&!!source.left&&foldedFrom(actual.left,source.left)
  &&(!actual.right&&!source.right||!!actual.right&&!!source.right&&foldedFrom(actual.right,source.right))
}
function provesEquation(source:Expression,left:Expression,right:Expression):boolean{
 return foldedFrom(left,source)&&foldedFrom(right,source)
  ||!!source.left&&provesEquation(source.left,left,right)||!!source.right&&provesEquation(source.right,left,right)
}
/** 两个独立真实回执也可连接单位换算；不能只凭等式结果恰好相同。 */
function connectsReceipts(expression:Expression,result:Expression,sources:readonly Expression[]):boolean{
 const output=valueKey(result.value)
 if(!sources.some(source=>valueKey(source.value)===output))return false
 const containsKnownInput=(node:Expression):boolean=>{
  if((!node.op||node.op==='negate'&&!node.left?.op)&&valueKey(node.value)!==output
   &&sources.some(source=>valueKey(source.value)===valueKey(node.value)))return true
  return !!node.left&&containsKnownInput(node.left)||!!node.right&&containsKnownInput(node.right)
 }
 return containsKnownInput(expression)
}
const numbers=(text:string)=>[...text.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)].flatMap(match=>{const v=arithmeticValue(match[0]);return v?[v]:[]})
function narrative(text:string):string{
 // 引用、代码和显式示例保留为原文数据，不当成本轮已计算的结论。
 return text.replace(/```[\s\S]*?(?:```|$)/g,'').replace(/`[^`\n]*`|“[^”\n]*”|「[^」\n]*」|"[^"\n]*"/g,'').split('\n').map(line=>line.replace(/^\s{0,3}(?:[-+*]|\d{1,9}[.)])\s+/,'')).filter(line=>!/^\s*>/.test(line)&&!/(?:例如|示例|举例|for example|example:|e\.g\.)/i.test(line)).join('\n')
}
/** 只接受可完整识别的算式调用；成功执行不等于任意 stdout 数字都属于该算式。 */
function receiptValue(receipt:ArithmeticReceipt):Expression|undefined{
 const args=receipt.arguments&&typeof receipt.arguments==='object'?receipt.arguments as Record<string,unknown>:{}
 let expression:unknown=args.expression
 if(!/^(?:calculate|calculator)$/.test(receipt.name)){
  let code:unknown=args.code
  if(receipt.name==='bash'){
   if(typeof args.command!=='string'||args.command.length>1024)return
   // 整条 shell 命令只能是一次 Python 调用；不接受前后附加命令、重定向或未引用 heredoc。
   const command=args.command.trim()
   const python=command.match(/^python3?\s+-c\s+(["'])([\s\S]*)\1$/)
   const heredoc=command.match(/^python3?\s+-\s*<<\s*(["'])([A-Za-z_]\w{0,31})\1[ \t]*\n([\s\S]*?)\n\2$/)
   code=python?.[2]??heredoc?.[3]
  }else if(receipt.name!=='python'&&(receipt.name!=='run_code'||args.language!=='python'))return
  if(typeof code!=='string'||code.length>512)return
  // 唯一语句必须是 print(纯算式)。算式语法由下方有界解释器完整消费，不解释 Python 程序。
  expression=code.trim().match(/^print\s*\(([\s\S]*)\)$/)?.[1]
  if(typeof expression!=='string'||!/^[\d.\s()+*/-]+$/.test(expression))return
 }
 if(typeof expression!=='string'||(expression.match(/\d+(?:\.\d+)?/g)?.length??0)<2)return
 const calculated=arithmeticValue(expression),output=receipt.text.trim()
 // stdout 必须完整是唯一标量，且等于同一算式的精确值；不能从日志、标签或多个数字中挑结果。
 if(!calculated||output.length>128||!/^[-]?\d+(?:\.\d+)?$/.test(output))return
 return arithmeticValue(output)===calculated?parseArithmetic(expression):undefined
}
export function assessArithmetic(input:string,answer:string,receipts:readonly ArithmeticReceipt[]):'none'|'verified'|'unverified'|'missing'|'contradiction'{
 if(input.length>64000||answer.length>64000)return 'none'
 if(/(?:逐字(?:引用|转写|复述|抄录)|原样(?:引用|转写|输出)|quote verbatim|transcribe verbatim)/i.test(input)&&!/(?:计算|核算|校验|纠正|calculate|verify|check)/i.test(input))return 'none'
 const body=narrative(answer).replaceAll('**','').replace(/（([\d.()+*/×÷− -]+)）/g,'($1)')
 // 数学结果也可用文字连接；仍只解释完整的纯算式，不把编号或业务事实当运算。
 const equations:{left:Expression;right:Expression}[]=[]
 // 先定位结果连接词，线性读取相邻算式；不对长数字文本逐起点回溯，也不截断超限算式后取尾部。
 for(const match of body.matchAll(/=|得(?:到|出)?|等于|结果为|\b(?:equals?|yields?)\b/gi)){
  let leftEnd=match.index!,rightStart=leftEnd+match[0].length
  while(leftEnd>0&&/\s/.test(body[leftEnd-1]!))leftEnd--
  while(rightStart<body.length&&/\s/.test(body[rightStart]!))rightStart++
  let start=leftEnd,finish=rightStart
  while(start>0&&/[\d.()+*/×÷− -]/.test(body[start-1]!))start--
  while(finish<body.length&&/[\d.()+*/×÷− -]/.test(body[finish]!))finish++
  const rawLeft=body.slice(start,leftEnd),a=rawLeft.trim(),b=body.slice(rightStart,finish).trim()
  if(!a||!b||a.length>expressionLimit||b.length>expressionLimit)continue
  const leftStart=start+rawLeft.length-rawLeft.trimStart().length
  if(leftStart>0&&/[\w.]/.test(body[leftStart-1]!))continue
  const [left,right]=[arithmeticValue(a.trim()),arithmeticValue(b.trim())]
  if(!left||!right||!/[+*/×÷−-]/.test(a+b))continue
  if(left!==right)return 'contradiction'
  equations.push({left:parseArithmetic(a.trim())!,right:parseArithmetic(b.trim())!})
 }
 const totals=[...body.matchAll(/(?:总金额|总价|总计|合计|总件数|件数|grand total|total amount|item count|total)\s*[:：|]?\s*(-?\d+(?:\.\d+)?)(?![\d.,/−-])(?:\s*(?:元|件|USD|CNY|items?))?/gi)]
 const request=narrative(input)
 const requested=/(?:计算|核算|求和|\b(?:add|subtract|multiply|divide|calculate|compute|sum)\b)/i.test(request)
  ||/(?:核对|\bcheck\b)/i.test(request)&&numbers(request).length>1&&/(?:总金额|总价|合计|\btotal\b)/i.test(request)
 if(!equations.length&&(!requested||!totals.length))return 'none'
 // 明确未核验/未知不是已核验交付；仍先拒绝上面可确定的错误等式。
 if(/(?:未(?:经|执行|进行)?(?:程序|工具|实际|计算)?核验|未(?:执行|进行)(?:实际)?计算|未验证|尚未核验|无法(?:计算|核验)|not (?:verified|computed)|unverified)/i.test(body)){
  return /(?:已(?:全部)?完成|全部完成|核对完成|已核验|已验证|\bcompleted\b)/i.test(body)?'missing':'unverified'
 }
 const results=receipts.flatMap(receipt=>{const value=receiptValue(receipt);return value?[value]:[]})
 return (equations.length||totals.length)&&equations.every(({left,right})=>(results.some(source=>provesEquation(source,left,right))||connectsReceipts(left,right,results)||connectsReceipts(right,left,results)))
  &&totals.every(match=>results.some(source=>valueKey(source.value)===arithmeticValue(match[1]!)))?'verified':'missing'
}
