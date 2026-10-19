<?php
// Chunks of one upload arrive side by side. php -S buffers a request body whole, so this test gives each
// chunk a child process whose body is its STDIN pipe: a chunk can stall inside the engine.
//   php tests/parallel.php
use Salyra\Upload\{DiskSessions, DiskStorage, UploadEngine, UploadError};
spl_autoload_register(function ($name) { $prefix='Salyra\\Upload\\'; if (str_starts_with($name,$prefix)) require __DIR__.'/../src/'.substr($name,strlen($prefix)).'.php'; });
function engine(string $directory): UploadEngine { return new UploadEngine(new DiskSessions($directory.'/sessions'), new DiskStorage($directory.'/storage'), ['allowAnonymous'=>true]); }
if (($argv[1] ?? '') === 'chunk') {
    [, , $directory, $id, $index, $checksum] = $argv;
    try { engine($directory)->receivePart($id, (int)$index, $checksum, STDIN); $status=200; }
    catch (UploadError $error) { $status=$error->status; }
    catch (\Throwable $error) { $status=500; }
    echo $status; exit(0);
}
function check(bool $condition, string $message): void { if (!$condition) { fwrite(STDERR, "FAILED: $message\n"); exit(1); } }
function child(string $directory, string $id, int $index, string $text): array {
    $process=proc_open([PHP_BINARY, __FILE__, 'chunk', $directory, $id, (string)$index, hash('sha256', $text)], [0=>['pipe','r'], 1=>['pipe','w']], $pipes);
    return ['process'=>$process, 'in'=>$pipes[0], 'out'=>$pipes[1]];
}
/** A chunk whose body stops after its first byte. */
function stalled(string $directory, string $id, int $index, string $text): array { $c=child($directory,$id,$index,$text); fwrite($c['in'], $text[0]); fflush($c['in']); usleep(400000); return $c; }
function finish(array &$c, string $rest): void { fwrite($c['in'], $rest); fclose($c['in']); }
/** The status the child printed, or null when it has not finished within the time. */
function outcome(array $c, int $milliseconds): ?int {
    $deadline=microtime(true)+$milliseconds/1000;
    while (proc_get_status($c['process'])['running']) { if (microtime(true)>$deadline) return null; usleep(20000); }
    $status=(int)stream_get_contents($c['out']); proc_close($c['process']); return $status;
}
function send(string $directory, string $id, int $index, string $text): array { $c=child($directory,$id,$index,$text); finish($c, $text); return $c; }
function create(UploadEngine $engine, int $chunks): array { return $engine->createUpload(['protocol'=>'salyra-upload/1', 'name'=>'file.txt', 'size'=>$chunks*4, 'type'=>'text/plain', 'lastModified'=>0, 'chunkSize'=>4], bin2hex(random_bytes(8))); }
function record(string $directory, string $id): array { return json_decode(file_get_contents($directory.'/sessions/'.$id.'.json'), true); }

$directory=sys_get_temp_dir().'/salyra-php-'.getmypid(); $engine=engine($directory);
// 1. a chunk that is still streaming blocks no other chunk of the same upload
$id=create($engine, 2)['id']; $slow=stalled($directory, $id, 0, 'abcd');
check(outcome(send($directory, $id, 1, 'efgh'), 8000)===200, 'chunk 1 waited for chunk 0 to finish streaming');
finish($slow, 'bcd'); check(outcome($slow, 8000)===200, 'chunk 0 after its body arrived');
check($engine->finishUpload($id)['sha256']===hash('sha256','abcdefgh'), 'completed content');
// 2. one writer per chunk number: the same chunk sent twice at once is stored once, a different body is a conflict
$id=create($engine, 1)['id']; $slow=stalled($directory, $id, 0, 'abcd'); $twin=send($directory, $id, 0, 'abcd'); $rival=send($directory, $id, 0, 'zzzz');
check(outcome($twin, 800)===null, 'a second request for a streaming chunk did not wait');
finish($slow, 'bcd');
check(outcome($slow, 8000)===200 && outcome($twin, 8000)===200, 'a twin of a streaming chunk');
check(outcome($rival, 8000)===409, 'a different body for a chunk that waited is a conflict');
check(count(record($directory, $id)['parts'])===1, 'one copy of the chunk');
// 3. a session canceled while a chunk streams does not take the chunk
$id=create($engine, 1)['id']; $slow=stalled($directory, $id, 0, 'abcd'); $engine->cancelUpload($id);
finish($slow, 'bcd'); check(outcome($slow, 8000)!==200, 'a canceled upload took a chunk');
check(record($directory, $id)['state']==='canceled' && record($directory, $id)['parts']===[], 'canceled upload keeps no parts');
// 4. many chunks at once: none is lost from the session record, the TTL follows progress, the chunk locks go
$created=create($engine, 16); $id=$created['id']; usleep(5000); $children=[];
for ($i=0; $i<16; $i++) $children[$i]=send($directory, $id, $i, sprintf('%04d', $i));
foreach ($children as $i=>$c) check(outcome($c, 20000)===200, "chunk $i of the burst");
$saved=record($directory, $id);
check(array_column($saved['parts'], 'index')===range(0, 15), 'the session record lost a chunk');
check($saved['expiresAt']>$created['expiresAt'], 'stored chunks did not extend the expiry');
$engine->finishUpload($id);
check(glob($directory.'/sessions/'.$id.'-part-*')===[], 'chunk locks left behind');
exec('rm -rf '.escapeshellarg($directory));
echo "PHP parallel chunks passed\n";
