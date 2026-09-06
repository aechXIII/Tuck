use std::collections::BTreeSet;
use std::fmt::{Display, Formatter};

use serde::Serialize;
use serde_json::{json, Map, Value};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PublicBackendError {
    pub code: String,
    pub message: String,
    pub details: Map<String, Value>,
}

impl PublicBackendError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Map::new(),
        }
    }

    pub fn with_details(mut self, details: Map<String, Value>) -> Self {
        self.details = details;
        self
    }
}

impl Display for PublicBackendError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PublicBackendError {}

#[derive(Debug)]
pub enum BackendFrame {
    Ready {
        backend_version: String,
    },
    Fatal(PublicBackendError),
    Response {
        request_id: String,
        result: Result<Value, PublicBackendError>,
    },
}

pub fn parse_stdout_frame(line: &str) -> Result<BackendFrame, PublicBackendError> {
    let value: Value = serde_json::from_str(line).map_err(|_| {
        PublicBackendError::new(
            "MALFORMED_BACKEND_OUTPUT",
            "The backend emitted invalid protocol output.",
        )
    })?;
    let frame = value.as_object().ok_or_else(invalid_frame)?;
    require_fields(frame, ["kind", "protocol"])?;
    require_protocol(frame)?;

    match string_field(frame, "kind")? {
        "event" => parse_event(frame),
        "response" => parse_response(frame),
        _ => Err(invalid_frame()),
    }
}

pub fn request_frame(
    request_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, PublicBackendError> {
    if request_id.is_empty() || !params.is_object() {
        return Err(PublicBackendError::new(
            "INVALID_BACKEND_REQUEST",
            "The desktop shell could not serialize the backend request.",
        ));
    }
    Ok(json!({
        "kind": "request",
        "protocol": PROTOCOL_VERSION,
        "id": request_id,
        "method": method,
        "params": params,
    }))
}

fn parse_event(frame: &Map<String, Value>) -> Result<BackendFrame, PublicBackendError> {
    require_exact_fields(frame, ["kind", "protocol", "event", "payload"])?;
    let payload = object_field(frame, "payload")?;
    match string_field(frame, "event")? {
        "backend_ready" => Ok(BackendFrame::Ready {
            backend_version: string_field(payload, "backend_version")?.to_owned(),
        }),
        "backend_fatal" => Ok(BackendFrame::Fatal(error_from_fatal_payload(payload)?)),
        _ => Err(invalid_frame()),
    }
}

fn parse_response(frame: &Map<String, Value>) -> Result<BackendFrame, PublicBackendError> {
    let request_id = string_field(frame, "id")?;
    if request_id.is_empty() {
        return Err(invalid_frame());
    }
    let ok = frame
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_frame)?;
    if ok {
        require_exact_fields(frame, ["kind", "protocol", "id", "ok", "result"])?;
        let result = frame.get("result").cloned().ok_or_else(invalid_frame)?;
        Ok(BackendFrame::Response {
            request_id: request_id.to_owned(),
            result: Ok(result),
        })
    } else {
        require_exact_fields(frame, ["kind", "protocol", "id", "ok", "error"])?;
        Ok(BackendFrame::Response {
            request_id: request_id.to_owned(),
            result: Err(error_from_object(object_field(frame, "error")?)?),
        })
    }
}

fn error_from_object(value: &Map<String, Value>) -> Result<PublicBackendError, PublicBackendError> {
    require_exact_fields(value, ["code", "message", "details"])?;
    Ok(PublicBackendError {
        code: string_field(value, "code")?.to_owned(),
        message: string_field(value, "message")?.to_owned(),
        details: object_field(value, "details")?.clone(),
    })
}

fn error_from_fatal_payload(
    value: &Map<String, Value>,
) -> Result<PublicBackendError, PublicBackendError> {
    // The Python sidecar's fatal event predates response errors and omits
    // details. Keep that wire format compatible while retaining strict
    // validation for ordinary response errors.
    let expected: BTreeSet<&str> = ["code", "message", "details"].into_iter().collect();
    let legacy: BTreeSet<&str> = ["code", "message"].into_iter().collect();
    let actual: BTreeSet<&str> = value.keys().map(String::as_str).collect();
    if actual != expected && actual != legacy {
        return Err(invalid_frame());
    }
    Ok(PublicBackendError {
        code: string_field(value, "code")?.to_owned(),
        message: string_field(value, "message")?.to_owned(),
        details: match value.get("details") {
            Some(_) => object_field(value, "details")?.clone(),
            None => Map::new(),
        },
    })
}

fn require_protocol(frame: &Map<String, Value>) -> Result<(), PublicBackendError> {
    if frame.get("protocol").and_then(Value::as_u64) == Some(PROTOCOL_VERSION) {
        Ok(())
    } else {
        Err(PublicBackendError::new(
            "BACKEND_PROTOCOL_MISMATCH",
            "The backend protocol version is not supported.",
        ))
    }
}

fn require_fields<const N: usize>(
    object: &Map<String, Value>,
    required: [&str; N],
) -> Result<(), PublicBackendError> {
    if required.iter().all(|field| object.contains_key(*field)) {
        Ok(())
    } else {
        Err(invalid_frame())
    }
}

fn require_exact_fields<const N: usize>(
    object: &Map<String, Value>,
    expected: [&str; N],
) -> Result<(), PublicBackendError> {
    let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = expected.into_iter().collect();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid_frame())
    }
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, PublicBackendError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(invalid_frame)
}

fn object_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, PublicBackendError> {
    object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(invalid_frame)
}

fn invalid_frame() -> PublicBackendError {
    PublicBackendError::new(
        "MALFORMED_BACKEND_OUTPUT",
        "The backend emitted an invalid protocol frame.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_sidecars_legacy_fatal_event_without_details() {
        let frame = parse_stdout_frame(
            r#"{"kind":"event","protocol":1,"event":"backend_fatal","payload":{"code":"INTERNAL_ERROR","message":"The backend could not start."}}"#,
        )
        .expect("legacy fatal event is part of the sidecar protocol");

        assert!(matches!(
            frame,
            BackendFrame::Fatal(PublicBackendError { ref code, ref details, .. })
                if code == "INTERNAL_ERROR" && details.is_empty()
        ));
    }
}
