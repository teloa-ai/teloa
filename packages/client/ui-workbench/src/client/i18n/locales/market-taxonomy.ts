// 市场分类受控词表文案（规格 2026-09-25 §4.2）。
// 25 键 × 11 列：key, zh-CN, zh-Hant, en, ja, ko, vi, es, fr, de, pt。
// 功能 10 键 + 行业 6 根键 + 9 二级键；二级键中的 / 写成 .。
type Row=readonly [string,string,string,string,string,string,string,string,string,string,string]
export const MARKET_TAXONOMY_MESSAGE_ROWS:readonly Row[]=[
 // 功能维度（10 键）
 ['market.taxonomy.function.office-docs','办公与文档','辦公與文件','Office & Docs','オフィス & 文書','오피스 & 문서','Văn phòng & Tài liệu','Ofimática y Documentos','Bureautique et Documents','Büro & Dokumente','Escritório e Documentos'],
 ['market.taxonomy.function.communication','沟通与协作','溝通與協作','Communication & Collaboration','コミュニケーション & コラボ','커뮤니케이션 & 협업','Giao tiếp & Cộng tác','Comunicación y Colaboración','Communication et Collaboration','Kommunikation & Zusammenarbeit','Comunicação e Colaboração'],
 ['market.taxonomy.function.content-design','内容与设计','內容與設計','Content & Design','コンテンツ & デザイン','콘텐츠 & 디자인','Nội dung & Thiết kế','Contenido y Diseño','Contenu et Design','Inhalt & Design','Conteúdo e Design'],
 ['market.taxonomy.function.data-research','数据与研究','數據與研究','Data & Research','データ & 研究','데이터 & 리서치','Dữ liệu & Nghiên cứu','Datos e Investigación','Données et Recherche','Daten & Forschung','Dados e Pesquisa'],
 ['market.taxonomy.function.dev-tools','研发工具','研發工具','Dev Tools','開発ツール','개발 도구','Công cụ Phát triển','Herramientas de Desarrollo','Outils de Développement','Entwicklungs-tools','Ferramentas de Desenvolvimento'],
 ['market.taxonomy.function.cloud-ops','云与运维','雲端與維運','Cloud & Ops','クラウド & 運用','클라우드 & 운영','Đám mây & Vận hành','Nube y Operaciones','Cloud et Ops','Cloud & Betrieb','Nuvem e Operações'],
 ['market.taxonomy.function.security','安全','安全','Security','セキュリティ','보안','Bảo mật','Seguridad','Sécurité','Sicherheit','Segurança'],
 ['market.taxonomy.function.business-ops','商务运营','商務營運','Business Ops','ビジネス運営','비즈니스 운영','Vận hành Kinh doanh','Operaciones de Negocio','Opérations Commerciales','Geschäftsbetrieb','Operações de Negócio'],
 ['market.taxonomy.function.automation','自动化与集成','自動化與整合','Automation & Integration','自動化 & 統合','자동화 & 통합','Tự động hóa & Tích hợp','Automatización e Integración','Automatisation et Intégration','Automatisierung & Integration','Automação e Integração'],
 ['market.taxonomy.function.other','其他','其他','Other','その他','기타','Khác','Otros','Autres','Sonstiges','Outros'],
 // 行业维度 - 一级键（6 键）
 ['market.taxonomy.industry.general','通用','通用','General','一般','일반','Tổng quát','General','Général','Allgemein','Geral'],
 ['market.taxonomy.industry.cyber-security','网络安全','網路安全','Cyber Security','サイバーセキュリティ','사이버보안','An ninh mạng','Ciberseguridad','Cybersécurité','Cybersicherheit','Cibersegurança'],
 ['market.taxonomy.industry.marketing','市场营销','市場行銷','Marketing','マーケティング','마케팅','Marketing','Marketing','Marketing','Marketing','Marketing'],
 ['market.taxonomy.industry.media','媒体内容','媒體內容','Media & Content','メディア & コンテンツ','미디어 & 콘텐츠','Truyền thông & Nội dung','Medios y Contenido','Médias et Contenu','Medien & Inhalt','Mídia e Conteúdo'],
 ['market.taxonomy.industry.software','软件研发','軟體研發','Software Development','ソフトウェア開発','소프트웨어 개발','Phát triển Phần mềm','Desarrollo de Software','Développement Logiciel','Softwareentwicklung','Desenvolvimento de Software'],
 ['market.taxonomy.industry.other','其他','其他','Other','その他','기타','Khác','Otros','Autres','Sonstiges','Outros'],
 // 行业维度 - 二级键（9 键）；i18n 中 / 写成 .
 ['market.taxonomy.industry.cyber-security.soc','SOC 运营','SOC 運營','SOC Operations','SOC 運用','SOC 운영','Vận hành SOC','Operaciones SOC','Opérations SOC','SOC-Betrieb','Operações SOC'],
 ['market.taxonomy.industry.cyber-security.detection','检测工程','偵測工程','Detection Engineering','検知エンジニアリング','탐지 엔지니어링','Kỹ thuật Phát hiện','Ingeniería de Detección','Ingénierie de Détection','Detection Engineering','Engenharia de Detecção'],
 ['market.taxonomy.industry.cyber-security.appsec','应用安全','應用程式安全','Application Security','アプリケーションセキュリティ','애플리케이션 보안','Bảo mật Ứng dụng','Seguridad de Aplicaciones','Sécurité Applicative','Applikationssicherheit','Segurança de Aplicações'],
 ['market.taxonomy.industry.cyber-security.grc','合规与治理','合規與治理','Compliance & GRC','コンプライアンス & ガバナンス','컴플라이언스 & 거버넌스','Tuân thủ & Quản trị','Cumplimiento y GRC','Conformité et Gouvernance','Compliance & Governance','Conformidade e Governança'],
 ['market.taxonomy.industry.marketing.new-media','新媒体','新媒體','New Media','ニューメディア','뉴미디어','Truyền thông Mới','Nuevos Medios','Nouveaux Médias','Neue Medien','Novos Médias'],
 ['market.taxonomy.industry.marketing.e-commerce','电商','電商','E-commerce','EC','이커머스','Thương mại điện tử','Comercio Electrónico','E-commerce','E-Commerce','E-commerce'],
 ['market.taxonomy.industry.media.video','视频制作','視頻製作','Video Production','動画制作','영상 제작','Sản xuất Video','Producción de Video','Production Vidéo','Videoproduktion','Produção de Vídeo'],
 ['market.taxonomy.industry.software.engineering','研发工程','研發工程','Engineering','エンジニアリング','엔지니어링','Kỹ thuật Phần mềm','Ingeniería','Ingénierie','Engineering','Engenharia'],
 ['market.taxonomy.industry.software.product','产品','產品','Product','プロダクト','프로덕트','Sản phẩm','Producto','Produit','Produkt','Produto'],
] as const
