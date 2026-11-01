/* 测试专用：在真实 proc_pidinfo 完成第二次 child 世代读取后，协调自有夹具 fork。
 * 不进入生产二进制；只延长原代码已存在的读取/注册窗口，不伪造内核查询或退出事件。 */
#include <libproc.h>
#include <stdint.h>
#include <sys/event.h>
static int window_proc_pidinfo(int pid,int flavor,uint64_t argument,void *buffer,int size);
static int window_kevent(int queue,const struct kevent *changes,int change_count,struct kevent *events,int event_count,const struct timespec *timeout);
#define proc_pidinfo window_proc_pidinfo
#define kevent(...) window_kevent(__VA_ARGS__)
#define main maintenance_product_main
#include "../../native/maintenance-process.c"
#undef main
#undef proc_pidinfo
#undef kevent
static bool cause_fork(void){
 const char *path=getenv("TELOA_FIXTURE_CLEANUP");if(!path)return false;
 char trigger[4096],done[4096];snprintf(trigger,sizeof(trigger),"%s.trigger",path);snprintf(done,sizeof(done),"%s.done",path);
 FILE *file=fopen(trigger,"w");if(!file)return false;fputs("fork",file);fclose(file);
 for(int i=0;i<3000&&access(done,F_OK)!=0;i++)usleep(1000);
 return access(done,F_OK)==0;
}
static int window_kevent(int queue,const struct kevent *changes,int change_count,struct kevent *events,int event_count,const struct timespec *timeout){
 const char *window=getenv("TELOA_FIXTURE_WINDOW");
 if(window&&strcmp(window,"registration-gap")==0&&change_count>=2&&change_count<=3&&event_count==change_count){
  // 真实内核注册分步执行，验证先注册的 leaf 在其祖先注册前 fork 的边界。
  int first=kevent(queue,changes,1,events,1,timeout);if(first!=1)return -1;
  if(!cause_fork())return -1;
  int rest=kevent(queue,changes+1,change_count-1,events+1,event_count-1,timeout);return rest==change_count-1?change_count:-1;
 }
 return kevent(queue,changes,change_count,events,event_count,timeout);
}
static int window_proc_pidinfo(int pid,int flavor,uint64_t argument,void *buffer,int size){
 int result=proc_pidinfo(pid,flavor,argument,buffer,size);
 static int reads=0;const char *target=getenv("TELOA_FIXTURE_CHILD");
 if(!getenv("TELOA_FIXTURE_WINDOW")&&target&&pid==atoi(target)&&flavor==17&&result>0&&++reads==2){
  if(!cause_fork())return -1;
 }
 return result;
}
int main(int argc,char **argv){return maintenance_product_main(argc,argv);}
