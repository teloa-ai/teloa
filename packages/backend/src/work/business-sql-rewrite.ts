import {isDeepStrictEqual} from 'node:util'
import {parseSync} from 'libpg-query'
import {deparseSync} from 'pgsql-deparser'
import {WorkError,type BusinessFieldType,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2,type BusinessWidgetDefinition,type BusinessTimeRange} from '@teloa/contract'
import {currentVersionSubquery} from './business-warehouse.ts'
import {analyzeBusinessSql,prepareBusinessSqlParser,isBusinessSqlPlatformSchema,verifyRewrittenBusinessSql,type BusinessSqlAnalysis} from './business-sql-guard.ts'

/** params 是**一维有序数组**，与产物里的 $n 一一对应：$1=ownerId，$2=scopeId，$3..$(2+k)=第 1..k 个逻辑表（按分析登记顺序）的 object_type id，其后依次为各字段标签（按生成顺序追加），
 * 接入整页时间范围时最后再追加一个区间文本（同一次改写只占一个位置）。
 * 不引用任何逻辑表时产物里没有 $n，params 为空（多传的参数在 PG 推不出类型，报 42P18）。tables 记录每个逻辑表分到的 object_type 占位序号，便于测试断言。 */
export type BusinessSqlRewrite={sql:string;params:string[];tables:Array<{logical:string;alias:string;objectTypeParam:number}>}

/** 声明类型 → 安全转换函数；text/enum/reference 保持原值 text。duration 折成秒数（纯秒数或 ISO 8601 时长，与契约 parseDurationSeconds 同口径）。 */
const castFunctions:Readonly<Record<BusinessFieldType,string|undefined>>={
 text:undefined,enum:undefined,reference:undefined,
 number:'teloa_safe_numeric',duration:'teloa_safe_duration_seconds',datetime:'teloa_safe_timestamptz',boolean:'teloa_safe_boolean',
}
const identifier=(name:string)=>'"'+name.replaceAll('"','""')+'"'
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
/** 解析器 / deparser 的内部异常不外露，统一转成固定文案。 */
function fixed<T>(run:()=>T):T{
 try{return run()}catch{throw new WorkError('teloa/invalid-input','SQL 过于复杂或无法解析。')}
}
const positional=new Set(['location','stmt_location','stmt_len','rexpr_list_start','rexpr_list_end','list_start','list_end'])
function withoutPositions(value:unknown):unknown{
 if(Array.isArray(value))return value.map(withoutPositions)
 if(typeof value!=='object'||value===null)return value
 return Object.fromEntries(Object.entries(value).filter(([key])=>!positional.has(key)).map(([key,item])=>[key,withoutPositions(item)]))
}

/**
 * 逻辑表 → `(select … from (currentVersionSubquery) s) <alias>`；快照表写作 `<schema>.teloa_business_object_snapshots`，转换函数写作 `<schema>.teloa_safe_*`
 * （执行时 search_path=pg_temp，不限定就找不到）。schema 是 Teloa 表所在模式（执行器初始化时取应用连接的 current_schema()，个人版为 public）。字段列 = 对象类型每个声明字段按 from 标签匹配后按类型安全转换；标签只走占位符，不拼进 SQL 文本。
 * 系统列固定六个；未被 SQL 引用的字段列也照常生成（简单、可预测）。`now()` 不改写，由执行器事务固化。
 * 分析结果不被修改：先连同待替换节点一起整体克隆，再在克隆上原位替换，最后 deparse 并做二次校验。
 * 往返校验：deparse 产物重新解析后（去掉位置字段）必须与克隆语法树深度相等——deparser 对某类名字不加引号或转义不足时，
 * 产物的语义会漂移（曾把 CTE 名里的文本拼成跨租户查询），这一步从根上拒绝任何漂移。
 *
 * 整页时间范围（二期规格 §3.2）：`options.timeFilter` 给出时，逻辑名等于 `logical` 的**每一处**引用在替换子查询外再包一层
 * `select * from (<替换子查询>) as teloa_range where teloa_range.<列> >= now() - $k::interval`。列名只能是该表的 datetime 字段或
 * `_observed_at` / `_synced_at`，走 `identifier()` 加引号；区间文本只走占位符（取值来自服务端常量表），`$k` 追加在参数末尾。
 * 包装在平台生成段里、别名作用域封闭，用户 SQL 的别名 / CTE 同名也够不着它。不传 timeFilter 时产物与一期逐字相同。
 * SQL 没有读取该表 → `teloa/invalid-input`：接了时间范围却不生效是沉默的错误结果。
 */
export function rewriteBusinessSql(analysis:BusinessSqlAnalysis,actor:{ownerId:string;scope:string},schema:string,options:{timeFilter?:{logical:string;column:string;interval:string}}={}):BusinessSqlRewrite{
 if(analysis.tables.some(table=>table.objectType.fields.some(field=>'format' in field||!(field.type in castFunctions))))throw new WorkError('teloa/dependency-unavailable','旧业务 SQL 尚不支持金额或多选字段。')
 if(!text(actor.ownerId,128)||!text(actor.scope,120))throw new WorkError('teloa/forbidden','需要有效的数据读取主体与业务范围。')
 if(!isBusinessSqlPlatformSchema(schema))throw new WorkError('teloa/invalid-input','快照表模式名不合法。')
 const range=options.timeFilter
 if(range){
  if(!text(range.interval,32))throw new WorkError('teloa/invalid-input','时间范围区间不合法。')
  const read=analysis.tables.filter(table=>table.logical===range.logical)
  if(!read.length)throw new WorkError('teloa/invalid-input','组件接入了时间范围，但 SQL 没有读取表 '+range.logical+'。')
  const column=range.column==='_observed_at'||range.column==='_synced_at'||read[0]!.objectType.fields.some(field=>field.name===range.column&&field.type==='datetime')
  if(!column)throw new WorkError('teloa/invalid-input','组件接入时间范围的列 '+range.column+' 不是表 '+range.logical+' 的时间字段。')
 }
 const cloned=structuredClone({ast:analysis.ast,nodes:analysis.tables.map(table=>table.node)})
 const params=analysis.tables.length?[actor.ownerId,actor.scope,...analysis.tables.map(table=>table.objectType.id)]:[]
 // 区间占位排在全部对象类型与字段标签之后：先按字段总数算出它的序号，生成各段时即可引用。
 const rangeParam=range?params.length+analysis.tables.reduce((total,table)=>total+table.objectType.fields.length,0)+1:0
 const tables=analysis.tables.map((table,index)=>{
  const objectTypeParam=3+index
  const columns=[
   's.object_id as _id','s.object_version as _version','s.source_id as _source','s.first_seen_at as _synced_at',
   `${schema}.teloa_safe_timestamptz(s.snapshot->>'observedAt') as _observed_at`,`${schema}.teloa_safe_timestamptz(s.snapshot->>'deletedAt') as _deleted_at`,
   ...table.objectType.fields.map(field=>{
    params.push(field.from)
    const value=`(select f->>'value' from jsonb_array_elements(s.snapshot->'fields') f where f->>'label' = $${params.length} limit 1)`
    const cast=castFunctions[field.type]
    return (cast?`${schema}.${cast}(${value})`:value)+' as '+identifier(field.name)
   }),
  ]
  const current=`select ${columns.join(', ')} from ${currentVersionSubquery(false,objectTypeParam,schema)} s`
  const scoped=range&&table.logical===range.logical?`select * from (${current}) as teloa_range where teloa_range.${identifier(range.column)} >= now() - $${rangeParam}::interval`:current
  const source=`select * from (${scoped}) as ${identifier(table.alias)}`
  const replacement=(fixed(()=>parseSync(source)).stmts![0]!.stmt as {SelectStmt:{fromClause:Array<{RangeSubselect:unknown}>}}).SelectStmt.fromClause[0]!.RangeSubselect
  const holder=cloned.nodes[index]!
  delete holder.RangeVar
  holder.RangeSubselect=replacement
  return {logical:table.logical,alias:table.alias,objectTypeParam}
 })
 if(range)params.push(range.interval)
 const sql=fixed(()=>deparseSync(cloned.ast as Parameters<typeof deparseSync>[0],{pretty:false}))
 if(!isDeepStrictEqual(withoutPositions(fixed(()=>parseSync(sql))),withoutPositions(cloned.ast)))throw new WorkError('teloa/invalid-input','SQL 改写前后语法树不一致，已拒绝。')
 verifyRewrittenBusinessSql(sql,params.length,schema)
 return {sql,params,tables}
}

/** 组件刷新和整体候选校验共用：只分析、改写及二次白名单，不执行查询。 */
export async function rewriteBusinessWidgetSql(ctx:{ownerId:string;scope:string;objectTypes:Array<BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2>},widget:BusinessWidgetDefinition,schema:string,range:BusinessTimeRange='all'):Promise<BusinessSqlRewrite>{
 if(ctx.objectTypes.some(type=>type.fields.some(field=>'format' in field)))throw new WorkError('teloa/dependency-unavailable','旧业务 SQL 尚不支持金额或多选字段。')
 await prepareBusinessSqlParser()
 const intervals={'24h':'24 hours','7d':'7 days','30d':'30 days','90d':'90 days'} as const
 const timeFilter=range!=='all'&&widget.timeFilter?{logical:widget.timeFilter.table,column:widget.timeFilter.column,interval:intervals[range]}:undefined
 return rewriteBusinessSql(analyzeBusinessSql(widget.query??'',ctx.objectTypes as BusinessObjectTypeDefinition[]),{ownerId:ctx.ownerId,scope:ctx.scope},schema,timeFilter?{timeFilter}:{})
}
