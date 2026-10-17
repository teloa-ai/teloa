import type {RoleAvatarKey} from '@teloa/contract'
import avatar0 from '../brand/resources/ui-designer.webp'
import avatar1 from '../brand/resources/project.webp'
import avatar2 from '../brand/resources/researcher.webp'
import avatar3 from '../brand/resources/sales.webp'
import avatar4 from '../brand/resources/supporter.webp'
import avatar5 from '../brand/resources/commerce.webp'
import avatar6 from '../brand/resources/developer.webp'
import avatar7 from '../brand/resources/product-manager.webp'
import avatar8 from '../brand/resources/data-analyst.webp'
import avatar9 from '../brand/resources/qa-tester.webp'
import avatar10 from '../brand/resources/it-operations.webp'
import avatar11 from '../brand/resources/security-analyst.webp'
import avatar12 from '../brand/resources/marketing.webp'
import avatar13 from '../brand/resources/content-writer.webp'
import avatar14 from '../brand/resources/brand-designer.webp'
import avatar15 from '../brand/resources/hr.webp'
import avatar16 from '../brand/resources/recruiter.webp'
import avatar17 from '../brand/resources/finance.webp'
import avatar18 from '../brand/resources/legal.webp'
import avatar19 from '../brand/resources/procurement.webp'
import avatar20 from '../brand/resources/admin.webp'
import avatar21 from '../brand/resources/executive-assistant.webp'
import avatar22 from '../brand/resources/business-analyst.webp'
import avatar23 from '../brand/resources/trainer.webp'
import avatar24 from '../brand/resources/general.webp'
import avatar25 from '../brand/resources/general-research.webp'
import avatar26 from '../brand/resources/general-creative.webp'
import avatar27 from '../brand/resources/general-execution.webp'
export const employeeAvatars:readonly {key:RoleAvatarKey;zh:string;en:string;src:string}[]=[
 {key:"ui-designer",zh:"UI 设计师",en:"UI designer",src:avatar0},
 {key:"project",zh:"项目协调员",en:"Project coordinator",src:avatar1},
 {key:"researcher",zh:"研究与情报助手",en:"Research and intelligence assistant",src:avatar2},
 {key:"sales",zh:"销售协作员",en:"Sales coordinator",src:avatar3},
 {key:"supporter",zh:"客户支持协作员",en:"Customer support coordinator",src:avatar4},
 {key:"commerce",zh:"电商运营协作员",en:"Ecommerce operations coordinator",src:avatar5},
 {key:"developer",zh:"研发协作员",en:"Development coordinator",src:avatar6},
 {key:"product-manager",zh:"产品经理",en:"Product manager",src:avatar7},
 {key:"data-analyst",zh:"数据分析师",en:"Data analyst",src:avatar8},
 {key:"qa-tester",zh:"测试工程师",en:"QA engineer",src:avatar9},
 {key:"it-operations",zh:"IT 运维工程师",en:"IT operations engineer",src:avatar10},
 {key:"security-analyst",zh:"安全分析师",en:"Security analyst",src:avatar11},
 {key:"marketing",zh:"市场营销专员",en:"Marketing specialist",src:avatar12},
 {key:"content-writer",zh:"内容创作者",en:"Content creator",src:avatar13},
 {key:"brand-designer",zh:"品牌设计师",en:"Brand designer",src:avatar14},
 {key:"hr",zh:"人事专员",en:"HR specialist",src:avatar15},
 {key:"recruiter",zh:"招聘专员",en:"Recruiter",src:avatar16},
 {key:"finance",zh:"财务专员",en:"Finance specialist",src:avatar17},
 {key:"legal",zh:"法务专员",en:"Legal specialist",src:avatar18},
 {key:"procurement",zh:"采购专员",en:"Procurement specialist",src:avatar19},
 {key:"admin",zh:"行政专员",en:"Administrative coordinator",src:avatar20},
 {key:"executive-assistant",zh:"高管助理",en:"Executive assistant",src:avatar21},
 {key:"business-analyst",zh:"业务分析师",en:"Business analyst",src:avatar22},
 {key:"trainer",zh:"培训师",en:"Training specialist",src:avatar23},
 {key:"general",zh:"通用工作伙伴",en:"General work partner",src:avatar24},
 {key:"general-research",zh:"通用研究助手",en:"General research assistant",src:avatar25},
 {key:"general-creative",zh:"通用创作助手",en:"General creative assistant",src:avatar26},
 {key:"general-execution",zh:"通用执行助手",en:"General execution assistant",src:avatar27}
]
export const employeeAvatar=(key?:RoleAvatarKey)=>employeeAvatars.find(item=>item.key===(key??'general'))??employeeAvatars.find(item=>item.key==='general')!

const traditionalNames:Record<RoleAvatarKey,string>={
 'ui-designer':'UI 設計師','project':'專案協調員','researcher':'研究與情報助理','sales':'銷售協作員','supporter':'客戶支援協作員','commerce':'電商營運協作員','developer':'開發協作員','product-manager':'產品經理','data-analyst':'資料分析師','qa-tester':'測試工程師','it-operations':'IT 維運工程師','security-analyst':'資訊安全分析師','marketing':'市場行銷專員','content-writer':'內容創作者','brand-designer':'品牌設計師','hr':'人事專員','recruiter':'招募專員','finance':'財務專員','legal':'法務專員','procurement':'採購專員','admin':'行政專員','executive-assistant':'主管助理','business-analyst':'業務分析師','trainer':'培訓師','general':'通用工作夥伴','general-research':'通用研究助理','general-creative':'通用創作助理','general-execution':'通用執行助理',
}
const hongKongNames:Partial<Record<RoleAvatarKey,string>>={
 project:'項目協調員',researcher:'研究與情報助手',supporter:'客戶支援協作員',developer:'研發協作員','data-analyst':'數據分析師','it-operations':'IT 運維工程師','security-analyst':'資訊保安分析師',marketing:'市場推廣專員',recruiter:'招聘專員','executive-assistant':'高管助理','general-research':'通用研究助手','general-creative':'通用創作助手','general-execution':'通用執行助手',
}
export function employeeAvatarName(key:RoleAvatarKey,locale:string){
 const avatar=employeeAvatar(key)
 if(locale==='zh-CN')return avatar.zh
 if(locale.startsWith('zh'))return locale==='zh-HK'?(hongKongNames[key]??traditionalNames[key]):traditionalNames[key]
 return avatar.en
}
