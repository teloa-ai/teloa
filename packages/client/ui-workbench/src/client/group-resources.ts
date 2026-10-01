/** 当前页面的群资料形状。与个人 ResourceService 分离，不表示已授予共享权限。 */
export type GroupResourceVersion={version:number;title:string;body:string;createdAt:string}
export type GroupResource={id:string;groupId:string;versions:GroupResourceVersion[];withdrawn:boolean}
export type GroupResourceRef={id:string;version:number}
export type GroupResourceSnapshot=GroupResourceRef&{groupId:string;title:string}
