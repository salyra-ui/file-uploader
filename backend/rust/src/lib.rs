use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
pub mod filesystem;
#[cfg(feature = "http")]
pub mod http;
#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub code: String,
    pub message: String,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new(500, "IO", &e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new(400, "JSON", &e.to_string())
    }
}
impl Error {
    pub fn new(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Default)]
pub struct Context {
    pub data: Value,
    pub canceled: Arc<AtomicBool>,
}
impl Context {
    pub fn check(&self) -> Result<()> {
        if self.canceled.load(Ordering::Relaxed) {
            Err(Error::new(499, "ABORT", "Request stopped"))
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub protocol: String,
    pub name: String,
    pub size: u64,
    pub r#type: String,
    pub last_modified: u64,
    pub chunk_size: u64,
    #[serde(default)]
    pub metadata: Value,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Part {
    pub index: usize,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub reference: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub descriptor: Descriptor,
    pub expires_at: u64,
    pub state: String,
    pub parts: Vec<Part>,
    pub storage_ref: Value,
    #[serde(default)]
    pub result: Value,
}
pub trait Lease {}
pub trait SessionStore: Send + Sync {
    fn lock(&self, id: &str, context: &Context) -> Result<Box<dyn Lease>>;
    fn get(&self, id: &str) -> Result<Option<Session>>;
    fn save(&self, s: &Session) -> Result<()>;
}
pub trait Storage: Send + Sync {
    fn begin(&self, s: &Session, c: &Context) -> Result<Value>;
    fn write_part(&self, s: &Session, p: &Part, body: &mut dyn Read, c: &Context) -> Result<Part>;
    fn probe(&self, s: &Session, c: &Context) -> Result<Vec<Part>>;
    fn inspect(&self, s: &Session, c: &Context) -> Result<Option<Value>>;
    fn finish(&self, s: &Session, parts: &[Part], c: &Context) -> Result<Value>;
    fn abort(&self, s: &Session, c: &Context) -> Result<()>;
}
pub type Authorize = Arc<dyn Fn(&str, Option<&Session>, &Context) -> Result<()> + Send + Sync>;
pub type Validate = Arc<dyn Fn(&Descriptor, &Context) -> Result<()> + Send + Sync>;
pub type Notify = Arc<dyn Fn(&str, &Session, Option<&Part>, &Context) + Send + Sync>;
pub struct Options {
    pub ttl_ms: u64,
    pub max_file_size: u64,
    pub max_chunk_size: u64,
    pub scope: Arc<dyn Fn(&Context) -> String + Send + Sync>,
    /// Without it, anyone who reaches the routes can create, read and finish uploads: every
    /// operation is then refused unless `allow_anonymous` is set (local demos, tests).
    pub authorize: Option<Authorize>,
    pub allow_anonymous: bool,
    pub validate: Validate,
    pub notify: Notify,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            ttl_ms: 86_400_000,
            max_file_size: 9_007_199_254_740_991,
            max_chunk_size: 64 * 1024 * 1024,
            scope: Arc::new(|_| String::new()),
            authorize: None,
            allow_anonymous: false,
            validate: Arc::new(|_, _| Ok(())),
            notify: Arc::new(|_, _, _, _| {}),
        }
    }
}
pub struct Engine {
    pub sessions: Arc<dyn SessionStore>,
    pub storage: Arc<dyn Storage>,
    pub options: Options,
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn count(d: &Descriptor) -> usize {
    (d.size.div_ceil(d.chunk_size).max(1)) as usize
}
/// The lock of one chunk number. Session IDs are hex digests, so a key with a `-part-` suffix is
/// never another session's ID.
pub fn chunk_lock(id: &str, index: usize) -> String {
    format!("{id}-part-{index}")
}
/// Consumes a retransmitted body and compares it with the recorded chunk. A matching header does
/// not prove matching content.
fn verify_part(old: &Part, p: &Part, body: &mut dyn Read, c: &Context) -> Result<Value> {
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        c.check()?;
        let read = body.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > p.size {
            return Err(Error::new(
                413,
                "PART_SIZE",
                "Chunk exceeds its expected size",
            ));
        }
        hash.update(&buffer[..read]);
    }
    if size != p.size || format!("{:x}", hash.finalize()) != old.sha256 || p.sha256 != old.sha256 {
        return Err(Error::new(
            409,
            "PART_CONFLICT",
            "Chunk contains different data",
        ));
    }
    Ok(json!({"index":old.index,"size":old.size,"sha256":old.sha256}))
}
impl Engine {
    fn authorize(&self, op: &str, s: Option<&Session>, c: &Context) -> Result<()> {
        match &self.options.authorize {
            Some(authorize) => authorize(op, s, c),
            None if self.options.allow_anonymous => Ok(()),
            None => Err(Error::new(
                500,
                "AUTHORIZE",
                "Provide authorize (and scope) from your authentication, or allow_anonymous for a local demo",
            )),
        }
    }
    pub fn create_upload(&self, d: Descriptor, key: &str, c: &Context) -> Result<Value> {
        self.authorize("create", None, c)?;
        if d.protocol != "salyra-upload/1"
            || d.name.chars().count() > 1024
            || d.chunk_size == 0
            || d.chunk_size > self.options.max_chunk_size
            || d.size > 9_007_199_254_740_991
            || d.last_modified > 9_007_199_254_740_991
            || key.is_empty()
            || key.len() > 200
        {
            return Err(Error::new(
                400,
                "DESCRIPTOR",
                "Invalid upload configuration",
            ));
        }
        if d.size > self.options.max_file_size || count(&d) > 100000 {
            return Err(Error::new(413, "FILE_SIZE", "File exceeds its limit"));
        };
        (self.options.validate)(&d, c)?;
        let id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([(self.options.scope)(c), key]))?)
        );
        let _lease = self.sessions.lock(&id, c)?;
        if let Some(mut existing) = self.sessions.get(&id)? {
            self.authorize("create", Some(&existing), c)?;
            if existing.descriptor != d {
                return Err(Error::new(
                    409,
                    "KEY_CONFLICT",
                    "Key belongs to another file",
                ));
            };
            if existing.expires_at <= now() && existing.state == "finalizing" {
                self.reconcile(&mut existing, c)?;
            }
            if existing.expires_at <= now() && existing.state != "completed" {
                return Err(Error::new(410, "EXPIRED", "Session expired"));
            };
            return Ok(json!({"id":id,"chunkSize":d.chunk_size,"expiresAt":existing.expires_at}));
        }
        let mut s = Session {
            id: id.clone(),
            descriptor: d.clone(),
            expires_at: now() + self.options.ttl_ms,
            state: "open".into(),
            parts: vec![],
            storage_ref: Value::Null,
            result: Value::Null,
        };
        s.storage_ref = self.storage.begin(&s, c)?;
        self.sessions.save(&s)?;
        (self.options.notify)("created", &s, None, c);
        Ok(json!({"id":id,"chunkSize":d.chunk_size,"expiresAt":s.expires_at}))
    }
    fn get(&self, id: &str, op: &str, c: &Context) -> Result<Session> {
        let mut s = self
            .sessions
            .get(id)?
            .ok_or_else(|| Error::new(404, "NOT_FOUND", "Upload session was not found"))?;
        self.authorize(op, Some(&s), c)?;
        if s.state == "expired" {
            return Err(Error::new(410, "EXPIRED", "Session expired"));
        };
        if s.expires_at <= now() && s.state != "completed" && s.state != "canceled" {
            if s.state == "finalizing" {
                self.reconcile(&mut s, c)?;
                if s.state == "completed" {
                    return Ok(s);
                }
            }
            self.storage.abort(&s, c)?;
            s.state = "expired".into();
            self.sessions.save(&s)?;
            (self.options.notify)("expired", &s, None, c);
            return Err(Error::new(410, "EXPIRED", "Session expired"));
        };
        Ok(s)
    }
    fn reconcile(&self, s: &mut Session, c: &Context) -> Result<()> {
        if s.state == "completed" || s.state == "canceled" {
            return Ok(());
        }
        if let Some(result) = self.storage.inspect(s, c)? {
            s.state = "completed".into();
            s.result = result;
        } else {
            let mut parts = self.storage.probe(s, c)?;
            parts.sort_by_key(|p| p.index);
            let mut seen = std::collections::HashSet::new();
            for p in &parts {
                if p.index >= count(&s.descriptor)
                    || !seen.insert(p.index)
                    || p.size
                        != s.descriptor
                            .chunk_size
                            .min(s.descriptor.size - p.index as u64 * s.descriptor.chunk_size)
                {
                    return Err(Error::new(
                        500,
                        "STORAGE_CHECKPOINT",
                        "Storage returned an invalid part",
                    ));
                }
            }
            s.parts = parts;
        }
        self.sessions.save(s)
    }
    pub fn get_upload(&self, id: &str, c: &Context) -> Result<Value> {
        let _lease = self.sessions.lock(id, c)?;
        let mut s = self.get(id, "probe", c)?;
        self.reconcile(&mut s, c)?;
        let parts: Vec<Value> = s
            .parts
            .iter()
            .map(|p| json!({"index":p.index,"size":p.size,"sha256":p.sha256}))
            .collect();
        let mut result = json!({"status":s.state,"parts":parts,"expiresAt":s.expires_at});
        if s.state == "completed" {
            result["result"] = s.result
        };
        Ok(result)
    }
    /// Holds the session lock only to check and to record. The body streams outside it, under a
    /// lock of its own per chunk number taken from the same store (key `<id>-part-<index>`), so
    /// chunks of one upload arrive side by side and a slow one blocks nobody.
    pub fn receive_part(
        &self,
        id: &str,
        index: usize,
        sha256: &str,
        body: &mut dyn Read,
        c: &Context,
    ) -> Result<Value> {
        let (session, p, existing) = self.plan_part(id, index, sha256, c)?;
        if let Some(old) = existing {
            return verify_part(&old, &p, body, c);
        }
        let _chunk = self.sessions.lock(&chunk_lock(id, index), c)?;
        // another request may have stored this chunk number while this one waited
        if let Some(current) = self.sessions.get(id)? {
            if let Some(old) = current.parts.iter().find(|part| part.index == index) {
                return verify_part(old, &p, body, c);
            }
        }
        let saved = self.storage.write_part(&session, &p, body, c)?;
        if saved.index != index || saved.size != p.size || saved.sha256 != p.sha256 {
            return Err(Error::new(
                500,
                "STORAGE_RECEIPT",
                "Storage returned an invalid receipt",
            ));
        }
        self.record_part(id, &saved, c)?;
        Ok(json!({"index":saved.index,"size":saved.size,"sha256":saved.sha256}))
    }
    /// Validates the request under the session lock. The last value is the recorded chunk with
    /// this number, if there is one.
    fn plan_part(
        &self,
        id: &str,
        index: usize,
        sha256: &str,
        c: &Context,
    ) -> Result<(Session, Part, Option<Part>)> {
        let _lease = self.sessions.lock(id, c)?;
        let s = self.get(id, "part", c)?;
        if s.state != "open" {
            return Err(Error::new(409, "STATE", "Upload does not accept chunks"));
        };
        if index >= count(&s.descriptor)
            || sha256.len() != 64
            || !sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::new(400, "PART", "Invalid chunk or checksum"));
        };
        let p = Part {
            index,
            size: s
                .descriptor
                .chunk_size
                .min(s.descriptor.size - index as u64 * s.descriptor.chunk_size),
            sha256: sha256.into(),
            reference: Value::Null,
        };
        let existing = s.parts.iter().find(|part| part.index == index).cloned();
        Ok((s, p, existing))
    }
    /// Stores a written chunk in the session under the session lock. The session is read again:
    /// it may have been canceled or expired while the body streamed, and other chunks may have
    /// been recorded meanwhile.
    fn record_part(&self, id: &str, saved: &Part, c: &Context) -> Result<()> {
        let _lease = self.sessions.lock(id, c)?;
        let mut s = self.get(id, "part", c)?;
        if s.state != "open" {
            return Err(Error::new(409, "STATE", "Upload does not accept chunks"));
        };
        if s.parts.iter().any(|part| part.index == saved.index) {
            return Ok(());
        }
        s.parts.push(saved.clone());
        s.parts.sort_by_key(|part| part.index);
        // progress keeps a long upload alive: the TTL counts inactivity
        s.expires_at = s.expires_at.max(now() + self.options.ttl_ms);
        self.sessions.save(&s)?;
        (self.options.notify)("part-stored", &s, Some(saved), c);
        Ok(())
    }
    pub fn finish_upload(&self, id: &str, c: &Context) -> Result<Value> {
        let _lease = self.sessions.lock(id, c)?;
        let mut s = self.get(id, "complete", c)?;
        self.reconcile(&mut s, c)?;
        if s.state == "completed" {
            return Ok(s.result);
        };
        if s.state == "canceled" {
            return Err(Error::new(409, "CANCELED", "Upload was canceled"));
        };
        if s.parts.len() != count(&s.descriptor)
            || s.parts.iter().enumerate().any(|(i, p)| p.index != i)
        {
            return Err(Error::new(409, "INCOMPLETE", "Upload is missing chunks"));
        };
        s.state = "finalizing".into();
        self.sessions.save(&s)?;
        s.result = match self.storage.finish(&s, &s.parts, c) {
            Ok(result) => result,
            Err(error) => self.storage.inspect(&s, c)?.ok_or(error)?,
        };
        s.state = "completed".into();
        self.sessions.save(&s)?;
        (self.options.notify)("completed", &s, None, c);
        Ok(s.result)
    }
    pub fn cancel_upload(&self, id: &str, c: &Context) -> Result<Value> {
        let _lease = self.sessions.lock(id, c)?;
        let mut s = self.get(id, "cancel", c)?;
        self.reconcile(&mut s, c)?;
        if s.state == "completed" {
            return Err(Error::new(
                409,
                "COMPLETED",
                "Remove completed files through the application",
            ));
        };
        self.storage.abort(&s, c)?;
        s.state = "canceled".into();
        s.parts.clear();
        self.sessions.save(&s)?;
        (self.options.notify)("canceled", &s, None, c);
        Ok(Value::Null)
    }
}
