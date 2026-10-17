#pragma once
#include <string>
#include <cstdint>
namespace teloa { bool SynchronizeHostTime(const std::string& host, int port, const std::string& device_id, const std::string& credential, int64_t minimum_time); }
