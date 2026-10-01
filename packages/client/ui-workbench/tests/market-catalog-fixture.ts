// 官方目录条目样例：客户端 API 与目录卡片渲染测试共用。
export const solutionEntry=()=>({format:'teloa.market-catalog-entry/v1',id:'teloa.office',kind:'solution',delivery:'install',version:'1.0.0',taxonomy:{functions:['office-docs'],industries:['general']},upstream:null,
 solution:{packageId:'office',title:{'zh-CN':'通用办公','en':'General Office'},summary:{'zh-CN':'日常办公自动化方案。','en':'Everyday office automation.'},scope:'office',capabilities:{
  now:[{'zh-CN':'起草邮件与会议纪要','en':'Draft emails and meeting notes'},{'zh-CN':'整理工作计划','en':'Organize work plans'},{'zh-CN':'生成周报','en':'Generate weekly reports'}],
  needs:[{'zh-CN':'提供会议录音或文字稿','en':'Provide meeting recordings or transcripts'}],
  permissions:[{'zh-CN':'读取日历事件','en':'Read calendar events'}],
 }},
 modifications:[],license:{spdx:'Apache-2.0',files:['LICENSE']},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}})
export const catalogEntry=()=>({format:'teloa.market-catalog-entry/v1',id:'anthropic.internal-comms',kind:'skill',delivery:'install',version:'1.0.0',taxonomy:{functions:['communication'],industries:['general']},
 skill:{name:'internal-comms',title:{'zh-CN':'内部沟通稿',en:'Internal communications'},summary:{'zh-CN':'起草周报与简讯。',en:'Drafts reports.'}},
 upstream:{ecosystem:'anthropic',author:'Anthropic',repository:{host:'github.com',owner:'anthropics',repo:'skills'},commit:'33375500bcea98d610eb30ce10ac4e59b89c390d',path:'skills/internal-comms',license:'Apache-2.0',files:[{path:'SKILL.md',gitBlob:'56ea935b74f371bfeb4c7d3c19d5139df866e73b',size:1511}]},
 modifications:[],license:{spdx:'Apache-2.0',files:['LICENSE.txt']},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}})
export const roleEntry=()=>({format:'teloa.market-catalog-entry/v1',id:'teloa.role.test-role',kind:'role',delivery:'install',version:'1.0.0',upstream:null,
 taxonomy:{functions:['office-docs'],industries:['general']},
 role:{roleId:'test-role',title:{'zh-CN':'测试岗',en:'Test role'},summary:{'zh-CN':'测试。',en:'Test.'},
  definition:{name:'测试岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility:{triggers:['收到任务'],autonomousActions:['读取'],confirmationPoints:['外发确认'],escalationRules:['冲突升级'],deliveryChecks:['有来源']}},
  skills:['tool-a'],scope:'test',preferredModel:null,fromSolution:{packageId:'test-sol',version:'1.0.0',path:'roles/test-role.json'}},
 modifications:[],license:{spdx:'MIT',files:[],url:'https://opensource.org/license/mit'},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}})
export const modelEntry=()=>({format:'teloa.market-catalog-entry/v1',id:'teloa.model.test-model',kind:'model',delivery:'reference',version:'1.0.0',upstream:null,
 taxonomy:{functions:['other'],industries:['general']},
 model:{modelId:'test-model',title:{'zh-CN':'测试模型',en:'Test model'},summary:{'zh-CN':'测试。',en:'Test.'},form:'cloud',usage:['chat'],capabilities:{tools:true,vision:false,reasoning:false,structured:true},contextWindow:32000,
  license:{spdx:'custom',name:'服务条款',url:'https://example.com/terms',tier:'commercial',restrictions:[] as {'zh-CN':string;en:string}[]},cnReachable:'direct',support:'supported',notes:[],
  cloud:{provider:{kind:'pi-ai',id:'deepseek'},models:[{id:'m1',name:'M1',contextWindow:32000,maxTokens:4096,input:['text']}],priceBand:'low',credentialLabel:{'zh-CN':'密钥',en:'Key'},signupUrl:'https://example.com'}},
 modifications:[],license:{spdx:'custom',files:[],url:'https://example.com/terms'},
 compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}})
// 二次开发条目样例：5 条修改跨 3 类（输入顺序故意打乱，界面按类优先级分组、组内按 id 升序），1 个未修改文件，2 条原版没有的新文件。
const derivativeCommit='33375500bcea98d610eb30ce10ac4e59b89c390d'
const derivativeSource=(path:string)=>'anthropics/skills@'+derivativeCommit+':skills/internal-comms/'+path
const derivativeChange=(id:string,type:string,path:string,upstream:string|null,section?:string)=>({id,type,path,...(section?{section}:{}),upstream,summary:{'zh-CN':'摘要 '+id,en:'Summary '+id},reason:{'zh-CN':'原因说明 '+id,en:'Reason '+id}})
export const derivativeEntry=()=>({...catalogEntry(),id:'anthropic.internal-comms-plus',version:'1.1.0',
 skill:{name:'internal-comms-plus',title:{'zh-CN':'内部沟通稿（增强）',en:'Internal communications plus'},summary:{'zh-CN':'起草周报与简讯。',en:'Drafts reports.'}},
 upstream:{...catalogEntry().upstream,files:[
  {path:'SKILL.md',gitBlob:'56ea935b74f371bfeb4c7d3c19d5139df866e73b',size:1511,sha256:'1'.repeat(64)},
  {path:'LICENSE.txt',gitBlob:'66ea935b74f371bfeb4c7d3c19d5139df866e73b',size:11357,sha256:'2'.repeat(64)},
  {path:'references/guide.md',gitBlob:'76ea935b74f371bfeb4c7d3c19d5139df866e73b',size:900,sha256:'3'.repeat(64)},
 ]},
 derivation:{unchangedFiles:['LICENSE.txt'],changes:[
  derivativeChange('ICM-M04','added','references/new.md',null),
  derivativeChange('ICM-M03','fixed','SKILL.md',derivativeSource('SKILL.md'),'§2'),
  derivativeChange('ICM-M02','security','references/guide.md',derivativeSource('references/guide.md')),
  derivativeChange('ICM-M05','added','references/extra notes.md',null),
  derivativeChange('ICM-M01','security','SKILL.md',derivativeSource('SKILL.md'),'L10-L24'),
 ]},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]}})
