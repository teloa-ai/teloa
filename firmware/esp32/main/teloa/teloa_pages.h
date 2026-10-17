#pragma once
#include <string>
#include <vector>
namespace teloa {
// Conservative round-screen bounds. Preserve every input byte and explicit line break.
inline std::vector<std::string> ApprovalPages(const std::string& text) {
    std::vector<std::string> pages;
    std::string page;
    unsigned column = 0, line = 0;
    for (unsigned char byte : text) {
        if ((byte & 0xc0) != 0x80) {
            if (line >= 6 || (column >= 12 && line == 5 && byte != '\n')) {
                pages.push_back(page); page.clear(); column = 0; line = 0;
            }
            if (byte == '\n') { column = 0; ++line; }
            else { if (column >= 12) { ++line; column = 0; } ++column; }
        }
        page += byte;
    }
    if (!page.empty()) pages.push_back(page);
    return pages;
}
}
