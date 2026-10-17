<?php
namespace Salyra\Upload;
final class UploadEngine {
    public function __construct(public SessionStore $sessions, public Storage $storage, public array $options = []) {
        // without authorize anyone who reaches the routes can create, read and finish uploads
        if (!isset($options['authorize']) && empty($options['allowAnonymous'])) throw new \InvalidArgumentException('Provide authorize (and scope) from your authentication, or allowAnonymous => true for a local demo');
    }
    private function authorize(string $operation, ?array $session, mixed $context): void { if (isset($this->options['authorize'])) ($this->options['authorize'])($operation, $session, $context); }
    private function notify(string $type, array $session, mixed $context, ?array $part = null): void {
        if (!isset($this->options['notify'])) return;
        try { ($this->options['notify'])(['id' => $session['id'].':'.$type.($part ? ':'.$part['index'] : ''), 'type'=>$type, 'session'=>$session, 'part'=>$part], $context); }
        catch (\Throwable $error) { if (isset($this->options['onNotificationError'])) ($this->options['onNotificationError'])($error); }
    }
    private function count(array $descriptor): int { return max(1, (int)ceil($descriptor['size'] / $descriptor['chunkSize'])); }
    public function createUpload(array $descriptor, string $key, mixed $context = null): array {
        $this->authorize('create', null, $context);
        foreach (['size', 'lastModified', 'chunkSize'] as $field) if (!isset($descriptor[$field]) || !is_int($descriptor[$field]) || $descriptor[$field] < 0 || $descriptor[$field] > 9007199254740991) throw new UploadError(400, 'DESCRIPTOR', 'Invalid upload configuration');
        if (($descriptor['protocol'] ?? '') !== 'salyra-upload/1' || !is_string($descriptor['name'] ?? null) || strlen($descriptor['name']) > 4096 || !is_string($descriptor['type'] ?? null) || $descriptor['chunkSize'] < 1 || $descriptor['chunkSize'] > ($this->options['maxChunkSize'] ?? 64*1024*1024) || !$key || strlen($key) > 200) throw new UploadError(400, 'DESCRIPTOR', 'Invalid upload configuration');
        if ($descriptor['size'] > ($this->options['maxFileSize'] ?? 9007199254740991) || $this->count($descriptor) > 100000) throw new UploadError(413, 'FILE_SIZE', 'File exceeds its limit');
        if (isset($this->options['validate'])) ($this->options['validate'])($descriptor, $context);
        $scope = isset($this->options['scope']) ? ($this->options['scope'])($context) : '';
        $id = hash('sha256', json_encode([$scope, $key], JSON_THROW_ON_ERROR));
        return $this->sessions->transaction($id, function () use ($id, $descriptor, $context) {
            $existing = $this->sessions->get($id);
            if ($existing) {
                $this->authorize('create', $existing, $context);
                if ($existing['descriptor'] != $descriptor) throw new UploadError(409, 'KEY_CONFLICT', 'Key belongs to another file');
                if ($existing['expiresAt'] <= microtime(true)*1000 && $existing['state'] === 'finalizing') $this->reconcile($existing, $context);
                if ($existing['expiresAt'] <= microtime(true)*1000 && $existing['state'] !== 'completed') throw new UploadError(410, 'EXPIRED', 'Session expired');
                return ['id'=>$id, 'chunkSize'=>$descriptor['chunkSize'], 'expiresAt'=>$existing['expiresAt']];
            }
            $session = ['id'=>$id, 'descriptor'=>$descriptor, 'expiresAt'=>(int)(microtime(true)*1000)+($this->options['ttlMilliseconds'] ?? 86400000), 'state'=>'open', 'parts'=>[]];
            $session['storageRef'] = $this->storage->begin($session, $context);
            $this->sessions->save($session); $this->notify('created', $session, $context);
            return ['id'=>$id, 'chunkSize'=>$descriptor['chunkSize'], 'expiresAt'=>$session['expiresAt']];
        });
    }
    private function get(string $id, string $operation, mixed $context): array {
        $session = $this->sessions->get($id);
        if (!$session) throw new UploadError(404, 'NOT_FOUND', 'Upload session was not found');
        $this->authorize($operation, $session, $context);
        if ($session['state'] === 'expired') throw new UploadError(410, 'EXPIRED', 'Session expired');
        if ($session['expiresAt'] <= microtime(true)*1000 && !in_array($session['state'], ['completed', 'canceled'])) {
            if ($session['state'] === 'finalizing') {
                $this->reconcile($session, $context);
                if ($session['state'] === 'completed') return $session;
            }
            $this->storage->abort($session, $context); $session['state'] = 'expired'; $this->sessions->save($session); $this->notify('expired', $session, $context);
            throw new UploadError(410, 'EXPIRED', 'Session expired');
        }
        return $session;
    }
    private function reconcile(array &$session, mixed $context): void {
        if (in_array($session['state'], ['completed', 'canceled'])) return;
        $result = $this->storage->inspectResult($session, $context);
        if ($result !== null) { $session['state'] = 'completed'; $session['result'] = $result; }
        else {
            $parts = $this->storage->probe($session, $context); usort($parts, fn($a, $b) => $a['index'] <=> $b['index']); $seen=[];
            foreach ($parts as $part) { $index=$part['index']; if (isset($seen[$index]) || $index < 0 || $index >= $this->count($session['descriptor']) || $part['size'] !== min($session['descriptor']['chunkSize'], $session['descriptor']['size']-$index*$session['descriptor']['chunkSize'])) throw new UploadError(500, 'STORAGE_CHECKPOINT', 'Storage returned an invalid part'); $seen[$index]=true; }
            $session['parts'] = $parts;
        }
        $this->sessions->save($session);
    }
    public function getUpload(string $id, mixed $context = null): array {
        return $this->sessions->transaction($id, function () use ($id, $context) {
            $session=$this->get($id, 'probe', $context); $this->reconcile($session, $context);
            $result=['status'=>$session['state'], 'parts'=>array_map(fn($part)=>array_intersect_key($part, array_flip(['index','size','sha256'])), $session['parts']), 'expiresAt'=>$session['expiresAt']];
            if ($session['state']==='completed') $result['result']=$session['result']; return $result;
        });
    }
    public function receivePart(string $id, int $index, string $checksum, mixed $body, mixed $context = null): array {
        return $this->sessions->transaction($id, function () use ($id, $index, $checksum, $body, $context) {
            $session=$this->get($id, 'part', $context); if ($session['state']!=='open') throw new UploadError(409, 'STATE', 'Upload does not accept chunks');
            $d=$session['descriptor']; if ($index<0 || $index >= $this->count($d) || !preg_match('/^[a-f0-9]{64}$/D', $checksum)) throw new UploadError(400, 'PART', 'Invalid chunk or checksum');
            $part=['index'=>$index, 'size'=>min($d['chunkSize'], $d['size']-$index*$d['chunkSize']), 'sha256'=>$checksum];
            $saved=$this->storage->writePart($session, $part, $body, $context);
            $session['parts']=array_values(array_filter($session['parts'], fn($part)=>$part['index']!==$index)); $session['parts'][]=$saved;
            usort($session['parts'], fn($a,$b)=>$a['index']<=>$b['index']); $this->sessions->save($session); $this->notify('part-stored', $session, $context, $saved);
            unset($saved['reference']); return $saved;
        });
    }
    public function finishUpload(string $id, mixed $context = null): mixed {
        return $this->sessions->transaction($id, function () use ($id, $context) {
            $session=$this->get($id, 'complete', $context); $this->reconcile($session, $context);
            if ($session['state']==='completed') return $session['result']; if ($session['state']==='canceled') throw new UploadError(409, 'CANCELED', 'Upload was canceled');
            if (count($session['parts']) !== $this->count($session['descriptor'])) throw new UploadError(409, 'INCOMPLETE', 'Upload is missing chunks');
            foreach ($session['parts'] as $index=>$part) if ($part['index']!==$index) throw new UploadError(409, 'MANIFEST', 'Invalid manifest');
            $session['state']='finalizing'; $this->sessions->save($session);
            try { $result=$this->storage->finish($session, $session['parts'], $context); }
            catch (\Throwable $error) { $result=$this->storage->inspectResult($session, $context); if ($result===null) throw $error; }
            $session['state']='completed'; $session['result']=$result; $this->sessions->save($session); $this->notify('completed', $session, $context); return $result;
        });
    }
    public function cancelUpload(string $id, mixed $context = null): void {
        $this->sessions->transaction($id, function () use ($id, $context) { $session=$this->get($id, 'cancel', $context); $this->reconcile($session, $context); if ($session['state']==='completed') throw new UploadError(409, 'COMPLETED', 'Remove completed files through the application'); $this->storage->abort($session, $context); $session['state']='canceled'; $session['parts']=[]; $this->sessions->save($session); $this->notify('canceled', $session, $context); });
    }
}
