#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace teloa::device {

constexpr size_t kAudioHeaderBytes = 16;
constexpr size_t kMaxOpusBytes = 4096;
constexpr size_t kBufferedPlaybackFrames = 33;

struct AudioBinding {
    uint8_t kind;
    uint32_t connection_generation;
    uint32_t stream_id;
};

std::optional<std::vector<uint8_t>> EncodeAudioFrame(
    AudioBinding binding, uint32_t sequence, const std::vector<uint8_t>& payload);

// Each receiver owns one ordered stream. Invalid input permanently closes it.
class AudioReceiver {
public:
    explicit AudioReceiver(AudioBinding binding);
    std::optional<std::vector<uint8_t>> Accept(const uint8_t* bytes, size_t size);
    void Close() { closed_ = true; }

private:
    AudioBinding binding_;
    uint32_t sequence_ = 0;
    bool closed_ = false;
};

}  // namespace teloa::device
