#pragma once
#include <cstdint>
#include <string>
namespace teloa {
struct ApprovalIdentity { std::string ticket, digest; uint32_t generation = 0; };
inline bool SameApproval(const ApprovalIdentity& one, const ApprovalIdentity& two) {
    return !one.ticket.empty() && one.generation && one.ticket == two.ticket &&
           one.digest == two.digest && one.generation == two.generation;
}
inline bool FreshApprovalHold(uint64_t shown_at, uint64_t now, uint32_t held_ms, bool stayed_inside) {
    return stayed_inside && held_ms >= 1200 && now >= shown_at && now - shown_at >= static_cast<uint64_t>(held_ms) * 1000;
}
inline bool ApprovalButton(int x, int y) { return x >= 166 && x < 272 && y >= 300 && y < 332; }
}
