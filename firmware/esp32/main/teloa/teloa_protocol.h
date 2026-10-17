#pragma once
#include "teloa_approval_view.h"
#include "protocol.h"
#include "teloa_frame.h"
#include "teloa_control.h"
#include "teloa_state.h"
#include <esp_websocket_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <atomic>
#include <mutex>

class TeloaProtocol final : public Protocol {
public:
    TeloaProtocol();
    ~TeloaProtocol() override;
    bool Start() override;
    bool OpenAudioChannel() override;
    void CloseAudioChannel(bool send_goodbye = true) override;
    bool IsAudioChannelOpened() const override;
    bool SendAudio(std::unique_ptr<AudioStreamPacket> packet) override;
    void SendStartListening(ListeningMode mode) override;
    void SendStopListening() override;
    void SendAbortSpeaking(AbortReason reason) override;
    void SendWakeWordDetected(const std::string&) override {}
    void SendMcpMessage(const std::string&) override {}
    bool IsCaptureReady() const;
    uint32_t ConnectionGeneration() const;
    void RejectPlayback(uint32_t token);
    // Called only after the application has reset its decoder and entered speaking.
    void ConfirmPlaybackReady();
    void PlaybackProgress(uint32_t stream_id, uint32_t position_ms);
    void PlaybackDrained();
    void RequestApprovals();
    void DecideApproval(const teloa::ApprovalIdentity& displayed,bool approve);

protected:
    bool SendText(const std::string& text) override;

private:
    static void Event(void* context, esp_event_base_t base, int32_t id, void* data);
    void Receive(const esp_websocket_event_data_t& data);
    void Control(const teloa::device::HostControl& control);
    void Binary(const std::vector<uint8_t>& data);
    void Fail();
    void Emit(const char* type, const char* state = nullptr, const std::string& text = "",const std::string& ticket="",const std::string& digest="");
    void ResetStreams();
    bool ReadConfiguration();
    EventGroupHandle_t events_;
    esp_websocket_client_handle_t client_ = nullptr;
    std::string uri_, ca_, server_name_, credential_, headers_;
    std::string host_, device_id_;
    int port_ = 0;
    int64_t time_floor_ = 1704067200;
    std::string approval_ticket_, approval_digest_;
    std::string approval_pending_ticket_;
    std::atomic<bool> connected_{false}, failed_{false}, closing_{false}, closed_announced_{true};
    mutable std::mutex state_mutex_;
    uint32_t generation_ = 0, uplink_stream_ = 0, uplink_sequence_ = 0;
    uint32_t playback_stream_ = 0, playback_sequence_ = 0, retired_playback_ = 0;
    uint32_t progress_sequence_ = 0;
    bool capture_ready_ = false, playback_ready_ = false, playback_ended_ = false, has_progress_ = false;
    std::string capture_id_, pending_capture_id_;
    teloa::device::CaptureLedger captures_;
    teloa::device::PlaybackIdentity playback_identity_{0, 0, 0};
    std::unique_ptr<teloa::device::AudioReceiver> receiver_;
    std::vector<uint8_t> incoming_;
    uint8_t incoming_kind_ = 0;
    int frame_offset_ = 0, frame_size_ = 0;
};
