use std::{cmp::Ordering, fs, path::Path};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Voucher {
    pub user: String,
    pub cumulative_amount: String,
    pub signed_at: i64,
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoucherWrite {
    Stored,
    IgnoredOlder,
}

#[derive(Debug, Error)]
pub enum VoucherError {
    #[error("failed to read voucher {path}: {source}")]
    Read {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
    #[error("failed to write voucher {path}: {source}")]
    Write {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse voucher {path}: {source}")]
    Parse {
        path: std::path::PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to encode voucher: {0}")]
    Encode(serde_json::Error),
}

pub fn load_voucher(path: &Path) -> Result<Voucher, VoucherError> {
    let bytes = fs::read(path).map_err(|source| VoucherError::Read {
        path: path.to_path_buf(),
        source,
    })?;

    serde_json::from_slice(&bytes).map_err(|source| VoucherError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

pub fn save_latest_voucher(path: &Path, voucher: &Voucher) -> Result<VoucherWrite, VoucherError> {
    if let Ok(existing) = load_voucher(path) {
        if compare_decimal_strings(&voucher.cumulative_amount, &existing.cumulative_amount)
            != Ordering::Greater
        {
            return Ok(VoucherWrite::IgnoredOlder);
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| VoucherError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    let body = serde_json::to_vec_pretty(voucher).map_err(VoucherError::Encode)?;
    fs::write(path, body).map_err(|source| VoucherError::Write {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(VoucherWrite::Stored)
}

pub fn compare_decimal_strings(left: &str, right: &str) -> Ordering {
    let left = normalize_decimal(left);
    let right = normalize_decimal(right);

    match left.len().cmp(&right.len()) {
        Ordering::Equal => left.cmp(&right),
        order => order,
    }
}

fn normalize_decimal(value: &str) -> String {
    let trimmed = value.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}
