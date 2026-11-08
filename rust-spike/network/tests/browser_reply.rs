use axum::{
    body::{to_bytes, Body},
    http::header,
    response::Response,
};
use moss_network::web::browser_auth_response;

#[tokio::test]
async fn session_token_is_only_in_the_http_only_cookie() {
    let response = Response::builder().header(header::SET_COOKIE, "__Secure-better-auth.session_token=sentinel-session; Secure; HttpOnly; SameSite=Lax")
        .body(Body::from(r#"{"token":"sentinel-session","user":{"id":"one","email":"owner@example.com","password":"sentinel-password","token":"sentinel-session"}}"#)).unwrap();
    let response = browser_auth_response(response).await;
    assert!(response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .contains("HttpOnly"));
    let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(!body.contains("sentinel"));
    assert!(!body.contains("token"));
    assert!(body.contains("owner@example.com"));
}
