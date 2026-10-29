import {readBusinessConfigurationPatchVersioned,readBusinessSourceMappingDefinition,businessSourceMappingLimits,businessSyncLimits,businessConfigurationLimits,scheduleTimezones} from '@teloa/contract'
import type {BusinessConfigurationDraft} from '@teloa/backend'

/** 工具回包提供静态声明格式；示例经正式读取器校验，不读取业务数据或执行同步。 */
export function businessBuilderSourceMappingProtocol(draft:BusinessConfigurationDraft){
 const sourceId=draft.candidate.sources.find(source=>source.kind==='local-records')?.sourceId
 if(!sourceId)return undefined
 const used=new Set(draft.candidate.definitions.map(item=>item.definition.id))
 const fresh=(base:string)=>{let id=base,index=1;while(used.has(id))id=base+'-'+ ++index;used.add(id);return id}
 const objectType=fresh('example-result'),mappingId=fresh('example-result-mapping')
 const object={format:draft.candidate.format==='teloa.business-configuration/v1'?'teloa.business-object-type/v1':'teloa.business-object-type/v2',id:objectType,version:'1.0.0',domain:draft.scope,title:'业务对象处理成果',unit:'条',lead:'保存已关联业务对象的最终处理成果，保留原对象。',sourceId,fields:[
  {name:'source_object_id',label:'原对象',from:'原对象',type:'text',required:true},
  {name:'task_id',label:'任务',from:'任务',type:'text',required:false},
  {name:'run_id',label:'本轮运行',from:'本轮运行',type:'text',required:false},
  {name:'employee_id',label:'员工',from:'员工',type:'text',required:false},
  {name:'finding',label:'处理结论',from:'处理结论',type:'text',required:false},
 ]}
 const definition=readBusinessSourceMappingDefinition({format:'teloa.business-source-mapping/v1',id:mappingId,version:'1.0.0',domain:draft.scope,title:'业务对象成果映射',objectType,source:{kind:'role-result'},mapping:[
  {path:'$.object.id',field:'source_object_id'},
  {path:'$.task.id',field:'task_id'},
  {path:'$.run.id',field:'run_id'},
  {path:'$.employee.id',field:'employee_id'},
  {path:'$.result.summary',field:'finding'},
 ],primaryKey:['source_object_id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:3600},acknowledgeShortInterval:false})
 const example=readBusinessConfigurationPatchVersioned({upsertDefinitions:[{kind:'object-type',definition:object},{kind:'source-mapping',definition}]},draft.candidate.format)
 const existing=draft.candidate.definitions.find(item=>item.kind==='source-mapping')
 return {
  format:'teloa.business-source-mapping/v1',
  required:['format','id','version','domain','title','objectType','source','mapping','primaryKey','deletionSemantics','schedule','acknowledgeShortInterval'],
  optional:['localized','incrementalCursor','deletedAtPath','retentionDays','pageSize'],
  limits:{...businessSourceMappingLimits,retentionDays:[1,365],pageSize:[1,100]},
  sourceKinds:{
   'role-result':{required:['kind'],optional:['roleId'],rules:'员工成果。roleId如填写须来自真实员工目录；省略时也不授予任何员工权限。固定业务对象成果使用宿主的 $.object.id 为唯一主键；任务、Run、员工身份取 $.task.id / $.run.id / $.employee.id，不能由模型填写；业务结论取 $.result. 下本人授权的结果字段。成果写入独立结果对象类型，不覆盖原始告警或对象。采用映射后，已授权的固定任务通过 teloa_business_object_result_record 写入本地成果；不需要启用外部adapter或周期同步，不能把外部同步授权当作成果写入的前置条件。看板统计已实际写入的成果，映射本身不会自动产生调查结果。'},
   'mcp-tool':{required:['kind','serverName','tool','arguments','itemsPath'],optional:['pagination'],rules:'serverName和原始tool名须从已连接服务的真实目录读取，工具须经本人确认为只读并具备当前业务授权，不编造。arguments为最多32项的字符串/数字/布尔对象，不含凭据。itemsPath为工具真实回包内的记录路径；可选pagination:{cursorArgument,nextCursorPath}，不与arguments已有键重名。声明不调用MCP工具。'},
   'business-data-port':{required:['kind','sourceId'],optional:[],rules:'使用真实业务数据端口sourceId，不能把local-records冒充外部端口。仅此来源允许mapping:[]原样落库，此时primaryKey固定为["id"]、deletionSemantics为compare。'},
  },
  mapping:{itemKeys:['path','field'],rules:'mapping是数组，每项精确为{path,field}。field是目标对象类型的字段name或平台列title/summary/observedAt，不能写标签或未知字段，目标不得重复。primaryKey为1–3个已映射的目标field；固定对象成果只用映射自$.object.id的一个字段。JSONPath只支持$、.name、[\'name\']、[n]；[*]只能是itemsPath末段，不支持脚本、过滤或递归。'},
  deletion:{values:['compare','tombstone'],rules:'compare不得写deletedAtPath；tombstone必须写合法的deletedAtPath。incrementalCursor可选且精确为{path,kind:"timestamp"或"sequence"}；MCP同时使用增量水位时pagination.cursorArgument不能叫cursor。'},
  schedule:{kinds:['every','hourly','daily','cron'],every:{kind:'every',seconds:3600},timezones:scheduleTimezones,limits:businessSyncLimits,rules:'every使用seconds，hourly使用minute，daily使用time/timezone，cron使用expression/timezone。acknowledgeShortInterval是定义顶层布尔值，不放进schedule。按source分支说明执行方式：role-result的schedule仅为声明兼容字段，本地成果由已授权固定任务的 teloa_business_object_result_record 写入，不要求外部adapter或周期同步授权；不能引导本人为成果映射启用持续同步。只有mcp-tool或business-data-port等外部来源需要持续拉取时，才由本人另行启用该来源的周期同步；声明和采用本身不会启动外部同步。'},
  update:{tool:'teloa_business_builder_revise',input:'patchJson',rules:'先read取得当前draftId/revision及目录；按nextCursor继续分页，用definition:{kind,localId}读取目标映射和object-type完整正文。upsertDefinitions按kind+definition.id新增或完整替换这一条定义；只传本次变更，未出现在patch的定义/页面均保留。追加一条映射时patch只含upsertDefinitions:[{kind:"source-mapping",definition:完整映射对象}]；不重发或清空已有页面，不加removeDefinitions/removePageIds/pageOrder。已有目标对象类型与字段无需再次upsert；确需新建或修改目标类型时才一并提交完整object-type。domain必须为本read的scope，objectType和mapping.field须与真实目标相符；附件中的映射保留原结构，只替换经读取核实的范围及目标标识。每次成功后使用新revision，未知先read核对，不重复新建。缺少格式信息时重读builder能力，不读取平台源码，不切到definitions独立草案或完整消息保存工具。'},
  ...(existing?{readExistingExample:{definition:{kind:'source-mapping',localId:existing.definition.id}}}:{}),
  exampleOnly:true,examplePurpose:'仅示范新增独立成果对象类型及其映射的完整结构；未保存。已有结果对象时使用它的真实id和字段，不照抄示例新建重复类型。',
  canAddExample:draft.candidate.definitions.length+2<=businessConfigurationLimits.definitions,
  examplePatchJson:JSON.stringify(example),
 }
}
