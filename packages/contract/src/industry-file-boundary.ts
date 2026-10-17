export const industryFileLimits={count:500,fileBytes:2*1024*1024,totalBytes:20*1024*1024} as const
/** 导入与分享采用同一包内路径边界，不访问文件系统。 */
export function validateIndustryFilePath(path:string):void{
 if(typeof path!=='string'||!path||path.length>500||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#\u0000-\u001f\u007f]/.test(path))throw Error('目录文件路径无效。')
}
