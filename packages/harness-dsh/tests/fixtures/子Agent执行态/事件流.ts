import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {createUserMessage} from '@deepseek-ai/dsh-llm'

/**
 * 执行态的轮次身份属于父策略会话。子 Agent 的首条消息由驱动写入，故刻意没有 rpcId；
 * 若守卫错误地核对子会话自身，这条夹具应让它拒绝，不能把没有 rpcId 当作可放行。
 */
export const 子Agent执行态事件流={
 nativeRequestId:'owned-native-request',
 父会话:{
  turnStart:{type:'turn/start' as const,data:{turn:0}},
  request:{type:'user/message' as const,surfaceOp:'append' as const,data:createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('owned-native-request')}})},
  otherRequest:{type:'user/message' as const,surfaceOp:'append' as const,data:createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('other-request')}})},
  turnEnd:{type:'turn/end' as const,data:{turn:0,reason:{kind:'completed' as const}}},
 },
 子会话:{
  turnStart:{type:'turn/start' as const,data:{turn:0}},
  driverMessage:{type:'user/message' as const,surfaceOp:'append' as const,data:createUserMessage({content:[],source:{kind:'user'}})},
 },
} as const
