#pragma once
#include <cstddef>
#include <cstdint>

namespace teloa {
// 固定格式、嵌入资源；不接受远端图像或任意尺寸。
inline constexpr unsigned kSpriteWidth=176,kSpriteHeight=176,kSpriteCount=54;
inline constexpr size_t kSpritePixels=kSpriteWidth*kSpriteHeight;
inline constexpr size_t kSpriteBytes=kSpritePixels*4,kSpriteScratchBytes=kSpritePixels*3/2;
using SpriteInflate=bool (*)(const uint8_t*,size_t,uint8_t*,size_t,void*);
class SpritePack {
public:
    bool Open(const uint8_t* data,size_t size);
    bool Decode(unsigned index,uint8_t* output,size_t output_size,uint8_t* scratch,
                size_t scratch_size,SpriteInflate inflate,void* context) const;
private:
    const uint8_t* data_=nullptr;
};
struct SpritePhase {
    unsigned first,count;
    const uint16_t* durations;
    unsigned repeats;
    const char* activity;
    const char* prop;
};
struct SpriteSelection {
    unsigned index;
    uint32_t remaining_ms;
    const char* activity;
    const char* prop;
};
// 绝对时间直接定位当前帧；迟到时不补播，不产生积压。
SpriteSelection SelectPetSprite(const char* mode,uint32_t elapsed_ms,unsigned pose,bool quiet,bool reacting);
}
