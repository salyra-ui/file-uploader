<?php
namespace Salyra\Upload;
final class DiskSessions implements SessionStore {
    public function __construct(private string $directory) { if (!is_dir($directory) && !mkdir($directory, 0700, true)) throw new \RuntimeException('Could not create session directory'); }
    public static function safe(string $id): string { if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $id)) throw new UploadError(400, 'ID', 'Invalid upload identifier'); return $id; }
    public static function atomic(string $path, array $value): void {
        $temp=tempnam(dirname($path), '.json-'); if ($temp===false) throw new \RuntimeException('Could not create metadata file');
        try { $stream=fopen($temp, 'wb'); if (!$stream) throw new \RuntimeException('Could not write metadata'); try { $bytes=json_encode($value, JSON_THROW_ON_ERROR); $position=0; while ($position<strlen($bytes)) { $written=fwrite($stream, substr($bytes,$position)); if ($written===false||$written===0) throw new \RuntimeException('Metadata write failed'); $position+=$written; } fflush($stream); fsync($stream); } finally { fclose($stream); } if (!rename($temp,$path)) throw new \RuntimeException('Metadata publish failed'); } finally { if (file_exists($temp)) unlink($temp); }
    }
    public function transaction(string $id, callable $operation): mixed { $stream=fopen($this->directory.'/'.self::safe($id).'.lock','c'); if (!$stream) throw new \RuntimeException('Could not open lock'); try { if (!flock($stream, LOCK_EX)) throw new \RuntimeException('Could not acquire lock'); return $operation(); } finally { flock($stream, LOCK_UN); fclose($stream); } }
    public function get(string $id): ?array { $path=$this->directory.'/'.self::safe($id).'.json'; return file_exists($path)?json_decode(file_get_contents($path),true,512,JSON_THROW_ON_ERROR):null; }
    public function save(array $session): void {
        self::atomic($this->directory.'/'.self::safe($session['id']).'.json', $session);
        // Nothing is received for a finished upload any more: its chunk locks can go. A chunk request still streaming is refused at its record.
        if (in_array($session['state'] ?? '', ['completed', 'canceled', 'expired'], true) && ($session['descriptor']['chunkSize'] ?? 0) >= 1) {
            $count=max(1, intdiv($session['descriptor']['size']+$session['descriptor']['chunkSize']-1, $session['descriptor']['chunkSize']));
            for ($index=0; $index<$count; $index++) @unlink($this->directory.'/'.UploadEngine::chunkLock($session['id'], $index).'.lock');
        }
    }
}
