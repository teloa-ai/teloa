/* 独立测试夹具：只管理本程序亲自 fork、尚未回收的进程。专用本地标记清理孤儿 child。 */
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
static volatile sig_atomic_t stopped=0,close_port=0;
static void stop_handler(int signal){(void)signal;stopped=1;}
static void port_handler(int signal){(void)signal;close_port=1;}
static void stop_child(pid_t pid){kill(pid,SIGTERM);while(waitpid(pid,NULL,0)<0&&errno==EINTR){}}
static bool fork_on_trigger(const char *cleanup,int socket_fd,bool *forked){
 if(*forked)return true;
 char trigger[4096],done[4096],escaped[4096];snprintf(trigger,sizeof(trigger),"%s.trigger",cleanup);snprintf(done,sizeof(done),"%s.done",cleanup);snprintf(escaped,sizeof(escaped),"%s.escaped",cleanup);
 if(access(trigger,F_OK)!=0)return true;
 *forked=true;pid_t intermediate=fork();if(intermediate<0)return false;
 if(intermediate==0){
  pid_t detached=fork();if(detached>0)_exit(0);if(detached<0)_exit(10);
  if(socket_fd>=0)close(socket_fd);close(STDOUT_FILENO);close(STDERR_FILENO);
  FILE *record=fopen(escaped,"w");if(!record)_exit(11);fprintf(record,"%d",getpid());fclose(record);
  while(access(cleanup,F_OK)!=0)usleep(10000);_exit(0);
 }
 while(waitpid(intermediate,NULL,0)<0&&errno==EINTR){}
 FILE *record=fopen(done,"w");if(!record)return false;fputs("done",record);fclose(record);return true;
}
int main(int argc,char **argv){
 if(argc<2)return 2;
 signal(SIGTERM,stop_handler);signal(SIGUSR1,port_handler);alarm(60);
 if(strcmp(argv[1],"after-exec")==0){if(argc!=3)return 3;stop_child((pid_t)atoi(argv[2]));return 0;}
 if(strcmp(argv[1],"leaf-after-exec")==0)return 0;
 pid_t child=fork();if(child<0)return 4;
 if(child==0){
  if(argc!=3)return 9;alarm(60);
  pid_t descendant=-1;
  if(strcmp(argv[1],"descendant")==0){descendant=fork();if(descendant==0){while(!stopped)pause();return 0;}}
  pid_t reference=-1;
  if(strncmp(argv[1],"reference",9)==0){
   int channel[2];if(pipe(channel))return 13;
   reference=fork();if(reference<0)return 14;
   if(reference==0){
    close(channel[0]);pid_t extra=-1;
    if(strcmp(argv[1],"reference-descendant")==0){extra=fork();if(extra==0){while(!stopped)pause();return 0;}}
    char ready=1;if(write(channel[1],&ready,1)!=1)return 15;close(channel[1]);bool forked=false;
    while(!stopped&&access(argv[2],F_OK)!=0){
     if(strcmp(argv[1],"reference-pre-registration-fork")==0&&!fork_on_trigger(argv[2],-1,&forked))return 16;
     usleep(10000);
    }
    if(extra>0)stop_child(extra);
    if(strcmp(argv[1],"reference-fork")==0){extra=fork();if(extra==0)return 0;while(waitpid(extra,NULL,0)<0&&errno==EINTR){}}
    if(strcmp(argv[1],"reference-exec")==0){execl(argv[0],argv[0],"leaf-after-exec",NULL);return 17;}
    return 0;
   }
   close(channel[1]);char ready;if(read(channel[0],&ready,1)!=1)return 18;close(channel[0]);
  }
  int socket_fd=socket(AF_INET,SOCK_STREAM,0);if(socket_fd<0)return 5;
  struct sockaddr_in addr={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
  if(bind(socket_fd,(struct sockaddr*)&addr,sizeof(addr))||listen(socket_fd,1))return 6;
  socklen_t length=sizeof(addr);if(getsockname(socket_fd,(struct sockaddr*)&addr,&length))return 7;
  printf("{\"child\":%d,\"port\":%u",getpid(),ntohs(addr.sin_port));if(reference>0)printf(",\"referenceMcp\":%d",reference);puts("}");fflush(stdout);
  bool forked=false;
  while(!stopped){
   if(strcmp(argv[1],"pre-registration-fork")==0&&!fork_on_trigger(argv[2],socket_fd,&forked))return 12;
   if(close_port&&socket_fd>=0){close(socket_fd);socket_fd=-1;}
   if(access(argv[2],F_OK)==0)break;
   struct timeval delay={.tv_sec=0,.tv_usec=10000};select(0,NULL,NULL,NULL,&delay);
  }
  if(descendant>0)stop_child(descendant);
  if(reference>0&&strcmp(argv[1],"reference-orphan")!=0)stop_child(reference);
  return 0;
 }
 while(!stopped)pause();
 if(strcmp(argv[1],"orphan")==0)return 0;
 if(strcmp(argv[1],"portless-orphan")==0){kill(child,SIGUSR1);return 0;}
 if(strcmp(argv[1],"fork")==0){pid_t extra=fork();if(extra==0)return 0;while(waitpid(extra,NULL,0)<0&&errno==EINTR){}}
 if(strcmp(argv[1],"exec")==0){char pid[32];snprintf(pid,sizeof(pid),"%d",child);execl(argv[0],argv[0],"after-exec",pid,NULL);return 8;}
 stop_child(child);return 0;
}
