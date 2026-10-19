<?php
namespace Salyra\Upload;
final class UploadError extends \RuntimeException {
    public function __construct(public int $status, public string $errorCode, string $message) { parent::__construct($message); }
}
