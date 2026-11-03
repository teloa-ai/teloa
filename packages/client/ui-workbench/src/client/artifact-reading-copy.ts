const copy={details:['文档详情','文件詳情','Document details'],modify:['提出修改','提出修改','Suggest changes'],title:['完整标题','完整標題','Full title']} as const
/** 成果阅读层只定稿简中、繁中与英文，其他语言沿英文回退。 */
export function artifactReadingCopy(locale:string,key:keyof typeof copy){return copy[key][/^zh-(hant|tw|hk)$/i.test(locale)?1:/^zh(?:-(hans|cn))?$/i.test(locale)?0:2]}
