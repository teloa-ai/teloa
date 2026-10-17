#include "teloa_state.h"

#include <algorithm>
#include <atomic>
#include <string_view>
#include <utility>

namespace teloa::device {
namespace {
bool IsCaptureId(const std::string& uuid) {
    if (uuid.size() != 36 || uuid[14] != '4' || std::string_view("89abAB").find(uuid[19]) == std::string_view::npos) return false;
    for (size_t i = 0; i < uuid.size(); ++i) {
        const char value = uuid[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (value != '-') return false; }
        else if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F'))) return false;
    }
    return true;
}
}  // namespace

bool CaptureLedger::Begin(const std::string& uuid) {
    if (pending_ || active_ || !IsCaptureId(uuid) || Knows(uuid)) return false;
    pending_ = uuid;
    return true;
}

bool CaptureLedger::Ready(const std::string& uuid) {
    if (!pending_ || *pending_ != uuid || active_) return false;
    active_ = std::move(pending_);
    pending_.reset();
    known_.push_back(*active_);
    if (known_.size() > 32) known_.pop_front();
    return true;
}

bool CaptureLedger::Seal(const std::string& uuid) {
    if (!active_ || *active_ != uuid) return false;
    active_.reset();
    return true;
}

bool CaptureLedger::Knows(const std::string& uuid) const {
    return std::find(known_.begin(), known_.end(), uuid) != known_.end();
}

std::optional<PlaybackIdentity> NewPlaybackIdentity(uint32_t generation, uint32_t streamId) {
    if (generation == 0 || generation == UINT32_MAX || streamId == 0 || streamId == UINT32_MAX) return std::nullopt;
    static std::atomic<uint32_t> next_token{1};
    auto token = next_token.load(std::memory_order_relaxed);
    while (token < UINT32_MAX) {
        if (next_token.compare_exchange_weak(token, token + 1, std::memory_order_relaxed)) return PlaybackIdentity{token, generation, streamId};
    }
    return std::nullopt;
}

}  // namespace teloa::device
