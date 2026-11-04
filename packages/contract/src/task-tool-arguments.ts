/**
 * 服务端固定的精确参数组合；不接受通配符或模型提供的授权规则。
 *
 * `anyArguments` 只为「参数不可枚举」的纯工具授权而存在（今天只有委派工具 `subagent_task`：
 * 它的参数是自由文本的任务描述与提示词，平台无从枚举）。带这一位时 `allowed` 必须为空数组，
 * 两者同时给即格式错误——否则「精确参数」和「任意参数」会在同一条规则里各说一半。
 * 哪些工具名允许带这一位由**服务端**的固定集判定（harness `unconstrainedGrantToolNames`），
 * 契约只负责让这种形状可被表达、可被逐字复核。
 */
export const workspaceFileToolNames=['read','write','edit'] as const
/** 目录身份由宿主和根会话核对；客户端只能回传服务端给出的默认工作目录范围。 */
export type WorkspacePaths={files:string[];directories:string[]}
export type TaskToolArgumentRule={name:string;allowed:Record<string,string|number|boolean|null>[];anyArguments?:true;workspaceFiles?:'default-workspace';workspacePaths?:WorkspacePaths;externalHarness?:'owner-general';workspaceRoot?:string}
/** 相对于可信工作目录的规范路径；目录授权包含其后代，不接受通配符、父级或敏感目录。 */
export function readWorkspacePaths(value:unknown):WorkspacePaths{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['files','directories'].includes(k)))throw Error('文件范围不正确。')
 const row=value as Record<string,unknown>,list=(v:unknown)=>{if(!Array.isArray(v)||v.length>128||!v.every(p=>typeof p==='string'&&p.length>0&&p.length<=1024&&!/[\\\x00-\x1f\x7f:*?]/.test(p)&&!p.startsWith('/')&&p.split('/').every(part=>!!part&&!['.','..','.git','.runtime'].includes(part.toLowerCase())))||new Set(v).size!==v.length)throw Error('请使用工作目录内的相对文件或目录路径。');return [...v as string[]].sort()}
 const files=list(row.files),directories=list(row.directories);if(files.length+directories.length===0||files.length+directories.length>128)throw Error('请至少指定一项文件或目录。');return {files,directories}
}
export function workspacePathAllowed(rule:TaskToolArgumentRule,path:string):boolean{
 if(!isWorkspaceFileRule(rule))return false
 if(!rule.workspacePaths)return true
 try{readWorkspacePaths({files:[path],directories:[]})}catch{return false}
 return rule.workspacePaths.files.includes(path)||rule.workspacePaths.directories.some(dir=>path===dir||path.startsWith(dir+'/'))
}
/** 同一冻结策略的模型参数投影；这不是实际 I/O 授权的替代。 */
export function workspacePathSchema(rules:readonly TaskToolArgumentRule[],name:string):{enum?:string[];pattern?:string;allOf?:{pattern:string}[];description:string}|undefined{
 if(!hasWorkspacePaths(rules)||!['read','write','edit','present'].includes(name))return
 const operations=name==='edit'?['edit','read','write']:name==='present'?['read','write']:[name]
 const selected=operations.map(op=>rules.find(rule=>rule.name===op&&isWorkspaceFileRule(rule)))
 if(name!=='present'&&selected.some(rule=>!rule))return {enum:[],description:'No path is authorized for this operation.'}
 if(name==='present'&&selected.some(rule=>rule&&!rule.workspacePaths))return {description:'Only authorized readable files or unchanged outputs successfully written by this same Run may be presented. Writing does not grant model read access.'}
 const scopes=selected.flatMap(rule=>rule?.workspacePaths?[rule.workspacePaths]:[])
 if(!scopes.length)return
 const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 const pattern=(scope:WorkspacePaths)=>'^(?:'+[...scope.files.map(escape),...scope.directories.map(dir=>escape(dir)+'(?:/[^/]+)*')].join('|')+')$'
 const finite=scopes.find(scope=>scope.directories.length===0)
 const paths=name==='present'&&scopes.every(scope=>!scope.directories.length)?[...new Set(scopes.flatMap(scope=>scope.files))]:name!=='present'&&finite?finite.files.filter(path=>selected.every(rule=>!!rule&&workspacePathAllowed(rule,path))):undefined
 const description='Paths are relative to this Run’s default workspace. '+(name==='present'?'Present only authorized inputs or this Run’s successful unchanged outputs; this grants no additional read access.':'Only the explicitly authorized '+name+' file/directory ranges are allowed. Parent paths and symbolic links are forbidden.')
 return {...paths?{enum:paths}:name==='present'?{pattern:'(?:'+scopes.map(pattern).join('|')+')'}:{allOf:scopes.map(scope=>({pattern:pattern(scope)}))},description}
}
export function hasWorkspacePaths(rules:readonly TaskToolArgumentRule[]|undefined):boolean{return !!rules?.some(rule=>rule.workspacePaths!==undefined)}
/** 这些入口能够在受限 FS 之外执行代码或委派 I/O；细路径授权不授予它们执行权。 */
export function workspacePathsUnsafeTool(name:string):boolean{return !['read','write','edit','present','ask_user_question','exit_plan_mode','get_goal','update_goal','teloa_submit_review_plan','teloa_knowledge_search','teloa_knowledge_read','teloa_skill_load','mcp__teloa_reference__read_reference','list_mcp_resources','list_mcp_resource_templates'].includes(name)}
export function isWorkspaceFileRule(rule:TaskToolArgumentRule):boolean{
 try{if(rule.workspacePaths!==undefined)readWorkspacePaths(rule.workspacePaths)}catch{return false}
 return rule.workspaceFiles==='default-workspace'&&(workspaceFileToolNames as readonly string[]).includes(rule.name)&&rule.allowed.length===0&&rule.anyArguments===undefined&&rule.externalHarness===undefined&&rule.workspaceRoot===undefined
}
/** 仅描述本人外部工具的固定参数面；本人、原生批准和实时目录许可仍由宿主独立核对。 */
export function isOwnerExternalHarnessRule(rule:TaskToolArgumentRule):boolean{
 const root=rule.workspaceRoot
 return rule.externalHarness==='owner-general'&&['subagent_codex','subagent_claude_code'].includes(rule.name)&&rule.allowed.length===0&&rule.anyArguments===undefined&&rule.workspaceFiles===undefined&&typeof root==='string'&&root.length>0&&!/[\x00-\x1f\x7f]/.test(root)&&(/^(?:\/|[A-Za-z]:[\\/])/.test(root))&&!root.split(/[\\/]/).some(part=>part==='.'||part==='..')
}
function ownerExternalHarnessArguments(rule:TaskToolArgumentRule,args:unknown):boolean{
 return fields(args)&&Object.keys(args).every(key=>['prompt','description','cwd'].includes(key))&&typeof args.prompt==='string'&&!!args.prompt.trim()&&typeof args.description==='string'&&!!args.description.trim()&&(args.cwd===undefined||args.cwd===rule.workspaceRoot)
}
/** 这里只核对官方工具的参数形状；真实目录与别名边界必须在宿主实际 I/O 处再核对。 */
function workspaceFileArguments(name:string,args:unknown):boolean{
 if(!fields(args)||typeof args.file_path!=='string'||!args.file_path.trim()||args.file_path.length>1024||/[\x00-\x1f\x7f]/.test(args.file_path)||/^[A-Za-z][A-Za-z\d+.-]*:/.test(args.file_path)&&!/^[A-Za-z]:[\\/]/.test(args.file_path)||args.file_path.split(/[\\/]/).some(part=>part==='..'))return false
 // 默认工作目录自身可位于宿主 .runtime 内；绝对路径里的受保护祖先由宿主相对根判断。
 if(!/^\/|^[A-Za-z]:[\\/]|^\\\\/.test(args.file_path)&&args.file_path.split(/[\\/]/).some(part=>['.runtime','.git'].includes(part.toLowerCase())))return false
 const keys=name==='read'?['file_path','offset','limit']:name==='write'?['file_path','content','sandbox_permissions','justification']:['file_path','old_string','new_string','replace_all','sandbox_permissions','justification']
 if(Object.keys(args).some(key=>!keys.includes(key)))return false
 if(name==='read')return ['offset','limit'].every(key=>args[key]===undefined||Number.isSafeInteger(args[key])&&(args[key] as number)>0)
 // 官方写入/编辑仅接受成对的一次性升级请求；是否批准和真实路径范围仍由宿主与官方工具核对。
 if((args.sandbox_permissions!==undefined||args.justification!==undefined)&&(!['workspace-write','danger-full-access'].includes(String(args.sandbox_permissions))||typeof args.justification!=='string'||!args.justification.trim()))return false
 if(name==='write')return typeof args.content==='string'
 return typeof args.old_string==='string'&&!!args.old_string.length&&typeof args.new_string==='string'&&args.old_string!==args.new_string&&(args.replace_all===undefined||typeof args.replace_all==='boolean')
}
function fields(value:unknown):value is Record<string,string|number|boolean|null>{
 return typeof value==='object'&&value!==null&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.values(value).every(v=>v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))
}
function argumentsObject(value:unknown):value is Record<string,unknown>{
 return typeof value==='object'&&value!==null&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
}
export function readTaskToolArgumentRules(rules:unknown):TaskToolArgumentRule[]{
 if(!Array.isArray(rules)||rules.length>128)throw Error('工具参数授权格式不正确。')
 const names=new Set<string>()
 for(const rule of rules){
  if(typeof rule!=='object'||rule===null||Object.keys(rule).some(key=>!['name','allowed','anyArguments','workspaceFiles','workspacePaths','externalHarness','workspaceRoot'].includes(key))||typeof rule.name!=='string'||!rule.name.trim()||names.has(rule.name)||!Array.isArray(rule.allowed)||rule.allowed.length>128||!rule.allowed.every(fields)||'anyArguments'in rule&&(rule.anyArguments!==true||rule.allowed.length>0)||('workspaceFiles'in rule||'workspacePaths'in rule)&&(!isWorkspaceFileRule(rule)||'anyArguments'in rule)||('externalHarness'in rule||'workspaceRoot'in rule)&&!isOwnerExternalHarnessRule(rule))throw Error('工具参数授权格式不正确。')
  names.add(rule.name)
 }
 // 缺省时不写出 anyArguments：既有调用方用 JSON.stringify 逐字串比规则，多一个 undefined 键都会不一致。
 return rules.map(rule=>({name:rule.name,allowed:rule.allowed.map((args:Record<string,string|number|boolean|null>)=>Object.fromEntries(Object.keys(args).sort().map(key=>[key,args[key]!]))),...(rule.anyArguments===true?{anyArguments:true as const}:{}),...(rule.workspaceFiles==='default-workspace'?{workspaceFiles:'default-workspace' as const}:{}),...(rule.workspacePaths===undefined?{}:{workspacePaths:readWorkspacePaths(rule.workspacePaths)}),...(rule.externalHarness==='owner-general'?{externalHarness:'owner-general' as const,workspaceRoot:rule.workspaceRoot!}:{})}))
}
export function taskToolArgumentsAllowed(rules:unknown,name:string,args:unknown):boolean{
 let parsed:TaskToolArgumentRule[]
 try{parsed=readTaskToolArgumentRules(rules)}catch{return false}
 const rule=parsed.find(rule=>rule.name===name)
 if(rule&&isWorkspaceFileRule(rule)){if(!workspaceFileArguments(name,args))return false;const path=(args as {file_path:string}).file_path;return /^\/|^[A-Za-z]:[\\/]|^\\\\/.test(path)||workspacePathAllowed(rule,path)}
 if(rule&&isOwnerExternalHarnessRule(rule))return ownerExternalHarnessArguments(rule,args)
 // 任意参数仍要求工具调用的顶层是参数对象；对象内的数组与嵌套 JSON 由工具自身 schema 校验。
 if(rule?.anyArguments===true)return argumentsObject(args)
 if(!fields(args))return false
 return !!rule?.allowed.some((candidate:Record<string,unknown>)=>Object.keys(candidate).length===Object.keys(args).length&&Object.keys(candidate).every(key=>Object.hasOwn(args,key)&&args[key]===candidate[key]))
}
