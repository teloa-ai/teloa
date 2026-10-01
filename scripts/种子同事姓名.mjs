// 稳定键与旧中文名仅用于认领历史种子；新建展示名统一使用英文。
export const seedRoleNames={
 'lin-xi':{name:'Alex Morgan',legacyName:'林析'},
 'zhou-heng':{name:'Jordan Lee',legacyName:'周衡'},
 'cheng-jian':{name:'Sam Taylor',legacyName:'程简'},
}

/** 复用旧创建指纹，不把改默认名变成新建请求，也不覆盖用户后来的编辑。 */
export async function ensureNamedSeedRole({pool,service,ownerId,requestId,key,fields}){
 const names=seedRoleNames[key]
 if(!names||fields.name!==names.name)throw Error('种子岗位姓名与固定映射不一致。')
 const existing=(await pool.query("select request_spec->>'name' name from teloa_roles where owner_id=$1 and request_id=$2",[ownerId,requestId])).rows[0]
 const name=existing?.name===names.legacyName?names.legacyName:names.name
 // 只允许姓名的这一处已知历史差异，其余字段仍由正式 create 完整核对。
 return service.create(ownerId,{requestId,fields:{...fields,name}})
}

/** 固定对象 v1 不可原地换名；旧库复放原姓名，新库直接写英文。 */
export async function preserveSeedObjectNames(pool,ownerId,items){
 const result=[]
 for(const item of items){
  const field=item.fields.find(value=>value.label==='负责同事')
  const names=Object.values(seedRoleNames).find(value=>value.name===field?.value)
  if(!names){result.push(item);continue}
  const stored=(await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5',[ownerId,item.scope,item.type,item.id,item.version])).rows[0]
  const previous=stored?.snapshot?.fields?.find(value=>value.label==='负责同事')
  // 不复用整份旧正文：其他字段有变化时，正式来源校验仍会拒绝改写固定快照。
  result.push(previous?.value===names.legacyName?{...item,fields:item.fields.map(value=>value===field?{...value,value:names.legacyName}:value)}:item)
 }
 return result
}
