#pragma once

namespace teloa::device::strings {
#if CONFIG_LANGUAGE_ZH_CN
inline constexpr auto kReviewWeb = "请在 Teloa 网页查看并处理。";
inline constexpr auto kDecisionSubmitted = "已提交本次决定。";
inline constexpr auto kDecisionStale = "申请已失效，请重新查看。";
inline constexpr auto kPair = "请先通过 USB 与 Teloa 配对。";
inline constexpr auto kTime = "设备时间未同步，请通过 USB 重新连接 Teloa。";
inline constexpr auto kConnect = "无法连接 Teloa，请核对电脑、网络或 USB 配对。";
inline constexpr auto kDisconnected = "Teloa 连接已中断，请重新连接；证书变化需通过 USB 配对。";
inline constexpr auto kSegmented = "本句已分段，可继续下一句。";
inline constexpr auto kNoSpeech = "没有听清，请再说一次。";
inline constexpr auto kBusy = "正在处理原请求，请稍候。";
inline constexpr auto kUnavailable = "当前连接暂时无法处理，请在 Teloa 查看原请求。";
#elif CONFIG_LANGUAGE_ZH_TW
inline constexpr auto kReviewWeb = "請在 Teloa 網頁查看並處理。";
inline constexpr auto kDecisionSubmitted = "已提交本次決定。";
inline constexpr auto kDecisionStale = "申請已失效，請重新查看。";
inline constexpr auto kPair = "請先透過 USB 與 Teloa 配對。";
inline constexpr auto kTime = "裝置時間尚未同步，請透過 USB 重新連接 Teloa。";
inline constexpr auto kConnect = "無法連接 Teloa，請檢查電腦、網路或 USB 配對。";
inline constexpr auto kDisconnected = "Teloa 連線已中斷，請重新連接；憑證變更後需透過 USB 配對。";
inline constexpr auto kSegmented = "本句已分段，可以繼續下一句。";
inline constexpr auto kNoSpeech = "沒有聽清楚，請再說一次。";
inline constexpr auto kBusy = "正在處理原請求，請稍候。";
inline constexpr auto kUnavailable = "目前無法處理，請在 Teloa 查看原請求。";
#else
inline constexpr auto kReviewWeb = "Review this request in the Teloa web workspace.";
inline constexpr auto kDecisionSubmitted = "Decision submitted.";
inline constexpr auto kDecisionStale = "Request expired. Open review again.";
inline constexpr auto kPair = "Pair with Teloa over USB first.";
inline constexpr auto kTime = "Device time is unavailable. Connect to Teloa over USB.";
inline constexpr auto kConnect = "Cannot reach Teloa. Check the computer, network or USB pairing.";
inline constexpr auto kDisconnected = "Teloa disconnected. Reconnect; certificate changes require USB pairing.";
inline constexpr auto kSegmented = "This sentence reached its limit. You can continue.";
inline constexpr auto kNoSpeech = "I could not hear that. Please try again.";
inline constexpr auto kBusy = "The original request is still being processed.";
inline constexpr auto kUnavailable = "Unavailable right now. Check the original request in Teloa.";
#endif
}  // namespace teloa::device::strings
