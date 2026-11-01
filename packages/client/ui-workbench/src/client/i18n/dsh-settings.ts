import type {DshLocalePort} from './index.js'
import {installDshLanguagePack,type DshPackRow as Row} from './dsh-locale-pack.ts'

const namespaces:Readonly<Record<string,readonly Row[]>>={
  'settings.locale':[
    ['language.title','語言','言語','언어','Ngôn ngữ','Idioma','Langue','Sprache','Idioma'],
  ],
  'settings.permission':[
    ['title','權限','権限','권한','Quyền','Permisos','Autorisations','Berechtigungen','Permissões'],
    ['description','選擇新會話的預設權限模式','新しいセッションの既定の権限モードを選択','새 세션의 기본 권한 모드를 선택하세요','Chọn chế độ quyền mặc định cho phiên mới','Elige el modo de permisos predeterminado para las sesiones nuevas','Choisissez le mode d’autorisation par défaut des nouvelles sessions','Wählen Sie den Standard-Berechtigungsmodus für neue Sitzungen','Escolha o modo de permissão predefinido para novas sessões'],
    ['loading','載入中','読み込み中','불러오는 중','Đang tải','Cargando','Chargement','Wird geladen','A carregar'],
    ['unavailable','無法使用','利用できません','사용할 수 없음','Không khả dụng','No disponible','Indisponible','Nicht verfügbar','Indisponível'],
    ['preset.readOnly','僅檢視','読み取り専用','읽기 전용','Chỉ đọc','Solo lectura','Lecture seule','Nur lesen','Só de leitura'],
    ['preset.workspaceWrite','可修改工作區','ワークスペースを編集','작업 공간 수정','Chỉnh sửa không gian làm việc','Editar el espacio de trabajo','Modifier l’espace de travail','Arbeitsbereich bearbeiten','Editar o espaço de trabalho'],
    ['preset.fullAccess','完整存取權','フルアクセス','전체 접근','Toàn quyền','Acceso completo','Accès complet','Vollzugriff','Acesso total'],
  ],
  'settings.theme':[
    ['appearance.title','外觀','外観','화면 모드','Giao diện','Apariencia','Apparence','Darstellung','Aparência'],
    ['appearance.light','淺色','ライト','라이트','Sáng','Claro','Clair','Hell','Claro'],
    ['appearance.dark','深色','ダーク','다크','Tối','Oscuro','Sombre','Dunkel','Escuro'],
    ['appearance.system','跟隨系統','システム設定','시스템 설정','Theo hệ thống','Sistema','Système','System','Sistema'],
    ['fontSize.title','字體大小','文字サイズ','글자 크기','Cỡ chữ','Tamaño del texto','Taille du texte','Textgröße','Tamanho do texto'],
    ['fontSize.description','只影響會話內容','会話内容にのみ適用されます','대화 내용에만 적용됩니다','Chỉ áp dụng cho nội dung hội thoại','Solo afecta al contenido de la conversación','S’applique uniquement au contenu de la conversation','Gilt nur für Gesprächsinhalte','Afeta apenas o conteúdo da conversa'],
    ['fontSize.unit','px','px','px','px','px','px','px','px'],
    ['fontSize.increase','放大字體','文字を大きくする','글자 크게','Tăng cỡ chữ','Aumentar texto','Agrandir le texte','Text vergrößern','Aumentar texto'],
    ['fontSize.decrease','縮小字體','文字を小さくする','글자 작게','Giảm cỡ chữ','Reducir texto','Réduire le texte','Text verkleinern','Reduzir texto'],
  ],
  chat:[
    ['settings.transcript.title','對話顯示','会話表示','대화 표시','Hiển thị hội thoại','Vista de la conversación','Affichage de la conversation','Gesprächsansicht','Visualização da conversa'],
    ['settings.transcript.description','控制已完成回合的過程內容','完了したターンの途中経過を表示する方法','완료된 응답의 진행 내용을 표시하는 방식','Cách hiển thị tiến trình của lượt đã hoàn tất','Controla el contenido del proceso de los turnos completados','Contrôle le détail des étapes terminées','Steuert die Anzeige abgeschlossener Abläufe','Controla o conteúdo de processo das interações concluídas'],
    ['settings.transcript.normal','標準','標準','기본','Tiêu chuẩn','Normal','Standard','Standard','Normal'],
    ['settings.transcript.compact','精簡','コンパクト','간결','Gọn','Compacta','Compact','Kompakt','Compacta'],
  ],
  conversation:[
    ['settings.enter.title','繁忙時的傳送方式','実行中の送信方法','실행 중 전송 방식','Cách gửi khi đang chạy','Envío durante la ejecución','Envoi pendant l’exécution','Senden während der Ausführung','Envio durante a execução'],
    ['settings.enter.description','Agent 執行時，Enter 與傳送按鈕的行為；Cmd/Ctrl+Enter 使用另一種方式','Agent の実行中に Enter と送信ボタンを押したときの動作。Cmd/Ctrl+Enter では別の方法を使います','Agent 실행 중 Enter 키와 전송 버튼의 동작입니다. Cmd/Ctrl+Enter는 다른 방식을 사용합니다','Hành vi của Enter và nút Gửi khi Agent đang chạy; Cmd/Ctrl+Enter dùng cách còn lại','Define qué hacen Enter y el botón Enviar mientras el Agent está en ejecución; Cmd/Ctrl+Enter usa la otra opción','Définit le comportement d’Entrée et du bouton Envoyer pendant l’exécution de l’Agent ; Cmd/Ctrl+Entrée utilise l’autre option','Legt das Verhalten von Eingabetaste und Senden während der Agent-Ausführung fest; Cmd/Strg+Enter nutzt die andere Option','Define o comportamento do Enter e do botão Enviar enquanto o Agent está em execução; Cmd/Ctrl+Enter usa a outra opção'],
    ['settings.enter.queue','排隊傳送','キューに追加','대기열에 추가','Xếp hàng','Poner en cola','Mettre en file','Einreihen','Colocar em fila'],
    ['settings.enter.steer','即時補充','指示を追加','지시 추가','Điều chỉnh ngay','Intervenir','Intervenir','Eingreifen','Intervir'],
  ],
  'settings.models':[
    ['nav','模型','モデル','모델','Mô hình','Modelos','Modèles','Modelle','Modelos'],
    ['title','模型','モデル','모델','Mô hình','Modelos','Modèles','Modelle','Modelos'],
    ['intro','設定模型供應商與 API 金鑰。','モデルプロバイダーと API キーを設定します。','모델 제공업체와 API 키를 설정합니다.','Cấu hình nhà cung cấp mô hình và khóa API.','Configura proveedores de modelos y claves API.','Configurez les fournisseurs de modèles et les clés API.','Konfigurieren Sie Modellanbieter und API-Schlüssel.','Configure fornecedores de modelos e chaves de API.'],
  ],
  'settings.plugins':[
    ['nav','外掛程式','プラグイン','플러그인','Plugin','Plugins','Plugins','Plugins','Plugins'],
    ['title','外掛程式','プラグイン','플러그인','Plugin','Plugins','Plugins','Plugins','Plugins'],
    ['intro','設定並查看此部署中的外掛程式。','この環境のプラグインを設定・確認します。','이 배포의 플러그인을 설정하고 확인합니다.','Cấu hình và kiểm tra plugin trong bản triển khai này.','Configura y revisa los plugins de esta instalación.','Configurez et consultez les plugins de ce déploiement.','Konfigurieren und prüfen Sie die Plugins dieser Installation.','Configure e consulte os plugins desta instalação.'],
    ['configurableTab','外掛程式設定','プラグイン設定','플러그인 설정','Cấu hình plugin','Configuración','Configuration','Konfiguration','Configuração'],
  ],
  'settings.agentPreset':[
    ['nav','Agent 預設','Agent プリセット','Agent 프리셋','Cấu hình Agent','Perfiles de Agent','Profils d’Agent','Agent-Profile','Perfis de Agent'],
    ['sectionIntro','管理會話所使用的 Agent 工具、提示詞與能力組合。','セッションで使う Agent のツール、プロンプト、機能構成を管理します。','세션에서 사용할 Agent 도구, 프롬프트, 기능 구성을 관리합니다.','Quản lý bộ công cụ, lời nhắc và khả năng của Agent cho từng phiên.','Gestiona las herramientas, instrucciones y capacidades del Agent de cada sesión.','Gérez les outils, instructions et capacités de l’Agent pour chaque session.','Verwalten Sie Werkzeuge, Anweisungen und Fähigkeiten des Agents je Sitzung.','Gerencie as ferramentas, instruções e capacidades do Agent em cada sessão.'],
  ],
  'settings.pluginInventory':[
    ['tab','外掛程式清單','プラグイン一覧','플러그인 목록','Danh sách plugin','Lista de plugins','Liste des plugins','Plugin-Liste','Lista de plugins'],
    ['loading','正在讀取外掛程式…','プラグインを読み込み中…','플러그인 불러오는 중…','Đang đọc plugin…','Leyendo plugins…','Lecture des plugins…','Plugins werden gelesen…','A ler plugins…'],
    ['error','暫時無法讀取外掛程式。','プラグインを読み込めません。','플러그인을 불러올 수 없습니다.','Tạm thời không thể đọc plugin.','No se pueden leer los plugins.','Impossible de lire les plugins.','Plugins können derzeit nicht gelesen werden.','Não foi possível ler os plugins.'],
    ['retry','重試','再試行','다시 시도','Thử lại','Reintentar','Réessayer','Erneut versuchen','Tentar novamente'],
    ['search','搜尋外掛程式','プラグインを検索','플러그인 검색','Tìm plugin','Buscar plugins','Rechercher des plugins','Plugins suchen','Pesquisar plugins'],
    ['empty','沒有可用的外掛程式。','利用できるプラグインはありません。','사용 가능한 플러그인이 없습니다.','Không có plugin.','No hay plugins disponibles.','Aucun plugin disponible.','Keine Plugins verfügbar.','Não existem plugins disponíveis.'],
  ],
  'settings.archivedSessions':[
    ['nav','已封存會話','アーカイブ済みの会話','보관된 대화','Cuộc trò chuyện đã lưu trữ','Conversaciones archivadas','Conversations archivées','Archivierte Unterhaltungen','Conversas arquivadas'],
    ['search','搜尋已封存會話','アーカイブ済みの会話を検索','보관된 대화 검색','Tìm cuộc trò chuyện đã lưu trữ','Buscar conversaciones archivadas','Rechercher des conversations archivées','Archivierte Unterhaltungen suchen','Pesquisar conversas arquivadas'],
    ['loading','正在讀取會話…','会話を読み込み中…','대화를 불러오는 중…','Đang đọc cuộc trò chuyện…','Leyendo conversaciones…','Lecture des conversations…','Unterhaltungen werden gelesen…','A ler conversas…'],
    ['empty','目前沒有已封存的會話。','アーカイブ済みの会話はありません。','보관된 대화가 없습니다.','Chưa có cuộc trò chuyện nào được lưu trữ.','No hay conversaciones archivadas.','Aucune conversation archivée.','Es gibt keine archivierten Unterhaltungen.','Não há conversas arquivadas.'],
    ['unavailable','這裡沒有可復原的已封存會話。','ここに復元できるアーカイブ済みの会話はありません。','여기에는 복원할 수 있는 보관된 대화가 없습니다.','Không có cuộc trò chuyện đã lưu trữ nào có thể khôi phục ở đây.','Aquí no hay ninguna conversación archivada que se pueda restaurar.','Aucune conversation archivée ne peut être restaurée ici.','Hier lässt sich keine archivierte Unterhaltung wiederherstellen.','Aqui não há nenhuma conversa arquivada que possa ser restaurada.'],
    ['emptySearch','沒有符合的會話。','一致する会話はありません。','일치하는 대화가 없습니다.','Không có cuộc trò chuyện nào khớp.','No hay conversaciones que coincidan.','Aucune conversation correspondante.','Keine passenden Unterhaltungen.','Não há conversas correspondentes.'],
    ['unarchive','取消封存','アーカイブを解除','보관 해제','Bỏ lưu trữ','Desarchivar','Désarchiver','Archivierung aufheben','Desarquivar'],
    ['unarchiveNamed','取消封存 {title}','{title} のアーカイブを解除','{title} 보관 해제','Bỏ lưu trữ {title}','Desarchivar {title}','Désarchiver {title}','Archivierung von {title} aufheben','Desarquivar {title}'],
    ['ungrouped','未分組','未分類','미분류','Chưa phân nhóm','Sin agrupar','Non groupées','Nicht gruppiert','Sem grupo'],
    ['time.now','剛剛','たった今','방금','Vừa xong','Ahora','À l’instant','Gerade eben','Agora'],
    ['time.minutes','{n} 分鐘','{n}分','{n}분','{n} phút','{n} min','{n} min','{n} Min.','{n} min'],
    ['time.hours','{n} 小時','{n}時間','{n}시간','{n} giờ','{n} h','{n} h','{n} Std.','{n} h'],
    ['time.days','{n} 天','{n}日','{n}일','{n} ngày','{n} d','{n} j','{n} T.','{n} d'],
    ['time.months','{n} 個月','{n}か月','{n}개월','{n} tháng','{n} mes','{n} mois','{n} Mon.','{n} mês'],
    ['time.years','{n} 年','{n}年','{n}년','{n} năm','{n} a','{n} an','{n} J.','{n} a'],
  ],
}

/** 为 DSH 自有设置组件补充 Teloa 提供的外部语言；未覆盖的深层文案继续安全回退英文。 */
export function installDshSettingsLanguagePack(locale:DshLocalePort,traditionalLocale:'zh-Hant'|'zh-TW'|'zh-HK'):Array<()=>void>{
  return installDshLanguagePack(locale,traditionalLocale,namespaces,{
    // 固定版 DSH 的字體選項已按 text/code/terminal 分組，舊 fontSize.title 不再被畫面讀取。
    'settings.theme':{
      'fontSize.text.title':'字體大小','fontSize.text.description':'只影響會話內容的字體大小',
      'fontSize.text.increase':'放大字體','fontSize.text.decrease':'縮小字體',
      'fontSize.code.title':'程式碼字體大小','fontSize.code.description':'用於程式碼區塊、行內程式碼與工具輸出',
      'fontSize.code.increase':'放大程式碼字體','fontSize.code.decrease':'縮小程式碼字體',
      'fontSize.terminal.title':'終端機字體大小','fontSize.terminal.description':'用於側邊欄終端機',
      'fontSize.terminal.increase':'放大終端機字體','fontSize.terminal.decrease':'縮小終端機字體',
      'fontFamily.text.title':'正文字體','fontFamily.text.description':'用於介面與會話正文。多種字體以逗號分隔，留空使用預設字體',
      'fontFamily.code.title':'程式碼字體','fontFamily.code.description':'用於程式碼區塊、行內程式碼與工具輸出。多種字體以逗號分隔，留空使用預設字體',
      'fontFamily.terminal.title':'終端機字體','fontFamily.terminal.description':'用於側邊欄終端機。多種字體以逗號分隔，留空使用預設字體',
      'fontFamily.placeholder':'預設','fontSize.more':'更多字體設定',
    },
    chat:{
      'settings.transcript.description':'選擇工具呼叫的步驟詳細程度',
      'settings.transcript.standard':'標準','settings.transcript.detailed':'詳細','settings.transcript.verbose':'完整',
      'settings.collapse.title':'工作步驟收合時機','settings.collapse.description':'選擇何時自動收合工作步驟',
      'settings.collapse.completion':'回答結束後','settings.collapse.nextInput':'下一則訊息時',
      'settings.performance.title':'效能與用量','settings.performance.description':'選擇效能與用量資訊的詳細程度',
      'settings.performance.compact':'精簡','settings.performance.detailed':'詳細',
    },
    // 固定版快捷鍵編輯器獨立讀取 shortcuts；只補設定列不會翻譯彈窗與錄鍵回執。
    shortcuts:{
      title:'快速鍵',open:'開啟快速鍵',settings:'快速鍵',view:'編輯快速鍵',description:'檢視及編輯可用的快速鍵與輸入操作',
      'edit-label':'修改「{command}」快速鍵',record:'按下快速鍵','record-help':'放開組合鍵即儲存。Tab 切換操作，Esc 取消錄製。',
      'web-help':'瀏覽器可用組合：Mod+/、Mod+Shift+,、Mod+Shift+.。Mod 在 Mac 上為 Command，其他系統為 Ctrl。',
      'unsupported-key':'暫不支援此按鍵。',reserved:'此組合已保留給系統或文字編輯操作。','modifier-required':'請同時按下 Command、Ctrl 或 Alt 修飾鍵。',
      'too-many-keys':'最多同時按下兩個非修飾鍵。請放開後重試。',
      'macos-web-help':'可設定 Command+/、Command+,、Command+反斜線、Control+反引號、Command+Option+按鍵或 Command+Shift+按鍵。亦支援三個或四個不同修飾鍵的組合。瀏覽器或系統佔用的組合可能無法傳到頁面。',
      'windows-web-help':'可設定 Ctrl+/、Ctrl+,、Ctrl+Alt+按鍵或 Ctrl+Shift+按鍵。亦支援三個或四個不同修飾鍵的組合。瀏覽器或系統佔用的組合可能無法傳到頁面。',
      'unsupported-browser':'此瀏覽器暫不支援這個組合。',conflict:'已由「{commands}」使用',saved:'已修改',clear:'移除','retry-save':'重試儲存',reset:'還原預設',
      'reset-all':'還原全部預設','modified-count':'已自訂 {count} 項','reset-title':'還原全部預設快速鍵？',
      'reset-description':'將還原目前平台的預設快速鍵。你修改或移除的快速鍵都會還原，其他平台不受影響。',cancel:'取消','reset-saved':'已還原預設快速鍵','close-confirmation':'關閉確認',
      'reset-failed':'無法還原預設。原有快速鍵已保留，請重試。',review:'已核對最新設定',stale:'快速鍵設定或可用指令已更新。請核對最新鍵位後再儲存。',
      'write-failed':'無法儲存。原有快速鍵和目前草稿已保留，請重試。','not-ready':'快速鍵尚未準備好，請稍後重試。',
      read:'無法讀取 {location}。請檢查存取權限後{reload}。',invalid:'{location} 的快速鍵設定已損壞。請先備份並修復設定，再{reload}。',future:'{location} 的快速鍵設定由較新版本建立。請升級 Harness 後重試。',
      'web-document':'目前網站本機儲存中的 dsh.keybindings.v1','desktop-document':'userData/keybindings.json','web-reload':'重新整理頁面','desktop-reload':'重新啟動 Harness',
      'using-defaults':'目前使用預設鍵位。','using-accepted':'目前繼續使用上次成功讀取的鍵位。','native-failed':'無法啟用桌面錄鍵保護，請關閉後重試。',
      'global-hint':'從任何位置開啟','clear-search':'清除搜尋',search:'搜尋快速鍵',close:'關閉快速鍵',application:'應用操作',input:'訊息輸入',menus:'選單與彈出視窗',approval:'審批區域',
      unbound:'尚無快速鍵',empty:'沒有符合的快速鍵',move:'移動選單選項',select:'選取選單項目',dismiss:'關閉選單或最上層視窗',
    },
    workspace:{'session.new':'新增會話','search.sessions.aria':'搜尋會話','workspace.add':'新增工作區','rename.session.title':'重新命名會話','menu.fork':'分支會話','menu.archiveSession':'封存會話'},
    'open-in-app':{'open.tooltip':'在本機開啟'},
    approval:{allowOnce:'允許一次',reject:'拒絕'},
    conversation:{'placeholder.hero':'描述你想建立的內容，/ 呼叫指令，@ 檔案或對話','placeholder.workspace':'選擇工作區以開始',
      'shortcut.newline':'換行','shortcut.complementary':'使用另一種排隊傳送／即時補充操作','shortcut.slash':'開啟指令選單','shortcut.mention':'開啟引用選單','input.stop':'停止產生','input.send':'傳送訊息'},
    'settings.agentPreset':{presetStandardName:'標準模式'},
    'permission.access':{
      mode:'存取模式，目前：{name}',close:'關閉',
      'preset.readOnly':'僅可檢視','preset.workspaceWrite':'工作區內修改','preset.fullAccess':'完整存取權',
      'confirm.title':'啟用完整存取權？','confirm.description':'啟用完整存取權後，Agent 將減少確認步驟，並可直接執行更多操作，包括敏感操作、檔案修改或外部指令。只建議在你信任目前任務時使用。',
      'confirm.acknowledge':'我已了解風險，並願意繼續','confirm.cancel':'取消','confirm.enable':'啟用完整存取權',
    },
  })
}
