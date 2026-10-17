#include "teloa_frame.h"

#include <limits>

namespace teloa::device {
namespace {

bool ValidNumber(uint32_t value, bool nonzero = false) {
    return value < std::numeric_limits<uint32_t>::max() && (!nonzero || value > 0);
}

bool ValidBinding(AudioBinding binding) {
    return (binding.kind == 1 || binding.kind == 2) &&
           ValidNumber(binding.connection_generation, true) && ValidNumber(binding.stream_id, true);
}

uint32_t ReadU32(const uint8_t* bytes) {
    return (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |
           (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
}

void WriteU32(uint8_t* bytes, uint32_t value) {
    bytes[0] = static_cast<uint8_t>(value >> 24);
    bytes[1] = static_cast<uint8_t>(value >> 16);
    bytes[2] = static_cast<uint8_t>(value >> 8);
    bytes[3] = static_cast<uint8_t>(value);
}

}  // namespace

std::optional<std::vector<uint8_t>> EncodeAudioFrame(
    AudioBinding binding, uint32_t sequence, const std::vector<uint8_t>& payload) {
    if (!ValidBinding(binding) || !ValidNumber(sequence) || payload.empty() || payload.size() > kMaxOpusBytes) {
        return std::nullopt;
    }
    std::vector<uint8_t> bytes(kAudioHeaderBytes + payload.size(), 0);
    bytes[0] = 1;
    bytes[1] = binding.kind;
    WriteU32(bytes.data() + 4, binding.connection_generation);
    WriteU32(bytes.data() + 8, binding.stream_id);
    WriteU32(bytes.data() + 12, sequence);
    for (size_t i = 0; i < payload.size(); ++i) {
        bytes[kAudioHeaderBytes + i] = payload[i];
    }
    return bytes;
}

AudioReceiver::AudioReceiver(AudioBinding binding) : binding_(binding), closed_(!ValidBinding(binding)) {}

std::optional<std::vector<uint8_t>> AudioReceiver::Accept(const uint8_t* bytes, size_t size) {
    if (closed_ || !bytes || size <= kAudioHeaderBytes || size > kAudioHeaderBytes + kMaxOpusBytes ||
        bytes[0] != 1 || bytes[1] != binding_.kind || bytes[2] != 0 || bytes[3] != 0 ||
        ReadU32(bytes + 4) != binding_.connection_generation || ReadU32(bytes + 8) != binding_.stream_id ||
        !ValidNumber(sequence_) || ReadU32(bytes + 12) != sequence_) {
        closed_ = true;
        return std::nullopt;
    }
    ++sequence_;
    return std::vector<uint8_t>(bytes + kAudioHeaderBytes, bytes + size);
}

}  // namespace teloa::device
