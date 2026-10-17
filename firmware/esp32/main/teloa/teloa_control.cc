#include "teloa_control.h"
#include <cJSON.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <initializer_list>
#include <memory>
#include <string_view>

namespace teloa::device {
namespace {
bool Exact(const cJSON* value, std::initializer_list<const char*> keys) {
    if (!cJSON_IsObject(value) || cJSON_GetArraySize(value) != static_cast<int>(keys.size())) return false;
    for (auto key : keys) {
        int count = 0;
        for (auto child = value->child; child; child = child->next)
            if (child->string && std::strcmp(child->string, key) == 0) ++count;
        if (count != 1) return false;
    }
    return true;
}
const cJSON* Get(const cJSON* value, const char* key) { return cJSON_GetObjectItemCaseSensitive(value, key); }
std::string Text(const cJSON* value, const char* key) {
    auto item = Get(value, key);
    return cJSON_IsString(item) ? item->valuestring : "";
}
bool IsText(const cJSON* value, const char* key, size_t maximum) {
    auto item = Get(value, key);
    if (!cJSON_IsString(item)) return false;
    const auto* p = reinterpret_cast<const unsigned char*>(item->valuestring);
    size_t count = 0;
    while (*p) {
        uint32_t code = *p++; int following = 0;
        if (code >= 0xc2 && code <= 0xdf) { code &= 0x1f; following = 1; }
        else if (code >= 0xe0 && code <= 0xef) { code &= 0x0f; following = 2; }
        else if (code >= 0xf0 && code <= 0xf4) { code &= 7; following = 3; }
        else if (code >= 0x80 || (code < 32 && code != 9 && code != 10 && code != 13) || code == 127) return false;
        for (int n = 0; n < following; ++n) { if ((*p & 0xc0) != 0x80) return false; code = (code << 6) | (*p++ & 63); }
        if ((following == 1 && code < 0x80) || (following == 2 && code < 0x800) ||
            (following == 3 && code < 0x10000) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || ++count > maximum) return false;
    }
    return true;
}
bool UInt(const cJSON* value, const char* key, uint32_t& output, bool zero = false) {
    auto item = Get(value, key);
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble) || item->valuedouble < (zero ? 0 : 1) ||
        item->valuedouble >= UINT32_MAX || std::floor(item->valuedouble) != item->valuedouble) return false;
    output = static_cast<uint32_t>(item->valuedouble); return true;
}
bool Capture(const std::string& id) {
    if (id.size() != 36 || id[14] != '4' || std::string_view("89abAB").find(id[19]) == std::string_view::npos) return false;
    for (size_t i = 0; i < id.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
        else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f') || (id[i] >= 'A' && id[i] <= 'F'))) return false;
    }
    return true;
}
bool OneOf(const std::string& value, std::initializer_list<const char*> allowed) {
    return std::any_of(allowed.begin(), allowed.end(), [&](const char* item) { return value == item; });
}
}  // namespace

std::optional<HostControl> ParseHostControl(const uint8_t* data, size_t size) {
    if (!data || size == 0 || size > 16384 || std::memchr(data, 0, size)) return std::nullopt;
    const std::string json(reinterpret_cast<const char*>(data), size);
    if (json.find("\\u0000") != std::string::npos) return std::nullopt;
    std::unique_ptr<cJSON, decltype(&cJSON_Delete)> root(cJSON_ParseWithLengthOpts(json.c_str(), json.size() + 1, nullptr, true), cJSON_Delete);
    if (!root) return std::nullopt;
    auto value = root.get(); HostControl result{}; const auto type = Text(value, "type");
    result.capture_id = Text(value, "captureId"); result.text = Text(value, "text");
    const auto stream = [&] { return UInt(value, "streamId", result.stream_id); };
    if (type == "hello" && Exact(value, {"type", "protocol", "connectionGeneration"}) && Text(value, "protocol") == "teloa-device/v1" && UInt(value, "connectionGeneration", result.generation)) result.type = ControlType::Hello;
    else if(type=="approval.card"&&Exact(value,{"type","ticket","digest","text","canDecide","index","total"})&&Capture(Text(value,"ticket"))&&Text(value,"digest").size()==64&&Text(value,"digest").find_first_not_of("0123456789abcdef")==std::string::npos&&IsText(value,"text",4000)&&cJSON_IsBool(Get(value,"canDecide"))&&UInt(value,"index",result.index,true)&&result.index<20&&UInt(value,"total",result.total,true)&&result.total<=20){result.type=ControlType::ApprovalCard;result.ticket=Text(value,"ticket");result.digest=Text(value,"digest");result.can_decide=cJSON_IsTrue(Get(value,"canDecide"));}
    else if(type=="approval.ack"&&Exact(value,{"type","ticket","state"})&&Capture(Text(value,"ticket"))&&OneOf(Text(value,"state"),{"submitted","stale"})){result.type=ControlType::ApprovalAck;result.ticket=Text(value,"ticket");result.state=Text(value,"state");}
    else if (type == "listen.ready" && Exact(value, {"type", "captureId", "streamId"}) && Capture(result.capture_id) && stream()) result.type = ControlType::ListenReady;
    else if (type == "listen.sealed" && Exact(value, {"type", "captureId", "reason"}) && Capture(result.capture_id) && OneOf(Text(value, "reason"), {"silence", "stop", "limit"})) { result.type = ControlType::ListenSealed; result.state = Text(value, "reason"); }
    else if (type == "transcript" && Exact(value, {"type", "captureId", "text"}) && Capture(result.capture_id) && IsText(value, "text", 4000)) result.type = ControlType::Transcript;
    else if (type == "request.receipt" && Exact(value, {"type", "captureId", "state", "text"}) && Capture(result.capture_id) && IsText(value, "text", 1200) && OneOf(Text(value, "state"), {"pending", "needs_approval", "completed", "unknown", "rejected"})) { result.type = ControlType::Receipt; result.state = Text(value, "state"); }
    else if (type == "playback.start" && Exact(value, {"type", "captureId", "streamId", "sampleRate", "frameDurationMs"}) && Capture(result.capture_id) && stream() && cJSON_IsNumber(Get(value, "sampleRate")) && Get(value, "sampleRate")->valuedouble == 24000 && cJSON_IsNumber(Get(value, "frameDurationMs")) && Get(value, "frameDurationMs")->valuedouble == 60) result.type = ControlType::PlaybackStart;
    else if (type == "playback.text" && Exact(value, {"type", "streamId", "text"}) && stream() && IsText(value, "text", 240)) result.type = ControlType::PlaybackText;
    else if (type == "playback.end" && Exact(value, {"type", "streamId", "lastSequence"}) && stream() && UInt(value, "lastSequence", result.sequence, true)) result.type = ControlType::PlaybackEnd;
    else if (type == "playback.interrupted" && Exact(value, {"type", "streamId"}) && stream()) result.type = ControlType::PlaybackInterrupted;
    else if (type == "error" && Exact(value, {"type", "code"}) && OneOf(Text(value, "code"), {"busy", "unavailable", "no-speech", "capture-rejected", "playback-failed"})) { result.type = ControlType::Error; result.state = Text(value, "code"); }
    else return std::nullopt;
    return result;
}
}  // namespace teloa::device
