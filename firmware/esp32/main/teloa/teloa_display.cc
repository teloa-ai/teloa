#include "teloa_display.h"
#include "teloa_pairing.h"
#include "teloa_motion_data.h"
#include "lvgl_theme.h"
#include "lvgl_font.h"
#include <cmath>
#include <cstring>
#include <algorithm>
#include "teloa_pages.h"
#include "teloa_strings.h"

LV_FONT_DECLARE(teloa_cjk_20);
namespace teloa {
TeloaDisplay* TeloaDisplay::current_=nullptr;
namespace {
#if CONFIG_LANGUAGE_EN_US
constexpr auto kName="Teloa",kReview="Review",kBack="Back",kNext="Next",kReject="Reject",kApprove="Hold: OK",kPair="Hold screen to pair",kPending="Waiting for you",kVoice="Talk",kStop="Stop",kQuiet="Still mode",kAnimated="Motion on";
#elif CONFIG_LANGUAGE_ZH_TW
constexpr auto kName="小羅同學",kReview="待確認",kBack="返回",kNext="下一頁",kReject="拒絕",kApprove="長按批准",kPair="長按螢幕確認配對",kPending="等待你確認",kVoice="說話",kStop="結束",kQuiet="安靜模式",kAnimated="動態模式";
#else
constexpr auto kName="小罗同学",kReview="待确认",kBack="返回",kNext="下一页",kReject="拒绝",kApprove="长按批准",kPair="长按屏幕确认配对",kPending="等待你确认",kVoice="说话",kStop="结束",kQuiet="安静模式",kAnimated="动态模式";
#endif
const char* ActivityText(const char* activity){
#if CONFIG_LANGUAGE_EN_US
 const char* values[]={"Here with you","A little walk","Looking around","Reading quietly","Taking a break","A little stretch","Listening","Working on it","Speaking","Waiting for you","USB pairing","All done","Hello there","A little tail wag"};
#elif CONFIG_LANGUAGE_ZH_TW
 const char* values[]={"陪你待一會兒","散個步","四處看看","翻翻書","休息一下","伸個懶腰","我在聽","正在處理","正在播報","等待你確認","USB 配對","完成了","摸摸頭，收到啦","尾巴動一動"};
#else
 const char* values[]={"陪你待一会儿","散个步","四处看看","翻翻书","休息一下","伸个懒腰","我在听","正在处理","正在播报","等待你确认","USB 配对","完成了","摸摸头，收到啦","摇摇尾巴"};
#endif
 const char* names[]={"idle","stroll","look","read","rest","stretch","listening","working","speaking","waiting","pairing","happy","pet","tail"};
 for(unsigned i=0;i<14;i++){if(!strcmp(activity,names[i]))return values[i];}
 return values[0];
}
lv_obj_t* Shape(lv_obj_t* parent,int x,int y,int width,int height,int radius){
 auto object=lv_obj_create(parent);lv_obj_set_pos(object,x,y);lv_obj_set_size(object,width,height);
 lv_obj_set_style_pad_all(object,0,0);lv_obj_set_style_border_width(object,0,0);lv_obj_set_style_radius(object,radius,0);
 lv_obj_remove_flag(object,LV_OBJ_FLAG_SCROLLABLE);return object;
}
void Visible(lv_obj_t* object,bool visible){if(visible)lv_obj_remove_flag(object,LV_OBJ_FLAG_HIDDEN);else lv_obj_add_flag(object,LV_OBJ_FLAG_HIDDEN);}
lv_obj_t* Label(lv_obj_t* parent,int x,int y,int width,const char* text){auto label=lv_label_create(parent);lv_obj_set_pos(label,x,y);lv_obj_set_width(label,width);lv_label_set_long_mode(label,LV_LABEL_LONG_WRAP);lv_obj_set_style_text_align(label,LV_TEXT_ALIGN_CENTER,0);lv_label_set_text(label,text);return label;}
void Text(lv_obj_t* object,const char* text){if(strcmp(lv_label_get_text(object),text))lv_label_set_text(object,text);}
void Palette(LvglTheme* theme){theme->text_font()->SetFallback(&teloa_cjk_20);const bool dark=theme->name()=="dark";theme->set_background_color(lv_color_hex(dark?0x20221f:0xfcfcfb));theme->set_text_color(lv_color_hex(dark?0xe7e9e3:0x242723));theme->set_assistant_bubble_color(lv_color_hex(dark?0x283c30:0xeaf3ed));}
bool Readable(const std::string& text,const lv_font_t* font){uint32_t point=0;for(unsigned char byte:text){if((byte&0xc0)==0x80){point=(point<<6)|(byte&63);continue;}if(point&&point!='\n'){lv_font_glyph_dsc_t glyph{};if(!lv_font_get_glyph_dsc(font,&glyph,point,0)||glyph.is_placeholder)return false;}point=byte<128?byte:byte&((byte&0xe0)==0xc0?31:(byte&0xf0)==0xe0?15:7);}if(point&&point!='\n'){lv_font_glyph_dsc_t glyph{};if(!lv_font_get_glyph_dsc(font,&glyph,point,0)||glyph.is_placeholder)return false;}return true;}
}
TeloaDisplay::~TeloaDisplay(){DisplayLockGuard lock(this);if(animation_)lv_timer_delete(animation_);if(emoji_image_)lv_image_set_src(emoji_image_,nullptr);sprites_.Reset();if(current_==this)current_=nullptr;}
void TeloaDisplay::SetupUI(){
 if(setup_ui_called_){return;}Display::SetupUI();DisplayLockGuard lock(this);current_=this;
 auto screen=lv_display_get_screen_active(display_);auto theme=static_cast<LvglTheme*>(current_theme_);Palette(theme);lv_obj_set_style_text_font(screen,theme->text_font()->font(),0);lv_obj_set_style_text_color(screen,theme->text_color(),0);
 container_=lv_obj_create(screen);lv_obj_set_size(container_,360,360);lv_obj_set_style_bg_color(container_,theme->background_color(),0);lv_obj_set_style_border_width(container_,0,0);lv_obj_set_style_pad_all(container_,0,0);lv_obj_remove_flag(container_,LV_OBJ_FLAG_SCROLLABLE);
 top_bar_=lv_obj_create(container_);lv_obj_set_pos(top_bar_,77,25);lv_obj_set_size(top_bar_,206,25);lv_obj_set_style_pad_all(top_bar_,0,0);lv_obj_set_style_bg_opa(top_bar_,LV_OPA_TRANSP,0);lv_obj_set_style_border_width(top_bar_,0,0);lv_obj_remove_flag(top_bar_,LV_OBJ_FLAG_SCROLLABLE);
 network_label_=Label(top_bar_,0,0,45,"");battery_label_=Label(top_bar_,165,0,40,"");mute_label_=Label(top_bar_,120,0,40,"");for(auto label:{network_label_,battery_label_,mute_label_})lv_obj_set_style_text_font(label,theme->icon_font()->font(),0);
 name_=Label(container_,65,54,230,kName);status_label_=Label(container_,55,82,250,"");notification_label_=Label(container_,55,82,250,"");lv_obj_add_flag(notification_label_,LV_OBJ_FLAG_HIDDEN);
 floor_=Shape(container_,75,229,210,24,LV_RADIUS_CIRCLE);shadow_=Shape(container_,120,239,120,10,LV_RADIUS_CIRCLE);
 desk_=Shape(container_,128,222,104,18,5);lv_obj_set_style_border_width(desk_,1,0);
 for(unsigned i=0;i<3;i++)signal_[i]=Shape(container_,155+i*19,106,7,7,LV_RADIUS_CIRCLE);
 effect_=Label(container_,145,107,70,"");
 sprites_.Init();emoji_box_=lv_obj_create(container_);lv_obj_set_pos(emoji_box_,92,80);lv_obj_set_size(emoji_box_,176,176);lv_obj_set_style_pad_all(emoji_box_,0,0);lv_obj_set_style_border_width(emoji_box_,0,0);lv_obj_set_style_bg_opa(emoji_box_,LV_OPA_TRANSP,0);lv_obj_remove_flag(emoji_box_,LV_OBJ_FLAG_SCROLLABLE);emoji_image_=lv_image_create(emoji_box_);lv_image_set_src(emoji_image_,sprites_.Show(0));lv_obj_add_flag(emoji_box_,LV_OBJ_FLAG_OVERFLOW_VISIBLE);lv_image_set_pivot(emoji_image_,88,150);
 lv_obj_move_foreground(desk_);lv_obj_move_foreground(effect_);for(auto dot:signal_)lv_obj_move_foreground(dot);
 activity_label_=Label(container_,55,253,250,"");lv_obj_set_style_text_opa(activity_label_,LV_OPA_70,0);
 chat_message_label_=Label(container_,45,277,270,"");lv_obj_set_height(chat_message_label_,22);lv_label_set_long_mode(chat_message_label_,LV_LABEL_LONG_DOT);
 caption_=Label(container_,50,107,260,"");lv_obj_set_height(caption_,168);lv_obj_set_style_text_line_space(caption_,0,0);lv_obj_add_flag(caption_,LV_OBJ_FLAG_HIDDEN);
 primary_=Label(container_,166,300,106,kReview);secondary_=Label(container_,88,300,74,kVoice);lv_obj_set_style_text_color(primary_,lv_color_hex(0x2f6c51),0);
 for(auto button:{primary_,secondary_}){lv_obj_set_height(button,32);lv_obj_set_style_radius(button,17,0);lv_obj_set_style_bg_color(button,theme->assistant_bubble_color(),0);lv_obj_set_style_bg_opa(button,LV_OPA_COVER,0);lv_obj_set_style_pad_top(button,5,0);}
 ApplySceneTheme(theme);
 state_at_=transition_at_=lv_tick_get();
 animation_=lv_timer_create([](lv_timer_t* timer){static_cast<TeloaDisplay*>(lv_timer_get_user_data(timer))->Draw();},50,this);
 Draw();
}
void TeloaDisplay::SetStatus(const char* status){if(!status_label_)return;DisplayLockGuard lock(this);lv_label_set_text(status_label_,status?status:"");}
void TeloaDisplay::SetEmotion(const char* emotion){if(!emotion)return;if(!strcmp(emotion,"happy"))SetState("happy");else if(!strcmp(emotion,"thinking"))SetState("thinking");}
void TeloaDisplay::SetChatMessage(const char*,const char* text){if(!chat_message_label_)return;DisplayLockGuard lock(this);lv_label_set_text(chat_message_label_,text?text:"");}
void TeloaDisplay::ClearChatMessages(){SetChatMessage("system","");}
void TeloaDisplay::SetMotionState(const std::string& state){
 if(state_==state){return;}
 transition_=frame_;transition_at_=state_at_=lv_tick_get();state_=state;reacting_=false;
}
void TeloaDisplay::SetState(const std::string& state){DisplayLockGuard lock(this);SetMotionState(state);Draw();}
void TeloaDisplay::ApprovalCount(unsigned count){DisplayLockGuard lock(this);count_=count;if(!card_&&primary_){auto label=std::string(kReview)+(count?" ("+std::to_string(count)+")":"");lv_label_set_text(primary_,label.c_str());}}
void TeloaDisplay::ApprovalCard(const std::string& text,bool can_decide,const ApprovalIdentity& identity){
 DisplayLockGuard lock(this);if(!caption_)return;const bool readable=Readable(text,static_cast<LvglTheme*>(current_theme_)->text_font()->font());pages_=ApprovalPages(readable?text:std::string(teloa::device::strings::kReviewWeb));if(pages_.empty())pages_.push_back(kPending);page_=0;approval_=identity;shown_at_=esp_timer_get_time();card_=true;can_decide_=can_decide&&readable;lv_obj_remove_flag(secondary_,LV_OBJ_FLAG_HIDDEN);SetMotionState("approval");lv_obj_add_flag(emoji_box_,LV_OBJ_FLAG_HIDDEN);lv_obj_add_flag(chat_message_label_,LV_OBJ_FLAG_HIDDEN);lv_obj_remove_flag(caption_,LV_OBJ_FLAG_HIDDEN);Draw();
}
void TeloaDisplay::Pairing(const std::string& host){SetState("pairing");SetStatus(kPair);SetChatMessage("system",host.c_str());}
bool TeloaDisplay::DismissApproval(const std::string& ticket){DisplayLockGuard lock(this);if(!ticket.empty()&&ticket!=approval_.ticket)return false;approval_={};card_=false;pages_.clear();SetMotionState("idle");if(!emoji_box_)return true;lv_obj_remove_flag(emoji_box_,LV_OBJ_FLAG_HIDDEN);lv_obj_remove_flag(chat_message_label_,LV_OBJ_FLAG_HIDDEN);lv_obj_add_flag(caption_,LV_OBJ_FLAG_HIDDEN);lv_label_set_text(secondary_,kVoice);lv_obj_remove_flag(secondary_,LV_OBJ_FLAG_HIDDEN);lv_label_set_text(primary_,kReview);lv_label_set_text(status_label_,"");return true;}
void TeloaDisplay::SceneVisible(bool visible){
 for(auto object:{floor_,shadow_,desk_,activity_label_,effect_,signal_[0],signal_[1],signal_[2]})Visible(object,visible);
}
void TeloaDisplay::DrawPet(uint32_t now){
 if(state_=="happy"&&now-state_at_>=2600)SetMotionState("idle");
 const bool frozen=quiet_||state_=="pairing"||state_=="approval";
 if(reacting_&&now-react_at_>=1500){reacting_=false;transition_=frame_;transition_at_=state_at_=now;}
 auto target=SamplePetMotion(reacting_?"pet":state_.c_str(),frozen?0:now-(reacting_?react_at_:state_at_));
 frame_=frozen?target:BlendPetMotion(transition_,target,now-transition_at_);
 const auto selection=SelectPetSprite(state_.c_str(),now-state_at_,frame_.pose,quiet_,reacting_);
 const bool daily=state_=="idle"&&!reacting_&&!quiet_&&sprites_.available();
 if(daily){frame_.x=frame_.y=frame_.angle=0;frame_.sx=frame_.sy=256;frame_.activity=selection.activity;frame_.prop=selection.prop;}
 const bool audio=state_=="listening"||state_=="speaking";
 if(audio){frame_.x=frame_.y=frame_.angle=0;frame_.sx=frame_.sy=256;}
 // 每次只呈现绝对时间对应的一帧；语音期间只显示固定姿势。
 const auto image=sprites_.Show(selection.index);const bool packed=sprites_.available();
 if(lv_image_get_src(emoji_image_)!=image)lv_image_set_src(emoji_image_,image);
 if(!packed&&state_=="idle"){frame_.x=frame_.y=0;frame_.activity="idle";frame_.prop="none";}
 lv_obj_set_pos(emoji_box_,92+frame_.x,80+frame_.y);
 lv_obj_set_pos(emoji_image_,packed?0:8,packed?0:10);
 lv_image_set_pivot(emoji_image_,packed?88:0,packed?150:0);
 lv_image_set_rotation(emoji_image_,packed?frame_.angle:0);
 lv_image_set_scale_x(emoji_image_,packed?frame_.sx:640);lv_image_set_scale_y(emoji_image_,packed?frame_.sy:640);
 const uint32_t spent=lv_tick_get()-now;
 const uint32_t until_next=selection.remaining_ms>spent?selection.remaining_ms-spent:0;
 next_frame_ms_=!packed||frozen?250:audio?100:daily?std::clamp<uint32_t>(until_next,sprites_.minimum_interval_ms(),250):50;
 lv_obj_set_x(shadow_,120+frame_.x);lv_obj_set_width(shadow_,120+(frame_.sy-256)/2);
 const bool desk=!strcmp(frame_.prop,"desk");Visible(desk_,desk);if(desk)lv_obj_set_y(desk_,222+(frame_.signal==1?1:0));
 Visible(effect_,!strcmp(frame_.prop,"sparkle"));Text(effect_,"+");lv_obj_set_y(effect_,107-static_cast<int>(frame_.signal)*3);
 for(unsigned i=0;i<3;i++){
  const bool active=state_=="listening"||state_=="speaking"||state_=="thinking";
  Visible(signal_[i],active&&!frozen);lv_obj_set_y(signal_[i],state_=="thinking"?111:245);
  const int height=state_=="thinking"?6:(i==frame_.signal?12:5);lv_obj_set_height(signal_[i],height);lv_obj_set_style_bg_opa(signal_[i],i==frame_.signal?LV_OPA_COVER:LV_OPA_40,0);
 }
 const auto caption=quiet_?kQuiet:ActivityText(frame_.activity);if(strcmp(lv_label_get_text(activity_label_),caption))Text(activity_label_,caption);
 Text(secondary_,state_=="listening"||state_=="speaking"?kStop:kVoice);
}
void TeloaDisplay::Draw(){
 if(!emoji_image_)return;
 if(state_=="pairing"&&!UsbPairing::Instance().Pending()){SetMotionState("idle");Text(status_label_,"");}
 SceneVisible(!card_&&state_!="pairing");
 if(card_){if(frame_period_!=250){frame_period_=250;lv_timer_set_period(animation_,250);}lv_timer_reset(animation_);Text(caption_,pages_[page_].c_str());Text(name_,kPending);auto page_label=std::to_string(page_+1)+" / "+std::to_string(pages_.size());Text(status_label_,page_label.c_str());Text(secondary_,can_decide_?kReject:kBack);Text(primary_,page_+1<pages_.size()?kNext:can_decide_?kApprove:kBack);return;}
 DrawPet(lv_tick_get());if(state_=="pairing")SceneVisible(false);Text(name_,kName);
 if(next_frame_ms_!=frame_period_){frame_period_=next_frame_ms_;lv_timer_set_period(animation_,frame_period_);}
 // LVGL 原计时基点在回调开始；这里从解码结束重计，与已扣除耗时的间隔对应。
 lv_timer_reset(animation_);
}
bool TeloaDisplay::Touch(int x,int y,uint32_t held_ms,bool held_inside){
 if(UsbPairing::Instance().Pending()){UsbPairing::Instance().ConfirmTouch(held_ms);return true;}
 ScreenAction command;ApprovalIdentity displayed;bool dispatch=false;
 {DisplayLockGuard lock(this);displayed=approval_;if(card_){if(y<80){card_=false;lv_obj_remove_flag(emoji_box_,LV_OBJ_FLAG_HIDDEN);lv_obj_remove_flag(chat_message_label_,LV_OBJ_FLAG_HIDDEN);lv_obj_add_flag(caption_,LV_OBJ_FLAG_HIDDEN);lv_label_set_text(secondary_,"");command=ScreenAction::Back;dispatch=true;}else if(y>=300&&y<332&&x>=88&&x<272&&(x<162||x>=166)){if(x<162){command=can_decide_?ScreenAction::Reject:ScreenAction::Back;dispatch=true;}else if(page_+1<pages_.size()){++page_;shown_at_=esp_timer_get_time();Draw();return true;}else if(!can_decide_){command=ScreenAction::Back;dispatch=true;}else if(FreshApprovalHold(shown_at_,esp_timer_get_time(),held_ms,held_inside)){command=ScreenAction::ApproveOnce;dispatch=true;}else return true;}else return true;}
 else {
  if(y<85&&held_ms>=900){quiet_=!quiet_;reacting_=false;transition_=frame_;state_at_=transition_at_=lv_tick_get();lv_label_set_text(chat_message_label_,quiet_?kQuiet:kAnimated);Draw();return true;}
  const auto intent=ResolvePetTouch(x,y,motion_data::origin_x+frame_.x,motion_data::origin_y+frame_.y,state_=="idle",quiet_,state_=="pairing");
  if(intent==PetTouch::Voice)return false;
  if(intent==PetTouch::Review){command=ScreenAction::OpenApprovals;dispatch=true;}
  else if(intent==PetTouch::Pet){transition_=frame_;react_at_=transition_at_=lv_tick_get();reacting_=true;Draw();return true;}
  else return true;
 }}
 if(dispatch&&command==ScreenAction::Back)DismissApproval();
 if(dispatch&&action_){action_({command,displayed});}return true;
}
}

void teloa::TeloaDisplay::SetTheme(Theme* theme){
 Display::SetTheme(theme);if(!container_)return;DisplayLockGuard lock(this);auto current=static_cast<LvglTheme*>(theme);Palette(current);auto screen=lv_display_get_screen_active(display_);lv_obj_set_style_text_font(screen,current->text_font()->font(),0);lv_obj_set_style_text_color(screen,current->text_color(),0);lv_obj_set_style_bg_color(container_,current->background_color(),0);for(auto label:{network_label_,battery_label_,mute_label_})lv_obj_set_style_text_font(label,current->icon_font()->font(),0);for(auto button:{primary_,secondary_})lv_obj_set_style_bg_color(button,current->assistant_bubble_color(),0);
 ApplySceneTheme(current);
}

void teloa::TeloaDisplay::ApplySceneTheme(Theme* theme){
 auto current=static_cast<LvglTheme*>(theme);
 const bool dark=current->name()=="dark";lv_obj_set_style_bg_color(floor_,current->assistant_bubble_color(),0);lv_obj_set_style_bg_color(shadow_,lv_color_hex(dark?0x14291d:0xc9d9ce),0);lv_obj_set_style_bg_color(desk_,lv_color_hex(dark?0x304a39:0xd6e5d9),0);lv_obj_set_style_border_color(desk_,lv_color_hex(dark?0x4a6a53:0xabc4b2),0);for(auto dot:signal_)lv_obj_set_style_bg_color(dot,lv_color_hex(dark?0x96c5a5:0x2f6c51),0);
 const auto accent=lv_color_hex(dark?0x96c5a5:0x2f6c51);
 for(auto button:{primary_,secondary_})lv_obj_set_style_text_color(button,accent,0);
 lv_obj_set_style_text_color(effect_,accent,0);
}
