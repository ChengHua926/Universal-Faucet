use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareOutcome {
    Accepted { hashes: u64 },
    Rejected,
    Invalid,
}

#[derive(Debug, Clone, Default)]
pub struct GateStats {
    inner: Arc<Mutex<BTreeMap<String, WorkerStats>>>,
}

impl GateStats {
    pub fn record_login(&self, worker_name: &str, ip: &str) {
        let mut workers = self.inner.lock().expect("gate stats mutex poisoned");
        let worker = workers
            .entry(worker_name.to_string())
            .or_insert_with(|| WorkerStats::new(worker_name, ip));
        worker.ip = ip.to_string();
        worker.connections = worker.connections.saturating_add(1);
    }

    pub fn record_disconnect(&self, worker_name: &str) {
        let mut workers = self.inner.lock().expect("gate stats mutex poisoned");
        if let Some(worker) = workers.get_mut(worker_name) {
            worker.connections = worker.connections.saturating_sub(1);
        }
    }

    pub fn record_share(&self, worker_name: &str, outcome: ShareOutcome, now_ms: u64) {
        let mut workers = self.inner.lock().expect("gate stats mutex poisoned");
        let worker = workers
            .entry(worker_name.to_string())
            .or_insert_with(|| WorkerStats::new(worker_name, "unknown"));

        match outcome {
            ShareOutcome::Accepted { hashes } => {
                worker.accepted = worker.accepted.saturating_add(1);
                worker.hashes = worker.hashes.saturating_add(hashes);
            }
            ShareOutcome::Rejected => {
                worker.rejected = worker.rejected.saturating_add(1);
            }
            ShareOutcome::Invalid => {
                worker.invalid = worker.invalid.saturating_add(1);
            }
        }

        worker.last_share_timestamp_ms = now_ms;
    }

    pub fn workers_response(&self) -> Value {
        let workers = self.inner.lock().expect("gate stats mutex poisoned");
        let rows: Vec<Value> = workers
            .values()
            .map(|worker| {
                json!([
                    worker.name,
                    worker.ip,
                    worker.connections,
                    worker.accepted,
                    worker.rejected,
                    worker.invalid,
                    worker.hashes,
                    worker.last_share_timestamp_ms,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0
                ])
            })
            .collect();

        json!({
            "hashrate": {
                "total": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
            },
            "mode": "rig_id",
            "workers": rows
        })
    }
}

#[derive(Debug, Clone)]
struct WorkerStats {
    name: String,
    ip: String,
    connections: u64,
    accepted: u64,
    rejected: u64,
    invalid: u64,
    hashes: u64,
    last_share_timestamp_ms: u64,
}

impl WorkerStats {
    fn new(worker_name: &str, ip: &str) -> Self {
        Self {
            name: worker_name.to_string(),
            ip: ip.to_string(),
            connections: 0,
            accepted: 0,
            rejected: 0,
            invalid: 0,
            hashes: 0,
            last_share_timestamp_ms: 0,
        }
    }
}
