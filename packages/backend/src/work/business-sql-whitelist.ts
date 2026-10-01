/**
 * 看板 SQL 语法树白名单（规格 §4.2「白名单第一部分：允许的函数」「白名单第二部分：允许的 AST 节点类型」）。
 * 节点名是 libpg_query 的节点名；函数按剥掉可选 `pg_catalog` 前缀后的**用户可见名**匹配（见 `businessSqlSyntaxFunctionAliases`）。
 * 这里只放常量，判定逻辑在 `business-sql-guard.ts`。
 */
export const businessSqlAllowedFunctions:ReadonlySet<string>=new Set([
 'count','sum','avg','min','max','stddev','stddev_samp','stddev_pop','percentile_cont','percentile_disc',
 'now','date_trunc','extract','date_part','to_char','make_interval','age',
 'concat','length','substring','lower','upper','trim','split_part','left','right',
 'abs','round','ceil','floor','greatest','least','power','sqrt',
 'row_number','lag','lead','rank',
])

/** 显式禁止：即使将来误入允许集也先按这张表拒绝。 */
export const businessSqlForbiddenFunctions:ReadonlySet<string>=new Set([
 'clock_timestamp','timeofday','statement_timestamp','transaction_timestamp','random','setseed',
 'pg_sleep','pg_read_file','pg_read_binary_file','pg_ls_dir','pg_stat_file',
 'xpath','xmltable','query_to_xml','table_to_xml','database_to_xml','set_config','current_setting',
])
export const businessSqlForbiddenFunctionPrefixes=['pg_','lo_','dblink'] as const
/** 只有这两个函数允许（且必须）带 WITHIN GROUP。 */
export const businessSqlWithinGroupFunctions=['percentile_cont','percentile_disc'] as const

/**
 * 允许的节点。带条件的几项由校验器逐项判定：SelectStmt 的 op 仅 SETOP_NONE|SETOP_UNION、valuesLists 元素仅 A_Const；
 * RangeSubselect.lateral 必须 false；NamedArgExpr 仅出现在 `businessSqlNamedArgFunctions` 的实参里；SQLValueFunction 仅 SVFOP_CURRENT_DATE。
 */
export const businessSqlAllowedNodes:ReadonlySet<string>=new Set([
 'SelectStmt','WithClause','CommonTableExpr','RangeSubselect','RangeVar','JoinExpr','SortBy','WindowDef','ResTarget',
 'ColumnRef','A_Const','A_Expr','BoolExpr','NullTest','BooleanTest','CaseExpr','CaseWhen','CoalesceExpr','NullIfExpr','MinMaxExpr',
 'TypeCast','TypeName','FuncCall','NamedArgExpr','SubLink','Alias','String','Integer','Float','Boolean','Null','List','A_Star','SQLValueFunction',
])

/** 比对前先剥 `TypeName.names` 里的 `pg_catalog` 前缀（`bigint` 解析为 `[pg_catalog,int8]`，`int8` 解析为 `[int8]`）。 */
export const businessSqlAllowedCastTypes:ReadonlySet<string>=new Set(['numeric','integer','int4','int8','bigint','text','timestamptz','date','interval','bool','boolean'])

/** PG14+ 把部分 SQL 标准语法解析成 funcname=[pg_catalog,<内部名>] 且 funcformat=COERCE_SQL_SYNTAX 的 FuncCall；白名单按剥前缀后的**用户可见名**匹配，这张表把内部名映回可见名。 */
export const businessSqlSyntaxFunctionAliases={btrim:'trim',ltrim:'trim',rtrim:'trim',extract:'extract',date_part:'date_part',substring:'substring',position:'position',overlay:'overlay',timezone:'timezone'} as const   // position/overlay/timezone 不在允许集，映射后照常被拒——表只负责还原名字，不放行

/** 唯一允许 NamedArgExpr 的函数；其 name 只允许下面七个参数名。 */
export const businessSqlNamedArgFunctions=['make_interval'] as const
export const businessSqlNamedArgNames:ReadonlySet<string>=new Set(['years','months','weeks','days','hours','mins','secs'])

/** 每张逻辑表固定带的六个系统列与其 SQL 类型；只在改写产物里生成，不落库。 */
export const businessSqlSystemColumns={_id:'text',_version:'integer',_source:'text',_synced_at:'timestamptz',_observed_at:'timestamptz',_deleted_at:'timestamptz'} as const
