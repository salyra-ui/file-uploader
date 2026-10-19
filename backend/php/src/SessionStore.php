<?php
namespace Salyra\Upload;
interface SessionStore {
    public function transaction(string $id, callable $operation): mixed;
    public function get(string $id): ?array;
    public function save(array $session): void;
}
