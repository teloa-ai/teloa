#include "teloa_time.h"
#include <cJSON.h>
#include <esp_random.h>
#include <psa/crypto.h>
#include <lwip/sockets.h>
#include <sys/time.h>
#include <cstdio>
#include <cstring>
#include <cmath>

namespace teloa {
static std::string Mac(const std::string& key,const std::string& text){unsigned char bytes[32];size_t length=0;psa_key_attributes_t attributes=PSA_KEY_ATTRIBUTES_INIT;psa_set_key_type(&attributes,PSA_KEY_TYPE_HMAC);psa_set_key_algorithm(&attributes,PSA_ALG_HMAC(PSA_ALG_SHA_256));psa_set_key_usage_flags(&attributes,PSA_KEY_USAGE_SIGN_MESSAGE);psa_key_id_t id=0;if(psa_crypto_init()!=PSA_SUCCESS||psa_import_key(&attributes,reinterpret_cast<const unsigned char*>(key.data()),key.size(),&id)!=PSA_SUCCESS)return "";auto status=psa_mac_compute(id,PSA_ALG_HMAC(PSA_ALG_SHA_256),reinterpret_cast<const unsigned char*>(text.data()),text.size(),bytes,sizeof(bytes),&length);psa_destroy_key(id);if(status!=PSA_SUCCESS||length!=32)return "";static const char hex[]="0123456789abcdef";std::string result;for(auto b:bytes){result+=hex[b>>4];result+=hex[b&15];}return result;}
bool SynchronizeHostTime(const std::string& host,int port,const std::string& device_id,const std::string& credential,int64_t minimum_time){
    unsigned char random[16];esp_fill_random(random,sizeof(random));random[6]=(random[6]&15)|64;random[8]=(random[8]&63)|128;char nonce[37];snprintf(nonce,sizeof(nonce),"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",random[0],random[1],random[2],random[3],random[4],random[5],random[6],random[7],random[8],random[9],random[10],random[11],random[12],random[13],random[14],random[15]);
    const std::string challenge=nonce,proof=Mac(credential,"teloa-time-request/v1\n"+device_id+"\n"+challenge);
    if(proof.size()!=64)return false;
    const std::string request="{\"deviceId\":\""+device_id+"\",\"nonce\":\""+challenge+"\",\"proof\":\""+proof+"\"}";
    int fd=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);if(fd<0)return false;timeval timeout{1,0};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));sockaddr_in address{};address.sin_family=AF_INET;address.sin_port=htons(port);inet_pton(AF_INET,host.c_str(),&address.sin_addr);bool valid=false;
    for(int attempt=0;attempt<3&&!valid;attempt++){
        if(sendto(fd,request.data(),request.size(),0,reinterpret_cast<sockaddr*>(&address),sizeof(address))<0)continue;
        char response[1024];sockaddr_in peer{};socklen_t length=sizeof(peer);int count=recvfrom(fd,response,sizeof(response)-1,0,reinterpret_cast<sockaddr*>(&peer),&length);if(count<=0||peer.sin_addr.s_addr!=address.sin_addr.s_addr||peer.sin_port!=address.sin_port)continue;response[count]=0;
        auto row=cJSON_ParseWithLengthOpts(response,count+1,nullptr,true);auto n=cJSON_GetObjectItemCaseSensitive(row,"nonce"),time=cJSON_GetObjectItemCaseSensitive(row,"unix_time"),mac=cJSON_GetObjectItemCaseSensitive(row,"proof");
        if(cJSON_IsObject(row)&&cJSON_GetArraySize(row)==3&&cJSON_IsString(n)&&challenge==n->valuestring&&cJSON_IsNumber(time)&&time->valuedouble>=minimum_time&&time->valuedouble>=1704067200&&time->valuedouble<4102444800&&floor(time->valuedouble)==time->valuedouble&&cJSON_IsString(mac)){
            auto expected=Mac(credential,"teloa-time/v1\n"+challenge+"\n"+std::to_string(static_cast<int64_t>(time->valuedouble)));unsigned diff=expected.size()==strlen(mac->valuestring)?0:1;for(size_t i=0;i<expected.size()&&i<strlen(mac->valuestring);i++)diff|=expected[i]^mac->valuestring[i];
            if(expected.size()==64&&diff==0){timeval current{static_cast<time_t>(time->valuedouble),0};valid=settimeofday(&current,nullptr)==0;}
        }cJSON_Delete(row);
    }close(fd);return valid;
}
}
