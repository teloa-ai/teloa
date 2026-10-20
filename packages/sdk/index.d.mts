import type {Employee,EmployeeWork,EmployeeWorkResult,EmployeeWorkEvent,StartWorkInput,ContinueWorkInput,CancelWorkInput} from './contract.mjs'
export type * from './contract.mjs'
export {EmployeeApiError} from './contract.mjs'
export type RequestOptions={signal?:AbortSignal}
export type MutationOptions=RequestOptions&{requestId:string}
export class TeloaClient{
 constructor(options:{baseUrl:string;apiKey:string;fetch?:typeof fetch;timeoutMs?:number})
 listEmployees(options?:RequestOptions):Promise<{items:Employee[]}>
 startWork(input:StartWorkInput,options:MutationOptions):Promise<EmployeeWork>
 getWork(id:string,options?:RequestOptions):Promise<EmployeeWork>
 continueWork(id:string,input:ContinueWorkInput,options:MutationOptions):Promise<EmployeeWork>
 cancelWork(id:string,input:CancelWorkInput,options:MutationOptions):Promise<EmployeeWork>
 getResult(id:string,options?:RequestOptions&{version?:number}):Promise<EmployeeWorkResult>
 listEvents(id:string,options?:RequestOptions&{after?:number}):Promise<{items:{cursor:number;event:EmployeeWorkEvent}[];nextCursor:number}>
}
export function verifyWebhook(input:{body:string;secret:string;timestamp:string;signature:string;now?:number;toleranceMs?:number}):Promise<boolean>
