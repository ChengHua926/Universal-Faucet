use serde_json::{json, Value};
use thiserror::Error;

use crate::shares::ShareSubmit;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginMessage {
    pub worker_name: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobMessage {
    pub job_id: String,
    pub height: u64,
    pub blob: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StratumMessageError {
    #[error("missing params object")]
    MissingParams,
    #[error("missing params.pass")]
    MissingPassword,
}

pub fn parse_json_line(line: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(line.trim_end())
}

pub fn serialize_json_line(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("serialize JSON value");
    bytes.push(b'\n');
    bytes
}

pub fn extract_login(value: &Value) -> Option<LoginMessage> {
    if value.get("method")?.as_str()? != "login" {
        return None;
    }

    let params = value.get("params")?;
    Some(LoginMessage {
        worker_name: params.get("login")?.as_str()?.to_string(),
        password: params.get("pass")?.as_str()?.to_string(),
    })
}

pub fn rewrite_login_password(
    value: &mut Value,
    upstream_password: &str,
) -> Result<(), StratumMessageError> {
    let params = value
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .ok_or(StratumMessageError::MissingParams)?;

    if !params.contains_key("pass") {
        return Err(StratumMessageError::MissingPassword);
    }

    params.insert(
        "pass".to_string(),
        Value::String(upstream_password.to_string()),
    );
    Ok(())
}

pub fn extract_submit(value: &Value) -> Option<ShareSubmit> {
    if value.get("method")?.as_str()? != "submit" {
        return None;
    }

    let params = value.get("params")?;
    Some(ShareSubmit {
        job_id: params.get("job_id")?.as_str()?.to_string(),
        nonce: params.get("nonce")?.as_str()?.to_string(),
        result: params.get("result")?.as_str()?.to_string(),
        algorithm: optional_string(params, "algo"),
        signature: optional_string(params, "sig"),
        commitment: optional_string(params, "commitment"),
    })
}

pub fn extract_job(value: &Value) -> Option<JobMessage> {
    if value.get("method").and_then(Value::as_str) == Some("job") {
        return job_from(value.get("params")?);
    }

    let result = value.get("result")?;
    job_from(result.get("job")?)
}

pub fn request_id(value: &Value) -> Value {
    value.get("id").cloned().unwrap_or(Value::Null)
}

pub fn request_id_key(value: &Value) -> Option<String> {
    let id = value.get("id")?;
    if id.is_null() {
        return None;
    }

    Some(serde_json::to_string(id).expect("serialize request id"))
}

pub fn response_result(value: &Value) -> Option<ResponseResult> {
    let _id = value.get("id")?;
    if !value.get("error").unwrap_or(&Value::Null).is_null() {
        return Some(ResponseResult::Rejected);
    }

    if value.get("result").is_some() {
        return Some(ResponseResult::Accepted);
    }

    None
}

pub fn error_response(id: &Value, message: &str) -> Value {
    json!({
        "id": id,
        "jsonrpc": "2.0",
        "error": {
            "code": -1,
            "message": message
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseResult {
    Accepted,
    Rejected,
}

fn job_from(value: &Value) -> Option<JobMessage> {
    Some(JobMessage {
        job_id: value.get("job_id")?.as_str()?.to_string(),
        height: value.get("height")?.as_u64()?,
        blob: value.get("blob")?.as_str()?.to_string(),
    })
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
