export function stripCredentialEnv(source:Readonly<Record<string,string|undefined>>,options?:{acceptance?:boolean}):{env:Record<string,string>;removed:string[]}
export function warnRemoved(removed:readonly string[],imKeys?:readonly string[]):void
