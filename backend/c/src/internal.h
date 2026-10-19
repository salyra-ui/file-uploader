#ifndef SALYRA_UPLOAD_INTERNAL
#define SALYRA_UPLOAD_INTERNAL
#include "salyra_upload.h"
#include <cJSON.h>
#include <openssl/evp.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
int u_error(upload_error *,int,const char *,const char *);
int u_safe(const char *);
void u_hex(const unsigned char *,size_t,char *);
const char *u_string(const cJSON *,const char *);
int64_t u_number(const cJSON *,const char *);
char *u_json(cJSON *);
#endif
