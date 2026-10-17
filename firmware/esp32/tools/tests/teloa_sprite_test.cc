#include "teloa_sprite.h"
#include <zlib.h>
#include <cassert>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <set>
#include <vector>
using namespace teloa;
bool Inflate(const uint8_t* src,size_t length,uint8_t* out,size_t capacity,void*){
    uLongf size=capacity;uLong consumed=length;
    return uncompress2(out,&size,src,&consumed)==Z_OK&&size==capacity&&consumed==length;
}
int main(int argc,char** argv){
    if(argc==3&&!strcmp(argv[1],"--trace")){
        std::ifstream file(argv[2],std::ios::binary);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(file)),{}),scratch(kSpriteScratchBytes),out(kSpriteBytes);
        SpritePack pack;assert(pack.Open(data.data(),data.size()));
        unsigned last=kSpriteCount,decodes=0;std::string line;
        while(std::getline(std::cin,line)){
            std::istringstream input(line);std::string mode;uint32_t ms;unsigned pose;bool quiet,reacting;
            if(!(input>>mode>>ms>>pose>>quiet>>reacting))return 2;
            const auto frame=SelectPetSprite(mode.c_str(),ms,pose,quiet,reacting);
            if(last!=frame.index){assert(pack.Decode(frame.index,out.data(),out.size(),scratch.data(),scratch.size(),Inflate,nullptr));++decodes;last=frame.index;}
            std::cout<<mode<<' '<<frame.index<<' '<<decodes<<std::endl;
        }
        return 0;
    }
    if(argc==6){
        const auto s=SelectPetSprite(argv[1],std::stoul(argv[2]),std::stoul(argv[3]),std::stoi(argv[4]),std::stoi(argv[5]));
        std::cout<<s.index<<' '<<s.remaining_ms<<'\n';return 0;
    }
    assert(argc==3);
    std::ifstream file(argv[1],std::ios::binary);
    std::vector<uint8_t> data((std::istreambuf_iterator<char>(file)),{}),scratch(kSpriteScratchBytes);
    std::vector<uint8_t> out(kSpriteBytes+32,0xa5);
    SpritePack pack;assert(pack.Open(data.data(),data.size()));
    std::ofstream decoded(argv[2],std::ios::binary);
    const auto start=std::chrono::steady_clock::now();
    for(unsigned repeat=0;repeat<3;++repeat)for(unsigned i=0;i<kSpriteCount;++i){
        assert(pack.Decode(i,out.data()+16,kSpriteBytes,scratch.data(),scratch.size(),Inflate,nullptr));
        for(unsigned p=0;p<16;++p)assert(out[p]==0xa5&&out[kSpriteBytes+16+p]==0xa5);
        if(!repeat)decoded.write(reinterpret_cast<const char*>(out.data()+16),kSpriteBytes);
    }
    const auto elapsed=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-start).count();
    assert(!pack.Decode(54,out.data(),out.size(),scratch.data(),scratch.size(),Inflate,nullptr));
    assert(!pack.Decode(0,out.data(),kSpriteBytes-1,scratch.data(),scratch.size(),Inflate,nullptr));
    assert(!pack.Decode(0,out.data(),out.size(),scratch.data(),scratch.size()-1,Inflate,nullptr));
    for(size_t size:{size_t(0),size_t(15),size_t(1216),data.size()-1})assert(!pack.Open(data.data(),size));
    for(size_t offset:{size_t(0),size_t(4),size_t(6),size_t(8),size_t(10),size_t(12),size_t(784),size_t(788)}){
        auto corrupt=data;corrupt[offset]^=0xff;assert(!pack.Open(corrupt.data(),corrupt.size()));
    }
    auto corrupt=data;corrupt.back()^=0xff;assert(pack.Open(corrupt.data(),corrupt.size()));
    std::fill(out.begin(),out.end(),0xa5);
    assert(!pack.Decode(53,out.data(),out.size(),scratch.data(),scratch.size(),Inflate,nullptr));
    for(auto value:out)assert(value==0xa5);
    std::set<unsigned> seen;
    for(uint32_t time=0;time<18320;++time){
        const auto s=SelectPetSprite("idle",time,0,false,false);seen.insert(s.index);
        assert(s.index<54&&s.remaining_ms>0);
        const auto repeat=SelectPetSprite("idle",time+18320,0,false,false);assert(s.index==repeat.index);
    }
    for(unsigned i=6;i<54;++i)assert(seen.count(i));
    assert(SelectPetSprite("idle",3000,0,false,false).index==6);
    assert(SelectPetSprite("idle",3540,0,false,false).index==12); // 延迟六帧，直接跳到当前帧。
    for(auto mode:{"listening","speaking","thinking","approval","pairing"})
        for(unsigned t=0;t<20000;t+=17)assert(SelectPetSprite(mode,t,2,false,false).index==2);
    for(unsigned t=0;t<20000;t+=17){
        assert(SelectPetSprite("idle",t,0,true,false).index==0);
        assert(SelectPetSprite("idle",t,1,false,true).index==1);
    }
    std::cout<<"sprite decode + expansion mean (desktop, not ESP32): "<<elapsed/162.0<<" us; bounds, corruption, clock and interruption passed\n";
}
