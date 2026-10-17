const copy={reply:['助手回复','助手回覆','Assistant reply'],original:['查看原文','檢視原文','View original'],images:['{count} 张图片','{count} 張圖片','{count} images']} as const
export function artifactMessageCopy(locale:string,key:keyof typeof copy){const normalized=locale.toLowerCase();return copy[key][normalized==='zh'||normalized==='zh-cn'?0:normalized.startsWith('zh')?1:2]}
