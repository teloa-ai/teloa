import {useEffect,useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import type {HardwareDevicesApi,DirectDeviceStatus,PairingJob} from './hardware-devices-api.js'
import page from './AutoDreamSettingsPage.module.css'
import css from './HardwareDevicesSettings.module.css'

const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
export function DirectDeviceSettings({api}:{api:HardwareDevicesApi['direct']}){
 const {locale}=useI18n(),tr=(cn:string,tw:string,en:string)=>locale.startsWith('en')?en:['zh-Hant','zh-TW','zh-HK'].includes(locale)?tw:cn
 const [status,setStatus]=useState<DirectDeviceStatus>(),[open,setOpen]=useState(false),[consent,setConsent]=useState(false),[approvals,setApprovals]=useState(false),[job,setJob]=useState<PairingJob|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[copied,setCopied]=useState(false)
 useEffect(()=>{let active=true;void api.status().then(value=>{if(active)setStatus(value)},()=>{});return()=>{active=false}},[api])
 useEffect(()=>{
  if(!open)return
  let active=true
  const read=async()=>{try{const [next,current]=await Promise.all([api.status(),api.pairing(job?.id)]);if(active){setStatus(next);setJob(current)}}catch{if(active)setFailed(true)}}
  void read();const timer=setInterval(()=>void read(),1500);return()=>{active=false;clearInterval(timer)}
 },[api,open,job?.id])
 if(!status?.enabled)return null
 const pending=job&&['awaiting-device','ready'].includes(job.state)&&job.expiresAt>Date.now()
 const act=async(operation:()=>Promise<PairingJob|null>)=>{setBusy(true);setFailed(false);try{setJob(await operation())}catch{setFailed(true)}finally{setBusy(false)}}
 return <>
  <div className={page.row}><div className={page.rowText}><strong>{tr('Teloa 自有固件','Teloa 自有韌體','Teloa firmware')}</strong><p>{status.devices.filter(device=>device.status==='active').length?tr('设备已配对，连接原助手','裝置已配對，連接原助理','Paired with your original assistant'):tr('通过 USB 配对，之后在同一局域网使用','透過 USB 配對，之後在同一區域網絡使用','Pair over USB, then use on the same local network')}</p></div><button type="button" onClick={()=>setOpen(true)}>{tr('管理设备','管理裝置','Manage devices')}</button></div>
  {open&&<ContextDrawer compact title={tr('Teloa 设备','Teloa 裝置','Teloa device')} close={()=>setOpen(false)}><div className={css.editor}>
   <section className={css.section}><h3>{tr('USB 配对','USB 配對','USB pairing')}</h3><p className={css.note}>{tr('先安装匹配的 Teloa 固件，再连接 USB 数据线。设备出现配对提示后，长按屏幕确认。','先安裝相符的 Teloa 韌體，再連接 USB 數據線。裝置出現配對提示後，長按螢幕確認。','Install matching Teloa firmware, connect a USB data cable, then hold the screen when the pairing prompt appears.')}</p>
    {!pending&&job?.state!=='paired'&&<><label className={css.consent}><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={busy}/><span>{tr('允许设备向原助手提交工作并读取回答','允許裝置向原助理提交工作及讀取回答','Allow this device to send work and read replies')}</span></label><label className={css.consent}><input type="checkbox" checked={approvals} onChange={event=>setApprovals(event.target.checked)} disabled={busy}/><span>{tr('允许在设备屏幕批准或拒绝本次操作','允許在裝置螢幕批准或拒絕本次操作','Allow one-time approvals and rejections on the device')}</span></label><p className={css.note}>{tr('设备会显示原助手上下文中的回答和审批内容。请确认你控制这台设备。','裝置會顯示原助理上下文中的回答及審批內容。請確認你控制這台裝置。','Replies and approval details may include your assistant’s context. Pair a device you control.')}</p><button className={css.primary} disabled={busy||!consent} onClick={()=>void act(()=>api.begin(approvals))}>{tr('授权并开始配对','授權並開始配對','Authorize and pair')}</button></>}
    {pending&&<><p role="status">{tr('等待本机配对助手和设备确认，有效期五分钟。','等待本機配對助理及裝置確認，有效期五分鐘。','Waiting for the local pairing helper and device confirmation. Expires after five minutes.')}</p><p className={css.note}>{job.allowApprovals?tr('本次包含触屏审批权限','本次包含觸屏審批權限','Includes on-device approvals'):tr('本次不授予设备审批权限','本次不授予裝置審批權限','Does not grant on-device approvals')}</p><div className={css.actions}><button disabled={busy||!status.helper} onClick={()=>{if(!status.helper)return;const command=`python3 ${quote(status.helper.script)} --socket ${quote(status.helper.socket)} --intent ${quote(job.id)} --write-usb-config`;void navigator.clipboard.writeText(command).then(()=>setCopied(true),()=>setFailed(true))}}>{tr(copied?'已复制配对命令':'复制本机配对命令',copied?'已複製配對指令':'複製本機配對指令',copied?'Copied pairing command':'Copy local pairing command')}</button><button disabled={busy} onClick={()=>void act(()=>api.cancel(job.id))}>{tr('取消配对','取消配對','Cancel pairing')}</button></div><p className={css.note}>{tr('在已准备固件工具依赖的本机终端运行命令。配对只写设备连接配置，不刷固件。关闭此窗口不会取消配对。','在已準備韌體工具依賴的本機終端執行指令。配對只寫入連接設定，不刷韌體。關閉此視窗不會取消配對。','Run in a local terminal with the firmware tool dependencies installed. Pairing writes connection settings only. Closing this drawer does not cancel pairing.')}</p></>}
    {job?.state==='paired'&&<p role="status">{tr('配对配置已保存，设备将连接这台电脑。','配對設定已儲存，裝置將連接這台電腦。','Pairing settings saved. The device will connect to this computer.')}</p>}
   </section>
   {status.devices.filter(device=>device.status==='active').map((device,index)=><section key={device.id} className={css.section}><h3>{tr('已配对设备','已配對裝置','Paired device')} {index+1}</h3><p className={css.note}>{device.allowApprovals?tr('允许触屏审批','允許觸屏審批','On-device approvals enabled'):tr('审批保留在 Teloa 网页','審批保留在 Teloa 網頁','Approvals stay in the web workspace')}</p><button disabled={busy} onClick={()=>{setBusy(true);void api.revoke(device.id).then(()=>api.status()).then(setStatus,()=>setFailed(true)).finally(()=>setBusy(false))}}>{tr('撤销设备连接','撤銷裝置連接','Revoke device')}</button></section>)}
   {failed&&<p role="alert" className={css.notice}>{tr('无法完成，请核对原配对状态后重试。','無法完成，請核對原配對狀態後重試。','Unable to complete. Check the original pairing status and retry.')}</p>}
  </div></ContextDrawer>}
 </>
}
