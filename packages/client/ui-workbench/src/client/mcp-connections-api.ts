// 受管 MCP 连接客户端 API；凭据只在 add 请求时提交，回包与其他端点均不含凭据字段。
type Call=(method:string,payload:unknown)=>Promise<unknown>

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const stamp=(v:unknown):v is string=>{if(typeof v!=='string')return false;try{return new Date(v).toISOString()===v}catch{return false}}
const serverNamePat=/^[A-Za-z0-9_-]{1,32}$/
const catalogIdPat=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/

function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value as object).some(k=>!keys.includes(k)))throw Error()
 return value as Record<string,unknown>
}

export type ManagedMcpConnectionRecord={
 id:string
 catalogId:string
 serverName:string
 /** installing：宿主首次安装依赖中（npm ci + 逐条核对，上限 180 秒），界面显示正在安装 */
 status:'saved'|'installing'|'connected'|'error'|'pending-oauth'
 errorMessage?:string
 /** 安装失败的明确错误码（可重试）；界面按它给本地化文案 */
 errorCode?:'install-timeout'|'install-failed'
 tools?:{name:string;fullName:string;readOnly:boolean}[]
 createdAt:string
 updatedAt:string
}
const recordStatuses:readonly ManagedMcpConnectionRecord['status'][]=['saved','installing','connected','error','pending-oauth']
const installErrorCodes:readonly NonNullable<ManagedMcpConnectionRecord['errorCode']>[]=['install-timeout','install-failed']
/** oauth-start 回包：授权链接（由负责人在浏览器中点击）或已连接标记；绝不含令牌 */
export type ManagedMcpOAuthStart={authorizationUrl:string}|{status:'already-connected'}
/** oauth-status 回包：授权进度；error 时附脱敏 errorMessage */
export type ManagedMcpOAuthStatus={status:'pending-oauth'|'connected'|'error';errorMessage?:string}

function readRecord(value:unknown):ManagedMcpConnectionRecord{
 try{
  const row=exact(value,['id','catalogId','serverName','status','errorMessage','errorCode','tools','createdAt','updatedAt'])
  if(!uuid(row.id)||typeof row.catalogId!=='string'||!catalogIdPat.test(row.catalogId))throw Error()
  if(typeof row.serverName!=='string'||!serverNamePat.test(row.serverName))throw Error()
  if(!(recordStatuses as readonly unknown[]).includes(row.status))throw Error()
  if(row.errorMessage!==undefined&&(typeof row.errorMessage!=='string'||!row.errorMessage))throw Error()
  if(row.errorCode!==undefined&&!(installErrorCodes as readonly unknown[]).includes(row.errorCode))throw Error()
  if(!stamp(row.createdAt)||!stamp(row.updatedAt))throw Error()
  let tools:ManagedMcpConnectionRecord['tools']
  if(row.tools!==undefined){
   if(!Array.isArray(row.tools))throw Error()
   tools=row.tools.map(item=>{
    const t=exact(item,['name','fullName','readOnly'])
    if(typeof t.name!=='string'||!t.name||typeof t.fullName!=='string'||!t.fullName||typeof t.readOnly!=='boolean')throw Error()
    return {name:t.name,fullName:t.fullName,readOnly:t.readOnly}
   })
  }
  const rec:ManagedMcpConnectionRecord={id:(row.id as string).toLowerCase(),catalogId:row.catalogId as string,serverName:row.serverName as string,status:row.status as ManagedMcpConnectionRecord['status'],createdAt:row.createdAt as string,updatedAt:row.updatedAt as string}
  if(row.errorMessage)rec.errorMessage=row.errorMessage as string
  if(row.errorCode)rec.errorCode=row.errorCode as NonNullable<ManagedMcpConnectionRecord['errorCode']>
  if(tools)rec.tools=tools
  return rec
 }catch{throw Error('受管 MCP 连接记录格式不正确。')}
}

/** 可展示为外链的授权入口：授权服务器的 https 地址，或本地宿主的授权入口 http://127.0.0.1:<端口>/oauth/start?state=<32 位十六进制>（下发浏览器绑定 cookie 后跳转） */
export function oauthAuthorizationUrlAllowed(url:string):boolean{
 return /^https:\/\/[^/]/.test(url)||/^http:\/\/127\.0\.0\.1:\d{1,5}\/oauth\/start\?state=[0-9a-f]{32}$/.test(url)
}

function readOAuthStart(value:unknown):ManagedMcpOAuthStart{
 try{
  const row=exact(value,['authorizationUrl','status'])
  if(row.status!==undefined){
   if(row.authorizationUrl!==undefined||row.status!=='already-connected')throw Error()
   return {status:'already-connected'}
  }
  if(typeof row.authorizationUrl!=='string'||!oauthAuthorizationUrlAllowed(row.authorizationUrl))throw Error()
  return {authorizationUrl:row.authorizationUrl}
 }catch{throw Error('受管 MCP OAuth 授权回包格式不正确。')}
}

function readOAuthStatus(value:unknown):ManagedMcpOAuthStatus{
 try{
  const row=exact(value,['status','errorMessage'])
  if(row.status!=='pending-oauth'&&row.status!=='connected'&&row.status!=='error')throw Error()
  if(row.errorMessage!==undefined&&(typeof row.errorMessage!=='string'||!row.errorMessage))throw Error()
  const rec:ManagedMcpOAuthStatus={status:row.status}
  if(row.errorMessage)rec.errorMessage=row.errorMessage as string
  return rec
 }catch{throw Error('受管 MCP OAuth 状态回包格式不正确。')}
}

export type ManagedMcpConnectionApi=ReturnType<typeof createManagedMcpConnectionApi>
export function createManagedMcpConnectionApi(call:Call){
 return {
  /** 添加连接器；credentials 只含配方声明字段，值均为字符串 */
  async add(catalogId:string,credentials?:Record<string,string>):Promise<ManagedMcpConnectionRecord>{
   if(typeof catalogId!=='string'||!catalogIdPat.test(catalogId))throw Error('catalogId 格式不正确。')
   // 凭据字段只允许 A-Z 开头且全大写字母数字下划线，或 bearer_<serverName> 格式
   const creds:Record<string,string>={}
   for(const [k,v] of Object.entries(credentials??{})){
    if(typeof v!=='string')throw Error('密钥值必须是字符串。')
    // oauth_* 槽由宿主写入；客户端只允许提交用户自带的 oauth_client_id
    if(/^oauth_/i.test(k)&&k!=='oauth_client_id')throw Error('密钥字段不允许提交：'+k)
    creds[k]=v
   }
   const payload:Record<string,unknown>={catalogId}
   if(Object.keys(creds).length>0)payload.credentials=creds
   return readRecord(await call('mcp-connections/add',payload))
  },
  /** 建立连接 */
  async connect(id:string):Promise<ManagedMcpConnectionRecord>{
   if(!uuid(id))throw Error('受管 MCP 连接 id 格式不正确。')
   return readRecord(await call('mcp-connections/connect',{id:id.toLowerCase()}))
  },
  /** 断开连接（保留凭据与配置） */
  async disconnect(id:string):Promise<ManagedMcpConnectionRecord>{
   if(!uuid(id))throw Error('受管 MCP 连接 id 格式不正确。')
   return readRecord(await call('mcp-connections/disconnect',{id:id.toLowerCase()}))
  },
  /** 删除连接与凭据 */
  async delete(id:string):Promise<void>{
   if(!uuid(id))throw Error('受管 MCP 连接 id 格式不正确。')
   await call('mcp-connections/delete',{id:id.toLowerCase()})
  },
  /** 发起 OAuth 授权：只提交 {id}；回包为授权链接，由负责人在浏览器中点击完成 */
  async oauthStart(id:string):Promise<ManagedMcpOAuthStart>{
   if(!uuid(id))throw Error('受管 MCP 连接 id 格式不正确。')
   return readOAuthStart(await call('mcp-connections/oauth-start',{id:id.toLowerCase()}))
  },
  /** 查询 OAuth 授权进度：只提交 {id} */
  async oauthStatus(id:string):Promise<ManagedMcpOAuthStatus>{
   if(!uuid(id))throw Error('受管 MCP 连接 id 格式不正确。')
   return readOAuthStatus(await call('mcp-connections/oauth-status',{id:id.toLowerCase()}))
  },
  /** 获取单条连接记录 */
  async get(id:string):Promise<ManagedMcpConnectionRecord>{
   if(!uuid(id))throw Error('受管 MCP 连接 id 格式不正确。')
   return readRecord(await call('mcp-connections/get',{id:id.toLowerCase()}))
  },
  /** 列出所有受管 MCP 连接 */
  async list():Promise<ManagedMcpConnectionRecord[]>{
   let row:Record<string,unknown>
   try{row=exact(await call('mcp-connections/list',{}),['items']);if(!Array.isArray(row.items))throw Error()}
   catch{throw Error('受管 MCP 连接列表格式不正确。')}
   return (row.items as unknown[]).map(readRecord)
  },
 }
}
