/* 同安装维护的 OS 证据边界。只向指定世代的 supervisor 发 SIGTERM，不直接终止 child。
 * 私有 ABI 来源（56 字节，flavor 17）：
 * https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
 * 不读取环境、命令参数或控制凭据；不支持的平台/API 一律拒绝。 */
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <mach/message.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/clonefile.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

#define CHILD_LIMIT 1024
#define WAIT_SECONDS 15
#define UNIQUE_INFO_FLAVOR 17
struct unique_info {
 uint8_t uuid[16];
 uint64_t unique_id,parent_unique_id;
 int32_t version,original_parent_version;
 uint64_t reserved[2];
};
_Static_assert(sizeof(struct unique_info)==56,"unsupported process identity ABI");
struct identity {
 struct proc_bsdinfo bsd;
 struct unique_info unique;
 char executable[PROC_PIDPATHINFO_MAXSIZE],cwd[MAXPATHLEN],boot[128];
 int children[CHILD_LIMIT],child_count;
};
struct receipt_file {int directory,fd;char name[NAME_MAX+1],temporary[NAME_MAX+1];};
typedef int (*signal_token_fn)(audit_token_t *,int);
static struct utsname system_info;
static signal_token_fn signal_token;

static int reject(const char *reason){fprintf(stderr,"maintenance-process: %s\n",reason);return 1;}
static bool number(const char *text,uint64_t limit,uint64_t *value){
 if(!text||!*text)return false;
 for(const char *p=text;*p;p++)if(!isdigit((unsigned char)*p))return false;
 errno=0;char *end=NULL;unsigned long long result=strtoull(text,&end,10);
 if(errno||*end||result==0||result>limit)return false;
 *value=result;return true;
}
static bool platform_supported(void){
 if(uname(&system_info))return false;
 char *end=NULL;long major=strtol(system_info.release,&end,10);
 if(!end||*end!='.'||major!=TELOA_OS_MAJOR||strcmp(system_info.machine,TELOA_BUILD_ARCH))return false;
 signal_token=(signal_token_fn)dlsym(RTLD_DEFAULT,"proc_signal_with_audittoken");
 return signal_token!=NULL;
}
static int pid_compare(const void *a,const void *b){int left=*(const int*)a,right=*(const int*)b;return (left>right)-(left<right);}
static bool same_generation(const struct identity *a,const struct identity *b){
 return a->bsd.pbi_pid==b->bsd.pbi_pid&&a->bsd.pbi_ppid==b->bsd.pbi_ppid&&a->bsd.pbi_uid==b->bsd.pbi_uid&&
 a->bsd.pbi_start_tvsec==b->bsd.pbi_start_tvsec&&a->bsd.pbi_start_tvusec==b->bsd.pbi_start_tvusec&&
 a->unique.unique_id==b->unique.unique_id&&a->unique.parent_unique_id==b->unique.parent_unique_id&&
 a->unique.version==b->unique.version;
}
static bool read_identity(pid_t pid,struct identity *out){
 memset(out,0,sizeof(*out));struct identity after={0};struct proc_vnodepathinfo vnode={0};
 if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&out->bsd,sizeof(out->bsd))!=sizeof(out->bsd)||
    proc_pidinfo(pid,UNIQUE_INFO_FLAVOR,0,&out->unique,sizeof(out->unique))!=sizeof(out->unique))return false;
 if(out->bsd.pbi_pid!=(unsigned)pid||out->bsd.pbi_uid!=getuid()||out->bsd.pbi_status==SZOMB||
    out->unique.version<=0||out->unique.unique_id==0)return false;
 if(proc_pidinfo(pid,PROC_PIDVNODEPATHINFO,0,&vnode,sizeof(vnode))!=sizeof(vnode)||
    proc_pidpath(pid,out->executable,sizeof(out->executable))<=0)return false;
 if(!memchr(vnode.pvi_cdir.vip_path,0,sizeof(vnode.pvi_cdir.vip_path))||vnode.pvi_cdir.vip_path[0]!='/')return false;
 if(strlcpy(out->cwd,vnode.pvi_cdir.vip_path,sizeof(out->cwd))>=sizeof(out->cwd))return false;
 size_t length=sizeof(out->boot);
 if(sysctlbyname("kern.bootsessionuuid",out->boot,&length,NULL,0)||!memchr(out->boot,0,sizeof(out->boot))||!out->boot[0])return false;
 /* proc_listchildpids 返回 PID 个数；清空 errno，避免把读取失败误认为零后代。 */
 errno=0;out->child_count=proc_listchildpids(pid,out->children,sizeof(out->children));
 if(errno||out->child_count<0||out->child_count>=CHILD_LIMIT)return false;
 for(int i=0;i<out->child_count;i++)if(out->children[i]<=0)return false;
 qsort(out->children,(size_t)out->child_count,sizeof(int),pid_compare);
 if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&after.bsd,sizeof(after.bsd))!=sizeof(after.bsd)||
    proc_pidinfo(pid,UNIQUE_INFO_FLAVOR,0,&after.unique,sizeof(after.unique))!=sizeof(after.unique))return false;
 return same_generation(out,&after)&&after.bsd.pbi_status!=SZOMB;
}
static bool same_identity(const struct identity *a,const struct identity *b){
 return same_generation(a,b)&&!strcmp(a->executable,b->executable)&&!strcmp(a->cwd,b->cwd)&&!strcmp(a->boot,b->boot)&&
 a->child_count==b->child_count&&!memcmp(a->children,b->children,(size_t)a->child_count*sizeof(int));
}
static bool topology(const struct identity *identities,int count){
 for(int i=0;i<count;i++){
  const struct identity *current=&identities[i];
  if(current->bsd.pbi_uid!=identities[0].bsd.pbi_uid||strcmp(current->boot,identities[0].boot))return false;
  for(int other=0;other<i;other++)if(current->bsd.pbi_pid==identities[other].bsd.pbi_pid||current->unique.unique_id==identities[other].unique.unique_id)return false;
  if(i==count-1){if(current->child_count!=0)return false;}
  else{
   const struct identity *child=&identities[i+1];
   if(current->child_count!=1||current->children[0]!=(int)child->bsd.pbi_pid||child->bsd.pbi_ppid!=current->bsd.pbi_pid||child->unique.parent_unique_id!=current->unique.unique_id)return false;
  }
 }
 return true;
}
static void quoted(FILE *stream,const char *text){
 fputc('"',stream);
 for(const unsigned char *p=(const unsigned char*)text;*p;p++){
  if(*p=='"'||*p=='\\'){fputc('\\',stream);fputc(*p,stream);}
  else if(*p<32)fprintf(stream,"\\u%04x",*p);
  else fputc(*p,stream);
 }
 fputc('"',stream);
}
static void write_identity(FILE *stream,const struct identity *value){
 fprintf(stream,"{\"pid\":%u,\"ppid\":%u,\"uid\":%u,\"birthSec\":%" PRIu64 ",\"birthUsec\":%" PRIu64 ",\"uniqueId\":\"%" PRIu64 "\",\"parentUniqueId\":\"%" PRIu64 "\",\"pidVersion\":%d,\"executable\":",
 value->bsd.pbi_pid,value->bsd.pbi_ppid,value->bsd.pbi_uid,value->bsd.pbi_start_tvsec,value->bsd.pbi_start_tvusec,value->unique.unique_id,value->unique.parent_unique_id,value->unique.version);
 quoted(stream,value->executable);fputs(",\"cwd\":",stream);quoted(stream,value->cwd);
 fputs(",\"bootId\":",stream);quoted(stream,value->boot);fputs(",\"children\":[",stream);
 for(int i=0;i<value->child_count;i++)fprintf(stream,"%s%d",i?",":"",value->children[i]);
 fputs("]}",stream);
}
static void discard_receipt(struct receipt_file *file){
 if(file->fd>=0)close(file->fd);
 if(file->directory>=0){if(file->temporary[0])unlinkat(file->directory,file->temporary,0);close(file->directory);}
 file->fd=-1;file->directory=-1;
}
static bool prepare_receipt(const char *path,struct receipt_file *file){
 *file=(struct receipt_file){.directory=-1,.fd=-1};char directory[PATH_MAX];
 if(!path||path[0]!='/'||strlen(path)>=sizeof(directory))return false;
 strlcpy(directory,path,sizeof(directory));char *slash=strrchr(directory,'/');
 if(!slash||!slash[1]||strlen(slash+1)>NAME_MAX||!strcmp(slash+1,".")||!strcmp(slash+1,".."))return false;
 strlcpy(file->name,slash+1,sizeof(file->name));if(slash==directory)slash[1]=0;else *slash=0;
 file->directory=open(directory,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(file->directory<0)return false;
 struct stat parent,existing;
 if(fstat(file->directory,&parent)||parent.st_uid!=getuid()||(parent.st_mode&0022))goto fail;
 if(fstatat(file->directory,file->name,&existing,AT_SYMLINK_NOFOLLOW)==0||errno!=ENOENT)goto fail;
 snprintf(file->temporary,sizeof(file->temporary),".maintenance-%d-%08x.tmp",getpid(),arc4random());
 file->fd=openat(file->directory,file->temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
 if(file->fd<0)goto fail;
 return true;
 fail:discard_receipt(file);return false;
}
static bool publish_receipt(struct receipt_file *file,const struct identity *identities,int count,const char *binding){
 char *json=NULL;size_t length=0;FILE *stream=open_memstream(&json,&length);if(!stream)return false;
 struct timespec now;struct tm utc;char time_text[32];
 if(clock_gettime(CLOCK_REALTIME,&now)||!gmtime_r(&now.tv_sec,&utc)||!strftime(time_text,sizeof(time_text),"%Y-%m-%dT%H:%M:%S",&utc)){fclose(stream);free(json);return false;}
 fputs("{\"schema\":\"teloa.maintenance-process-exit/v1\",\"bindingSha256\":",stream);quoted(stream,binding);
 fputs(",\"platform\":\"darwin\",\"arch\":",stream);quoted(stream,TELOA_BUILD_ARCH);
 fputs(",\"osRelease\":",stream);quoted(stream,system_info.release);fputs(",\"supervisor\":",stream);write_identity(stream,&identities[0]);
 fputs(",\"observationScope\":\"bound-processes-after-registration\"",stream);
 fputs(",\"child\":",stream);write_identity(stream,&identities[1]);
 if(count==3){fputs(",\"referenceMcp\":",stream);write_identity(stream,&identities[2]);}
 int exited[3];for(int i=0;i<count;i++)exited[i]=(int)identities[i].bsd.pbi_pid;qsort(exited,(size_t)count,sizeof(int),pid_compare);
 fputs(",\"exited\":[",stream);for(int i=0;i<count;i++)fprintf(stream,"%s%d",i?",":"",exited[i]);
 fprintf(stream,"],\"observedAt\":\"%s.%03ldZ\",\"signal\":\"SIGTERM\"}\n",time_text,now.tv_nsec/1000000);
 if(fclose(stream)){free(json);return false;}
 size_t offset=0;
 while(offset<length){ssize_t count=write(file->fd,json+offset,length-offset);if(count<0&&errno==EINTR)continue;if(count<=0){free(json);return false;}offset+=(size_t)count;}
 free(json);
 if(fsync(file->fd))return false;
 int closed=close(file->fd);file->fd=-1;if(closed)return false;
 /* 不覆盖既有收据；最终文件可见前已完整 fsync，目录持久化后才报告成功。 */
 if(renameatx_np(file->directory,file->temporary,file->directory,file->name,RENAME_EXCL))return false;
 file->temporary[0]=0;
 if(fsync(file->directory)){unlinkat(file->directory,file->name,0);fsync(file->directory);return false;}
 return true;
}
static bool registered(int queue,const pid_t *pids,int count){
 struct kevent changes[3],receipts[3];
 for(int i=0;i<count;i++)EV_SET(&changes[i],pids[count-i-1],EVFILT_PROC,EV_ADD|EV_ENABLE|EV_CLEAR|EV_RECEIPT,NOTE_EXIT|NOTE_FORK|NOTE_EXEC,0,NULL);
 if(kevent(queue,changes,count,receipts,count,NULL)!=count)return false;
 for(int i=0;i<count;i++)if(!(receipts[i].flags&EV_ERROR)||receipts[i].data!=0)return false;
 return true;
}
static bool no_longer_running(const struct identity *previous){
 struct unique_info unique={0};struct proc_bsdinfo bsd={0};
 errno=0;int count=proc_pidinfo((int)previous->bsd.pbi_pid,UNIQUE_INFO_FLAVOR,0,&unique,sizeof(unique));
 if(count==0)return errno==ESRCH;
 if(count!=sizeof(unique))return false;
 if(unique.unique_id!=previous->unique.unique_id||unique.version!=previous->unique.version)return false;
 /* NOTE_EXIT 已观察；尚未被父进程回收的 zombie 已不能执行，不能用它推断缺失的 EXIT。 */
 return proc_pidinfo((int)previous->bsd.pbi_pid,PROC_PIDTBSDINFO,0,&bsd,sizeof(bsd))==sizeof(bsd)&&bsd.pbi_status==SZOMB;
}
static bool observe_exits(int queue,const struct identity *identities,int process_count){
 bool exited[3]={false,false,false};int remaining=process_count;struct timespec start,now;if(clock_gettime(CLOCK_MONOTONIC,&start))return false;
 while(remaining>0){
  if(clock_gettime(CLOCK_MONOTONIC,&now)||now.tv_sec-start.tv_sec>=WAIT_SECONDS)return false;
  struct timespec timeout={.tv_sec=0,.tv_nsec=100000000};struct kevent events[3];
  int count=kevent(queue,NULL,0,events,process_count,&timeout);if(count<0){if(errno==EINTR)continue;return false;}
  for(int i=0;i<count;i++){
   struct kevent *event=&events[i];
   if(event->filter!=EVFILT_PROC||(event->flags&EV_ERROR)||event->fflags!=NOTE_EXIT)return false;
   int index=0;while(index<process_count&&event->ident!=identities[index].bsd.pbi_pid)index++;
   if(index==process_count)return false;
   if(!exited[index]){exited[index]=true;remaining--;}
  }
 }
 for(int i=0;i<process_count;i++)if(!no_longer_running(&identities[i]))return false;
 return true;
}
static int fence(char **argv,int count){
 uint64_t values[9];pid_t pids[3];
 for(int i=0;i<count*3;i++)if(!number(argv[i],i%3==2?UINT64_MAX:INT32_MAX,&values[i]))return reject("invalid process generation");
 for(int i=0;i<count;i++)pids[i]=(pid_t)values[i*3];
 const char *binding=argv[count*3+1];if(strlen(binding)!=64)return reject("invalid binding digest");
 for(int i=0;i<64;i++)if(!isdigit((unsigned char)binding[i])&&(binding[i]<'a'||binding[i]>'f'))return reject("invalid binding digest");
 struct identity identities[3],after[3];
 struct receipt_file file;if(!prepare_receipt(argv[count*3],&file))return reject("receipt destination is unsafe or exists");
 int queue=kqueue(),result=1;
 if(queue<0||!registered(queue,pids,count)){reject("process observation unavailable");goto done;}
 /* 从 leaf 向 supervisor 注册，不声明原子：观察起点是全部注册成功以后。再取基线，
  * 基线读取期间发生的 fork/exec 仍在队列中。注册前历史后代与外部效果不由此证明结清。 */
 for(int i=count-1;i>=0;i--){
  if(!read_identity(pids[i],&identities[i])){reject("process identity unavailable");goto done;}
  if(identities[i].unique.version!=(int32_t)values[i*3+1]||identities[i].unique.unique_id!=values[i*3+2]){reject("generation or topology mismatch");goto done;}
 }
 if(!topology(identities,count)){reject("generation or topology mismatch");goto done;}
 for(int i=count-1;i>=0;i--)if(!read_identity(pids[i],&after[i])||!same_identity(&identities[i],&after[i])){reject("process identity changed during registration");goto done;}
 if(!topology(after,count)){reject("process identity changed during registration");goto done;}
 struct timespec immediate={0};struct kevent pending[3];
 if(kevent(queue,NULL,0,pending,count,&immediate)!=0){reject("process changed before signal");goto done;}
 audit_token_t token={{0}};token.val[5]=identities[0].bsd.pbi_pid;token.val[7]=(uint32_t)identities[0].unique.version;
 /* 内核在发信号时验证 pidVersion；永不回退裸 PID kill 或直接给 child 发信号。 */
 if(signal_token(&token,SIGTERM)!=0){reject("generation-bound SIGTERM rejected");goto done;}
 if(!observe_exits(queue,identities,count)){reject("complete stable process exit was not observed");goto done;}
 if(!publish_receipt(&file,identities,count,binding)){reject("exit receipt could not be persisted");goto done;}
 result=0;
 done:if(queue>=0)close(queue);discard_receipt(&file);return result;
}
/* 备份大文件仅共享APFS物理块；文件内容、清单和0600语义与普通复制相同。
 * 逐级目录FD与O_NOFOLLOW阻断路径替换；不回退普通copy或跟随符号链接。 */
static int backup_directory(const char *path,bool private_target){
 if(!path||path[0]!='/'||strlen(path)>=PATH_MAX)return -1;
 int fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(fd<0)return -1;
 char value[PATH_MAX];strcpy(value,path);char *state=NULL;
 for(char *part=strtok_r(value,"/",&state);part;part=strtok_r(NULL,"/",&state)){
  if(!strcmp(part,".")||!strcmp(part,"..")){close(fd);return -1;}
  int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);close(fd);if(next<0)return -1;fd=next;
 }
 struct stat info;if(fstat(fd,&info)||info.st_uid!=getuid()||(private_target&&(info.st_mode&077))){close(fd);return -1;}
 return fd;
}
static int backup_parent(int root,const char *relative,char *name,bool private_target){
 if(!relative||!*relative||relative[0]=='/'||strlen(relative)>=PATH_MAX)return -1;
 char value[PATH_MAX];strcpy(value,relative);int fd=dup(root);if(fd<0)return -1;
 char *state=NULL,*part=strtok_r(value,"/",&state);if(!part){close(fd);return -1;}
 while(part){
  if(!strcmp(part,".")||!strcmp(part,"..")){close(fd);return -1;}
  char *next_part=strtok_r(NULL,"/",&state);
  if(!next_part){strcpy(name,part);return fd;}
  int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);close(fd);if(next<0)return -1;fd=next;
  struct stat info;if(fstat(fd,&info)||info.st_uid!=getuid()||(private_target&&(info.st_mode&077))){close(fd);return -1;}
  part=next_part;
 }
 close(fd);return -1;
}
static bool backup_source_same(const struct stat *a,const struct stat *b){
 return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&a->st_uid==b->st_uid&&a->st_size==b->st_size&&a->st_mode==b->st_mode&&a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec&&a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec&&a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec&&a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
}
static int clone_backup(char **args){
 int source_root=-1,target_root=-1,source_parent=-1,target_parent=-1,source=-1,target=-1,result=1;
 char source_name[PATH_MAX],target_name[PATH_MAX];struct stat before,after,parent,destination;
 source_root=backup_directory(args[0],false);target_root=backup_directory(args[1],true);
 if(source_root<0||target_root<0)goto done;
 source_parent=backup_parent(source_root,args[2],source_name,false);target_parent=backup_parent(target_root,args[2],target_name,true);
 if(source_parent<0||target_parent<0)goto done;
 source=openat(source_parent,source_name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
 if(source<0||fstat(source,&before)||!S_ISREG(before.st_mode)||before.st_uid!=getuid()||fstat(target_parent,&parent)||before.st_dev!=parent.st_dev)goto done;
 /* fclonefileat创建新文件，既有目标和跨设备均失败，绝不普通复制。 */
 if(fclonefileat(source,target_parent,target_name,0))goto done;
 target=openat(target_parent,target_name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
 if(target<0||fstat(target,&destination)||!S_ISREG(destination.st_mode)||destination.st_uid!=getuid()||destination.st_dev!=before.st_dev||destination.st_ino==before.st_ino||destination.st_nlink!=1||destination.st_size!=before.st_size||fchmod(target,0600)||fstat(source,&after)||!backup_source_same(&before,&after))goto done;
 printf("{\"schema\":\"teloa.backup-clone/v1\",\"method\":\"fclonefileat\",\"bytes\":%" PRId64 "}\n",(int64_t)before.st_size);result=0;
 done:
 if(target>=0)close(target);if(source>=0)close(source);if(target_parent>=0)close(target_parent);if(source_parent>=0)close(source_parent);if(target_root>=0)close(target_root);if(source_root>=0)close(source_root);
 if(result)return reject("backup clone refused; no ordinary copy fallback");return 0;
}
int main(int argc,char **argv){
 if(!platform_supported())return reject("unsupported platform or process API");
 if(argc==5&&!strcmp(argv[1],"clone-backup"))return clone_backup(argv+2);
 if(argc==3&&!strcmp(argv[1],"inspect")){
  uint64_t pid;struct identity identity;
  if(!number(argv[2],INT32_MAX,&pid))return reject("invalid process id");
  if(!read_identity((pid_t)pid,&identity)){
   /* 仅内核明确 ESRCH 才报告不存在；权限、ABI、zombie 或混合快照失败不能冒充退出。 */
   struct unique_info current={0};errno=0;
   if(proc_pidinfo((int)pid,UNIQUE_INFO_FLAVOR,0,&current,sizeof(current))==0&&errno==ESRCH){
    printf("{\"absent\":true,\"pid\":%" PRIu64 "}\n",pid);return 3;
   }
   return reject("process identity unavailable");
  }
  write_identity(stdout,&identity);fputc('\n',stdout);return 0;
 }
 if(argc==10&&!strcmp(argv[1],"fence"))return fence(argv+2,2);
 if(argc==13&&!strcmp(argv[1],"fence-reference"))return fence(argv+2,3);
 return reject("expected inspect PID, fence SUPERVISOR_PID PIDVERSION UNIQUEID CHILD_PID PIDVERSION UNIQUEID RECEIPT_PATH BINDING_SHA256, or fence-reference with REFERENCE_PID PIDVERSION UNIQUEID before RECEIPT_PATH");
}
