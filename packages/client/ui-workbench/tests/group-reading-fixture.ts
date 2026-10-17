/** 无 DOM 的旧消息夹具不模拟滚动；阅读水位与窗口行为由 group-reading.browser.test.ts 真浏览器覆盖。 */
export const groupReadingFixture={useGroupReading:()=>({unread:undefined,away:false,failed:false,onScroll:()=>{},latest:()=>{},retry:()=>{}})}
