#include "teloa_state.h"

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <set>
#include <string>
#include <thread>
#include <vector>

using namespace teloa::device;

static std::string Id(uint32_t value) {
    char result[37];
    std::snprintf(result, sizeof(result), "%08x-1234-4abc-8def-0123456789ab", value);
    return result;
}

static void PreserveSealedRequest() {
    CaptureLedger ledger;
    const auto a = Id(1), b = Id(2);
    assert(ledger.Begin(a));
    assert(!ledger.Begin(b));
    assert(!ledger.Ready(b));
    assert(!ledger.Knows(a));
    assert(ledger.Ready(a));
    assert(!ledger.Ready(a));
    assert(!ledger.Begin(b));
    assert(!ledger.Seal(b));
    assert(ledger.Seal(a));
    assert(ledger.Begin(b));
    ledger.RejectPending();
    assert(ledger.Knows(a));
    assert(!ledger.Knows(b));
    assert(!ledger.Ready(b));
    assert(ledger.Begin(b));
    assert(ledger.Ready(b));
    ledger.RejectPending();
    assert(ledger.Seal(b));
    assert(ledger.Knows(a) && ledger.Knows(b));
    assert(!ledger.Begin(a));
}

static void AbortPartialCapture() {
    CaptureLedger ledger;
    const auto a = Id(1), b = Id(2);
    assert(ledger.Begin(a));
    assert(ledger.Ready(a));
    ledger.Abort();
    assert(ledger.Knows(a));
    assert(!ledger.Seal(a));
    assert(ledger.Begin(b));
    ledger.Abort();
    assert(!ledger.Ready(b));
    assert(!ledger.Knows(b));
    assert(ledger.Knows(a));
    assert(ledger.Begin(b) && ledger.Ready(b) && ledger.Seal(b));
    CaptureLedger new_connection;
    assert(!new_connection.Knows(a) && !new_connection.Knows(b));
}

static void BoundKnownRequests() {
    CaptureLedger ledger;
    for (uint32_t i = 0; i < 32; ++i) assert(ledger.Begin(Id(i)) && ledger.Ready(Id(i)) && ledger.Seal(Id(i)));
    for (uint32_t i = 0; i < 32; ++i) assert(ledger.Knows(Id(i)));
    assert(ledger.Begin(Id(32)));
    ledger.RejectPending();
    assert(ledger.Knows(Id(0)) && ledger.Knows(Id(31)));
    assert(ledger.Begin(Id(32)) && ledger.Ready(Id(32)));
    assert(!ledger.Knows(Id(0)));
    for (uint32_t i = 1; i <= 32; ++i) assert(ledger.Knows(Id(i)));
    assert(ledger.Seal(Id(32)));
    ledger.Abort();
    for (uint32_t i = 1; i <= 32; ++i) assert(ledger.Knows(Id(i)));
}

static void ValidateCaptureIds() {
    CaptureLedger ledger;
    for (const auto& id : {"", "bad", "00000000-1234-1abc-8def-0123456789ab",
                           "00000000-1234-4abc-7def-0123456789ab", "00000000-1234-4abc-8def-0123456789ag"}) {
        assert(!ledger.Begin(id));
        assert(!ledger.Ready(id));
        assert(!ledger.Seal(id));
        assert(!ledger.Knows(id));
    }
    assert(ledger.Begin("ABCDEF00-1234-4ABC-ADEF-0123456789AB"));
    assert(ledger.Ready("ABCDEF00-1234-4ABC-ADEF-0123456789AB"));
}

static void IsolatePlaybackGenerations() {
    const auto old = NewPlaybackIdentity(7, 1), current = NewPlaybackIdentity(8, 1);
    assert(old && current);
    assert(old->token != current->token);
    assert(old->generation == 7 && old->streamId == 1);
    assert(current->generation == 8 && current->streamId == 1);
    assert(IsCurrentPlayback(*current, current->token, 8));
    assert(!IsCurrentPlayback(*current, old->token, 8));
    assert(!IsCurrentPlayback(*current, current->token, 7));
    const auto same_host_stream = NewPlaybackIdentity(8, 1);
    assert(same_host_stream && same_host_stream->token != current->token);
    for (const auto invalid : {uint32_t{0}, UINT32_MAX}) {
        assert(!NewPlaybackIdentity(invalid, 1));
        assert(!NewPlaybackIdentity(1, invalid));
        assert(!IsCurrentPlayback({invalid, 8, 1}, invalid, 8));
        assert(!IsCurrentPlayback({1, invalid, 1}, 1, invalid));
        assert(!IsCurrentPlayback({1, 8, invalid}, 1, 8));
    }
}

static void AllocateProcessWideTokens() {
    std::vector<std::vector<uint32_t>> tokens(4);
    std::vector<std::thread> workers;
    for (size_t i = 0; i < tokens.size(); ++i) workers.emplace_back([&, i] {
        for (int n = 0; n < 128; ++n) {
            const auto identity = NewPlaybackIdentity(1, 1);
            assert(identity && identity->token != 0 && identity->token != UINT32_MAX);
            tokens[i].push_back(identity->token);
        }
    });
    for (auto& worker : workers) worker.join();
    std::set<uint32_t> unique;
    for (const auto& values : tokens) unique.insert(values.begin(), values.end());
    assert(unique.size() == 512);
}

int main() {
    PreserveSealedRequest();
    AbortPartialCapture();
    BoundKnownRequests();
    ValidateCaptureIds();
    IsolatePlaybackGenerations();
    AllocateProcessWideTokens();
    std::puts("teloa_state: 6 cases passed");
}
