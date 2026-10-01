// 夹具：main 4fdb16f4（packages/* 版本 0.2.0-alpha.6）的 v2 索引读取器原样复制（仅把 work-error / resources / roles 的导入改指当前契约），
// 代表已发行旧版应用：逐条严格解析，已知 kind 且版本范围满足本机的条目出现未知字段即整份拒收。不要修改。
import {WorkError} from '../../../packages/contract/src/work-error.ts'

/**
 * 条目 compatibility.teloa 的最小 semver 范围判定（规格 §4「最低应用版本」）。
 * 只支持空格分隔的 >=、>、<=、<、= 比较子与 `*`；不支持 ^ ~ x-range ||，避免引入依赖。
 */
const semverPattern=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
type Parsed={main:[number,number,number];pre:string[]|null}
const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
function parse(version:string):Parsed{
 const match=semverPattern.exec(version)
 if(!match)throw bad('版本号格式不正确：'+version)
 return {main:[Number(match[1]),Number(match[2]),Number(match[3])],pre:match[4]===undefined?null:match[4].split('.')}
}
function compareIdentifiers(a:string,b:string):-1|0|1{
 const na=/^\d+$/.test(a),nb=/^\d+$/.test(b)
 if(na&&nb){const x=Number(a),y=Number(b);return x<y?-1:x>y?1:0}
 if(na)return -1
 if(nb)return 1
 return a<b?-1:a>b?1:0
}
export function compareSemver(a:string,b:string):-1|0|1{
 const left=parse(a),right=parse(b)
 for(let at=0;at<3;at+=1){if(left.main[at]!<right.main[at]!)return -1;if(left.main[at]!>right.main[at]!)return 1}
 if(left.pre===null&&right.pre===null)return 0
 if(left.pre===null)return 1
 if(right.pre===null)return -1
 const length=Math.max(left.pre.length,right.pre.length)
 for(let at=0;at<length;at+=1){
  const x=left.pre[at],y=right.pre[at]
  if(x===undefined)return -1
  if(y===undefined)return 1
  const result=compareIdentifiers(x,y)
  if(result!==0)return result
 }
 return 0
}
export type TeloaRangeComparator={op:'>='|'>'|'<='|'<'|'=';version:string}
/** 解析范围；`*` 返回空数组（恒满足）。语法错误抛 teloa/invalid-input。 */
export function parseTeloaRange(range:string):TeloaRangeComparator[]{
 const trimmed=range.trim()
 if(!trimmed)throw bad('版本范围不能为空。')
 if(trimmed==='*')return []
 return trimmed.split(/\s+/).map(part=>{
  const match=/^(>=|>|<=|<|=)?(.+)$/.exec(part)
  if(!match)throw bad('版本范围格式不正确：'+part)
  const version=match[2]!
  parse(version)
  return {op:(match[1]??'=') as TeloaRangeComparator['op'],version}
 })
}
/** 本机版本是否满足范围；范围或版本语法错误一律返回 false（读取器据此把条目计入 newerApp）。 */
export function teloaRangeSatisfies(range:string,version:string):boolean{
 let comparators:TeloaRangeComparator[]
 try{comparators=parseTeloaRange(range);parse(version)}catch{return false}
 return comparators.every(({op,version:target})=>{
  const result=compareSemver(version,target)
  return op==='>='?result>=0:op==='>'?result>0:op==='<='?result<=0:op==='<'?result<0:result===0
 })
}
