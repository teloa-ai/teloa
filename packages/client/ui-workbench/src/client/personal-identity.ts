export function usablePersonalName(value:string):string{
 const name=value.normalize('NFC').trim().replace(/\s+/gu,' ')
 return /[@＠\p{Cc}]/u.test(name)||!/\p{L}/u.test(name)?'':name
}

/** 姓名用于展示；邮箱只在账号设置中核对，不从邮箱推导本人姓名。 */
export function personalDisplayName(value:string,fallback:string):string{return usablePersonalName(value)||fallback}

const graphemes=new Intl.Segmenter('und',{granularity:'grapheme'})
/** 取姓名首尾词的首个完整字素，单名只取一个；跳过装饰符号及标点。 */
export function personalAvatarInitials(value:string):string{
 const words=usablePersonalName(value).split(' ').filter(word=>/\p{L}/u.test(word))
 const initial=(word:string)=>[...graphemes.segment(word)].find(part=>/\p{L}/u.test(part.segment))?.segment.toUpperCase()??''
 if(!words.length)return ''
 return initial(words[0]!)+(words.length>1?initial(words.at(-1)!):'')
}
