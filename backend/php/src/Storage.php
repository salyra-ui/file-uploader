<?php
namespace Salyra\Upload;
interface Storage {
    public function begin(array $session, mixed $context): mixed;
    /** The body is a readable stream, consumed exactly once. */
    public function writePart(array $session, array $part, mixed $body, mixed $context): array;
    public function probe(array $session, mixed $context): array;
    public function inspectResult(array $session, mixed $context): mixed;
    public function finish(array $session, array $parts, mixed $context): mixed;
    public function abort(array $session, mixed $context): void;
}
