import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session'
import {isNativeChildSession} from './main-session.ts'

/** 业务归属已由服务端核验；这里仅确认原身份可见，不把已有工作再次交给 create。 */
export async function readNativeSessionForOpening(sessions:ISessions,sessionId:string):Promise<SessionId>{
 const id=brandString<SessionId>(sessionId)
 await sessions.refresh()
 if(!sessions.list.getSnapshot().byId[id]||isNativeChildSession(sessions,id))throw Error('原工作会话目录暂时无法核对。')
 return id
}
