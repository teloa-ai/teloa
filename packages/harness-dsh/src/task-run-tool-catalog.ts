import {runContextMode,runContextToolNames,readAnalysisSelfAuthorizedTools,runAnalysisSelfAuthorizedTools} from '@teloa/contract'
import type {TaskRun} from '@teloa/backend'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import {selfAuthorizedToolNames} from './self-authorized-tools.ts'
import {groupAttachToolName} from './group-attach-tool.ts'
import {groupReactToolName} from './group-react-tool.ts'
import {groupMentionToolName} from './group-mention-tool.ts'
import {roleDailyDigestToolNames} from './role-daily-log.ts'
import {teamDelegationTools} from './role-tool-grants.ts'
import {taskRunPlanReportOccurrence} from './task-run-group-publisher.ts'

export type RunToolApplicability={group:boolean;digest:boolean;report?:boolean;context?:boolean;text?:boolean;selfAuthorizedTools?:readonly string[]}
const groupRunToolNames:readonly string[]=[groupAttachToolName,groupReactToolName,groupMentionToolName]

/** 父运行与真实子会话共用固定Run的适用范围，不从工具名或模型正文猜测。 */
export function runToolApplicability(run:Pick<TaskRun,'groupContext'|'inputText'>&Partial<Pick<TaskRun,'analysisScope'|'contextMode'>>,digest:boolean,text=false):RunToolApplicability{
 const auxiliary=text?runAnalysisSelfAuthorizedTools(run.analysisScope):[]
 return {group:run.groupContext!==undefined,context:run.contextMode===runContextMode,digest,report:taskRunPlanReportOccurrence(run)!==undefined,text,...(auxiliary.length?{selfAuthorizedTools:auxiliary}:{})}
}
export function runToolNames(allowedTools:readonly string[],applicable:RunToolApplicability):Set<string>{
 if(applicable.text)return new Set(readAnalysisSelfAuthorizedTools(applicable.selfAuthorizedTools))
 if(applicable.digest)return new Set(roleDailyDigestToolNames)
 const inapplicable=new Set<string>([...(applicable.context?[]:runContextToolNames),...(applicable.group?[]:groupRunToolNames.filter(name=>!applicable.report||name!==groupAttachToolName&&name!==groupMentionToolName)),...roleDailyDigestToolNames])
 const keep=new Set<string>([...allowedTools,...selfAuthorizedToolNames].filter(name=>!inapplicable.has(name)))
 if(allowedTools.some(name=>name.startsWith('mcp__playwright-mcp__')))keep.add('mcp__playwright-mcp__browser_close')
 return keep
}

/** 最终白名单覆盖子会话自有和迟注册schema；同时撤下不再可调用的工具说明。 */
export function filterRunToolAssembly(assembly:PromptAssembly,keep:ReadonlySet<string>):PromptAssembly{
 const permitted=(name:string)=>{const tool=name.match(/^tool:([^:]+)(?::.*)?$/)?.[1];return tool===undefined||keep.has(tool)}
 const team=teamDelegationTools.some(name=>keep.has(name))
 return {...assembly,tools:assembly.tools.filter(tool=>keep.has(tool.name)),sections:assembly.sections.filter(section=>permitted(section.name)&&(section.name!=='team:policy'||team)),contexts:assembly.contexts.filter(context=>permitted(context.name))}
}
