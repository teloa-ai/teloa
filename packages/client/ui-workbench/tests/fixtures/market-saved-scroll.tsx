import {createRoot} from 'react-dom/client'
import {MarketPage,type MarketProps} from '../../src/client/MarketPage.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import type {TeloaI18n} from '../../src/client/i18n/index.js'
import frame from '../../src/client/WorkbenchFrame.module.css'

// 保留正式壳层和市场页面；用长资源正文隔离底部裁切问题，不调用宿主或安装资源。
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1} as const
const runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage('zh-CN',key,params)} as TeloaI18n
const props={visible:true,installations:{visible:false,selected:null},skillInstallApi:{list:async()=>({items:[]})},industryResources:
 <article aria-label="已加入的方案"><h1>项目管理协作</h1><p>方案资源</p>{Array.from({length:24},(_,index)=><section key={index}><h2>资源 {index+1}</h2><p>核对项目会议、里程碑和风险的完整说明。</p><button type="button">查看资源 {index+1}</button></section>)}<button type="button">底部操作</button></article>
} as unknown as MarketProps
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={runtime}><div className={frame.frame}><div className={frame.workspace}><header className={frame.topbar}>Max › 市场</header><div className={frame.columns}><main className={frame.main}><MarketPage {...props}/></main></div></div></div></I18nProvider>)
