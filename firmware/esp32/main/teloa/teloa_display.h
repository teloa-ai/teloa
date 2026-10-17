#pragma once
#include "display/lcd_display.h"
#include <functional>
#include <vector>
#include "teloa_approval_view.h"
#include "teloa_motion.h"
#include "teloa_sprite_player.h"

namespace teloa {
enum class ScreenAction { OpenApprovals, ApproveOnce, Reject, NextPage, Back };
struct ScreenRequest { ScreenAction action; ApprovalIdentity approval; };
class TeloaDisplay final : public SpiLcdDisplay {
public:
    using SpiLcdDisplay::SpiLcdDisplay;
    ~TeloaDisplay() override;
    void SetupUI() override;
    void SetTheme(Theme* theme) override;
    void SetStatus(const char* status) override;
    void SetEmotion(const char* emotion) override;
    void SetChatMessage(const char* role,const char* content) override;
    void ClearChatMessages() override;
    void SetState(const std::string& state);
    void ApprovalCount(unsigned count);
    void ApprovalCard(const std::string& text,bool can_decide,const ApprovalIdentity& identity);
    bool DismissApproval(const std::string& ticket="");
    void Pairing(const std::string& host);
    bool Touch(int x,int y,uint32_t held_ms,bool held_inside);
    void OnAction(std::function<void(ScreenRequest)> action){action_=std::move(action);}
    static TeloaDisplay* Current(){return current_;}
private:
    void Draw();
    void SetMotionState(const std::string& state);
    void DrawPet(uint32_t now);
    void SceneVisible(bool visible);
    void ApplySceneTheme(Theme* theme);
    lv_timer_t* animation_=nullptr;
    lv_obj_t* name_=nullptr;
    lv_obj_t* primary_=nullptr;
    lv_obj_t* secondary_=nullptr;
    lv_obj_t* caption_=nullptr;
    lv_obj_t* floor_=nullptr;
    lv_obj_t* shadow_=nullptr;
    lv_obj_t* desk_=nullptr;
    lv_obj_t* activity_label_=nullptr;
    lv_obj_t* effect_=nullptr;
    lv_obj_t* signal_[3]{};
    PetFrame frame_{},transition_{};
    SpritePlayer sprites_;
    uint32_t next_frame_ms_=250;
    uint32_t state_at_=0,react_at_=0,transition_at_=0;
    uint32_t frame_period_=50;
    bool reacting_=false,quiet_=false;
    std::function<void(ScreenRequest)> action_;
    std::string state_="idle";
    ApprovalIdentity approval_;
    uint64_t shown_at_=0;
    std::vector<std::string> pages_;
    size_t page_=0;
    unsigned count_=0;
    bool card_=false,can_decide_=false;
    static TeloaDisplay* current_;
};
}
