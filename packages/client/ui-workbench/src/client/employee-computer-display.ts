/** 仅供展示的宿主输入；服务接入后由可信设备回执提供，不从员工状态或打开页面推导。 */
export type EmployeeComputerDisplay = Readonly<{
 employeeId:string
 state:'connected'|'connecting'|'disconnected'|'unavailable'
 preview?:Readonly<{dataUrl:string}>|undefined
}>
export type EmployeeComputerView = Readonly<{
 state:EmployeeComputerDisplay['state']|'not-integrated'
 previewDataUrl:string|undefined
}>

/** 不显示其他员工的设备，不加载外部链接或可执行矢量内容；断开后隐藏旧画面。 */
export function employeeComputerView(employeeId:string,computer?:EmployeeComputerDisplay):EmployeeComputerView{
 if(!computer||computer.employeeId!==employeeId)return {state:'not-integrated',previewDataUrl:undefined}
 const state=computer.state
 if(!['connected','connecting','disconnected','unavailable'].includes(state))return {state:'unavailable',previewDataUrl:undefined}
 const dataUrl=computer.preview?.dataUrl
 const previewDataUrl=state==='connected'&&typeof dataUrl==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)?dataUrl:undefined
 return {state,previewDataUrl}
}
