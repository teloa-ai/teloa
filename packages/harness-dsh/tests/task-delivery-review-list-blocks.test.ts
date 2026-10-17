import test from 'node:test'
import assert from 'node:assert/strict'
import {applyPlanEdits,readReviewSubmission,splitReviewBlocks,splitReviewUnits} from '../src/task-delivery-review.ts'

// 独立编造的中性夹具：结构与复核中出现过的「引导行 + 多条顶层步骤」一致，文字与任何运行数据无关。
const filler=(label:string)=>Array.from({length:64},(_,n)=>`${label}说明第${n+1}句，只用于撑开段落长度。`).join('')
const steps='**步骤**：\n- 第 1 步：整理待办清单，标出负责人。\n- 第 2–4 步：按清单逐项处理，每项记录开始与结束时间。\n- 第 5 步：汇总结果写成一页摘要，并附上未完成项。\n- 第 6 步起：按约定日期复查遗留项是否关闭。'
const doc=['# 示例计划','## 第一部分',filler('甲'),'## 第二部分',filler('乙'),steps,'**备注**：以上步骤可按需调整。','## 第三部分',filler('丙')].join('\n\n')
const slices=(text:string)=>splitReviewBlocks(text).map(block=>text.slice(block.start,block.end))
const rebuilt=(text:string)=>{let out='',offset=0;for(const block of splitReviewBlocks(text)){assert.ok(!text.slice(offset,block.start).trim(),'块之间只有空白');out+=text.slice(offset,block.end);offset=block.end}return out+text.slice(offset)}
const unitOf=(text:string)=>(id:number)=>{const blocks=splitReviewBlocks(text),block=blocks[id-1]!,unit=splitReviewUnits(text).find(unit=>unit.start<=block.start&&block.end<=unit.end)!,inside=blocks.flatMap((item,index)=>unit.start<=item.start&&item.end<=unit.end?[index]:[]);return {first:inside[0]!,last:inside.at(-1)!}}

test('顶层列表项各自成块，引导行单独成块；只改最后一步不会删掉同组其他步骤',()=>{
 const parts=slices(steps)
 assert.equal(parts.length,5,'引导行 + 4 条顶层步骤')
 assert.equal(parts[0],'**步骤**：')
 assert.ok(parts[4]!.startsWith('- 第 6 步起'))
 const blocks=splitReviewBlocks(doc),last=blocks.findIndex(block=>doc.slice(block.start,block.end).startsWith('- 第 6 步起'))+1
 const after='- 第 6 步起（以各项约定日期为准，属于后续跟进）：复查遗留项是否关闭。'
 const plan=readReviewSubmission({edits:[{blockId:last,after}]},doc,blocks,unitOf(doc)(last))
 assert.ok('edits' in plan,JSON.stringify(plan))
 const result=applyPlanEdits(doc,plan.edits)
 assert.ok('text' in result)
 assert.equal(result.text,doc.replace(parts[4]!,after),'只替换最后一步，引导行与前三条逐字保留')
 assert.ok(result.text.includes('**步骤**：\n- 第 1 步：')&&result.text.includes('并附上未完成项'))
})

test('项内缩进续行、子列表与懒续行留在所属项；有序与无序列表都按顶层项切分；粗体引导行不是列表项',()=>{
 const text='**样本**：\n- 项一\n  续行\n  - 子项\n    子项续行\n- 项二\n懒续行\n\n1. 第一\n2) 第二\n   续行\n10. 第十\n\n* 星号项\n+ 加号项'
 assert.deepEqual(slices(text),['**样本**：','- 项一\n  续行\n  - 子项\n    子项续行','- 项二\n懒续行','1. 第一','2) 第二\n   续行','10. 第十','* 星号项','+ 加号项'])
 assert.equal(rebuilt(text),text)
})

test('围栏内不切：项内围栏（含空行与形似列表项的行）和顶层围栏整体保留',()=>{
 const text='- 步骤一\n  ```\n  - 不是新项\n\n  - 也不是\n  ```\n- 步骤二\n\n```md\n- 围栏里的行\n- 第二行\n```\n- 围栏后紧接的项'
 assert.deepEqual(slices(text),['- 步骤一\n  ```\n  - 不是新项\n\n  - 也不是\n  ```','- 步骤二','```md\n- 围栏里的行\n- 第二行\n```','- 围栏后紧接的项'])
 assert.equal(rebuilt(text),text)
})

test('起止索引与原文完全可还原；复核单元仍按标题切分为同样 3 个，每个块只落在一个单元内',()=>{
 assert.equal(rebuilt(doc),doc)
 const units=splitReviewUnits(doc)
 assert.deepEqual(units.map(unit=>unit.start),[0,doc.indexOf('## 第二部分'),doc.indexOf('## 第三部分')])
 assert.equal(units.at(-1)!.end,doc.length)
 for(const block of splitReviewBlocks(doc))assert.equal(units.filter(unit=>unit.start<=block.start&&block.end<=unit.end).length,1)
})
