#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <string>

namespace teloa::device {

// Local IDs remembered for this connection only; this is not an authorization ledger.
// The protocol owns synchronization and creates a new ledger on a new connection.
class CaptureLedger {
public:
    bool Begin(const std::string& uuid);
    bool Ready(const std::string& uuid);
    bool Seal(const std::string& uuid);
    void RejectPending() { pending_.reset(); }
    void Abort() { pending_.reset(); active_.reset(); }
    bool Knows(const std::string& uuid) const;

private:
    std::optional<std::string> pending_, active_;
    std::deque<std::string> known_;
};

struct PlaybackIdentity {
    uint32_t token, generation, streamId;
};

// Tokens belong to the local process, survive connection changes, and never wrap.
std::optional<PlaybackIdentity> NewPlaybackIdentity(uint32_t generation, uint32_t streamId);

inline bool IsCurrentPlayback(const PlaybackIdentity& identity, uint32_t token, uint32_t generation) {
    return identity.token > 0 && identity.token < UINT32_MAX && identity.token == token &&
           identity.generation > 0 && identity.generation < UINT32_MAX && identity.generation == generation &&
           identity.streamId > 0 && identity.streamId < UINT32_MAX;
}

}  // namespace teloa::device
