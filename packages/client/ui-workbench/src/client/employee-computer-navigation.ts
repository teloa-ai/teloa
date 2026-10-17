/** 独立电脑视图只携带员工引用；不复制认证参数、会话目标或业务范围。 */
export function employeeComputerUrl(current:string,roleId:string,detached=false):string{
 const url=new URL(current)
 url.search='';url.hash=''
 url.searchParams.set('employeeComputer',roleId)
 if(detached)url.searchParams.set('computerWindow','1')
 return url.href
}
export function employeeComputerTarget(current:string):string|null{
 const id=new URL(current).searchParams.get('employeeComputer')
 return id&&/^[a-zA-Z0-9_-]{1,128}$/.test(id)?id:null
}
export function leaveEmployeeComputer(current:string):string{
 const url=new URL(current)
 url.searchParams.delete('employeeComputer');url.searchParams.delete('computerWindow')
 return url.href
}
