import {SqlError,loadModule,parseSync} from 'libpg-query'
import {WorkError,type BusinessObjectTypeDefinition} from '@teloa/contract'
import {businessSafeFunctions} from './business-warehouse.ts'
import {
 businessSqlAllowedCastTypes,businessSqlAllowedFunctions,businessSqlForbiddenFunctionPrefixes,businessSqlForbiddenFunctions,
 businessSqlNamedArgFunctions,businessSqlNamedArgNames,businessSqlSyntaxFunctionAliases,businessSqlSystemColumns,businessSqlWithinGroupFunctions,
} from './business-sql-whitelist.ts'

/**
 * 看板 SQL 语法树白名单校验（规格 §4.2）。两道入口共用同一个校验器：
 * - `analyzeBusinessSql`：用户（AI）写的逻辑 SQL，外加语义检查——表只能是声明过的对象类型或 CTE，列只能是声明字段与六个系统列；
 * - `verifyRewrittenBusinessSql`：改写产物的二次校验，同一套节点/函数白名单，只多放行平台生成的四类东西（见该函数注释），不做列解析。
 * 每个节点按字段白名单读取：出现没列出的字段（如 `SelectStmt.intoClause`）即拒绝，不做「没认出来就跳过」。
 * libpg_query 走 proto3，零值与 false 的键直接省略，判断一律 `=== true` / `?? 默认值`。
 * SelectStmt 按形态分三支各用一份严格键集（普通 SELECT / UNION / VALUES），任何一支都不能「提前返回」而漏掉其余字段。
 * 输入先按长度截断（`maxSqlLength`），递归按深度截断（`maxDepth`）；两个入口把任何非 WorkError（如栈溢出的 RangeError）统一转成固定文案。
 * 用户 SQL 里自起的名字（CTE 名、别名、列改名、输出列名、窗口名）只收普通小写标识符：pgsql-deparser 不给 CTE 名与窗口名加引号，
 * 带引号的任意文本会在 deparse 后变成 SQL 语法（曾借此拼出无 owner/scope 过滤的快照表查询）。改写器另有往返校验兜底。
 */

type Node=Record<string,unknown>
/** `node` 是语法树里包着这个 `RangeVar` 的节点对象（`{RangeVar:{…}}`），改写器据此原位替换为子查询。 */
export type BusinessSqlTable={logical:string;objectType:BusinessObjectTypeDefinition;alias:string;node:Node}
export type BusinessSqlAnalysis={ast:unknown;tables:BusinessSqlTable[];ctes:string[];columnsByTable:Map<string,Set<string>>}

/** wasm 解析器异步初始化；进程里调用同步解析前 await 一次（重复调用无开销）。 */
export async function prepareBusinessSqlParser():Promise<void>{await loadModule()}

const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const isNode=(value:unknown):value is Node=>typeof value==='object'&&value!==null&&!Array.isArray(value)
/** 位置类字段不影响语义。 */
const positional=new Set(['location','rexpr_list_start','rexpr_list_end','list_start','list_end'])
const setOperators=new Set(['SETOP_NONE','SETOP_UNION'])
const expressionKinds=new Set(['AEXPR_OP','AEXPR_NULLIF','AEXPR_LIKE','AEXPR_ILIKE','AEXPR_BETWEEN','AEXPR_NOT_BETWEEN','AEXPR_IN','AEXPR_DISTINCT','AEXPR_NOT_DISTINCT'])
/** A_Expr 只放算术与比较（规格「算术、比较」）；`->`/`->>` 只在改写产物里出现。 */
const userOperators=new Set(['+','-','*','/','%','^','=','<>','<','>','<=','>=','||'])
const platformOperators=new Set(['->','->>'])
const subLinkTypes=new Set(['EXPR_SUBLINK','ANY_SUBLINK','EXISTS_SUBLINK'])
const platformFunctions=new Set<string>(businessSafeFunctions)
const maxSqlLength=16000
const maxDepth=64
const plainIdentifier=/^[a-z_][a-z0-9_]{0,62}$/
/** 三种 SelectStmt 形态各自允许的键；顶层先用三者并集拒掉 INTO / FOR UPDATE / GROUP BY DISTINCT，再按形态收紧。 */
const plainSelectKeys=['targetList','fromClause','whereClause','groupClause','havingClause','windowClause','sortClause','limitCount','limitOffset','limitOption','withClause','op','distinctClause'] as const
const unionKeys=['op','all','larg','rarg','sortClause','limitCount','limitOffset','limitOption','withClause'] as const
const valuesKeys=['valuesLists','op','limitOption','withClause'] as const

function list(value:unknown):unknown[]{
 if(value===undefined)return []
 if(!Array.isArray(value))throw invalid('SQL 语法树形态异常。')
 return value
}
function unwrap(value:unknown):[string,Node]{
 if(!isNode(value))throw invalid('SQL 语法树形态异常。')
 const keys=Object.keys(value)
 if(keys.length!==1||!isNode(value[keys[0]!]))throw invalid('SQL 语法树形态异常。')
 return [keys[0]!,value[keys[0]!] as Node]
}
function only(kind:string,body:Node,allowed:readonly string[],named:Readonly<Record<string,string>>={}):void{
 for(const key of Object.keys(body))if(!positional.has(key)&&!allowed.includes(key))throw invalid('不允许的语法 '+(named[key]??kind+'.'+key))
}
function text(value:unknown):string{
 const [kind,body]=unwrap(value)
 if(kind!=='String'||typeof body.sval!=='string')throw invalid('SQL 语法树形态异常。')
 return body.sval
}
function alias(value:unknown):{name:string;columns:string[]}|undefined{
 if(value===undefined)return undefined
 if(!isNode(value))throw invalid('SQL 语法树形态异常。')
 only('Alias',value,['aliasname','colnames'])
 if(typeof value.aliasname!=='string')throw invalid('SQL 语法树形态异常。')
 return {name:value.aliasname,columns:list(value.colnames).map(text)}
}

function parseOne(sql:string):{result:Node;select:Node}{
 if(typeof sql!=='string'||!sql.trim())throw invalid('需要一条 SELECT 语句。')
 if(sql.length>maxSqlLength)throw invalid('SQL 过长：不能超过 '+maxSqlLength+' 个字符。')
 let result:unknown
 try{result=parseSync(sql)}catch(error){if(error instanceof SqlError)throw invalid('SQL 语法错误：'+error.message);throw error}
 if(!isNode(result))throw invalid('SQL 语法树形态异常。')
 const statements=list(result.stmts)
 if(!statements.length)throw invalid('需要一条 SELECT 语句。')
 if(statements.length>1)throw invalid('不允许多条语句，只能写一条 SELECT。')
 const statement=statements[0]
 if(!isNode(statement))throw invalid('SQL 语法树形态异常。')
 const [kind,body]=unwrap(statement.stmt)
 if(kind!=='SelectStmt')throw invalid('不允许的语法 '+kind+'：只能写一条 SELECT。')
 return {result,select:body}
}

/** 一层 FROM 里的一项：名字（别名或表名，无别名子查询为空）、可见列；逻辑表另带登记项。 */
type Entry={name?:string|undefined;columns:readonly string[];table?:BusinessSqlTable}
type Level={entries:Entry[]}
type Scope=readonly Level[]
type Ctes=ReadonlyMap<string,readonly string[]>

class Checker{
 readonly tables:BusinessSqlTable[]=[]
 readonly ctes:string[]=[]
 readonly columnsByTable=new Map<string,Set<string>>()
 /** semantic=true 为用户 SQL（解析表与列）；false 为改写产物（结构校验 + 平台放行项）。 */
 private readonly semantic:boolean
 private readonly paramCount:number
 private readonly objectTypes:readonly BusinessObjectTypeDefinition[]
 /** 改写产物里快照表与安全转换函数所在的模式（Teloa 表所在模式，个人版为 public）；用户 SQL 不用。 */
 private readonly platformSchema:string
 private depth=0
 constructor(semantic:boolean,paramCount:number,objectTypes:readonly BusinessObjectTypeDefinition[],platformSchema=''){this.semantic=semantic;this.paramCount=paramCount;this.objectTypes=objectTypes;this.platformSchema=platformSchema}

 /** 递归入口（select / fromItem / expr）都走这里计深度：超过 `maxDepth` 层即拒绝，不等 JS 栈溢出。 */
 private nest<T>(run:()=>T):T{
  if(++this.depth>maxDepth)throw invalid('SQL 嵌套过深：不能超过 '+maxDepth+' 层。')
  try{return run()}finally{this.depth--}
 }

 /** 校验一条 SELECT（含集合运算与 VALUES），返回输出列名。 */
 select(body:Node,outer:Scope,inherited:Ctes):string[]{return this.nest(()=>this.selectStmt(body,outer,inherited))}

 private selectStmt(body:Node,outer:Scope,inherited:Ctes):string[]{
  only('SelectStmt',body,[...new Set([...plainSelectKeys,...unionKeys,...valuesKeys])],{lockingClause:'LockingClause',intoClause:'IntoClause',groupDistinct:'GROUP BY DISTINCT'})
  const ctes=this.withClause(body.withClause,outer,inherited)
  const limitOption=body.limitOption??'LIMIT_OPTION_DEFAULT'
  if(limitOption!=='LIMIT_OPTION_DEFAULT'&&limitOption!=='LIMIT_OPTION_COUNT')throw invalid('不允许的语法 FETCH … WITH TIES')
  const op=body.op??'SETOP_NONE'
  if(typeof op!=='string'||!setOperators.has(op))throw invalid('不允许的集合运算 '+String(op).replace('SETOP_',''))
  if(op==='SETOP_UNION'){
   only('SelectStmt(UNION)',body,unionKeys)
   if(!isNode(body.larg)||!isNode(body.rarg))throw invalid('SQL 语法树形态异常。')
   const left=this.select(body.larg,outer,ctes),right=this.select(body.rarg,outer,ctes)
   if(left.length!==right.length)throw invalid('集合运算两侧列数不一致。')
   // 集合运算外层的 order by / limit 只能引用输出列名。
   const scope=[{entries:[{columns:left}]},...outer]
   for(const item of list(body.sortClause))this.sortBy(item,scope,ctes,left)
   for(const value of [body.limitCount,body.limitOffset])if(value!==undefined)this.expr(value,scope,ctes)
   return left
  }
  if(body.valuesLists!==undefined){
   // VALUES 不带 order by / limit / offset：这些键不在 valuesKeys 里，出现即拒（曾在这里提前返回而漏检）。
   only('SelectStmt(VALUES)',body,valuesKeys)
   if(limitOption!=='LIMIT_OPTION_DEFAULT')throw invalid('不允许的语法 SelectStmt(VALUES).limitOption')
   const rows=list(body.valuesLists).map(row=>{const [kind,items]=unwrap(row);if(kind!=='List')throw invalid('SQL 语法树形态异常。');return list(items.items)})
   for(const row of rows)for(const item of row){
    if(unwrap(item)[0]!=='A_Const')throw invalid('VALUES 里只允许常量。')
    this.expr(item,outer,ctes)
   }
   return (rows[0]??[]).map((_,index)=>'column'+(index+1))
  }
  only('SelectStmt',body,plainSelectKeys)
  const level:Level={entries:[]},from=list(body.fromClause)
  for(const item of from)this.fromItem(item,level,outer,ctes,false)
  if(from.length>1)throw invalid('不允许逗号连接（隐式 CROSS JOIN），请改用 join … on。')
  const scope=[level,...outer],outputs:string[]=[]
  for(const item of list(body.targetList)){
   const [kind,target]=unwrap(item)
   if(kind!=='ResTarget')throw invalid('不允许的语法 '+kind)
   only('ResTarget',target,['name','val'])
   if(typeof target.name==='string')this.identifier(target.name)
   outputs.push(...this.target(target.val,scope,ctes,typeof target.name==='string'?target.name:undefined))
  }
  const distinct=list(body.distinctClause)
  if(distinct.length&&!(distinct.length===1&&isNode(distinct[0])&&!Object.keys(distinct[0]).length)){
   if(this.semantic)throw invalid('不允许 DISTINCT ON。')
   for(const value of distinct)this.expr(value,scope,ctes)
  }
  for(const value of [body.whereClause,body.havingClause,body.limitCount,body.limitOffset])if(value!==undefined)this.expr(value,scope,ctes)
  for(const item of list(body.groupClause))this.expr(item,scope,ctes,outputs)
  for(const item of list(body.windowClause)){const [kind,window]=unwrap(item);if(kind!=='WindowDef')throw invalid('不允许的语法 '+kind);this.window(window,scope,ctes)}
  for(const item of list(body.sortClause))this.sortBy(item,scope,ctes,outputs)
  return outputs
 }

 private withClause(value:unknown,outer:Scope,inherited:Ctes):Ctes{
  if(value===undefined)return inherited
  if(!isNode(value))throw invalid('SQL 语法树形态异常。')
  only('WithClause',value,['ctes','recursive'])
  if(value.recursive===true)throw invalid('不允许递归 CTE（with recursive）。')
  const ctes=new Map(inherited)
  for(const item of list(value.ctes)){
   const [kind,cte]=unwrap(item)
   if(kind!=='CommonTableExpr')throw invalid('不允许的语法 '+kind)
   only('CommonTableExpr',cte,['ctename','aliascolnames','ctematerialized','ctequery'])
   const name=cte.ctename
   if(typeof name!=='string')throw invalid('SQL 语法树形态异常。')
   this.identifier(name)
   if(this.semantic&&this.objectTypes.some(type=>type.id.replaceAll('-','_')===name))throw invalid('CTE 名 '+name+' 与业务对象表重名。')
   const [queryKind,query]=unwrap(cte.ctequery)
   if(queryKind!=='SelectStmt')throw invalid('不允许的语法 '+queryKind+'：CTE 里只能写 SELECT。')
   const columns=this.select(query,outer,ctes),renamed=list(cte.aliascolnames).map(text)
   for(const column of renamed)this.identifier(column)
   if(renamed.length>columns.length)throw invalid('CTE '+name+' 的列名比输出列多。')
   ctes.set(name,[...renamed,...columns.slice(renamed.length)])
   this.ctes.push(name)
  }
  return ctes
 }

 private fromItem(item:unknown,level:Level,outer:Scope,ctes:Ctes,inJoin:boolean):void{return this.nest(()=>this.fromEntry(item,level,outer,ctes,inJoin))}

 private fromEntry(item:unknown,level:Level,outer:Scope,ctes:Ctes,inJoin:boolean):void{
  const [kind,body]=unwrap(item)
  if(kind==='RangeVar'){
   only('RangeVar',body,['relname','schemaname','catalogname','inh','relpersistence','alias'])
   const name=body.relname,renamed=this.alias(body.alias)
   if(typeof name!=='string')throw invalid('SQL 语法树形态异常。')
   if(renamed?.columns.length)throw invalid('不允许给表 '+name+' 的列改名。')
   if(body.schemaname!==undefined||body.catalogname!==undefined){
    const qualified=[body.catalogname,body.schemaname,name].filter(part=>part!==undefined).join('.')
    // 改写产物里平台生成的快照表是唯一放行的限定名；用户 SQL 一律拒绝。
    if(this.semantic||qualified!==this.platformSchema+'.teloa_business_object_snapshots')throw invalid('不允许带模式名的表 '+qualified)
    if(body.inh!==true)throw invalid('不允许 ONLY。')
    return this.enter(level,{name:renamed?.name??name,columns:[]})
   }
   if(body.inh!==true)throw invalid('不允许 ONLY。')
   const cte=ctes.get(name)
   if(cte)return this.enter(level,{name:renamed?.name??name,columns:cte})
   if(!this.semantic)throw invalid('未声明的表 '+name)
   const matches=this.objectTypes.filter(type=>type.id.replaceAll('-','_')===name)
   if(!matches.length)throw invalid('未声明的表 '+name)
   if(matches.length>1)throw invalid('表 '+name+' 有歧义。')
   const objectType=matches[0]!,table:BusinessSqlTable={logical:name,objectType,alias:renamed?.name??name,node:item as Node}
   this.tables.push(table)
   if(!this.columnsByTable.has(name))this.columnsByTable.set(name,new Set())
   return this.enter(level,{name:table.alias,columns:[...Object.keys(businessSqlSystemColumns),...objectType.fields.map(field=>field.name)],table})
  }
  if(kind==='RangeSubselect'){
   only('RangeSubselect',body,['lateral','subquery','alias'])
   if(body.lateral===true)throw invalid('不允许 LATERAL 子查询。')
   if(this.semantic&&inJoin)throw invalid('连接两侧只能是业务对象表或 CTE。')
   const [queryKind,query]=unwrap(body.subquery)
   if(queryKind!=='SelectStmt')throw invalid('不允许的语法 '+queryKind)
   // 非 LATERAL 子查询看不到同层 FROM，只看得到外层。
   const columns=this.select(query,outer,ctes),renamed=this.alias(body.alias)
   if(renamed&&renamed.columns.length>columns.length)throw invalid('子查询 '+renamed.name+' 的列名比输出列多。')
   return this.enter(level,{name:renamed?.name,columns:renamed?[...renamed.columns,...columns.slice(renamed.columns.length)]:columns})
  }
  if(kind==='JoinExpr'){
   only('JoinExpr',body,['jointype','larg','rarg','quals','usingClause','isNatural'],{alias:'连接别名',join_using_alias:'USING 别名'})
   if(body.isNatural===true)throw invalid('不允许 NATURAL 连接，请改用 join … on。')
   if(body.usingClause!==undefined)throw invalid('不允许 USING 连接，请改用 join … on。')
   const type=body.jointype??'JOIN_INNER'
   if(type!=='JOIN_INNER'&&type!=='JOIN_LEFT')throw invalid('不允许的连接方式 '+String(type).replace('JOIN_','')+'：只允许 inner / left join。')
   if(body.quals===undefined)throw invalid('不允许 CROSS JOIN，请写 join … on。')
   const start=level.entries.length
   this.fromItem(body.larg,level,outer,ctes,true)
   const middle=level.entries.length
   this.fromItem(body.rarg,level,outer,ctes,true)
   this.expr(body.quals,[level,...outer],ctes)
   const names=(entries:Entry[])=>new Set(entries.flatMap(entry=>entry.name===undefined?[]:[entry.name]))
   if(!joinsSides(body.quals,names(level.entries.slice(start,middle)),names(level.entries.slice(middle))))throw invalid('join 的 on 条件必须含「左表.列 = 右表.列」的等值条件（其余条件用 and 追加），不允许 on true、常量或同侧比较。')
   return
  }
  if(kind==='RangeFunction'&&!this.semantic){
   // 改写产物里的 `from jsonb_array_elements(s.snapshot->'fields') f`：只认这一种形态。
   only('RangeFunction',body,['functions','alias'])
   const functions=list(body.functions)
   if(functions.length!==1)throw invalid('不允许的语法 RangeFunction')
   const [listKind,pair]=unwrap(functions[0]),items=list(pair.items)
   const call=items[0]
   if(listKind!=='List'||items.length!==2||!isNode(items[1])||Object.keys(items[1]).length||unwrap(call)[0]!=='FuncCall')throw invalid('不允许的语法 RangeFunction')
   const name=list(unwrap(call)[1].funcname).map(text)
   if(name.length!==1||name[0]!=='jsonb_array_elements')throw invalid('不允许的语法 RangeFunction')
   this.nest(()=>this.call(unwrap(call)[1],[level,...outer],ctes,true))
   return this.enter(level,{name:alias(body.alias)?.name,columns:[]})
  }
  throw invalid('不允许的语法 '+kind)
 }

 /** 用户 SQL 自起的名字只收普通小写标识符；改写产物由往返校验兜底，这里不查。 */
 private identifier(name:string):void{
  if(this.semantic&&!plainIdentifier.test(name))throw invalid('不合法的标识符：CTE 名、别名、列名、窗口名只能用小写字母、数字与下划线，不以数字开头，最长 63 个字符。')
 }

 private alias(value:unknown):{name:string;columns:string[]}|undefined{
  const renamed=alias(value)
  if(renamed)for(const name of [renamed.name,...renamed.columns])this.identifier(name)
  return renamed
 }

 private enter(level:Level,entry:Entry):void{
  if(entry.name!==undefined&&level.entries.some(other=>other.name===entry.name))throw invalid('表别名 '+entry.name+' 重复。')
  level.entries.push(entry)
 }

 /** select 列表里的一项：`*` / `t.*` 只能写在这里，展开为可见列。返回输出列名。 */
 private target(value:unknown,scope:Scope,ctes:Ctes,name:string|undefined):string[]{
  const [kind,body]=unwrap(value)
  if(kind==='ColumnRef'){
   const parts=list(body.fields)
   if(parts.length&&unwrap(parts[parts.length-1])[0]==='A_Star')return this.star(body,scope)
  }
  this.expr(value,scope,ctes)
  return [name??outputName(value)]
 }

 private star(body:Node,scope:Scope):string[]{
  only('ColumnRef',body,['fields'])
  const parts=list(body.fields)
  if(parts.length>2)throw invalid('不允许带模式名的列。')
  if(!this.semantic)return []
  const entries=parts.length===1?scope[0]!.entries:[this.qualifier(text(parts[0]),scope)]
  return entries.flatMap(entry=>{for(const column of entry.columns)this.record(entry,column);return [...entry.columns]})
 }

 private qualifier(name:string,scope:Scope):Entry{
  for(const level of scope){const entry=level.entries.find(entry=>entry.name===name);if(entry)return entry}
  throw invalid('未声明的表 '+name)
 }

 private record(entry:Entry,column:string):void{if(entry.table)this.columnsByTable.get(entry.table.logical)!.add(column)}

 private column(body:Node,scope:Scope,outputs?:readonly string[]):void{
  only('ColumnRef',body,['fields'])
  const parts=list(body.fields)
  if(!parts.length||parts.length>2)throw invalid('不允许带模式名的列。')
  if(parts.some(part=>unwrap(part)[0]!=='String'))throw invalid('* 只能直接写在 select 列表里。')
  if(!this.semantic)return
  if(parts.length===2){
   const entry=this.qualifier(text(parts[0]),scope),name=text(parts[1])
   if(!entry.columns.includes(name))throw invalid('未声明的列 '+name)
   return this.record(entry,name)
  }
  const name=text(parts[0])
  // order by / group by 可以直接引用输出列别名。
  if(outputs?.includes(name))return
  for(const level of scope){
   const hits=level.entries.filter(entry=>entry.columns.includes(name))
   if(hits.length>1)throw invalid('列 '+name+' 有歧义，请加表名限定。')
   if(hits.length===1)return this.record(hits[0]!,name)
  }
  throw invalid('未声明的列 '+name)
 }

 private sortBy(item:unknown,scope:Scope,ctes:Ctes,outputs?:readonly string[]):void{
  const [kind,body]=unwrap(item)
  if(kind!=='SortBy')throw invalid('不允许的语法 '+kind)
  only('SortBy',body,['node','sortby_dir','sortby_nulls'])
  this.expr(body.node,scope,ctes,outputs)
 }

 private window(body:Node,scope:Scope,ctes:Ctes):void{
  only('WindowDef',body,['name','refname','partitionClause','orderClause','frameOptions','startOffset','endOffset'])
  for(const name of [body.name,body.refname])if(name!==undefined){if(typeof name!=='string')throw invalid('SQL 语法树形态异常。');this.identifier(name)}
  for(const value of list(body.partitionClause))this.expr(value,scope,ctes)
  for(const item of list(body.orderClause))this.sortBy(item,scope,ctes)
  for(const value of [body.startOffset,body.endOffset])if(value!==undefined)this.expr(value,scope,ctes)
 }

 private typeName(value:unknown):void{
  if(!isNode(value))throw invalid('SQL 语法树形态异常。')
  only('TypeName',value,['names','typmods','arrayBounds','typemod','setof','pct_type'])
  const names=list(value.names).map(text)
  const name=names.length===1?names[0]!:names.length===2&&names[0]==='pg_catalog'?names[1]!:undefined
  if(name===undefined)throw invalid('不允许的类型转换 '+names.join('.'))
  if(value.typmods!==undefined)throw invalid('不允许的类型转换 '+name+'(…)')
  if(value.arrayBounds!==undefined)throw invalid('不允许的类型转换 '+name+'[]')
  if(value.setof===true||value.pct_type===true||!businessSqlAllowedCastTypes.has(name))throw invalid('不允许的类型转换 '+name)
 }

 /** `rangeFunction` 只在改写产物的 `from jsonb_array_elements(…) f` 形态为 true：`jsonb_array_elements` 只在那里放行。 */
 private functionName(body:Node,rangeFunction:boolean):{name:string;platform:boolean}{
  const parts=list(body.funcname).map(text)
  if(parts.length===1){
   if(!this.semantic&&rangeFunction&&parts[0]==='jsonb_array_elements')return {name:parts[0],platform:true}
   return {name:parts[0]!,platform:false}
  }
  // PG14+：SQL 标准语法（extract/substring/trim…）解析成 pg_catalog.<内部名>，只有这种形态剥前缀并映回可见名。
  if(parts.length===2&&parts[0]==='pg_catalog'&&body.funcformat==='COERCE_SQL_SYNTAX'){
   const internal=parts[1]!,aliases=businessSqlSyntaxFunctionAliases as Readonly<Record<string,string>>
   return {name:Object.hasOwn(aliases,internal)?aliases[internal]!:internal,platform:false}
  }
  if(!this.semantic&&parts.length===2&&parts[0]===this.platformSchema&&platformFunctions.has(parts[1]!))return {name:parts.join('.'),platform:true}
  throw invalid('不允许的函数 '+parts.join('.')+'：不允许带模式名的函数。')
 }

 private call(body:Node,scope:Scope,ctes:Ctes,rangeFunction=false):void{
  only('FuncCall',body,['funcname','args','agg_order','agg_filter','over','agg_within_group','agg_star','agg_distinct','funcformat'],{func_variadic:'VARIADIC'})
  const {name,platform}=this.functionName(body,rangeFunction)
  if(!platform){
   if(businessSqlForbiddenFunctions.has(name)||businessSqlForbiddenFunctionPrefixes.some(prefix=>name.startsWith(prefix)))throw invalid('不允许的函数 '+name)
   if(!businessSqlAllowedFunctions.has(name))throw invalid('不允许的函数 '+name)
  }
  if(body.agg_star===true&&name!=='count')throw invalid('只有 count 可以写 *。')
  const withinGroup=(businessSqlWithinGroupFunctions as readonly string[]).includes(name)
  if(body.agg_within_group===true&&!withinGroup)throw invalid('函数 '+name+' 不允许 WITHIN GROUP。')
  if(withinGroup&&body.agg_within_group!==true)throw invalid('函数 '+name+' 必须带 WITHIN GROUP。')
  if(body.agg_order!==undefined&&body.agg_within_group!==true)throw invalid('不允许在聚合函数里写排序。')
  // substring 第二参数若是文本就是正则 / SIMILAR 形态（可 ReDoS），只收整数常量：substring(x from 1 for 8) / substring(x,1,8)。
  if(name==='substring'){
   const second=list(body.args)[1]
   if(second===undefined||!(isNode(second)&&isNode(second.A_Const)&&isNode(second.A_Const.ival)))throw invalid('substring 的第二个参数只能是整数常量（不支持正则形态）。')
  }
  for(const arg of list(body.args)){
   const [kind,value]=unwrap(arg)
   if(kind!=='NamedArgExpr'){this.expr(arg,scope,ctes);continue}
   if(!(businessSqlNamedArgFunctions as readonly string[]).includes(name))throw invalid('不允许命名参数（函数 '+name+'）。')
   only('NamedArgExpr',value,['arg','name','argnumber'])
   if(typeof value.name!=='string'||!businessSqlNamedArgNames.has(value.name))throw invalid('不允许命名参数 '+String(value.name))
   this.expr(value.arg,scope,ctes)
  }
  for(const item of list(body.agg_order))this.sortBy(item,scope,ctes)
  if(body.agg_filter!==undefined)this.expr(body.agg_filter,scope,ctes)
  if(body.over!==undefined){if(!isNode(body.over))throw invalid('SQL 语法树形态异常。');this.window(body.over,scope,ctes)}
 }

 /** 表达式；`outputs` 只对 order by / group by 的顶层列引用生效。 */
 expr(value:unknown,scope:Scope,ctes:Ctes,outputs?:readonly string[]):void{return this.nest(()=>this.expression(value,scope,ctes,outputs))}

 private expression(value:unknown,scope:Scope,ctes:Ctes,outputs?:readonly string[]):void{
  const [kind,body]=unwrap(value)
  const each=(values:unknown)=>{for(const item of list(values))this.expr(item,scope,ctes)}
  switch(kind){
   case 'ColumnRef':return this.column(body,scope,outputs)
   case 'A_Const':return only(kind,body,['ival','fval','sval','boolval','bsval','isnull'])
   case 'ParamRef':{
    if(this.semantic)throw invalid('不允许出现参数占位符（$n），参数由平台注入。')
    only(kind,body,['number'])
    const number=body.number??0
    if(!Number.isSafeInteger(number)||Number(number)<1||Number(number)>this.paramCount)throw invalid('参数占位符 $'+String(number)+' 超出范围。')
    return
   }
   case 'A_Expr':{
    only(kind,body,['kind','name','lexpr','rexpr'])
    const expression=String(body.kind)
    if(!expressionKinds.has(expression))throw invalid('不允许的语法 A_Expr('+expression.replace('AEXPR_','')+')')
    const names=list(body.name)
    if(names.length!==1)throw invalid('不允许带模式名的运算符。')
    const operator=text(names[0])
    if(expression==='AEXPR_OP'&&!userOperators.has(operator)&&(this.semantic||!platformOperators.has(operator)))throw invalid('不允许的运算符 '+operator)
    if(body.lexpr!==undefined)this.expr(body.lexpr,scope,ctes)
    if(body.rexpr!==undefined){const [rightKind,right]=unwrap(body.rexpr);if(rightKind==='List')each(right.items);else this.expr(body.rexpr,scope,ctes)}
    return
   }
   case 'BoolExpr':only(kind,body,['boolop','args']);return each(body.args)
   case 'NullTest':only(kind,body,['arg','nulltesttype','argisrow']);return this.expr(body.arg,scope,ctes)
   case 'BooleanTest':only(kind,body,['arg','booltesttype']);return this.expr(body.arg,scope,ctes)
   case 'CaseExpr':{
    only(kind,body,['arg','args','defresult'])
    if(body.arg!==undefined)this.expr(body.arg,scope,ctes)
    for(const item of list(body.args)){
     const [whenKind,when]=unwrap(item)
     if(whenKind!=='CaseWhen')throw invalid('不允许的语法 '+whenKind)
     only('CaseWhen',when,['expr','result'])
     this.expr(when.expr,scope,ctes);this.expr(when.result,scope,ctes)
    }
    if(body.defresult!==undefined)this.expr(body.defresult,scope,ctes)
    return
   }
   case 'CoalesceExpr':case 'NullIfExpr':only(kind,body,['args']);return each(body.args)
   case 'MinMaxExpr':only(kind,body,['op','args']);return each(body.args)
   case 'TypeCast':only(kind,body,['arg','typeName']);this.typeName(body.typeName);return this.expr(body.arg,scope,ctes)
   case 'FuncCall':return this.call(body,scope,ctes)
   case 'SubLink':{
    only(kind,body,['subLinkType','testexpr','operName','subselect'])
    if(!subLinkTypes.has(String(body.subLinkType)))throw invalid('不允许的子查询形态 '+String(body.subLinkType))
    for(const name of list(body.operName))if(!userOperators.has(text(name)))throw invalid('不允许的运算符 '+text(name))
    if(body.testexpr!==undefined)this.expr(body.testexpr,scope,ctes)
    const [queryKind,query]=unwrap(body.subselect)
    if(queryKind!=='SelectStmt')throw invalid('不允许的语法 '+queryKind)
    this.select(query,scope,ctes)
    return
   }
   case 'SQLValueFunction':
    only(kind,body,['op','typmod'])
    if(body.op!=='SVFOP_CURRENT_DATE')throw invalid('不允许的语法 SQLValueFunction('+String(body.op)+')：只允许 current_date，时刻请用 now()。')
    return
   default:throw invalid('不允许的语法 '+kind)
  }
 }
}

/** on 条件（或其顶层 and 链）里有一个 `左.列 = 右.列`：两侧都是带表名限定的列引用，分别落在连接左、右两侧。or / not 之下的等值不算。 */
function joinsSides(value:unknown,left:ReadonlySet<string>,right:ReadonlySet<string>):boolean{
 const [kind,body]=unwrap(value)
 if(kind==='BoolExpr')return body.boolop==='AND_EXPR'&&list(body.args).some(arg=>joinsSides(arg,left,right))
 if(kind!=='A_Expr'||body.kind!=='AEXPR_OP')return false
 const operator=list(body.name)
 if(operator.length!==1||text(operator[0])!=='=')return false
 const side=(operand:unknown):'left'|'right'|undefined=>{
  if(operand===undefined)return undefined
  const [operandKind,column]=unwrap(operand)
  if(operandKind!=='ColumnRef')return undefined
  const parts=list(column.fields)
  if(parts.length!==2||unwrap(parts[0])[0]!=='String')return undefined
  const qualifier=text(parts[0])
  return left.has(qualifier)?'left':right.has(qualifier)?'right':undefined
 }
 const sides=new Set([side(body.lexpr),side(body.rexpr)])
 return sides.has('left')&&sides.has('right')
}

/** 未起别名的输出列名，按 PG 的命名习惯取：列引用取列名、函数取函数名、类型转换取内层，其余 `?column?`。 */
function outputName(value:unknown):string{
 const [kind,body]=unwrap(value)
 if(kind==='ColumnRef'){const parts=list(body.fields);return text(parts[parts.length-1])}
 if(kind==='FuncCall'){const parts=list(body.funcname);return text(parts[parts.length-1])}
 if(kind==='TypeCast'){const inner=outputName(body.arg);return inner==='?column?'&&isNode(body.typeName)?text(list(body.typeName.names).at(-1)):inner}
 return '?column?'
}

/** 解析器或校验器抛出的非 WorkError（栈溢出的 RangeError、wasm 内部错误等）统一转成固定文案，不把内部细节带给调用方。 */
function guarded<T>(run:()=>T):T{
 try{return run()}catch(error){if(error instanceof WorkError)throw error;throw invalid('SQL 过于复杂或无法解析。')}
}

/** 解析 + 白名单校验；失败一律 `teloa/invalid-input`，reason 写明具体项。 */
export function analyzeBusinessSql(sql:string,objectTypes:readonly BusinessObjectTypeDefinition[]):BusinessSqlAnalysis{
 return guarded(()=>{
  const {result,select}=parseOne(sql)
  const checker=new Checker(true,0,objectTypes)
  checker.select(select,[],new Map())
  return {ast:result,tables:checker.tables,ctes:checker.ctes,columnsByTable:checker.columnsByTable}
 })
}

/** Teloa 表所在模式名：只收普通小写标识符（deparse 不加引号也不漂移），`pg_` 开头的系统模式一律拒绝。 */
export function isBusinessSqlPlatformSchema(value:unknown):value is string{
 return typeof value==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(value)&&!value.startsWith('pg_')
}

/**
 * 对改写产物再做一遍同一套白名单，差异只有这几点：RangeVar 只允许 `<schema>.teloa_business_object_snapshots` 与 CTE 名；
 * FuncCall 额外放行 `jsonb_array_elements`（不带模式名，且只在 `from jsonb_array_elements(…) f` 的 RangeFunction 里放行，别处照常拒绝）
 * 与 `<schema>.teloa_safe_*`（必须带该模式名，不带或换成别的模式即拒）；ParamRef 允许 $1..$paramCount；`->`/`->>` 运算符；`distinct on`。不做列解析。
 * schema 是 Teloa 表所在模式（个人版为 public；验收宿主为独立 schema），由执行器初始化时按应用连接的 current_schema() 取得。
 */
export function verifyRewrittenBusinessSql(sql:string,paramCount:number,schema:string):void{
 // 0 = 无表产物（不得出现任何 $n）；有表产物至少带 owner/scope 两个平台参数。
 if(!Number.isSafeInteger(paramCount)||paramCount<0||paramCount===1)throw invalid('改写产物的参数个数不合法。')
 if(!isBusinessSqlPlatformSchema(schema))throw invalid('改写产物的模式名不合法。')
 guarded(()=>new Checker(false,paramCount,[],schema).select(parseOne(sql).select,[],new Map()))
}
