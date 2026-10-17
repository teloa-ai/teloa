import type {pendingLegacyTeamMessages} from '../packages/harness-dsh/src/task-run-team-records.ts'

export function inspectLegacyTeamMessages(input:{root:string;sessionId:string;compression?:'none'|'zstd'}):Promise<{
 sessionId:string;pending:ReturnType<typeof pendingLegacyTeamMessages>;action:'review-required';automaticReplay:false
}>
