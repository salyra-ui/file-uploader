use salyra_upload_server::{
    filesystem::{DiskSessions, DiskStorage},
    Context, Descriptor, Engine, Options,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        mpsc::{channel, Receiver, RecvTimeoutError, Sender},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn directory() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("salyra-rust-{}-{nanos}", std::process::id()))
}
fn engine(root: &PathBuf) -> Arc<Engine> {
    Arc::new(Engine {
        sessions: Arc::new(DiskSessions {
            directory: root.join("sessions"),
        }),
        storage: Arc::new(DiskStorage {
            directory: root.join("storage"),
        }),
        options: Options {
            allow_anonymous: true,
            ..Options::default()
        },
    })
}
fn create(engine: &Engine, size: u64, chunk_size: u64) -> (String, u64) {
    let descriptor = Descriptor {
        protocol: "salyra-upload/1".into(),
        name: "file.txt".into(),
        size,
        r#type: "text/plain".into(),
        last_modified: 0,
        chunk_size,
        metadata: Value::Null,
    };
    let created = engine
        .create_upload(descriptor, "key", &Context::default())
        .unwrap();
    (
        created["id"].as_str().unwrap().into(),
        created["expiresAt"].as_u64().unwrap(),
    )
}
/// A body that gives its bytes as they are sent and stops until more arrive.
struct Gate(Receiver<Vec<u8>>);
impl Read for Gate {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self.0.recv() {
            Ok(bytes) => {
                buffer[..bytes.len()].copy_from_slice(&bytes);
                Ok(bytes.len())
            }
            Err(_) => Ok(0),
        }
    }
}
/// Starts a chunk whose body stops after its first byte. Dropping the sender ends the body.
fn stalled(
    engine: &Arc<Engine>,
    id: &str,
    index: usize,
    text: &'static str,
) -> (JoinHandle<Result<Value, u16>>, Sender<Vec<u8>>) {
    let (sender, receiver) = channel();
    let (engine, id) = (Arc::clone(engine), id.to_string());
    let handle = thread::spawn(move || {
        engine
            .receive_part(
                &id,
                index,
                &digest(text),
                &mut Gate(receiver),
                &Context::default(),
            )
            .map_err(|error| error.status)
    });
    sender.send(text.as_bytes()[..1].to_vec()).unwrap();
    thread::sleep(Duration::from_millis(200));
    (handle, sender)
}
fn lock_files(root: &PathBuf) -> usize {
    std::fs::read_dir(root.join("sessions"))
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("-part-")
        })
        .count()
}

#[test]
fn chunks_arrive_side_by_side() {
    let root = directory();
    let engine = engine(&root);
    let (id, _) = create(&engine, 8, 4);
    let (slow, sender) = stalled(&engine, &id, 0, "abcd");
    let (done, finished) = channel();
    let other = {
        let (engine, id) = (Arc::clone(&engine), id.clone());
        thread::spawn(move || {
            let result = engine.receive_part(
                &id,
                1,
                &digest("efgh"),
                &mut "efgh".as_bytes(),
                &Context::default(),
            );
            done.send(result.is_ok()).unwrap();
        })
    };
    assert_eq!(
        finished.recv_timeout(Duration::from_secs(5)),
        Ok(true),
        "chunk 1 waited for chunk 0 to finish streaming"
    );
    other.join().unwrap();
    sender.send(b"bcd".to_vec()).unwrap();
    drop(sender);
    assert!(slow.join().unwrap().is_ok());
    let result = engine.finish_upload(&id, &Context::default()).unwrap();
    assert_eq!(result["sha256"], digest("abcdefgh"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_same_chunk_has_one_writer() {
    let root = directory();
    let engine = engine(&root);
    let (id, _) = create(&engine, 4, 4);
    let (slow, sender) = stalled(&engine, &id, 0, "abcd");
    let (done, finished) = channel();
    let twin = {
        let (engine, id) = (Arc::clone(&engine), id.clone());
        thread::spawn(move || {
            let result = engine.receive_part(
                &id,
                0,
                &digest("abcd"),
                &mut "abcd".as_bytes(),
                &Context::default(),
            );
            done.send(result.is_ok()).unwrap();
        })
    };
    assert_eq!(
        finished.recv_timeout(Duration::from_millis(300)),
        Err(RecvTimeoutError::Timeout),
        "a second request for a streaming chunk did not wait"
    );
    sender.send(b"bcd".to_vec()).unwrap();
    drop(sender);
    assert!(slow.join().unwrap().is_ok());
    assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok(true));
    twin.join().unwrap();
    let stored = engine.sessions.get(&id).unwrap().unwrap();
    assert_eq!(stored.parts.len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_canceled_upload_refuses_the_chunk_that_was_streaming() {
    let root = directory();
    let engine = engine(&root);
    let (id, _) = create(&engine, 4, 4);
    let (slow, sender) = stalled(&engine, &id, 0, "abcd");
    engine.cancel_upload(&id, &Context::default()).unwrap();
    sender.send(b"bcd".to_vec()).unwrap();
    drop(sender);
    assert!(
        slow.join().unwrap().is_err(),
        "a canceled upload took a chunk"
    );
    let stored = engine.sessions.get(&id).unwrap().unwrap();
    assert_eq!(stored.state, "canceled");
    assert!(stored.parts.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_burst_keeps_every_part_and_renews_the_expiry() {
    let root = directory();
    let engine = engine(&root);
    let chunks = 32;
    let (id, expires) = create(&engine, chunks as u64 * 2, 2);
    thread::sleep(Duration::from_millis(5));
    thread::scope(|scope| {
        for index in 0..chunks {
            let (engine, id) = (&engine, &id);
            scope.spawn(move || {
                let text = format!(
                    "{}{}",
                    (b'a' + index as u8 % 26) as char,
                    (b'A' + index as u8 % 26) as char
                );
                engine
                    .receive_part(
                        id,
                        index,
                        &digest(&text),
                        &mut text.as_bytes(),
                        &Context::default(),
                    )
                    .unwrap();
            });
        }
    });
    // read the record itself: a probe would rebuild it from storage and hide a lost update
    let stored = engine.sessions.get(&id).unwrap().unwrap();
    let indexes: Vec<usize> = stored.parts.iter().map(|part| part.index).collect();
    assert_eq!(indexes, (0..chunks).collect::<Vec<_>>());
    assert!(
        stored.expires_at > expires,
        "stored chunks did not extend the expiry"
    );
    engine.finish_upload(&id, &Context::default()).unwrap();
    assert_eq!(lock_files(&root), 0, "chunk locks left behind");
    std::fs::remove_dir_all(root).unwrap();
}
