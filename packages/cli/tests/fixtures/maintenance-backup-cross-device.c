/* 仅注入目标目录设备号不同；验证产品在clone syscall之前拒绝跨设备。 */
#include <sys/stat.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
static int backup_test_fstat(int fd,struct stat *info){
 int result=fstat(fd,info);char path[PATH_MAX];
 if(result==0&&S_ISDIR(info->st_mode)&&fcntl(fd,F_GETPATH,path)==0&&strstr(path,"/cross-device-target"))info->st_dev^=1;
 return result;
}
#define fstat backup_test_fstat
#define main maintenance_product_main
#include "../../native/maintenance-process.c"
#undef main
int main(int argc,char **argv){return maintenance_product_main(argc,argv);}
