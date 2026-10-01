import {posix} from 'node:path'

const fields=['host','node','helper','helperHash','workspace','mode']
const version='0.1.7-rc.1'

/** 只验证部署坐标；连接、摘要核验、远端文件和进程执行由官方提供方负责。 */
export function createRemoteProfile(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('SSH 配置必须是对象。')
  if(Object.keys(input).some(key=>!fields.includes(key)))throw new Error('SSH 配置包含不支持的字段；不能传入 Web 组合或凭据。')
  if(typeof input.host!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(input.host))throw new Error('host 必须是已配置的 OpenSSH 主机别名。')
  for(const key of ['node','helper','workspace']){
    const value=input[key]
    if(typeof value!=='string'||!posix.isAbsolute(value)||/[\0\r\n]/.test(value)||value.split('/').some(part=>part==='.'||part==='..'))throw new Error(key+' 必须是无相对路径段的 POSIX 绝对路径。')
  }
  const workspace=posix.normalize(input.workspace).replace(/\/+$/,'')
  if(!workspace)throw new Error('workspace 不能是根目录。')
  for(const key of ['node','helper']){
    const path=posix.normalize(input[key])
    if(path==='/'||path===workspace||path.startsWith(workspace+'/')||['/tmp','/private/tmp','/var/tmp'].some(root=>path===root||path.startsWith(root+'/')))throw new Error(key+' 必须部署在工作区和临时目录之外。')
  }
  if(typeof input.helperHash!=='string'||!/^[0-9a-f]{64}$/.test(input.helperHash))throw new Error('helperHash 必须是已部署官方 helper 的小写 SHA-256。')
  const mode=input.mode??'workspace-write'
  if(!['read-only','workspace-write'].includes(mode))throw new Error('mode 只支持 read-only 或 workspace-write。')
  const ssh={host:input.host,node:posix.normalize(input.node),helper:posix.normalize(input.helper),helperHash:input.helperHash,workspace}
  return {
    manifest:{
      name:'teloa-remote-headless',private:true,type:'module',
      dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless']}},
      dependencies:{
        '@deepseek-ai/dsh-ssh':version,
        '@deepseek-ai/dsh-fs-ssh':version,
        '@deepseek-ai/dsh-subprocess-ssh':version,
        '@deepseek-ai/dsh-sandbox-ssh':version,
      },
    },
    patches:[
      // 官方 patch 的 name 是匹配条件，不能重命名条目：先停本地行再插入远端行。
      {id:'subprocess',disabled:true},
      {id:'sandbox',disabled:true},
      {id:'fs-sandbox',disabled:true},
      {insert:[
        {id:'teloa-ssh',name:'@deepseek-ai/dsh-ssh',required:true,config:ssh},
        {id:'teloa-subprocess-ssh',name:'@deepseek-ai/dsh-subprocess-ssh',required:true},
        {id:'teloa-sandbox-ssh',name:'@deepseek-ai/dsh-sandbox-ssh',required:true},
        {id:'teloa-fs-ssh',name:'@deepseek-ai/dsh-fs-ssh',required:true},
      ]},
      {id:'sandbox-policy',config:{mode,workspaceRoot:workspace}},
      // 无交互通道：需要审批的动作明确拒绝，不能默认为 Full access。
      {id:'approval',config:{policy:'never'}},
      {id:'permission',config:{presets:{
        'read-only':{sandbox:'read-only',approval:'never'},
        'workspace-write':{sandbox:'workspace-write',approval:'never'},
      }}},
      {id:'tools',config:{mode:'native'}},
      // 首期只承接 FS/Bash/终端；不能让本机 bootstrap 被当作远端文件执行。
      {id:'ptc-runtime',disabled:true},
      {id:'workflow-ptc',disabled:true},
      {id:'tool-workflow',disabled:true},
      {id:'tool-ralph',disabled:true},
      {id:'session-telemetry-otel',config:{mode:'DISABLED'}},
    ],
  }
}
