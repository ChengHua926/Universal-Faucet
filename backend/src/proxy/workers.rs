use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq)]
pub struct ProxyWorker {
    pub name: String,
    pub address: String,
    pub connections: u64,
    pub accepted_shares: u64,
    pub rejected_shares: u64,
    pub invalid_shares: u64,
    pub total_hashes: u64,
    pub last_share_timestamp_ms: Option<u64>,
    pub hashrates: Vec<f64>,
    pub raw: Value,
}

#[derive(Debug, Error, PartialEq)]
pub enum ProxyWorkersError {
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
    #[error("missing workers array")]
    MissingWorkers,
    #[error("worker row {row} has too few fields: expected at least {expected}, got {actual}")]
    TooFewFields {
        row: usize,
        expected: usize,
        actual: usize,
    },
    #[error("worker row {row} field {field} has invalid type; expected {expected}")]
    InvalidField {
        row: usize,
        field: usize,
        expected: &'static str,
    },
}

pub fn parse_workers_response(body: &str) -> Result<Vec<ProxyWorker>, ProxyWorkersError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| ProxyWorkersError::InvalidJson(error.to_string()))?;
    let workers = value
        .get("workers")
        .and_then(Value::as_array)
        .ok_or(ProxyWorkersError::MissingWorkers)?;

    workers
        .iter()
        .enumerate()
        .map(|(row_index, row)| parse_worker_row(row_index, row))
        .collect()
}

fn parse_worker_row(row_index: usize, raw: &Value) -> Result<ProxyWorker, ProxyWorkersError> {
    let fields = raw.as_array().ok_or(ProxyWorkersError::InvalidField {
        row: row_index,
        field: 0,
        expected: "array",
    })?;

    if fields.len() < 8 {
        return Err(ProxyWorkersError::TooFewFields {
            row: row_index,
            expected: 8,
            actual: fields.len(),
        });
    }

    let last_share_timestamp_ms =
        required_u64(row_index, fields, 7)
            .map(|value| if value == 0 { None } else { Some(value) })?;

    Ok(ProxyWorker {
        name: required_string(row_index, fields, 0)?,
        address: required_string(row_index, fields, 1)?,
        connections: required_u64(row_index, fields, 2)?,
        accepted_shares: required_u64(row_index, fields, 3)?,
        rejected_shares: required_u64(row_index, fields, 4)?,
        invalid_shares: required_u64(row_index, fields, 5)?,
        total_hashes: required_u64(row_index, fields, 6)?,
        last_share_timestamp_ms,
        hashrates: parse_hashrates(row_index, fields)?,
        raw: raw.clone(),
    })
}

fn parse_hashrates(row_index: usize, fields: &[Value]) -> Result<Vec<f64>, ProxyWorkersError> {
    fields
        .iter()
        .enumerate()
        .skip(8)
        .map(|(field_index, value)| {
            value.as_f64().ok_or(ProxyWorkersError::InvalidField {
                row: row_index,
                field: field_index,
                expected: "number",
            })
        })
        .collect()
}

fn required_string(
    row_index: usize,
    fields: &[Value],
    field_index: usize,
) -> Result<String, ProxyWorkersError> {
    fields[field_index]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or(ProxyWorkersError::InvalidField {
            row: row_index,
            field: field_index,
            expected: "string",
        })
}

fn required_u64(
    row_index: usize,
    fields: &[Value],
    field_index: usize,
) -> Result<u64, ProxyWorkersError> {
    fields[field_index]
        .as_u64()
        .ok_or(ProxyWorkersError::InvalidField {
            row: row_index,
            field: field_index,
            expected: "unsigned integer",
        })
}
