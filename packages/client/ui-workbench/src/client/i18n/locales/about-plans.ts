type Values=readonly [string,string,string,string,string,string,string,string,string,string]
type Row<K extends string=string>=readonly [K,...Values]
const r=<K extends string>(key:K,...values:Values):Row<K>=>[key,...values]

// 三版本的产品定位与使用场景；开发进度和实际授权不在这里描述。
export const ABOUT_PLAN_MESSAGE_ROWS=[

 r("about.plans.title","版本定位","版本定位","Product editions","製品エディション","제품 에디션","Định vị phiên bản","Ediciones del producto","Éditions du produit","Produkteditionen","Edições do produto"),
 r("about.plans.more","了解详情：","了解詳情：","Learn more:","詳細：","자세히:","Tìm hiểu thêm:","Más información:","En savoir plus :","Mehr erfahren:","Saiba mais:"),
] as const
