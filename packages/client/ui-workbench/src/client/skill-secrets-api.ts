// 技能密钥客户端 API：密钥只随 save 请求提交；任何回包不含密钥值。
type Call=(method:string,payload:unknown)=>Promise<unknown>
export type SkillSecretEndpoint={origin:string;pathPrefixes:string[]}
/** 每个变量附带目录声明的注入位置（target/name）与目标地址（endpoints），供页面如实显示「此密钥将发往何处」。 */
export type SkillSecretVar={envVarName:string;label:{'zh-CN':string;en:string};required:boolean;configured:boolean;target:'bearer'|'header'|'query';name?:string;endpoints:SkillSecretEndpoint[]}
/**
 * vars 为空：当前生效的不是声明密钥的市场安装（未安装、非市场来源或被同名技能遮蔽），页面显示「需先安装」。
 * group：共享密钥组（目录内同组技能名，按名排序）；保存与删除作用于整组。
 */
export type SkillSecretsState={skill:string;binding:string|null;writable:boolean;reconfirm:boolean;vars:SkillSecretVar[];group?:{id:string;members:string[]}}
const skillPat=/^[a-z][a-z0-9-]{0,63}$/,varPat=/^[A-Z][A-Z0-9_]{1,63}$/,groupPat=/^[a-z][a-z0-9-]{1,63}$/
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error()
 return value as Record<string,unknown>
}
const httpsOrigin=(value:unknown):value is string=>{
 if(typeof value!=='string')return false
 try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value}catch{return false}
}
function readVar(item:unknown):SkillSecretVar{
 const named=!!item&&typeof item==='object'&&'target' in item&&(item.target==='header'||item.target==='query')
 const v=exact(item,['envVarName','label','required','configured','target','endpoints',...(named?['name']:[])]),label=exact(v.label,['zh-CN','en'])
 if(typeof v.envVarName!=='string'||!varPat.test(v.envVarName)||typeof label['zh-CN']!=='string'||typeof label.en!=='string'||typeof v.required!=='boolean'||typeof v.configured!=='boolean')throw Error()
 if(v.target!=='bearer'&&v.target!=='header'&&v.target!=='query')throw Error()
 // bearer 固定放 Authorization，不带 name；header/query 必须带 name。
 if((v.target!=='bearer')!==(typeof v.name==='string'&&v.name.length>0))throw Error()
 if(!Array.isArray(v.endpoints)||!v.endpoints.length)throw Error()
 const endpoints=v.endpoints.map(entry=>{
  const row=exact(entry,['origin','pathPrefixes'])
  if(!httpsOrigin(row.origin)||!Array.isArray(row.pathPrefixes)||!row.pathPrefixes.length||!row.pathPrefixes.every(prefix=>typeof prefix==='string'&&prefix.startsWith('/')))throw Error()
  return {origin:row.origin,pathPrefixes:[...row.pathPrefixes] as string[]}
 })
 return {envVarName:v.envVarName,label:{'zh-CN':label['zh-CN'],en:label.en},required:v.required,configured:v.configured,target:v.target,...(typeof v.name==='string'?{name:v.name}:{}),endpoints}
}
function readState(value:unknown):SkillSecretsState{
 try{
  const grouped=!!value&&typeof value==='object'&&Object.hasOwn(value,'group')
  const row=exact(value,['skill','binding','writable','reconfirm','vars',...(grouped?['group']:[])])
  if(typeof row.skill!=='string'||!skillPat.test(row.skill)||typeof row.writable!=='boolean'||typeof row.reconfirm!=='boolean'||!Array.isArray(row.vars))throw Error()
  if(row.vars.length?(typeof row.binding!=='string'||!/^[a-f0-9]{64}$/.test(row.binding)):row.binding!==null)throw Error()
  let group:{id:string;members:string[]}|undefined
  if(grouped){
   // 组只随有效声明出现；成员须为技能名且含本技能。
   const g=exact(row.group,['id','members'])
   if(!row.vars.length||typeof g.id!=='string'||!groupPat.test(g.id)||!Array.isArray(g.members)||!g.members.every(name=>typeof name==='string'&&skillPat.test(name))||!g.members.includes(row.skill))throw Error()
   group={id:g.id,members:[...g.members] as string[]}
  }
  return {skill:row.skill,binding:row.binding as string|null,writable:row.writable,reconfirm:row.reconfirm,vars:row.vars.map(readVar),...(group?{group}:{})}
 }catch{throw Error('技能密钥回包格式不正确。')}
}
const checkSkill=(skill:string)=>{if(!skillPat.test(skill))throw Error('技能名格式不正确。')}
/**
 * 「已添加」卡片徽标：密钥：已保存 / 未填写 / 需重新确认；另有两种不能说「未填写」的状态——
 * 当前生效的不是声明密钥的市场安装（需先安装）、存储锁定或只读（此时宿主读不到记录，已保存与否不可知）。
 */
export function skillSecretsBadge(state:SkillSecretsState,t:(key:string)=>string):string{
 const status=!state.vars.length?t('market.skillSecrets.needsInstallShort'):!state.writable?t('market.skillSecrets.lockedShort'):state.reconfirm?t('market.skillSecrets.reconfirmShort'):state.vars.every(v=>v.configured||!v.required)&&state.vars.some(v=>v.configured)?t('market.skillSecrets.saved'):t('market.skillSecrets.missing')
 return `${t('market.skillSecrets.open')}：${status}`
}
export type SkillSecretsApi=ReturnType<typeof createSkillSecretsApi>
export function createSkillSecretsApi(call:Call){
 return {
  async describe(skill:string){checkSkill(skill);return readState(await call('skill-secrets/describe',{skill}))},
  async save(skill:string,values:Record<string,string>,expectedBinding:string){
   checkSkill(skill)
   if(typeof expectedBinding!=='string'||!/^[a-f0-9]{64}$/.test(expectedBinding))throw Error('技能密钥说明的校验值格式不正确。')
   for(const [name,value] of Object.entries(values))if(!varPat.test(name)||typeof value!=='string')throw Error('密钥变量名格式不正确。')
   return readState(await call('skill-secrets/save',{skill,values,expectedBinding}))
  },
  async remove(skill:string){checkSkill(skill);return readState(await call('skill-secrets/delete',{skill}))},
 }
}
