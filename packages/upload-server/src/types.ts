import type { Readable } from "node:stream";
export interface UploadDescriptor {
  protocol: "salyra-upload/1";
  name: string;
  size: number;
  type: string;
  lastModified: number;
  chunkSize: number;
  metadata?: Record<string, unknown>;
}
export interface StoredPart {
  index: number;
  size: number;
  sha256: string;
  reference: unknown;
}
export interface ServerSession {
  id: string;
  key: string;
  descriptor: UploadDescriptor;
  expiresAt: number;
  state: "open" | "finalizing" | "completed" | "canceled" | "expired";
  storageRef: unknown;
  parts: StoredPart[];
  result?: unknown;
}
export interface SessionStore {
  /** Cross-process lock or CAS transaction. Lock must cover the whole operation and survive awaited I/O. */
  transaction<T>(key: string, operation: () => Promise<T>): Promise<T>;
  get(id: string): Promise<ServerSession | undefined>;
  put(value: ServerSession): Promise<void>;
  list(): AsyncIterable<ServerSession>;
}
export interface StorageAdapter {
  capabilities: {
    minChunkSize: number;
    maxChunkSize: number;
    maxParts: number;
    parallelParts: boolean;
  };
  begin(
    session: Pick<ServerSession, "id" | "descriptor">,
    context: unknown,
  ): Promise<unknown>;
  writePart(
    session: ServerSession,
    part: Omit<StoredPart, "reference">,
    body: Readable,
    context: unknown,
  ): Promise<StoredPart>;
  probe(session: ServerSession, context: unknown): Promise<StoredPart[]>;
  finish(
    session: ServerSession,
    parts: StoredPart[],
    context: unknown,
  ): Promise<unknown>;
  inspectResult(
    session: ServerSession,
    context: unknown,
  ): Promise<{ found: boolean; result?: unknown }>;
  abort(session: ServerSession, context: unknown): Promise<void>;
  remove?(result: unknown, context: unknown): Promise<void>;
}
export type ServerOperation =
  "create" | "probe" | "part" | "complete" | "cancel";
export interface ServerOptions<Context = unknown> {
  sessionStore: SessionStore;
  storage: StorageAdapter;
  maxFileSize?: number;
  maxChunkSize?: number;
  sessionTTL?: number;
  /**
   * Without authorize, anyone who can reach the routes can create, read and finish uploads. The
   * server refuses to start without it unless this is set (local demos, tests).
   */
  allowAnonymous?: boolean;
  /** Must return a stable application/user scope. Session access is still authorized on every operation. */
  scope?(context: Context | undefined): string | Promise<string>;
  authorize?(
    operation: ServerOperation,
    session: ServerSession | undefined,
    context: Context | undefined,
  ): void | Promise<void>;
  validateUpload?(
    descriptor: UploadDescriptor,
    context: Context | undefined,
  ): void | Promise<void>;
  onEvent?(
    event: {
      id: string;
      type: "created" | "part-stored" | "completed" | "canceled" | "expired";
      session: ServerSession;
      part?: StoredPart;
    },
    context: Context | undefined,
  ): void | Promise<void>;
  onNotificationError?(error: unknown): void;
}
export class UploadServerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MultipartReference {
  version: 1;
  bucket: string;
  key: string;
  uploadId?: string;
}
export interface ReceiptJournal {
  get(sessionId: string): Promise<StoredPart[]>;
  put(sessionId: string, part: StoredPart): Promise<void>;
  getReference(sessionId: string): Promise<MultipartReference | undefined>;
  putReference(sessionId: string, reference: MultipartReference): Promise<void>;
  remove(sessionId: string): Promise<void>;
}
