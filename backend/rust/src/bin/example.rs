use salyra_upload_server::{
    filesystem::{DiskSessions, DiskStorage},
    http::{default_route, handle},
    Context, Engine, Options,
};
use std::{path::PathBuf, sync::Arc};
fn main() {
    let directory = PathBuf::from(std::env::var("UPLOAD_DIRECTORY").unwrap_or(".uploads".into()));
    let host = std::env::var("HOST").unwrap_or("127.0.0.1".into());
    let port = std::env::var("PORT").unwrap_or("4337".into());
    let engine = Engine {
        sessions: Arc::new(DiskSessions {
            directory: directory.join("sessions"),
        }),
        storage: Arc::new(DiskStorage {
            directory: directory.join("storage"),
        }),
        // a local demo: set authorize in an application
        options: Options {
            allow_anonymous: true,
            ..Options::default()
        },
    };
    let server = tiny_http::Server::http(format!("{host}:{port}")).unwrap();
    for request in server.incoming_requests() {
        if let Some(route) = default_route(&request, "/uploads") {
            handle(&engine, request, route, Context::default())
        } else {
            let _ = request.respond(tiny_http::Response::empty(404));
        }
    }
}
