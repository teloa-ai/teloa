#include "teloa_motion.h"
#include "teloa_motion_data.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace teloa {
namespace {
int Mix(int a,int b,double progress){return static_cast<int>(std::lround(a+(b-a)*progress));}
double Ease(double value){return value*value*(3-2*value);}
PetFrame Interpolate(const MotionKeyframe& from,const MotionKeyframe& to,double progress){
    return {Mix(from.x,to.x,progress),Mix(from.y,to.y,progress),Mix(from.angle,to.angle,progress),
            Mix(from.sx,to.sx,progress),Mix(from.sy,to.sy,progress),from.pose,from.activity,from.prop,from.signal};
}
}
PetFrame SamplePetMotion(const char* mode,uint32_t elapsed_ms){
    const MotionClip* selected=&motion_data::clips[0];
    for(const auto& clip:motion_data::clips)if(mode&&!std::strcmp(mode,clip.name)){selected=&clip;break;}
    const auto& clip=*selected;const auto end=clip.frames[clip.count-1].at;
    const uint32_t time=clip.loop?elapsed_ms%end:std::min(elapsed_ms,end);
    size_t index=0;while(index+1<clip.count&&clip.frames[index+1].at<=time)++index;
    const auto& from=clip.frames[index];const auto& to=clip.frames[std::min(index+1,clip.count-1)];
    const double progress=to.at==from.at?0:Ease(static_cast<double>(time-from.at)/(to.at-from.at));
    return Interpolate(from,to,progress);
}
PetFrame BlendPetMotion(const PetFrame& from,const PetFrame& to,uint32_t elapsed_ms){
    const double progress=Ease(std::min(static_cast<double>(elapsed_ms)/motion_data::transition_ms,1.0));
    auto frame=to;frame.x=Mix(from.x,to.x,progress);frame.y=Mix(from.y,to.y,progress);
    frame.angle=Mix(from.angle,to.angle,progress);frame.sx=Mix(from.sx,to.sx,progress);frame.sy=Mix(from.sy,to.sy,progress);return frame;
}
PetTouch ResolvePetTouch(int x,int y,int pet_x,int pet_y,bool idle,bool quiet,bool pairing){
    if(pairing)return PetTouch::Ignore;
    if(y>=300&&y<332){
        if(x>=88&&x<162)return PetTouch::Voice;
        if(x>=166&&x<272)return PetTouch::Review;
    }
    if(idle&&!quiet&&x>=pet_x+20&&x<pet_x+140&&y>=pet_y&&y<pet_y+155)return PetTouch::Pet;
    return PetTouch::Ignore;
}
}  // namespace teloa
