use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRecord {
    pub job_id: String,
    pub height: u64,
    pub blob: String,
    pub received_at: Instant,
    pub replaced_at: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareSubmit {
    pub job_id: String,
    pub nonce: String,
    pub result: String,
    pub algorithm: Option<String>,
    pub signature: Option<String>,
    pub commitment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareDecision {
    Accept,
    Duplicate,
    Stale,
    UnknownJob,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StalePolicy {
    pub same_height_grace: Duration,
}

impl Default for StalePolicy {
    fn default() -> Self {
        Self {
            same_height_grace: Duration::from_secs(1),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ShareTracker {
    inner: Arc<Mutex<ShareTrackerInner>>,
}

impl ShareTracker {
    fn retain_job(&self, job: &JobRecord) {
        let mut inner = self.inner.lock().expect("share tracker mutex poisoned");
        inner.jobs.entry(work_key(job)).or_default().references += 1;
    }

    fn release_job(&self, job: &JobRecord) {
        let mut inner = self.inner.lock().expect("share tracker mutex poisoned");
        let key = work_key(job);
        let Some(entry) = inner.jobs.get_mut(&key) else {
            return;
        };

        if entry.references <= 1 {
            inner.jobs.remove(&key);
        } else {
            entry.references -= 1;
        }
    }

    fn mark_seen(&self, job: &JobRecord, share: &ShareSubmit) -> bool {
        let mut inner = self.inner.lock().expect("share tracker mutex poisoned");
        inner
            .jobs
            .entry(work_key(job))
            .or_default()
            .nonces
            .insert(nonce_key(share))
    }
}

#[derive(Debug, Default)]
struct ShareTrackerInner {
    jobs: HashMap<String, TrackedJob>,
}

#[derive(Debug, Default)]
struct TrackedJob {
    references: usize,
    nonces: HashSet<String>,
}

#[derive(Debug)]
pub struct SharePolicy {
    current: Option<JobRecord>,
    previous: Option<JobRecord>,
    policy: StalePolicy,
    tracker: ShareTracker,
}

impl Default for SharePolicy {
    fn default() -> Self {
        Self::new(StalePolicy::default())
    }
}

impl SharePolicy {
    pub fn new(policy: StalePolicy) -> Self {
        Self::with_tracker(policy, ShareTracker::default())
    }

    pub fn with_tracker(policy: StalePolicy, tracker: ShareTracker) -> Self {
        Self {
            current: None,
            previous: None,
            policy,
            tracker,
        }
    }

    pub fn set_current_job(&mut self, job: JobRecord) {
        self.release_jobs();
        self.tracker.retain_job(&job);
        self.current = Some(job);
        self.previous = None;
    }

    pub fn replace_current_job(&mut self, job: JobRecord, now: Instant) {
        if let Some(previous) = self.previous.take() {
            self.tracker.release_job(&previous);
        }

        self.previous = self.current.take().map(|mut previous| {
            previous.replaced_at = Some(now);
            previous
        });
        self.tracker.retain_job(&job);
        self.current = Some(job);
    }

    pub fn evaluate(&mut self, share: &ShareSubmit, now: Instant) -> ShareDecision {
        let job = match self.find_job(share, now) {
            JobLookup::Current(job) | JobLookup::Previous(job) => job,
            JobLookup::Stale => return ShareDecision::Stale,
            JobLookup::Unknown => return ShareDecision::UnknownJob,
        };

        if self.tracker.mark_seen(job, share) {
            ShareDecision::Accept
        } else {
            ShareDecision::Duplicate
        }
    }

    fn find_job(&self, share: &ShareSubmit, now: Instant) -> JobLookup<'_> {
        if let Some(current) = &self.current {
            if current.job_id == share.job_id {
                return JobLookup::Current(current);
            }
        }

        let Some(previous) = self.previous.as_ref() else {
            return JobLookup::Unknown;
        };
        if previous.job_id != share.job_id {
            return JobLookup::Unknown;
        }

        let Some(current) = self.current.as_ref() else {
            return JobLookup::Stale;
        };
        let Some(replaced_at) = previous.replaced_at else {
            return JobLookup::Stale;
        };
        if previous.height == current.height
            && now.saturating_duration_since(replaced_at) <= self.policy.same_height_grace
        {
            return JobLookup::Previous(previous);
        }

        JobLookup::Stale
    }

    fn release_jobs(&mut self) {
        if let Some(job) = self.current.take() {
            self.tracker.release_job(&job);
        }
        if let Some(job) = self.previous.take() {
            self.tracker.release_job(&job);
        }
    }
}

impl Drop for SharePolicy {
    fn drop(&mut self) {
        self.release_jobs();
    }
}

enum JobLookup<'a> {
    Current(&'a JobRecord),
    Previous(&'a JobRecord),
    Stale,
    Unknown,
}

fn work_key(job: &JobRecord) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, job.height.to_string().as_bytes());
    hash_field(&mut hasher, job.blob.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn nonce_key(share: &ShareSubmit) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, share.nonce.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}
