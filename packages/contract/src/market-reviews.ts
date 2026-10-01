import {WorkError} from './work-error.ts'

/** 市场评分评论的公开契约；不引用 Worker 或账号凭据实现。 */
export const MARKET_REVIEW_BODY_MAX=2000
export const MARKET_REPLY_BODY_MAX=2000
export const MARKET_NICKNAME_MAX=24
export const MARKET_REVIEW_LINKS_MAX=2
/** GitHub 用户名：GitHub 账号的公开署名（Worker 登录回调与管理员按用户名认领用同一规则）。 */
export const MARKET_GITHUB_LOGIN=/^[A-Za-z0-9-]{1,39}$/
// 覆盖目录全部类型的 ID（含 2–5 段模型）；存在性由 Worker 已验签目录判断。
export const marketReviewEntryId=/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,4}$/
export const marketReviewStatuses=['visible','pending','hidden'] as const
export type MarketReviewStatus=typeof marketReviewStatuses[number]
export type MarketRating={id:string;count:number;avg:number}
export type MarketRatings={enabled:boolean;asOf:string|null;entries:MarketRating[]}
/** 条目已公开评价的星级分布（与 count、avg 同口径，含只评分不写正文的评价）。 */
export type MarketRatingDistribution={1:number;2:number;3:number;4:number;5:number}
export type MarketReviewReply={by:'author'|'teloa';name:string;body:string;createdAt:string}
/** nickname 为公开署名：GitHub 账号是 GitHub 用户名，邮箱账号是昵称。 */
export type MarketReview={id:string;nickname:string;rating:number;body:string;entryVersion:string;createdAt:string;updatedAt:string;reply:MarketReviewReply|null}
/** items 只含有正文的评价；count、avg、distribution 计入全部已公开评价。distribution 由新版服务端提供，旧回包没有该键。 */
export type MarketReviewPage={entryId:string;count:number;avg:number|null;distribution?:MarketRatingDistribution;claimedBy:string|null;items:MarketReview[];nextCursor:string|null}
export type MarketOwnReview={id:string;rating:number;body:string;entryVersion:string;status:MarketReviewStatus;createdAt:string;updatedAt:string}
/** 市场审核方式：pre 先审后发（评价经审核才公开），post 先发后审。 */
export type MarketModeration='pre'|'post'
/** moderation 由宿主从 /v1/me 读出；缺省时界面按先审后发写文案。 */
export type MarketAccountStatus={linked:false}|{linked:true;nickname:string;provider:'email'|'github';moderation?:MarketModeration}
export type MarketLinkStart={userCode:string;verificationUri:string;expiresAt:string;interval:number}
export type MarketLinkPoll={status:'idle'|'pending'|'denied'|'expired'}|{status:'linked';nickname:string;provider:'email'|'github'}

const invalid=()=>new WorkError('teloa/invalid-host-response','市场评价服务返回了无效内容。')
const invalidInput=()=>new WorkError('teloa/invalid-input','评价需要 1–5 星，正文最多 2000 字、最多 2 个链接，不能包含控制字符。')
// 保留换行和制表符；另拒绝 C1、双向格式控制符及不完整的 Unicode 代理项。
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const SURROGATE=/[\ud800-\udfff]/u
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USER_CODE=/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/
const RESERVED=/teloa|官方|official|admin|管理员|moderator/i
const linkCount=(value:string)=>(value.match(/https?:\/\/|www\./gi)??[]).length

/** 只接受 JSON 对象的自有数据字段：未知字段、继承字段、访问器和 Symbol 都不能透传。 */
function fields(value:unknown,required:readonly string[],optional:readonly string[]=[],bad=invalid):Record<string,unknown>{
 if(typeof value!=='object'||value===null||Array.isArray(value))throw bad()
 const proto=Object.getPrototypeOf(value)
 if(proto!==Object.prototype&&proto!==null)throw bad()
 const keys=Reflect.ownKeys(value)
 if(required.some(key=>!Object.hasOwn(value,key))||keys.some(key=>typeof key!=='string'||(!required.includes(key)&&!optional.includes(key))))throw bad()
 for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)throw bad()}
 return value as Record<string,unknown>
}

function canonicalBody(value:unknown,max:number,allowEmpty:boolean):string|null{
 if(typeof value!=='string'||CONTROL.test(value)||SURROGATE.test(value))return null
 const body=value.replace(/\r\n?/g,'\n').trim()
 if((!allowEmpty&&!body)||[...body].length>max||linkCount(body)>MARKET_REVIEW_LINKS_MAX)return null
 return body
}
function body(value:unknown,max:number,allowEmpty:boolean):string{
 const clean=canonicalBody(value,max,allowEmpty)
 if(clean===null||clean!==value)throw invalid()
 return clean
}
function nickname(value:unknown):string{
 if(typeof value!=='string'||CONTROL.test(value)||SURROGATE.test(value)||value!==value.trim().replace(/\s+/g,' ')||/[<>@]/.test(value)||RESERVED.test(value)||linkCount(value)>0||[...value].length<2||[...value].length>MARKET_NICKNAME_MAX)throw invalid()
 return value
}
/** 公开署名：GitHub 用户名（可含保留词、可为 1 字或最长 39 字），否则按昵称规则。 */
function publicName(value:unknown):string{
 if(typeof value==='string'&&MARKET_GITHUB_LOGIN.test(value))return value
 return nickname(value)
}
function authorName(value:unknown):string{
 // 人工认领可以使用非 GitHub 账号；回复姓名也可能是其公开昵称。
 if(typeof value!=='string'||!value||value!==value.trim()||[...value].length>39||CONTROL.test(value)||SURROGATE.test(value)||/[<>@\r\n\t]/.test(value)||linkCount(value)>0)throw invalid()
 return value
}
function timestamp(value:unknown):string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw invalid()
 return value
}
function times(row:Record<string,unknown>):{createdAt:string;updatedAt:string}{
 const createdAt=timestamp(row.createdAt),updatedAt=timestamp(row.updatedAt)
 if(updatedAt<createdAt)throw invalid()
 return {createdAt,updatedAt}
}
function uuid(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))throw invalid();return value}
function stars(value:unknown):number{if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>5)throw invalid();return value}
function count(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw invalid();return value}
function average(value:unknown):number{if(typeof value!=='number'||value<1||value>5||Math.round(value*10)/10!==value)throw invalid();return value}
function entryId(value:unknown):string{if(typeof value!=='string'||!marketReviewEntryId.test(value))throw invalid();return value}
function provider(value:unknown):'email'|'github'{if(value!=='email'&&value!=='github')throw invalid();return value}
function version(value:unknown):string{
 // 与已有 market-catalog 条目版本一致，保留预发行与 build metadata。
 if(typeof value!=='string'||!/^(?=.{1,80}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value))throw invalid()
 return value
}

/** 一位小数的均分必须能由 total 个整数星级形成，并包含当前页已知评分。 */
function aggregate(total:number,avg:number,ratings:readonly number[]=[]):void{
 if(total===0||ratings.length>total)throw invalid()
 const n=BigInt(total),tenths=BigInt(Math.round(avg*10)),known=BigInt(ratings.reduce((sum,rating)=>sum+rating,0)),remaining=n-BigInt(ratings.length)
 const lower=((2n*tenths-1n)*n+19n)/20n,upper=((2n*tenths+1n)*n-1n)/20n
 const min=known+remaining,max=known+5n*remaining
 // lower>upper 表示没有任何整数合计能四舍五入到该均分（如 4 条评价的 1.2）
 if(lower>upper||lower>max||upper<min)throw invalid()
}

/** 发表输入只含星级与正文；验证码和账号令牌由专用连接流程处理。 */
export function checkMarketReviewInput(value:unknown):{rating:number;body:string}{
 const row=fields(value,['rating'],['body'],invalidInput),rating=row.rating
 if(typeof rating!=='number'||!Number.isInteger(rating)||rating<1||rating>5)throw invalidInput()
 const clean=canonicalBody(Object.hasOwn(row,'body')?row.body:'',MARKET_REVIEW_BODY_MAX,true)
 if(clean===null)throw invalidInput()
 return {rating,body:clean}
}

export function readMarketRatings(value:unknown):MarketRatings{
 const row=fields(value,['enabled','asOf','entries'])
 if(typeof row.enabled!=='boolean'||!Array.isArray(row.entries)||row.entries.length>5000)throw invalid()
 const asOf=row.asOf===null?null:timestamp(row.asOf)
 if(!row.enabled&&(asOf!==null||row.entries.length!==0))throw invalid()
 const seen=new Set<string>(),entries=row.entries.map(input=>{
  const r=fields(input,['id','count','avg']),id=entryId(r.id),total=count(r.count),avg=average(r.avg)
  if(seen.has(id))throw invalid()
  seen.add(id);aggregate(total,avg)
  return {id,count:total,avg}
 })
 return {enabled:row.enabled,asOf,entries}
}

function reply(value:unknown):MarketReviewReply|null{
 if(value===null)return null
 const row=fields(value,['by','name','body','createdAt'])
 if(row.by!=='author'&&row.by!=='teloa')throw invalid()
 const name=authorName(row.name)
 if(row.by==='teloa'&&name!=='Teloa')throw invalid()
 return {by:row.by,name,body:body(row.body,MARKET_REPLY_BODY_MAX,false),createdAt:timestamp(row.createdAt)}
}

/** 星级分布：五个键齐全，合计等于 count，按分布算出的一位小数均分（.5 进位）等于 avg。 */
function distribution(value:unknown,total:number,avg:number|null):MarketRatingDistribution{
 const row=fields(value,['1','2','3','4','5'])
 const result={1:count(row['1']),2:count(row['2']),3:count(row['3']),4:count(row['4']),5:count(row['5'])}
 const n=BigInt(result[1])+BigInt(result[2])+BigInt(result[3])+BigInt(result[4])+BigInt(result[5])
 if(n!==BigInt(total))throw invalid()
 if(avg!==null){
  const sum=BigInt(result[1])+2n*BigInt(result[2])+3n*BigInt(result[3])+4n*BigInt(result[4])+5n*BigInt(result[5])
  if((20n*sum+n)/(2n*n)!==BigInt(Math.round(avg*10)))throw invalid()
 }
 return result
}

export function readMarketReviewPage(value:unknown):MarketReviewPage{
 const row=fields(value,['entryId','count','avg','claimedBy','items','nextCursor'],['distribution'])
 if(!Array.isArray(row.items)||row.items.length>20)throw invalid()
 const total=count(row.count),avg=row.avg===null?null:average(row.avg),seen=new Set<string>()
 if((total===0)!==(avg===null)||row.items.length>total)throw invalid()
 const items:MarketReview[]=row.items.map(input=>{
  const r=fields(input,['id','nickname','rating','body','entryVersion','createdAt','updatedAt','reply']),id=uuid(r.id),stamps=times(r),response=reply(r.reply)
  if(seen.has(id)||(response&&response.createdAt<stamps.createdAt))throw invalid()
  seen.add(id)
  return {id,nickname:publicName(r.nickname),rating:stars(r.rating),body:body(r.body,MARKET_REVIEW_BODY_MAX,true),entryVersion:version(r.entryVersion),...stamps,reply:response}
 })
 for(let at=1;at<items.length;at++){
  const previous=items[at-1]!,current=items[at]!
  if(previous.updatedAt<current.updatedAt||(previous.updatedAt===current.updatedAt&&previous.id<=current.id))throw invalid()
 }
 if(avg!==null)aggregate(total,avg,items.map(item=>item.rating))
 const spread=Object.hasOwn(row,'distribution')?distribution(row.distribution,total,avg):undefined
 // 当前页每一档星级的条数不能超过分布里该档的总数
 if(spread)for(const rating of [1,2,3,4,5] as const)if(items.filter(item=>item.rating===rating).length>spread[rating])throw invalid()
 let nextCursor:string|null=null
 if(row.nextCursor!==null){
  const last=items.at(-1)
  // 游标固定为当前页末项；短页、空页和已含全部记录的页不得声称还有下一页。
  if(typeof row.nextCursor!=='string'||items.length!==20||total<=items.length||!last||row.nextCursor!==`${Date.parse(last.updatedAt)}.${last.id}`)throw invalid()
  nextCursor=row.nextCursor
 }
 return {entryId:entryId(row.entryId),count:total,avg,...(spread?{distribution:spread}:{}),claimedBy:row.claimedBy===null?null:authorName(row.claimedBy),items,nextCursor}
}

export function readMarketOwnReview(value:unknown):MarketOwnReview|null{
 const row=fields(value,['review'])
 if(row.review===null)return null
 const r=fields(row.review,['id','rating','body','entryVersion','status','createdAt','updatedAt'])
 if(!(marketReviewStatuses as readonly unknown[]).includes(r.status))throw invalid()
 return {id:uuid(r.id),rating:stars(r.rating),body:body(r.body,MARKET_REVIEW_BODY_MAX,true),entryVersion:version(r.entryVersion),status:r.status as MarketReviewStatus,...times(r)}
}

/** GitHub 账号的署名是 GitHub 用户名；邮箱账号仍按昵称规则。 */
function accountName(value:unknown,kind:'email'|'github'):string{return kind==='github'?publicName(value):nickname(value)}

export function readMarketAccountStatus(value:unknown):MarketAccountStatus{
 const row=fields(value,['linked'],['nickname','provider','moderation'])
 if(row.linked===false){fields(row,['linked']);return {linked:false}}
 fields(row,['linked','nickname','provider'],['moderation'])
 if(row.linked!==true)throw invalid()
 if(Object.hasOwn(row,'moderation')&&row.moderation!=='pre'&&row.moderation!=='post')throw invalid()
 const kind=provider(row.provider)
 return {linked:true,nickname:accountName(row.nickname,kind),provider:kind,...(row.moderation==='pre'||row.moderation==='post'?{moderation:row.moderation}:{})}
}

/** 界面署名：GitHub 账号写 @用户名，邮箱账号写昵称；只有名字（评价列表、作者回复）时按 GitHub 用户名形态判断。 */
export function marketSignature(name:string,kind?:'email'|'github'):string{
 return (kind===undefined?MARKET_GITHUB_LOGIN.test(name):kind==='github')?'@'+name:name
}

/** verificationUri 只认市场站账号页（旧）或连接确认页（新，/account/connect/）带本次用户码的地址。 */
export function readMarketLinkStart(value:unknown):MarketLinkStart{
 const row=fields(value,['userCode','verificationUri','expiresAt','interval'])
 if(typeof row.userCode!=='string'||!USER_CODE.test(row.userCode)||(row.verificationUri!=='https://market.teloa.ai/account/?code='+row.userCode&&row.verificationUri!=='https://market.teloa.ai/account/connect/?code='+row.userCode))throw invalid()
 if(typeof row.interval!=='number'||!Number.isInteger(row.interval)||row.interval<1||row.interval>60)throw invalid()
 return {userCode:row.userCode,verificationUri:row.verificationUri,expiresAt:timestamp(row.expiresAt),interval:row.interval}
}

export function readMarketLinkPoll(value:unknown):MarketLinkPoll{
 const row=fields(value,['status'],['nickname','provider'])
 if(row.status==='idle'||row.status==='pending'||row.status==='denied'||row.status==='expired'){fields(row,['status']);return {status:row.status}}
 fields(row,['status','nickname','provider'])
 if(row.status!=='linked')throw invalid()
 const kind=provider(row.provider)
 return {status:'linked',nickname:accountName(row.nickname,kind),provider:kind}
}
