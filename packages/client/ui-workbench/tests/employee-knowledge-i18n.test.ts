import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {EMPLOYEE_KNOWLEDGE_MESSAGE_ROWS} from '../src/client/i18n/locales/employee-knowledge.ts'
import {chineseUiLiterals} from './i18n-ast.ts'
test('员工知识及覆盖确认词条提供10语言、相同变量与非空内容',()=>{
 for(const row of EMPLOYEE_KNOWLEDGE_MESSAGE_ROWS){assert.equal(row.length,11);const variables=(value:string)=>[...value.matchAll(/\{([^}]+)\}/g)].map(row=>row[1]).sort();for(const value of row.slice(1)){assert.ok(value.trim());assert.deepEqual(variables(value),variables(row[1]))}assert.doesNotMatch(row[3],/\p{Script=Han}/u)}
})
for(const name of ['EmployeeKnowledgeDocument','ResourceKnowledgeDocument','KnowledgeResetConfirmation'])test(name+'界面通过词条展示，无中文硬编码',async()=>{const source=await readFile(new URL('../src/client/'+name+'.tsx',import.meta.url),'utf8');assert.deepEqual(chineseUiLiterals(source),[])})
