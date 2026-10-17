#include "teloa_frame.h"
#include "fixed_queue.h"
#include <cassert>
#include <vector>

int main() {
    using namespace teloa::device;
    const AudioBinding binding{1, 7, 9};
    const std::vector<uint8_t> payload{0xf8, 0xff, 0xfe};
    auto packet = EncodeAudioFrame(binding, 0, payload);
    assert(packet);
    const std::vector<uint8_t> expected{1, 1, 0, 0, 0, 0, 0, 7, 0, 0, 0, 9, 0, 0, 0, 0, 0xf8, 0xff, 0xfe};
    assert(*packet == expected);
    AudioReceiver stream(binding);
    assert(stream.Accept(packet->data(), packet->size()) == payload);
    assert(!stream.Accept(packet->data(), packet->size()));
    auto next = EncodeAudioFrame(binding, 1, payload);
    assert(!stream.Accept(next->data(), next->size()));
    for (size_t offset : {0, 1, 2, 7, 11, 15}) {
        auto bad = expected;
        bad[offset]++;
        AudioReceiver receiver(binding);
        assert(!receiver.Accept(bad.data(), bad.size()));
    }
    AudioReceiver short_frame(binding);
    assert(!short_frame.Accept(expected.data(), 16));
    AudioReceiver oversized(binding);
    std::vector<uint8_t> huge(16 + 4097);
    assert(!oversized.Accept(huge.data(), huge.size()));
    assert(!EncodeAudioFrame({1, 0, 9}, 0, payload));
    assert(!EncodeAudioFrame(binding, 0xffffffff, payload));
    assert(!EncodeAudioFrame(binding, 0, {}));
    AudioReceiver stopped(binding);
    stopped.Close();
    assert(!stopped.Accept(expected.data(), expected.size()));
    // The real fixed queue must retain the full host burst before DAC progress.
    FixedQueue<std::vector<uint8_t>, kBufferedPlaybackFrames> playback;
    for (uint32_t sequence = 0; sequence < 33; ++sequence)
        assert(playback.push_back(*EncodeAudioFrame({2, 7, 9}, sequence, payload)));
    assert(playback.full() && playback.size() == 33);
    assert(!playback.push_back(expected));
    AudioReceiver downlink({2, 7, 9});
    while (!playback.empty()) {
        assert(downlink.Accept(playback.front().data(), playback.front().size()) == payload);
        playback.pop_front();
    }
    for (uint32_t sequence = 0; sequence < 33; ++sequence)
        assert(playback.push_back(*EncodeAudioFrame({2, 7, 9}, sequence, payload)));
    playback.clear(); // Cancellation discards every buffered old-connection frame.
    assert(playback.empty());
    assert(playback.push_back(*EncodeAudioFrame({2, 8, 9}, 0, payload)));
    AudioReceiver replacement({2, 8, 9});
    assert(replacement.Accept(playback.front().data(), playback.front().size()) == payload);
    return 0;
}
