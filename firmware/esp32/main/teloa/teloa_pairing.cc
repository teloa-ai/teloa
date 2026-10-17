#include "teloa_pairing.h"
#include "settings.h"
#include <cJSON.h>
#include <driver/usb_serial_jtag.h>
#include <esp_timer.h>
#include <esp_random.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <psa/crypto.h>
#include <nvs.h>
#include <arpa/inet.h>
#include <lwip/sockets.h>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <cmath>

namespace teloa {
namespace {
std::string String(cJSON* value, const char* key) { auto v = cJSON_GetObjectItemCaseSensitive(value, key); return cJSON_IsString(v) ? v->valuestring : ""; }
bool Exact(cJSON* value, std::initializer_list<const char*> keys) {
    if (!cJSON_IsObject(value) || cJSON_GetArraySize(value) != static_cast<int>(keys.size())) return false;
    for (auto key : keys) { int count = 0; for (auto p = value->child; p; p = p->next) if (p->string && !strcmp(p->string, key)) ++count; if (count != 1) return false; }
    return true;
}
bool Uuid(const std::string& text) { if (text.size() != 36) return false; for (size_t i=0;i<text.size();++i) { if (i==8||i==13||i==18||i==23) { if(text[i]!='-')return false; } else if(!isxdigit(static_cast<unsigned char>(text[i])))return false; } return true; }
bool PrivateHost(const std::string& host) { in_addr address{}; if(inet_pton(AF_INET,host.c_str(),&address)!=1)return false; auto n=ntohl(address.s_addr); return (n>>24)==10 || (n>>20)==0xac1 || (n>>16)==0xc0a8; }
std::string Hash(const std::string& value) { unsigned char result[32];size_t size=0;if(psa_crypto_init()!=PSA_SUCCESS||psa_hash_compute(PSA_ALG_SHA_256,reinterpret_cast<const unsigned char*>(value.data()),value.size(),result,sizeof(result),&size)!=PSA_SUCCESS||size!=32)return "";static const char hex[]="0123456789abcdef";std::string out;for(auto b:result){out+=hex[b>>4];out+=hex[b&15];}return out; }
std::string Nonce() { unsigned char bytes[16];esp_fill_random(bytes,sizeof(bytes));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;char out[37];snprintf(out,sizeof(out),"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]);return out; }
std::string Json(cJSON* row) { char* data=cJSON_PrintUnformatted(row);std::string out=data?data:"{}";cJSON_free(data);cJSON_Delete(row);return out; }
}
bool ReadPairedConfiguration(std::string& configuration) { Settings settings("teloa");configuration=settings.GetString("config");return !configuration.empty()&&ValidatePairedConfiguration(configuration); }
bool ValidatePairedConfiguration(const std::string& configuration) {
    if(configuration.empty()||configuration.size()>12000||configuration.find('\0')!=std::string::npos)return false;
    if(configuration.find("\\u0000")!=std::string::npos)return false;
    auto row=cJSON_ParseWithLengthOpts(configuration.c_str(),configuration.size()+1,nullptr,true);if(!row)return false;
    auto number=[&](const char* key){auto p=cJSON_GetObjectItemCaseSensitive(row,key);return cJSON_IsNumber(p)?p->valuedouble:-1;};
    auto ca=String(row,"ca"),credential=String(row,"credential"),name=String(row,"server_name");
    bool good=Exact(row,{"schema","device_id","host","port","server_name","ca","credential","unix_time"})&&number("schema")==1&&Uuid(String(row,"device_id"))&&PrivateHost(String(row,"host"))&&number("port")>=1024&&number("port")<=65535&&number("port")!=3100&&number("port")!=3101&&number("port")==static_cast<int>(number("port"))&&ca.size()>=100&&ca.size()<=8192&&ca.find("-----BEGIN CERTIFICATE-----")==0&&name.size()>0&&name.size()<=253&&name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")==std::string::npos&&credential.size()==43&&credential.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")==std::string::npos&&(std::string("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_").find(credential.back())&3)==0&&std::floor(number("unix_time"))==number("unix_time")&&number("unix_time")>=1704067200&&number("unix_time")<=4102444800;
    cJSON_Delete(row);return good;
}
UsbPairing& UsbPairing::Instance(){static UsbPairing instance;return instance;}
void UsbPairing::Start(std::function<void(const std::string&)> show) {
    if(started_){return;}show_=std::move(show);
    usb_serial_jtag_driver_config_t config={.tx_buffer_size=2048,.rx_buffer_size=16384};
    if(!usb_serial_jtag_is_driver_installed()&&usb_serial_jtag_driver_install(&config)!=ESP_OK)return;
    started_=true;xTaskCreate([](void* self){static_cast<UsbPairing*>(self)->Run();},"teloa_usb",8192,this,4,nullptr);
}
bool UsbPairing::Pending(){std::lock_guard<std::mutex> lock(mutex_);return !intent_.empty()&&esp_timer_get_time()<deadline_;}
bool UsbPairing::HasConfiguration(){std::string config;return ReadPairedConfiguration(config);}
bool UsbPairing::ConfirmTouch(uint32_t held_ms){std::lock_guard<std::mutex> lock(mutex_);if(intent_.empty()||esp_timer_get_time()>=deadline_)return false;if(held_ms>=1200&&esp_timer_get_time()-opened_at_>=static_cast<int64_t>(held_ms)*1000)confirmed_=true;return true;}
std::string UsbPairing::Handle(const std::string& line){
    if(line.find('\0')!=std::string::npos||line.find("\\u0000")!=std::string::npos)return "{\"type\":\"pair.error\"}";
    auto row=cJSON_ParseWithLengthOpts(line.c_str(),line.size()+1,nullptr,true);if(!row)return "{\"type\":\"pair.error\"}";
    std::string type=String(row,"type"),result="{\"type\":\"pair.error\"}";
    std::unique_lock<std::mutex> lock(mutex_);
    if(type=="pair.begin"&&Exact(row,{"type","intentId","host","serverName"})&&Uuid(String(row,"intentId"))&&PrivateHost(String(row,"host"))&&String(row,"serverName").size()<=253){
        auto id=String(row,"intentId");
        if(intent_!=id||esp_timer_get_time()>=deadline_){intent_=id;nonce_=Nonce();expected_host_=String(row,"host");expected_name_=String(row,"serverName");confirmed_=false;opened_at_=esp_timer_get_time();deadline_=opened_at_+60000000;}
        result="{\"type\":\"pair.waiting\"}";auto show=show_;auto host=expected_host_;lock.unlock();if(show)show(host);lock.lock();
    }else if(type=="pair.status"&&Exact(row,{"type"})){
        auto out=cJSON_CreateObject();cJSON_AddStringToObject(out,"type","pair.status");cJSON_AddStringToObject(out,"intentId",intent_.c_str());cJSON_AddStringToObject(out,"nonce",nonce_.c_str());cJSON_AddBoolToObject(out,"confirmed",confirmed_&&esp_timer_get_time()<deadline_);
        std::string config;if(ReadPairedConfiguration(config)){auto saved=cJSON_Parse(config.c_str());cJSON_AddStringToObject(out,"deviceId",String(saved,"device_id").c_str());cJSON_AddStringToObject(out,"configDigest",Hash(config).c_str());cJSON_Delete(saved);}result=Json(out);
    }else if(type=="pair.configure"&&Exact(row,{"type","intentId","nonce","configuration","digest"})&&confirmed_&&esp_timer_get_time()<deadline_&&String(row,"intentId")==intent_&&String(row,"nonce")==nonce_){
        auto config=String(row,"configuration"),digest=String(row,"digest");auto parsed=cJSON_Parse(config.c_str());
        if(digest.size()==64&&ValidatePairedConfiguration(config)&&digest==Hash(config)&&String(parsed,"device_id")==intent_&&String(parsed,"host")==expected_host_&&String(parsed,"server_name")==expected_name_){
            nvs_handle_t nvs=0;esp_err_t error=nvs_open("teloa",NVS_READWRITE,&nvs);
            if(error==ESP_OK){error=nvs_set_str(nvs,"config",config.c_str());if(error==ESP_OK)error=nvs_commit(nvs);nvs_close(nvs);}
            if(error==ESP_OK){confirmed_=false;deadline_=0;result="{\"type\":\"pair.saved\",\"digest\":\""+digest+"\"}";}
        }cJSON_Delete(parsed);
    }
    lock.unlock();cJSON_Delete(row);return result;
}
void UsbPairing::Run(){
    std::string line;bool overflow=false;char bytes[256];
    while(true){int count=usb_serial_jtag_read_bytes(bytes,sizeof(bytes),pdMS_TO_TICKS(200));for(int i=0;i<count;++i){if(bytes[i]=='\n'){if(!overflow&&line.rfind("@TELOA ",0)==0){auto result="@TELOA "+Handle(line.substr(7))+"\n";usb_serial_jtag_write_bytes(result.data(),result.size(),pdMS_TO_TICKS(1000));}line.clear();overflow=false;}else if(!overflow){if(line.size()>=16384){overflow=true;line.clear();}else line+=bytes[i];}}}
}
}
