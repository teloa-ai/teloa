export type EmployeeWorkState='queued'|'running'|'waiting'|'succeeded'|'failed'|'cancel_requested'|'cancelled'
export type EmployeeApiPermission='read'|'execute'|'cancel'
export type EmployeePermissionMode='danger-full-access'|'workspace-write'|'read-only'
export type EmployeeModelSelection={provider:string;model:string;reasoningEffort?:string}
export type Employee={id:string;version:number;name:string;description:string;scope:string;state:'active'|'unavailable'}
export type EmployeeWork={id:string;employeeId:string;employeeVersion:number;version:number;round:number;state:EmployeeWorkState;title:string;createdAt:string;updatedAt:string;resultVersion:number|null;error:string|null;permissionMode:EmployeePermissionMode;model:EmployeeModelSelection|null;links:{self:string;result:string;events:string}}
export type EmployeeWorkResult={workId:string;version:number;round:number;text:string;sha256:string;createdAt:string;review:'accepted'|'unreviewed'}
export type EmployeeWorkEvent={specversion:'1.0';id:string;source:string;type:'ai.teloa.work.changed.v1';subject:string;time:string;datacontenttype:'application/json';data:EmployeeWork}
export type StartWorkInput={employeeId:string;input:string;title?:string;permissionMode?:EmployeePermissionMode;model?:EmployeeModelSelection}
export type ContinueWorkInput={expectedVersion:number;input:string;permissionMode?:EmployeePermissionMode;model?:EmployeeModelSelection}
export type CancelWorkInput={expectedVersion:number}
export class EmployeeApiError extends Error{code:string;status:number;requestId?:string;constructor(code:string,message:string,status?:number,requestId?:string)}
export const employeeApiVersion:string
export const employeeApiStates:readonly EmployeeWorkState[]
export const employeeApiPermissions:readonly EmployeeApiPermission[]
export const employeeApiPermissionModes:readonly EmployeePermissionMode[]
export const employeeApiScopes:Readonly<Record<EmployeeApiPermission,string>>
export const uuidPattern:string
export const employeeApiSchemas:Readonly<Record<string,any>>
export const employeeApiOperations:readonly {id:string;method:string;path:string;permission:string;body?:string;response?:string;list?:boolean;idempotent?:boolean;status?:number;events?:boolean;resultVersion?:boolean}[]
export function employeeApiId(value:unknown):string
export function employeeApiEndpoint(value:string):string
export function readEmployeeApiPermissionMode(value:unknown):EmployeePermissionMode
export function readEmployeeApiModel(value:unknown):EmployeeModelSelection
export function readEmployeeApiRequest(kind:'StartWork',value:unknown):StartWorkInput
export function readEmployeeApiRequest(kind:'ContinueWork',value:unknown):ContinueWorkInput
export function readEmployeeApiRequest(kind:'CancelWork',value:unknown):CancelWorkInput
