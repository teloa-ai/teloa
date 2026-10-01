import {BookOpen, Boxes, ClipboardList, Cpu, Database, Plug, Puzzle, Sparkles, Users, Wrench, CalendarClock} from 'lucide-react'

/** 类型图标同源：业务组成、市场与能力管理共用，状态图标另行表达。 */
export const capabilityIcons={skill:Sparkles,knowledge:BookOpen,source:Plug,mcp:Plug,connector:Plug,extension:Puzzle,plugin:Puzzle,method:ClipboardList,'work-template':ClipboardList,'data-source':Database,'execution-tool':Wrench,plan:CalendarClock,industry:Boxes,staff:Users,board:Database,model:Cpu} as const
