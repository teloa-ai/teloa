import type {ChildProcessByStdio} from 'node:child_process'
import type {Readable} from 'node:stream'
export type RuntimeLayout={programRoot:string;dshHome:string;runtimeRoot:string;workspaceRoot:string;profileName:string}
export function runtimeEnvironment(layout:RuntimeLayout,environment?:NodeJS.ProcessEnv):NodeJS.ProcessEnv
export function prepareRuntimeProfile(layout:RuntimeLayout):Promise<string>
export function launchRuntime(layout:RuntimeLayout,options:{port:number}):ChildProcessByStdio<null,Readable,Readable>
