// 用真实控件打开按需抽屉；群内旧只读容器仍使用其实际页签。
const labels={advanced:/^(版本与反馈|版本與回饋|Versions and feedback)$/,files:/^(文件|檔案|Files)$/,details:/^(文档详情|文件詳情|Document details)$/}
export async function openArtifactReaderDrawer(page:any,kind:keyof typeof labels){
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
 const existing=page.getByRole('dialog',{name:labels[kind]});if(await existing.isVisible().catch(()=>false))return
 const reader=page.locator('[data-artifact-reader]').filter({visible:true});
 if(await reader.count()){await reader.locator('summary').click();await reader.getByRole('menuitem',{name:labels[kind]}).click();await existing.waitFor();return}
 await page.getByRole('button',{name:kind==='advanced'?labels.advanced:/^(文件与来源|文件與來源|Files and sources)$/}).click()
}
export async function closeArtifactReaderDrawer(page:any){
 const drawer=page.getByRole('dialog',{name:/^(版本与反馈|版本與回饋|Versions and feedback|文档详情|文件詳情|Document details|文件|檔案|Files)$/});
 if(await drawer.isVisible().catch(()=>false)){await drawer.getByRole('button',{name:/^(关闭|關閉|Close)$/}).click();return}
 const preview=page.getByRole('button',{name:/^(预览|預覽|Preview)$/});if(await preview.isVisible().catch(()=>false))await preview.click()
}
export async function startNewArtifactResult(page:any){
 const normal=page.getByRole('button',{name:'整理新成果',exact:true});if(await normal.isVisible().catch(()=>false)){await normal.click();return}
 const reader=page.locator('[data-artifact-reader]').filter({visible:true});await reader.locator('summary').click();await reader.getByRole('menuitem',{name:'整理新成果',exact:true}).click()
}
