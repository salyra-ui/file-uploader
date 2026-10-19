<?php
namespace Salyra\Upload;
final class HttpAdapter {
    public function __construct(private UploadEngine $engine, private string $basePath='/uploads') {}
    /** A framework route can pass an explicit operation, ID and index instead of using the default matcher. */
    public function handle(array $request, mixed $body, ?array $route=null, mixed $context=null): array {
        try {
            $path=parse_url($request['path'],PHP_URL_PATH); $method=$request['method']; $headers=array_change_key_case($request['headers'],CASE_LOWER);
            if (!$route) {
                if ($path===$this->basePath && $method==='POST') $route=['operation'=>'create'];
                elseif (preg_match('#^'.preg_quote($this->basePath,'#').'/([a-zA-Z0-9_-]{1,100})(?:/parts/(\d+)|/(complete))?$#D',$path,$matches)) {
                    $operation=isset($matches[2]) && $matches[2]!=='' && $method==='PUT'?'part':(isset($matches[3]) && $matches[3]==='complete' && $method==='POST'?'complete':(count($matches)===2 && $method==='GET'?'probe':(count($matches)===2 && $method==='DELETE'?'cancel':'')));
                    if ($operation) $route=['operation'=>$operation,'id'=>$matches[1],'index'=>(int)($matches[2]??0)];
                }
            }
            if (!$route) throw new UploadError(404,'NOT_FOUND','Route was not found');
            switch ($route['operation']) {
                case 'create': if (strtolower(trim(explode(';', (string)($headers['content-type'] ?? ''))[0])) !== 'application/json') throw new UploadError(415,'CONTENT_TYPE','Upload metadata must be sent as application/json'); $bytes=stream_get_contents($body,65537); if (strlen($bytes)>65536) throw new UploadError(413,'JSON_SIZE','Upload metadata is too large'); try { $descriptor=json_decode($bytes,true,512,JSON_THROW_ON_ERROR); } catch (\JsonException $error) { throw new UploadError(400,'JSON','Invalid JSON body'); } if (!is_array($descriptor)) throw new UploadError(400,'JSON','Invalid JSON body'); $result=$this->engine->createUpload($descriptor,$headers['idempotency-key']??'',$context); break;
                case 'probe': $result=$this->engine->getUpload($route['id'],$context); break;
                case 'part': $result=$this->engine->receivePart($route['id'],$route['index'],$headers['upload-checksum']??'',$body,$context); break;
                case 'complete': $result=$this->engine->finishUpload($route['id'],$context); break;
                case 'cancel': $this->engine->cancelUpload($route['id'],$context); $result=null; break;
                default: throw new UploadError(404,'NOT_FOUND','Route was not found');
            }
            return ['status'=>200,'body'=>$result];
        } catch (UploadError $error) { return ['status'=>$error->status,'body'=>['code'=>$error->errorCode,'message'=>$error->getMessage()]]; }
        catch (\Throwable $error) { return ['status'=>500,'body'=>['code'=>'INTERNAL','message'=>'Upload operation failed']]; }
    }
}
