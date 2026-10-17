#pragma once
#include <cstddef>
#include <cstdint>
namespace teloa {
struct MotionKeyframe {
    uint32_t at;
    int x,y,angle,sx,sy;
    unsigned pose;
    const char* activity;
    const char* prop;
    unsigned signal;
};
struct MotionClip { const char* name; const MotionKeyframe* frames; size_t count; bool loop; };
struct PetFrame {
    int x=0,y=0,angle=0,sx=256,sy=256;
    unsigned pose=0;
    const char* activity="idle";
    const char* prop="none";
    unsigned signal=0;
};
PetFrame SamplePetMotion(const char* mode,uint32_t elapsed_ms);
PetFrame BlendPetMotion(const PetFrame& from,const PetFrame& to,uint32_t elapsed_ms);
enum class PetTouch { Ignore, Pet, Voice, Review };
PetTouch ResolvePetTouch(int x,int y,int pet_x,int pet_y,bool idle,bool quiet,bool pairing);
}
