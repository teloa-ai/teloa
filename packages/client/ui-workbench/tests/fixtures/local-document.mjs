/** 本机可信来源保留浏览器原生 Web Crypto；文档由路由提供，不开启服务或放行外网。 */
export async function setLocalDocument(page,html){
 const url='http://127.0.0.1/teloa-test-document'
 const fulfill=route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html})
 await page.route(url,fulfill)
 try{await page.goto(url)}finally{await page.unroute(url,fulfill)}
}
