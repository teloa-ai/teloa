/**
 * 一期 IM 命令（规格 §9）：只有八条；不搬上游 /workspace /bind /continue /file。
 * 命令词大小写不敏感，中英别名等价；Telegram 群里的 `/cmd@bot` 后缀忽略。
 */
export type Command={name:'pair';code:string}|{name:'new'}|{name:'status'}|{name:'stop'}|{name:'colleague';query?:string}|{name:'tasks'}|{name:'attention'}|{name:'help'}

export const commandNames:readonly string[]=['/pair','/new','/status','/stop','/colleague','/tasks','/attention','/help']

/** /help 回复的八行说明，与 commandNames 一一对应。 */
export const commandHelp:readonly string[]=[
 '/pair <配对码>：绑定本账号（仅私聊）',
 '/new：新开一个会话',
 '/status：查看当前对话对象',
 '/stop：停止当前回复',
 '/同事 [名字]（/colleague）：列出或切换同事，「/同事 助理」切回助理',
 '/任务（/tasks）：最近任务',
 '/需要你（/attention）：待你处理的事项',
 '/help：命令说明',
]

const aliases:Record<string,Command['name']|undefined>={
 '/pair':'pair','/new':'new','/status':'status','/stop':'stop','/colleague':'colleague','/同事':'colleague',
 '/tasks':'tasks','/任务':'tasks','/attention':'attention','/需要你':'attention','/help':'help',
}

export function parseCommand(text:string):Command|undefined{
 const match=/^(\/\S+?)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
 if(!match)return undefined
 const name=aliases[match[1]!.toLowerCase()]
 const rest=match[2]?.trim()??''
 if(name===undefined)return undefined
 if(name==='pair')return /^\d{6}$/.test(rest)?{name,code:rest}:undefined
 if(name==='colleague')return rest?{name,query:rest}:{name}
 return {name}
}
