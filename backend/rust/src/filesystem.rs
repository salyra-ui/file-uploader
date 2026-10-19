use crate::*;
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::Duration,
};
static TEMPORARY: AtomicU64 = AtomicU64::new(0);
/// A temporary file name no other thread or process uses: chunks of one upload write side by side.
fn unique() -> String {
    format!(
        "{}-{}-{}",
        now(),
        std::process::id(),
        TEMPORARY.fetch_add(1, Ordering::Relaxed)
    )
}
fn safe(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err(Error::new(400, "ID", "Invalid upload identifier"))
    } else {
        Ok(())
    }
}
fn atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", unique()));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    let result = (|| {
        output.write_all(&serde_json::to_vec(value)?)?;
        output.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
struct DiskLease(File);
impl Lease for DiskLease {}
impl Drop for DiskLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
pub struct DiskSessions {
    pub directory: PathBuf,
}
impl SessionStore for DiskSessions {
    fn lock(&self, id: &str, c: &Context) -> Result<Box<dyn Lease>> {
        safe(id)?;
        fs::create_dir_all(&self.directory)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(self.directory.join(format!("{id}.lock")))?;
        loop {
            c.check()?;
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(Box::new(DiskLease(file))),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    fn get(&self, id: &str) -> Result<Option<Session>> {
        safe(id)?;
        match fs::read(self.directory.join(format!("{id}.json"))) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn save(&self, s: &Session) -> Result<()> {
        safe(&s.id)?;
        atomic(&self.directory.join(format!("{}.json", s.id)), s)?;
        // Nothing is received for a finished upload any more: its chunk locks can go. A chunk
        // request still streaming is refused at its record.
        if matches!(s.state.as_str(), "completed" | "canceled" | "expired")
            && s.descriptor.chunk_size > 0
        {
            for index in 0..count(&s.descriptor) {
                let _ = fs::remove_file(
                    self.directory
                        .join(format!("{}.lock", chunk_lock(&s.id, index))),
                );
            }
        }
        Ok(())
    }
}
pub struct DiskStorage {
    pub directory: PathBuf,
}
fn measure(path: &Path, index: usize, c: &Context) -> Result<Part> {
    let mut input = File::open(path)?;
    let mut buffer = [0u8; 65536];
    let mut hash = Sha256::new();
    let mut size = 0;
    loop {
        c.check()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    Ok(Part {
        index,
        size,
        sha256: format!("{:x}", hash.finalize()),
        reference: json!({"version":1,"index":index}),
    })
}
impl DiskStorage {
    fn parts(&self, s: &Session) -> PathBuf {
        self.directory.join("parts").join(&s.id)
    }
    fn result(&self, s: &Session) -> PathBuf {
        self.directory.join("files").join(&s.id)
    }
}
impl Storage for DiskStorage {
    fn begin(&self, s: &Session, _: &Context) -> Result<Value> {
        safe(&s.id)?;
        fs::create_dir_all(self.parts(s))?;
        Ok(json!({"version":1,"id":s.id}))
    }
    fn write_part(&self, s: &Session, p: &Part, body: &mut dyn Read, c: &Context) -> Result<Part> {
        let path = self.parts(s).join(p.index.to_string());
        if path.exists() {
            let old = measure(&path, p.index, c)?;
            if old.sha256 != p.sha256 || old.size != p.size {
                return Err(Error::new(
                    409,
                    "PART_CONFLICT",
                    "Chunk contains different data",
                ));
            }
        }
        let temp = self
            .parts(s)
            .join(format!(".part-{}-{}.tmp", p.index, unique()));
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        let result = (|| {
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
                output.write_all(&buffer[..read])?;
            }
            if size != p.size || format!("{:x}", hash.finalize()) != p.sha256 {
                return Err(Error::new(422, "CHECKSUM", "Chunk checksum does not match"));
            }
            output.sync_all()?;
            drop(output);
            fs::rename(&temp, &path)?;
            let mut saved = p.clone();
            saved.reference = json!({"version":1,"index":p.index});
            atomic(&path.with_extension("receipt.json"), &saved)?;
            Ok(saved)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    fn probe(&self, s: &Session, c: &Context) -> Result<Vec<Part>> {
        let mut parts = vec![];
        let entries = match fs::read_dir(self.parts(s)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(parts),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            if let Some(index) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<usize>().ok())
            {
                let path = entry.path();
                let receipt = path.with_extension("receipt.json");
                let p: Part = if receipt.exists() {
                    serde_json::from_slice(&fs::read(receipt)?)?
                } else {
                    let part = measure(&path, index, c)?;
                    atomic(&receipt, &part)?;
                    part
                };
                if p.size != entry.metadata()?.len() {
                    return Err(Error::new(
                        500,
                        "STORAGE_CHECKPOINT",
                        "Stored chunk changed",
                    ));
                }
                parts.push(p)
            }
        }
        parts.sort_by_key(|p| p.index);
        Ok(parts)
    }
    fn inspect(&self, s: &Session, c: &Context) -> Result<Option<Value>> {
        if !self.result(s).exists() {
            return Ok(None);
        }
        let p = measure(&self.result(s), 0, c)?;
        if p.size != s.descriptor.size {
            return Err(Error::new(
                500,
                "RESULT_SIZE",
                "Completed file size does not match",
            ));
        }
        Ok(Some(json!({"id":s.id,"size":p.size,"sha256":p.sha256})))
    }
    fn finish(&self, s: &Session, parts: &[Part], c: &Context) -> Result<Value> {
        if let Some(result) = self.inspect(s, c)? {
            return Ok(result);
        }
        let target = self.result(s);
        fs::create_dir_all(target.parent().unwrap())?;
        let temp = target.with_extension(format!("{}.tmp", unique()));
        let mut out = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        let result = (|| {
            let mut hash = Sha256::new();
            let mut total = 0u64;
            let mut buffer = [0u8; 65536];
            for p in parts {
                let mut input = File::open(self.parts(s).join(p.index.to_string()))?;
                let mut part_hash = Sha256::new();
                let mut size = 0u64;
                loop {
                    c.check()?;
                    let read = input.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    hash.update(&buffer[..read]);
                    part_hash.update(&buffer[..read]);
                    size += read as u64;
                    out.write_all(&buffer[..read])?;
                }
                if size != p.size || format!("{:x}", part_hash.finalize()) != p.sha256 {
                    return Err(Error::new(422, "CHECKSUM", "Saved chunk changed"));
                }
                total += size;
            }
            if total != s.descriptor.size {
                return Err(Error::new(422, "SIZE", "Assembled size does not match"));
            }
            out.sync_all()?;
            drop(out);
            fs::rename(&temp, &target)?;
            fs::remove_dir_all(self.parts(s))?;
            Ok(json!({"id":s.id,"size":total,"sha256":format!("{:x}",hash.finalize())}))
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    fn abort(&self, s: &Session, _: &Context) -> Result<()> {
        match fs::remove_dir_all(self.parts(s)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}
