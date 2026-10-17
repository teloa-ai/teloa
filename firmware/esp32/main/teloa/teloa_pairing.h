#pragma once
#include <string>
#include <functional>
#include <mutex>

namespace teloa {
// Pairing only handles application USB messages; it never enters ROM or writes firmware.
class UsbPairing {
public:
    static UsbPairing& Instance();
    void Start(std::function<void(const std::string&)> show);
    bool ConfirmTouch(uint32_t held_ms);
    bool Pending();
    bool HasConfiguration();
private:
    void Run();
    std::string Handle(const std::string& line);
    std::mutex mutex_;
    std::string intent_, nonce_, expected_host_, expected_name_;
    int64_t deadline_ = 0,opened_at_ = 0;
    bool confirmed_ = false, started_ = false;
    std::function<void(const std::string&)> show_;
};
bool ReadPairedConfiguration(std::string& configuration);
bool ValidatePairedConfiguration(const std::string& configuration);
}
