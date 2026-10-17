#pragma once
#include "teloa_sprite.h"
#include <lvgl.h>

namespace teloa {
// 只由 LVGL 线程/DisplayLockGuard 调用；双缓冲与工作区终身复用。
class SpritePlayer {
public:
    ~SpritePlayer();
    void Reset();
    void Init();
    const lv_image_dsc_t* Show(unsigned index);
    bool available() const {return available_;}
    uint32_t minimum_interval_ms() const {return minimum_interval_ms_;}
private:
    SpritePack pack_;
    lv_image_dsc_t images_[2]{},fallback_{};
    uint8_t* memory_=nullptr;
    uint8_t* scratch_=nullptr;
    void* inflater_=nullptr;
    unsigned front_=0,index_=kSpriteCount;
    bool initialized_=false,available_=false;
    uint32_t minimum_interval_ms_=20;
};
}
