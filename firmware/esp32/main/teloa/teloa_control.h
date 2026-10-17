#pragma once
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace teloa::device {
enum class ControlType { Hello, ApprovalCard, ApprovalAck, ListenReady, ListenSealed, Transcript, Receipt,
                         PlaybackStart, PlaybackText, PlaybackEnd, PlaybackInterrupted, Error };
struct HostControl {
    ControlType type;
    uint32_t generation = 0, stream_id = 0, sequence = 0;
    std::string capture_id, text, state;
    std::string ticket, digest;
    bool can_decide = false;
    uint32_t index = 0, total = 0;
};
// Finite host messages only: no URLs, RPC, device commands or model-supplied actions.
std::optional<HostControl> ParseHostControl(const uint8_t* data, size_t size);
}  // namespace teloa::device
