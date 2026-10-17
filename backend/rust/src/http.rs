use crate::*;
use tiny_http::{Header, Request, Response};
pub struct Route {
    pub operation: String,
    pub id: String,
    pub index: usize,
}
pub fn default_route(request: &Request, base: &str) -> Option<Route> {
    let path = request.url().split('?').next()?.strip_prefix(base)?;
    let method = request.method().as_str();
    if path.is_empty() && method == "POST" {
        return Some(Route {
            operation: "create".into(),
            id: String::new(),
            index: 0,
        });
    }
    let segments: Vec<_> = path.strip_prefix('/')?.split('/').collect();
    let op = match (segments.len(), method) {
        (1, "GET") => "probe",
        (1, "DELETE") => "cancel",
        (2, "POST") if segments[1] == "complete" => "complete",
        (3, "PUT") if segments[1] == "parts" => "part",
        _ => return None,
    };
    Some(Route {
        operation: op.into(),
        id: segments[0].into(),
        index: if op == "part" {
            segments[2].parse().ok()?
        } else {
            0
        },
    })
}
// Custom routers construct Route and call handle with their own application Context.
pub fn handle(engine: &Engine, mut request: Request, route: Route, context: Context) {
    let result = (|| {
        let header = |name: &'static str| {
            request
                .headers()
                .iter()
                .find(|h| h.field.equiv(name))
                .map(|h| h.value.to_string())
                .unwrap_or_default()
        };
        match route.operation.as_str() {
            "create" => {
                // a cross-site form can post text/plain without a CORS preflight, not this type
                let media = header("Content-Type");
                if !media
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
                {
                    return Err(Error::new(
                        415,
                        "CONTENT_TYPE",
                        "Upload metadata must be sent as application/json",
                    ));
                }
                let key = header("Idempotency-Key");
                let mut bytes = vec![];
                request.as_reader().take(65537).read_to_end(&mut bytes)?;
                if bytes.len() > 65536 {
                    return Err(Error::new(413, "JSON_SIZE", "Upload metadata is too large"));
                }
                engine.create_upload(serde_json::from_slice(&bytes)?, &key, &context)
            }
            "probe" => engine.get_upload(&route.id, &context),
            "part" => {
                let checksum = header("Upload-Checksum");
                engine.receive_part(
                    &route.id,
                    route.index,
                    &checksum,
                    request.as_reader(),
                    &context,
                )
            }
            "complete" => engine.finish_upload(&route.id, &context),
            "cancel" => engine.cancel_upload(&route.id, &context),
            _ => Err(Error::new(404, "NOT_FOUND", "Route was not found")),
        }
    })();
    let (status, value) = match result {
        Ok(value) => (200, value),
        Err(error) => (
            error.status,
            json!({"code":error.code,"message":if error.status==500{"Upload operation failed".to_string()}else{error.message}}),
        ),
    };
    let response = Response::from_string(value.to_string())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
    let _ = request.respond(response);
}
