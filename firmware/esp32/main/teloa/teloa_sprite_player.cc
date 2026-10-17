#include "teloa_sprite_player.h"
#include <algorithm>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <miniz.h>
#include <src/misc/cache/instance/lv_image_cache.h>

extern const uint8_t mascot_pack[] asm("_binary_mascot_pet_start");
extern const uint8_t mascot_pack_end[] asm("_binary_mascot_pet_end");
extern const uint8_t fallback_pixels[] asm("_binary_fallback_rgba_start");
namespace teloa {
namespace {
bool Inflate(const uint8_t* input,size_t size,uint8_t* output,size_t capacity,void* context){
    auto* state=static_cast<tinfl_decompressor*>(context);
    tinfl_init(state);
    size_t consumed=size,written=capacity;
    const auto result=tinfl_decompress(state,input,&consumed,output,output,&written,
        TINFL_FLAG_PARSE_ZLIB_HEADER|TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    return result==TINFL_STATUS_DONE&&consumed==size&&written==capacity;
}
void Describe(lv_image_dsc_t& image,const uint8_t* pixels,unsigned size){
    image.header.magic=LV_IMAGE_HEADER_MAGIC;image.header.cf=LV_COLOR_FORMAT_ARGB8888;
    image.header.w=image.header.h=size;image.header.stride=size*4;
    image.data_size=size*size*4;image.data=pixels;
}
}
SpritePlayer::~SpritePlayer(){Reset();}
void SpritePlayer::Reset(){
    if(!initialized_)return;
    for(auto& image:images_)lv_image_cache_drop(&image);
    heap_caps_free(memory_);
    memory_=nullptr;scratch_=nullptr;inflater_=nullptr;
    initialized_=available_=false;index_=kSpriteCount;
}
void SpritePlayer::Init(){
    if(initialized_)return;
    initialized_=true;
    Describe(fallback_,fallback_pixels,64);
    if(!pack_.Open(mascot_pack,mascot_pack_end-mascot_pack))return;
    const size_t bytes=kSpriteBytes*2+kSpriteScratchBytes+sizeof(tinfl_decompressor);
    // 分配失败不侵占音频使用的内部 SRAM；小图仍直接来自 Flash。
    memory_=static_cast<uint8_t*>(heap_caps_calloc(1,bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    if(!memory_){ESP_LOGW("TeloaPet","PSRAM unavailable, using still artwork");return;}
    scratch_=memory_+kSpriteBytes*2;inflater_=scratch_+kSpriteScratchBytes;
    for(unsigned i=0;i<2;++i)Describe(images_[i],memory_+i*kSpriteBytes,kSpriteWidth);
    available_=true;
    ESP_LOGI("TeloaPet","54 sprites, %u flash bytes, %u PSRAM bytes",unsigned(mascot_pack_end-mascot_pack),unsigned(bytes));
}
const lv_image_dsc_t* SpritePlayer::Show(unsigned index){
    if(!available_)return &fallback_;
    if(index==index_)return &images_[front_];
    const unsigned next=1-front_;
    lv_image_cache_drop(&images_[next]);
    const int64_t started=esp_timer_get_time();
    if(!pack_.Decode(index,const_cast<uint8_t*>(images_[next].data),kSpriteBytes,scratch_,
                     kSpriteScratchBytes,Inflate,inflater_)){
        available_=false;ESP_LOGW("TeloaPet","Sprite decode failed, using still artwork");return &fallback_;
    }
    const uint32_t elapsed=(esp_timer_get_time()-started+999)/1000;
    // 慢解码时减少刷新；由绝对时间选择器跳过过期帧，不追赶旧帧。
    minimum_interval_ms_=std::max(minimum_interval_ms_,std::clamp<uint32_t>(elapsed*3,20,250));
    index_=index;front_=next;return &images_[front_];
}
}
