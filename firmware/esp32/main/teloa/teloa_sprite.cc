#include "teloa_sprite.h"
#include "assets/teloa_sprite_data.h"
#include <cstring>

namespace teloa {
namespace {
uint16_t U16(const uint8_t* p){return p[0]|(uint16_t(p[1])<<8);}
uint32_t U32(const uint8_t* p){return U16(p)|(uint32_t(U16(p+2))<<16);}
constexpr size_t kTable=16+768,kPayload=kTable+kSpriteCount*8;
}
bool SpritePack::Open(const uint8_t* data,size_t size){
    data_=nullptr;
    if(!data||size<kPayload||memcmp(data,"TPET",4)||U16(data+4)!=1||
       U16(data+6)!=kSpriteWidth||U16(data+8)!=kSpriteHeight||U16(data+10)!=256||
       U32(data+12)!=kSpriteCount)return false;
    size_t expected=kPayload;
    for(unsigned i=0;i<kSpriteCount;++i){
        const auto* entry=data+kTable+i*8;
        const size_t offset=U32(entry),length=U32(entry+4);
        if(offset!=expected||!length||length>size-expected)return false;
        expected+=length;
    }
    if(expected!=size)return false;
    data_=data;return true;
}
bool SpritePack::Decode(unsigned index,uint8_t* output,size_t output_size,uint8_t* scratch,
                        size_t scratch_size,SpriteInflate inflate,void* context) const {
    if(!data_||index>=kSpriteCount||!output||!scratch||output_size<kSpriteBytes||
       scratch_size<kSpriteScratchBytes||!inflate)return false;
    const auto* entry=data_+kTable+index*8;
    if(!inflate(data_+U32(entry),U32(entry+4),scratch,kSpriteScratchBytes,context))return false;
    // 校验/解压成功后才改输出；alpha 与颜色分离，透明轮廓不受色板限制。
    const auto* palette=data_+16;
    for(size_t p=0;p<kSpritePixels;++p){
        const auto* rgb=palette+scratch[p]*3;
        const unsigned alpha=scratch[kSpritePixels+p/2];
        output[p*4]=rgb[2];output[p*4+1]=rgb[1];output[p*4+2]=rgb[0];
        output[p*4+3]=((p&1)?alpha&15:alpha>>4)*17;
    }
    return true;
}
SpriteSelection SelectPetSprite(const char* mode,uint32_t elapsed_ms,unsigned pose,bool quiet,bool reacting){
    if(!mode||strcmp(mode,"idle")||quiet||reacting)return {pose<6?pose:0,250,nullptr,nullptr};
    uint32_t time=elapsed_ms%sprite_data::cycle_ms;
    for(const auto& phase:sprite_data::phases){
        uint32_t duration=0;
        for(unsigned i=0;i<phase.count;++i)duration+=phase.durations[i];
        const uint32_t length=duration*phase.repeats;
        if(time>=length){time-=length;continue;}
        time%=duration;
        for(unsigned i=0;i<phase.count;++i){
            if(time<phase.durations[i])return {phase.first+i,phase.durations[i]-time,phase.activity,phase.prop};
            time-=phase.durations[i];
        }
    }
    return {0,250,"idle","none"};
}
}
