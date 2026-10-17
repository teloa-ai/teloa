export type MiniMaxVoice=Readonly<{id:string;language:'zh'|'en';zh:string;hant:string;en:string}>
/** 保留既有默认音色；其余为官方中英文系统音色，不在通话时请求目录。
 * https://platform.minimax.io/docs/faq/system-voice-id
 */
export const miniMaxVoices:readonly MiniMaxVoice[]=[
 {id:'male-qn-qingse',language:'zh',zh:'青涩青年',hant:'青澀青年',en:'Youthful Male'},
 {id:'Chinese (Mandarin)_Reliable_Executive',language:'zh',zh:'沉稳高管',hant:'沉穩主管',en:'Reliable Executive'},
 {id:'Chinese (Mandarin)_News_Anchor',language:'zh',zh:'新闻主播',hant:'新聞主播',en:'News Anchor'},
 {id:'Chinese (Mandarin)_Gentleman',language:'zh',zh:'温润男声',hant:'溫潤男聲',en:'Gentleman'},
 {id:'Chinese (Mandarin)_Warm_Bestie',language:'zh',zh:'温暖闺蜜',hant:'溫暖閨蜜',en:'Warm Bestie'},
 {id:'Chinese (Mandarin)_Sweet_Lady',language:'zh',zh:'甜美女声',hant:'甜美女聲',en:'Sweet Lady'},
 {id:'Chinese (Mandarin)_Gentle_Youth',language:'zh',zh:'温润青年',hant:'溫潤青年',en:'Gentle Youth'},
 {id:'Chinese (Mandarin)_Warm_Girl',language:'zh',zh:'温暖少女',hant:'溫暖少女',en:'Warm Girl'},
 {id:'Chinese (Mandarin)_Radio_Host',language:'zh',zh:'电台主持',hant:'電台主持',en:'Radio Host'},
 {id:'Chinese (Mandarin)_IntellectualGirl',language:'zh',zh:'知性女孩',hant:'知性女孩',en:'Intellectual Girl'},
 {id:'English_expressive_narrator',language:'en',zh:'生动旁白',hant:'生動旁白',en:'Expressive Narrator'},
 {id:'English_radiant_girl',language:'en',zh:'阳光女孩',hant:'陽光女孩',en:'Radiant Girl'},
 {id:'English_magnetic_voiced_man',language:'en',zh:'磁性男声',hant:'磁性男聲',en:'Magnetic-voiced Male'},
 {id:'English_Trustworth_Man',language:'en',zh:'可靠男声',hant:'可靠男聲',en:'Trustworthy Man'},
 {id:'English_CalmWoman',language:'en',zh:'沉静女声',hant:'沉靜女聲',en:'Calm Woman'},
 {id:'English_Gentle-voiced_man',language:'en',zh:'温柔男声',hant:'溫柔男聲',en:'Gentle-voiced Man'},
 {id:'English_Graceful_Lady',language:'en',zh:'优雅女士',hant:'優雅女士',en:'Graceful Lady'},
 {id:'English_FriendlyPerson',language:'en',zh:'亲切男声',hant:'親切男聲',en:'Friendly Guy'},
]
export function miniMaxVoiceName(voice:MiniMaxVoice,locale:string){return locale==='zh-CN'?voice.zh:locale.startsWith('zh')?voice.hant:voice.en}
