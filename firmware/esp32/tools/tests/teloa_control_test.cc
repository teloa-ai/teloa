#include "teloa_control.h"
#include "teloa_pages.h"
#include "teloa_approval_view.h"
#include <cassert>
#include <string>
using namespace teloa::device;
static auto Parse(const std::string& input) { return ParseHostControl(reinterpret_cast<const uint8_t*>(input.data()), input.size()); }
int main() {
    auto hello = Parse(R"({"type":"hello","protocol":"teloa-device/v1","connectionGeneration":7})");
    assert(hello && hello->type == ControlType::Hello && hello->generation == 7);
    auto playback = Parse(R"({"type":"playback.start","captureId":"4c35115b-5dad-4d18-a5f3-c8ed8884e404","streamId":9,"sampleRate":24000,"frameDurationMs":60})");
    assert(playback && playback->stream_id == 9);
    assert(Parse(R"({"type":"playback.text","streamId":9,"text":"Teloa 已完成。"})"));
    for (const auto& input : {
        R"({"type":"system","command":"reboot"})", R"({"type":"notify","audio_url":"https://example.invalid"})",
        R"({"type":"hello","protocol":"teloa-device/v1","connectionGeneration":0})",
        R"({"type":"hello","protocol":"teloa-device/v1","connectionGeneration":7,"ownerId":"x"})",
        R"({"type":"hello","protocol":"teloa-device/v1","connectionGeneration":7,"connectionGeneration":8})",
        R"({"type":"playback.end","streamId":9,"lastSequence":-1})",
        R"({"type":"playback.end","streamId":9,"lastSequence":1.5})",
        R"({"type":"playback.end","streamId":9,"lastSequence":4294967295})",
        R"({"type":"playback.text","streamId":9,"text":"a\u0000b"})",
        R"({"type":"playback.text","streamId":9,"text":"a"} false)"}) assert(!Parse(input));
    assert(!Parse(std::string(16385, ' ')));
    assert(!Parse(std::string("{\"type\":\"playback.text\",\"streamId\":9,\"text\":\"") + char(0xff) + "\"}"));
    auto card=Parse(R"({"type":"approval.card","ticket":"4c35115b-5dad-4d18-a5f3-c8ed8884e404","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","text":"确认写入 test.txt","canDecide":true,"index":0,"total":1})");
    assert(card && card->can_decide && card->total==1);
    auto pages=teloa::ApprovalPages(std::string(90,'x')+"\n\n\n\n\n\n\n"+"中文审批内容");std::string restored;
    for(const auto& page:pages)restored+=page;
    assert(restored==std::string(90,'x')+"\n\n\n\n\n\n\n"+"中文审批内容");assert(pages.size()>=3);
    teloa::ApprovalIdentity shown{"A","digestA",7},latest{"B","digestB",7};
    assert(!teloa::SameApproval(shown,latest));assert(teloa::SameApproval(shown,shown));
    latest=shown;latest.generation++;assert(!teloa::SameApproval(shown,latest));
    assert(!teloa::FreshApprovalHold(2000000,2500000,1300,true));
    assert(!teloa::FreshApprovalHold(1000000,2500000,1300,false));
    assert(teloa::FreshApprovalHold(1000000,2500000,1300,true));
    assert(!teloa::ApprovalButton(90,310));assert(teloa::ApprovalButton(200,310));
    return 0;
}
