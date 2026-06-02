use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use pretty_assertions::assert_eq;
use serde_json::Value;
use tower::ServiceExt;
use xpool_backend::http::app;

#[tokio::test]
async fn health_returns_service_status() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body bytes");
    let json: Value = serde_json::from_slice(&body).expect("json body");

    assert_eq!(
        json,
        serde_json::json!({
            "service": "xpool-backend",
            "status": "ok"
        })
    );
}
