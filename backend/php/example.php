<?php
spl_autoload_register(function ($name) { $prefix='Salyra\\Upload\\'; if (str_starts_with($name,$prefix)) require __DIR__.'/src/'.substr($name,strlen($prefix)).'.php'; });
$directory=getenv('UPLOAD_DIRECTORY')?:__DIR__.'/.uploads';
$engine=new Salyra\Upload\UploadEngine(new Salyra\Upload\DiskSessions($directory.'/sessions'),new Salyra\Upload\DiskStorage($directory.'/storage'),['allowAnonymous'=>true]);
$adapter=new Salyra\Upload\HttpAdapter($engine);
$response=$adapter->handle(['method'=>$_SERVER['REQUEST_METHOD'],'path'=>$_SERVER['REQUEST_URI'],'headers'=>getallheaders()],fopen('php://input','rb'),context:$_SERVER);
http_response_code($response['status']); header('Content-Type: application/json'); header('Cache-Control: no-store'); echo json_encode($response['body'],JSON_THROW_ON_ERROR);
