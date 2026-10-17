#include "teloa_protocol.h"
#include "teloa_pairing.h"
#include "teloa_time.h"
#include "settings.h"
#include "teloa_strings.h"
#include <esp_random.h>
#include <arpa/inet.h>
#include <algorithm>
#include <cstring>
#include <ctime>
#include <cstdio>
#if CONFIG_TELOA_DIRECT && !CONFIG_MBEDTLS_HAVE_TIME_DATE
#error "Teloa TLS requires certificate validity date verification"
#endif

using teloa::device::ControlType;
namespace strings = teloa::device::strings;
namespace {
constexpr EventBits_t kHello = BIT0, kCapture = BIT1, kFailure = BIT2, kCaptureRejected = BIT3;
constexpr const char* kHelloJson = R"({"type":"hello","protocol":"teloa-device/v1","audio":{"uplink":{"format":"opus","sampleRate":16000,"channels":1,"frameDurationMs":60},"downlink":{"format":"opus","sampleRate":24000,"channels":1,"frameDurationMs":60}}})";
std::string CaptureId() {
    uint8_t bytes[16]; esp_fill_random(bytes, sizeof(bytes)); bytes[6] = (bytes[6] & 15) | 0x40; bytes[8] = (bytes[8] & 63) | 0x80;
    char id[37]; std::snprintf(id, sizeof(id), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]); return id;
}
uint32_t Read32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
}
TeloaProtocol::TeloaProtocol() : events_(xEventGroupCreate()) {}
TeloaProtocol::~TeloaProtocol() { CloseAudioChannel(false); vEventGroupDelete(events_); }

bool TeloaProtocol::ReadConfiguration() {
    Settings config("teloa");
    auto host = config.GetString("host"); auto port = config.GetInt("port");
    ca_ = config.GetString("ca"); server_name_ = config.GetString("server_name"); credential_ = config.GetString("credential");
    std::string paired;
    device_id_.clear();
    const bool valid_paired=teloa::ReadPairedConfiguration(paired);
    if(!valid_paired&&!paired.empty())return false;
    if(valid_paired){
        auto row=cJSON_Parse(paired.c_str());auto text=[&](const char* key){return std::string(cJSON_GetObjectItemCaseSensitive(row,key)->valuestring);};
        host=text("host");port=cJSON_GetObjectItemCaseSensitive(row,"port")->valueint;ca_=text("ca");server_name_=text("server_name");credential_=text("credential");device_id_=text("device_id");time_floor_=static_cast<int64_t>(cJSON_GetObjectItemCaseSensitive(row,"unix_time")->valuedouble);cJSON_Delete(row);
    }
    in_addr parsed{};
    if (inet_pton(AF_INET, host.c_str(), &parsed) != 1) return false;
    const uint32_t ip = ntohl(parsed.s_addr);
    const bool private_ip = (ip >> 24) == 10 || (ip >> 20) == 0xac1 || (ip >> 16) == 0xc0a8;
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    if (!private_ip || port < 1024 || port > 65535 || port == 3100 || port == 3101 || ca_.size() < 100 || ca_.size() > 8192 ||
        server_name_.empty() || server_name_.size() > 253 || server_name_.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-") != std::string::npos ||
        credential_.size() != 43 || credential_.find_first_not_of(alphabet) != std::string::npos || (alphabet.find(credential_.back()) & 3) != 0) return false;
    uri_ = "wss://" + host + ":" + std::to_string(port) + "/devices/v1/connect";
    host_=host;port_=port;
    headers_ = "Authorization: Bearer " + credential_ + "\r\n";
    return true;
}
bool TeloaProtocol::Start() {
    if (!ReadConfiguration()) { SetError(strings::kPair); return false; }
    return true;
}
bool TeloaProtocol::OpenAudioChannel() {
    if (IsAudioChannelOpened()) return true;
    CloseAudioChannel(false);
    if (!ReadConfiguration()) { SetError(strings::kPair); return false; }
    // Nonce-authenticated host time survives cold boot without trusting unauthenticated NTP.
    if(!device_id_.empty()&&!teloa::SynchronizeHostTime(host_,port_,device_id_,credential_,time_floor_)){SetError(strings::kTime);return false;}
    if (std::time(nullptr) < 1704067200) { SetError(strings::kTime); return false; }
    failed_ = false; closing_ = false; closed_announced_ = false; xEventGroupClearBits(events_, kHello | kCapture | kFailure);
    esp_websocket_client_config_t config{};
    config.uri = uri_.c_str(); config.headers = headers_.c_str(); config.cert_pem = ca_.c_str(); config.cert_common_name = server_name_.c_str();
    config.skip_cert_common_name_check = false; config.disable_auto_reconnect = true;
    config.network_timeout_ms = 10000; config.ping_interval_sec = 15; config.pingpong_timeout_sec = 30;
    config.buffer_size = 4096; config.task_stack = 8192; config.task_name = "teloa-wss";
    client_ = esp_websocket_client_init(&config);
    if (!client_ || esp_websocket_register_events(client_, WEBSOCKET_EVENT_ANY, Event, this) != ESP_OK || esp_websocket_client_start(client_) != ESP_OK) { Fail(); return false; }
    const auto bits = xEventGroupWaitBits(events_, kHello | kFailure, pdFALSE, pdFALSE, pdMS_TO_TICKS(10000));
    if (!(bits & kHello) || (bits & kFailure)) { CloseAudioChannel(false); SetError(strings::kConnect); return false; }
    if (on_audio_channel_opened_) on_audio_channel_opened_();
    return true;
}
void TeloaProtocol::ResetStreams() {
    std::lock_guard<std::mutex> lock(state_mutex_);
    capture_ready_ = false; uplink_stream_ = 0; receiver_.reset(); captures_.Abort(); pending_capture_id_.clear();
    approval_ticket_.clear();approval_digest_.clear();approval_pending_ticket_.clear();
    retired_playback_ = std::max(retired_playback_, playback_stream_); playback_stream_ = 0;
    playback_ready_ = false; playback_ended_ = false; has_progress_ = false; playback_identity_ = {0, 0, 0};
}
void TeloaProtocol::CloseAudioChannel(bool send_goodbye) {
    if (send_goodbye && IsAudioChannelOpened()) SendText(R"({"type":"abort"})");
    closing_ = true; connected_ = false; ResetStreams();
    if (client_) { esp_websocket_client_stop(client_); esp_websocket_client_destroy(client_); client_ = nullptr; }
    incoming_.clear(); incoming_kind_ = 0; frame_offset_ = 0;
    if (send_goodbye && !closed_announced_.exchange(true) && on_audio_channel_closed_) on_audio_channel_closed_();
}
bool TeloaProtocol::IsAudioChannelOpened() const { return connected_ && !failed_ && !closing_; }
bool TeloaProtocol::IsCaptureReady() const { std::lock_guard<std::mutex> lock(state_mutex_); return capture_ready_ && IsAudioChannelOpened(); }
uint32_t TeloaProtocol::ConnectionGeneration() const { std::lock_guard<std::mutex> lock(state_mutex_); return generation_; }
bool TeloaProtocol::SendText(const std::string& text) {
    if (!client_ || failed_ || closing_ || text.size() > 16384 || !esp_websocket_client_is_connected(client_)) return false;
    if (esp_websocket_client_send_text(client_, text.data(), text.size(), pdMS_TO_TICKS(3000)) != static_cast<int>(text.size())) { Fail(); return false; }
    return true;
}
void TeloaProtocol::SendStartListening(ListeningMode) {
    if (!IsAudioChannelOpened()) return;
    std::string id;
    { std::lock_guard<std::mutex> lock(state_mutex_); if (capture_ready_ || playback_stream_) return; id = CaptureId(); if (!captures_.Begin(id)) return; pending_capture_id_ = id; uplink_sequence_ = 0; }
    xEventGroupClearBits(events_, kCapture | kCaptureRejected);
    if (!SendText("{\"type\":\"listen.start\",\"captureId\":\"" + id + "\"}")) return;
    const auto bits = xEventGroupWaitBits(events_, kCapture | kFailure | kCaptureRejected, pdFALSE, pdFALSE, pdMS_TO_TICKS(10000));
    if (!(bits & (kCapture | kCaptureRejected)) || (bits & kFailure)) Fail();
}
void TeloaProtocol::SendStopListening() {
    std::string id;
    { std::lock_guard<std::mutex> lock(state_mutex_); if (!capture_ready_) return; capture_ready_ = false; id = capture_id_; }
    SendText("{\"type\":\"listen.stop\",\"captureId\":\"" + id + "\"}");
}
void TeloaProtocol::SendAbortSpeaking(AbortReason) { ResetStreams(); SendText(R"({"type":"abort"})"); Emit("teloa_idle"); }
void TeloaProtocol::RequestApprovals(){if(IsAudioChannelOpened())SendText(R"({"type":"approval.list","index":0})");}
void TeloaProtocol::DecideApproval(const teloa::ApprovalIdentity& displayed,bool approve){
    bool current=false;
    {std::lock_guard<std::mutex> lock(state_mutex_);current=teloa::SameApproval(displayed,{approval_ticket_,approval_digest_,generation_});if(current){approval_pending_ticket_=displayed.ticket;approval_ticket_.clear();approval_digest_.clear();}}
    if(!current||!IsAudioChannelOpened()){Emit("teloa_approval_done","stale","",displayed.ticket);return;}
    SendText("{\"type\":\"approval.decide\",\"ticket\":\""+displayed.ticket+"\",\"digest\":\""+displayed.digest+"\",\"decision\":\""+(approve?"approve":"reject")+"\"}");
}
bool TeloaProtocol::SendAudio(std::unique_ptr<AudioStreamPacket> packet) {
    std::optional<std::vector<uint8_t>> frame;
    { std::lock_guard<std::mutex> lock(state_mutex_); if (!capture_ready_ || !IsAudioChannelOpened() || !packet) return false;
      frame = teloa::device::EncodeAudioFrame({1, generation_, uplink_stream_}, uplink_sequence_++, packet->payload); }
    if (!frame || esp_websocket_client_send_bin(client_, reinterpret_cast<const char*>(frame->data()), frame->size(), pdMS_TO_TICKS(1000)) != static_cast<int>(frame->size())) { Fail(); return false; }
    return true;
}
void TeloaProtocol::Emit(const char* type, const char* state, const std::string& text,const std::string& ticket,const std::string& digest) {
    if (!on_incoming_json_) return;
    auto root = cJSON_CreateObject(); cJSON_AddStringToObject(root, "type", type);
    cJSON_AddNumberToObject(root, "connectionGeneration", ConnectionGeneration());
    if (state) cJSON_AddStringToObject(root, "state", state);
    if(!ticket.empty())cJSON_AddStringToObject(root,"ticket",ticket.c_str());
    if(!digest.empty())cJSON_AddStringToObject(root,"digest",digest.c_str());
    if (!text.empty()) cJSON_AddStringToObject(root, "text", text.c_str());
    on_incoming_json_(root); cJSON_Delete(root);
}
void TeloaProtocol::Fail() { failed_ = true; connected_ = false; ResetStreams(); xEventGroupSetBits(events_, kFailure); SetError(strings::kDisconnected); Emit("teloa_idle"); if (!closed_announced_.exchange(true) && on_audio_channel_closed_) on_audio_channel_closed_(); }
void TeloaProtocol::Event(void* context, esp_event_base_t, int32_t id, void* raw) {
    auto self = static_cast<TeloaProtocol*>(context);
    if (self->closing_) return;
    if (id == WEBSOCKET_EVENT_CONNECTED) self->SendText(kHelloJson);
    else if (id == WEBSOCKET_EVENT_DATA && !self->failed_) self->Receive(*static_cast<esp_websocket_event_data_t*>(raw));
    else if (id == WEBSOCKET_EVENT_ERROR || id == WEBSOCKET_EVENT_DISCONNECTED || id == WEBSOCKET_EVENT_CLOSED) {
        self->Fail();
    }
}
void TeloaProtocol::Receive(const esp_websocket_event_data_t& event) {
    if (event.op_code == 9 || event.op_code == 10 || event.op_code == 8) return;
    if (event.payload_offset == 0) {
        if (frame_offset_ != 0 || (event.op_code != 0 && event.op_code != 1 && event.op_code != 2)) { Fail(); return; }
        if (incoming_kind_ == 0) { if (event.op_code == 0) { Fail(); return; } incoming_kind_ = event.op_code; }
        else if (event.op_code != 0) { Fail(); return; }
        frame_size_ = event.payload_len;
    }
    const size_t limit = incoming_kind_ == 2 ? 4112 : 16384;
    if (event.payload_len <= 0 || event.payload_len != frame_size_ || event.payload_offset != frame_offset_ || event.data_len <= 0 ||
        event.data_len > frame_size_ - frame_offset_ || incoming_.size() + event.data_len > limit) { Fail(); return; }
    incoming_.insert(incoming_.end(), event.data_ptr, event.data_ptr + event.data_len); frame_offset_ += event.data_len;
    if (frame_offset_ != frame_size_) return;
    frame_offset_ = 0;
    if (!event.fin) return;
    const auto kind = incoming_kind_; incoming_kind_ = 0; auto complete = std::move(incoming_); incoming_.clear();
    if (kind == 2) Binary(complete);
    else { const auto message = teloa::device::ParseHostControl(complete.data(), complete.size()); if (!message) Fail(); else Control(*message); }
}
void TeloaProtocol::Control(const teloa::device::HostControl& control) {
    if (control.type == ControlType::Hello) {
        { std::lock_guard<std::mutex> lock(state_mutex_); if (generation_ && connected_) { failed_ = true; } else { generation_ = control.generation; retired_playback_ = 0; captures_ = {}; } }
        if (failed_) { Fail(); return; } connected_ = true; xEventGroupSetBits(events_, kHello); if (on_connected_) on_connected_(); return;
    }
    if (!IsAudioChannelOpened()) { Fail(); return; }
    bool accepted = true;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        // Result IDs belong to host-verified requests, not to the current microphone.
        if (control.type == ControlType::ListenReady) {
            if (capture_ready_ || playback_stream_ || control.capture_id != pending_capture_id_ || !captures_.Ready(control.capture_id)) accepted = false;
            else { capture_id_ = control.capture_id; pending_capture_id_.clear(); uplink_stream_ = control.stream_id; capture_ready_ = true; }
        } else if (control.type == ControlType::ListenSealed) {
            if (!captures_.Knows(control.capture_id)) accepted = false;
            else if (!captures_.Seal(control.capture_id)) return;
            else capture_ready_ = false;
        }
        else if (control.type == ControlType::PlaybackStart) {
            if (capture_ready_ || playback_stream_ || control.stream_id <= retired_playback_) accepted = false;
            else {
                const auto identity = teloa::device::NewPlaybackIdentity(generation_, control.stream_id);
                if (!identity) accepted = false;
                else { playback_identity_ = *identity; playback_stream_ = control.stream_id; playback_sequence_ = 0; playback_ready_ = false; playback_ended_ = false; has_progress_ = false; receiver_ = std::make_unique<teloa::device::AudioReceiver>(teloa::device::AudioBinding{2, generation_, playback_stream_}); }
            }
        } else if (control.type == ControlType::PlaybackText || control.type == ControlType::PlaybackEnd || control.type == ControlType::PlaybackInterrupted) {
            if (control.stream_id != playback_stream_) { if (control.stream_id <= retired_playback_) return; accepted = false; }
            else if (control.type == ControlType::PlaybackEnd) { if (!playback_sequence_ || control.sequence != playback_sequence_ - 1 || playback_ended_) accepted = false; else playback_ended_ = true; }
        } else if (control.type == ControlType::Error && control.state == "busy") {
            captures_.RejectPending(); pending_capture_id_.clear();
        }
    }
    if (!accepted) { Fail(); return; }
    switch (control.type) {
        case ControlType::ApprovalCard: { Emit("teloa_approval_count",nullptr,std::to_string(control.total)); {std::lock_guard<std::mutex> lock(state_mutex_);approval_ticket_=control.ticket;approval_digest_=control.digest;} Emit("teloa_approval",control.can_decide?"ready":"readonly",control.text,control.ticket,control.digest);break; }
        case ControlType::ApprovalAck: {bool current=false;{std::lock_guard<std::mutex> lock(state_mutex_);current=control.ticket==approval_pending_ticket_;if(current)approval_pending_ticket_.clear();}if(current)Emit("teloa_approval_done",control.state.c_str(),"",control.ticket);break;}
        case ControlType::ListenReady: xEventGroupSetBits(events_, kCapture); break;
        case ControlType::ListenSealed: Emit("teloa_idle"); if (control.state == "limit") Emit("teloa_status", nullptr, strings::kSegmented); break;
        case ControlType::Transcript: Emit("stt", nullptr, control.text); break;
        case ControlType::Receipt: Emit("teloa_status", control.state.c_str(), control.text); break;
        case ControlType::PlaybackStart: Emit("tts", "start"); break;
        case ControlType::PlaybackText: Emit("tts", "sentence_start", control.text); break;
        case ControlType::PlaybackEnd: Emit("teloa_drain"); break;
        case ControlType::PlaybackInterrupted: ResetStreams(); Emit("teloa_idle"); break;
        case ControlType::Error:
            xEventGroupSetBits(events_, kCaptureRejected);
            if (control.state != "busy") { ResetStreams(); Emit("teloa_idle"); }
            Emit("teloa_status", nullptr, control.state == "no-speech" ? strings::kNoSpeech : control.state == "busy" ? strings::kBusy : strings::kUnavailable); break;
        default: break;
    }
}
void TeloaProtocol::Binary(const std::vector<uint8_t>& data) {
    std::unique_ptr<AudioStreamPacket> packet;
    bool accepted = false;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (data.size() > 16 && data[0] == 1 && data[1] == 2 && data[2] == 0 && data[3] == 0 && Read32(data.data() + 4) == generation_) {
            const auto stream = Read32(data.data() + 8); if (stream && stream <= retired_playback_) return;
            if (stream == playback_stream_ && receiver_ && playback_ready_ && !playback_ended_ && playback_sequence_ < 2000) {
                auto payload = receiver_->Accept(data.data(), data.size());
                if (payload) { packet = std::make_unique<AudioStreamPacket>(); packet->sample_rate = 24000; packet->frame_duration = 60; packet->playback_id = playback_identity_.token; packet->media_position_ms = playback_sequence_++ * 60; packet->payload = std::move(*payload); accepted = true; }
            }
        }
    }
    if (!accepted) { Fail(); return; } if (on_incoming_audio_) on_incoming_audio_(std::move(packet));
}
void TeloaProtocol::ConfirmPlaybackReady() {
    uint32_t stream;
    { std::lock_guard<std::mutex> lock(state_mutex_); if (!playback_stream_ || playback_ready_) return; playback_ready_ = true; stream = playback_stream_; }
    SendText("{\"type\":\"playback.ready\",\"streamId\":" + std::to_string(stream) + "}");
}
void TeloaProtocol::RejectPlayback(uint32_t token) {
    { std::lock_guard<std::mutex> lock(state_mutex_); if (!teloa::device::IsCurrentPlayback(playback_identity_, token, generation_)) return; }
    Fail();
}
void TeloaProtocol::PlaybackProgress(uint32_t token, uint32_t position) {
    const auto sequence = position / 60;
    uint32_t stream;
    { std::lock_guard<std::mutex> lock(state_mutex_); if (!teloa::device::IsCurrentPlayback(playback_identity_, token, generation_) || !playback_ready_ || position % 60 || sequence >= playback_sequence_ || (has_progress_ && sequence <= progress_sequence_)) return; progress_sequence_ = sequence; has_progress_ = true; stream = playback_stream_; }
    SendText("{\"type\":\"playback.progress\",\"streamId\":" + std::to_string(stream) + ",\"sequence\":" + std::to_string(sequence) + "}");
}
void TeloaProtocol::PlaybackDrained() {
    uint32_t stream, sequence;
    { std::lock_guard<std::mutex> lock(state_mutex_); if (!playback_stream_ || !playback_ended_ || !has_progress_ || progress_sequence_ + 1 != playback_sequence_) return;
      stream = playback_stream_; sequence = progress_sequence_; retired_playback_ = std::max(retired_playback_, stream); playback_stream_ = 0; playback_identity_ = {0, 0, 0}; receiver_.reset(); }
    SendText("{\"type\":\"playback.played\",\"streamId\":" + std::to_string(stream) + ",\"lastSequence\":" + std::to_string(sequence) + "}"); Emit("tts", "stop");
}
