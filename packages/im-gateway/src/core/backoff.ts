/** 渠道断线重连的最大尝试次数。 */
export const maxReconnectAttempts=10

/** 第 attempt 次（≥1）重连前的等待：1000*2^(attempt-1) 毫秒，上限 60000。 */
export function reconnectDelayMs(attempt:number):number{
 return Math.min(60_000,1000*2**(attempt-1))
}
