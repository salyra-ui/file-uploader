export type UploadStatus =
  | "idle"
  | "validating"
  | "queued"
  | "awaiting-file"
  | "verifying"
  | "uploading"
  | "retrying"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed"
  | "canceled"
  | "expired";
export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  metadata?: Record<string, unknown>;
}
export interface PartReceipt {
  index: number;
  size: number;
  sha256: string;
}
export interface UploadSession {
  id: string;
  chunkSize: number;
  expiresAt?: number;
}
export interface Checkpoint {
  parts: PartReceipt[];
  status: "open" | "finalizing" | "completed" | "canceled" | "expired";
  result?: unknown;
}
export interface TransportContext {
  signal: AbortSignal;
  metadata: FileMetadata;
  requestKey: string;
}
export interface UploadTransport {
  capabilities: {
    resume: boolean;
    progress: boolean;
    parallelParts: boolean;
    checksums: boolean;
    terminate: boolean;
  };
  create(
    context: TransportContext & { chunkSize: number },
  ): Promise<UploadSession>;
  probe(session: UploadSession, context: TransportContext): Promise<Checkpoint>;
  upload(
    session: UploadSession,
    context: TransportContext & {
      blob: Blob;
      index: number;
      sha256: string;
      onProgress(bytes: number): void;
    },
  ): Promise<PartReceipt>;
  complete(session: UploadSession, context: TransportContext): Promise<unknown>;
  terminate?(session: UploadSession, context: TransportContext): Promise<void>;
}
export interface UploadError {
  message: string;
  code: string;
  status?: number;
}
export interface UploadItem {
  id: string;
  requestKey: string;
  file?: File;
  metadata: FileMetadata;
  status: UploadStatus;
  session?: UploadSession;
  parts: readonly PartReceipt[];
  result?: unknown;
  uploadedBytes: number;
  transferredBytes: number;
  totalBytes: number;
  progress: number | null;
  remainingBytes: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  activeMilliseconds: number;
  attempt: number;
  nextRetryAt: number | null;
  error?: UploadError;
  removing: boolean;
  removeError?: UploadError;
}
export interface CleanupRecord {
  id: string;
  itemId: string;
  session?: UploadSession;
  requestKey: string;
  chunkSize: number;
  metadata: FileMetadata;
  status: "pending" | "failed";
  error?: UploadError;
}
export interface PersistedItem extends Omit<
  UploadItem,
  "file" | "bytesPerSecond" | "etaSeconds"
> {}
export interface PersistenceSnapshot {
  version: 1;
  items: PersistedItem[];
  cleanups: CleanupRecord[];
}
export interface UploadPersistence {
  load(): Promise<PersistenceSnapshot | null>;
  save(value: PersistenceSnapshot): Promise<void>;
}
export interface UploaderSnapshot {
  items: readonly UploadItem[];
  cleanups: readonly CleanupRecord[];
  disabled: boolean;
  readOnly: boolean;
  restored: boolean;
  persistenceError?: UploadError;
}
export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  jitter?: boolean;
  shouldRetry?(error: unknown): boolean;
}
export interface ExistingUpload {
  id: string;
  metadata: FileMetadata;
  result?: unknown;
}
export interface HistoryPage {
  items: ExistingUpload[];
  nextCursor?: string;
}
export interface UploaderOptions {
  transport: UploadTransport;
  autoUpload?: boolean;
  chunkSize?: number;
  maxConcurrentFiles?: number;
  maxConcurrentChunks?: number;
  maxConcurrentRequests?: number;
  retry?: RetryOptions;
  requestTimeout?: number;
  progressInterval?: number;
  persistence?: UploadPersistence | false;
  initialFiles?: ExistingUpload[];
  loadHistory?(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<HistoryPage>;
  accept?: string;
  maxFileSize?: number;
  maxTotalSize?: number;
  maxFiles?: number;
  validateFile?(file: File, signal: AbortSignal): Promise<string | void>;
  disabled?: boolean;
  readOnly?: boolean;
  onCancel?(session: UploadSession, context: TransportContext): Promise<void>;
  onRemove?(item: UploadItem, signal: AbortSignal): Promise<void>;
  onError?(error: UploadError, item?: UploadItem): void | Promise<void>;
  onCompleted?(item: UploadItem): void | Promise<void>;
}
export interface UploaderStore {
  getSnapshot(): UploaderSnapshot;
  getItem(id: string): UploadItem | undefined;
  subscribe(listener: () => void): () => void;
  subscribeItem(id: string, listener: () => void): () => void;
  add(files: Iterable<File>): Promise<string[]>;
  restore(): Promise<void>;
  addExisting(items: ExistingUpload[]): void;
  loadHistory(cursor?: string): Promise<string | undefined>;
  attach(id: string, file: File): Promise<void>;
  start(id?: string): void;
  pause(id: string): void;
  resume(id: string): void;
  retry(id: string): void;
  cancel(id: string): Promise<void>;
  reset(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  forget(id: string): void;
  retryCleanup(id: string): Promise<void>;
  setOptions(options: Pick<UploaderOptions, "disabled" | "readOnly">): void;
  destroy(): void;
}
