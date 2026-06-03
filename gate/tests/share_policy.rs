use std::time::{Duration, Instant};

use pretty_assertions::assert_eq;
use xpool_gate::shares::{
    JobRecord, ShareDecision, SharePolicy, ShareSubmit, ShareTracker, StalePolicy,
};

fn job(job_id: &str, height: u64, blob: &str) -> JobRecord {
    JobRecord {
        job_id: job_id.to_string(),
        height,
        blob: blob.to_string(),
        received_at: Instant::now(),
        replaced_at: None,
    }
}

fn submit(job_id: &str, nonce: &str, result: &str) -> ShareSubmit {
    ShareSubmit {
        job_id: job_id.to_string(),
        nonce: nonce.to_string(),
        result: result.to_string(),
        algorithm: Some("rx/0".to_string()),
        signature: None,
        commitment: None,
    }
}

#[test]
fn accepts_first_share_for_current_job() {
    let mut policy = SharePolicy::new(StalePolicy {
        same_height_grace: Duration::from_secs(1),
    });
    policy.set_current_job(job("job-a", 100, "blob-a"));

    let decision = policy.evaluate(&submit("job-a", "00000001", "result-a"), Instant::now());

    assert_eq!(decision, ShareDecision::Accept);
}

#[test]
fn rejects_duplicate_share_on_same_connection() {
    let mut policy = SharePolicy::default();
    policy.set_current_job(job("job-a", 100, "blob-a"));
    let share = submit("job-a", "00000001", "result-a");

    assert_eq!(
        policy.evaluate(&share, Instant::now()),
        ShareDecision::Accept
    );
    assert_eq!(
        policy.evaluate(&share, Instant::now()),
        ShareDecision::Duplicate
    );
}

#[test]
fn rejects_duplicate_share_across_connections() {
    let tracker = ShareTracker::default();
    let mut alice = SharePolicy::with_tracker(StalePolicy::default(), tracker.clone());
    let mut bob = SharePolicy::with_tracker(StalePolicy::default(), tracker);
    alice.set_current_job(job("job-a", 100, "same-blob"));
    bob.set_current_job(job("job-b", 100, "same-blob"));

    assert_eq!(
        alice.evaluate(&submit("job-a", "00000001", "same-result"), Instant::now()),
        ShareDecision::Accept
    );
    assert_eq!(
        bob.evaluate(&submit("job-b", "00000001", "same-result"), Instant::now()),
        ShareDecision::Duplicate
    );
}

#[test]
fn rejects_duplicate_nonce_even_if_claimed_result_changes() {
    let tracker = ShareTracker::default();
    let mut alice = SharePolicy::with_tracker(StalePolicy::default(), tracker.clone());
    let mut bob = SharePolicy::with_tracker(StalePolicy::default(), tracker);
    alice.set_current_job(job("job-a", 100, "same-blob"));
    bob.set_current_job(job("job-b", 100, "same-blob"));

    assert_eq!(
        alice.evaluate(&submit("job-a", "00000001", "result-a"), Instant::now()),
        ShareDecision::Accept
    );
    assert_eq!(
        bob.evaluate(&submit("job-b", "00000001", "result-b"), Instant::now()),
        ShareDecision::Duplicate
    );
}

#[test]
fn rejects_duplicate_for_active_job_after_long_delay() {
    let mut policy = SharePolicy::default();
    let now = Instant::now();
    policy.set_current_job(job("job-a", 100, "blob-a"));
    let share = submit("job-a", "00000001", "result-a");

    assert_eq!(policy.evaluate(&share, now), ShareDecision::Accept);
    assert_eq!(
        policy.evaluate(&share, now + Duration::from_secs(3600)),
        ShareDecision::Duplicate
    );
}

#[test]
fn allows_previous_same_height_job_within_grace_window() {
    let mut policy = SharePolicy::new(StalePolicy {
        same_height_grace: Duration::from_secs(1),
    });
    let now = Instant::now();
    policy.set_current_job(job("job-a", 100, "blob-a"));
    policy.replace_current_job(job("job-b", 100, "blob-b"), now);

    assert_eq!(
        policy.evaluate(
            &submit("job-a", "00000001", "result-a"),
            now + Duration::from_millis(999)
        ),
        ShareDecision::Accept
    );
}

#[test]
fn rejects_previous_same_height_job_after_grace_window() {
    let mut policy = SharePolicy::new(StalePolicy {
        same_height_grace: Duration::from_secs(1),
    });
    let now = Instant::now();
    policy.set_current_job(job("job-a", 100, "blob-a"));
    policy.replace_current_job(job("job-b", 100, "blob-b"), now);

    assert_eq!(
        policy.evaluate(
            &submit("job-a", "00000001", "result-a"),
            now + Duration::from_millis(1001)
        ),
        ShareDecision::Stale
    );
}

#[test]
fn rejects_previous_different_height_job_even_within_grace_window() {
    let mut policy = SharePolicy::default();
    let now = Instant::now();
    policy.set_current_job(job("job-a", 100, "blob-a"));
    policy.replace_current_job(job("job-b", 101, "blob-b"), now);

    assert_eq!(
        policy.evaluate(
            &submit("job-a", "00000001", "result-a"),
            now + Duration::from_millis(10)
        ),
        ShareDecision::Stale
    );
}

#[test]
fn rejects_unknown_job_id() {
    let mut policy = SharePolicy::default();
    policy.set_current_job(job("job-a", 100, "blob-a"));

    assert_eq!(
        policy.evaluate(&submit("job-x", "00000001", "result-a"), Instant::now()),
        ShareDecision::UnknownJob
    );
}
