//! TCP→WebSocket proxy so noVNC in the webview can reach a sandbox's VNC port (replaces websockify).
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

/// The app's own webview origins (macOS/Linux, Windows, `tauri dev`). Any other page, such as a website in
/// the user's browser probing local ports, is refused.
const ALLOWED_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"];

/// WebSocket handshake that only accepts the app's own webview.
pub async fn accept<S: AsyncRead + AsyncWrite + Unpin>(stream: S) -> Result<WebSocketStream<S>, String> {
    // The callback signature is fixed by tungstenite.
    #[allow(clippy::result_large_err)]
    let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = request.headers().get("origin").and_then(|o| o.to_str().ok());
        if origin.is_some_and(|o| ALLOWED_ORIGINS.contains(&o)) {
            Ok(response)
        } else {
            let mut refused = ErrorResponse::new(Some("origin not allowed".into()));
            *refused.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
            Err(refused)
        }
    };
    tokio_tungstenite::accept_hdr_async(stream, check).await.map_err(|e| e.to_string())
}

/// Relay bytes both ways until either side closes.
pub async fn relay<T, W>(tcp: T, ws: WebSocketStream<W>)
where
    T: AsyncRead + AsyncWrite + Unpin,
    W: AsyncRead + AsyncWrite + Unpin,
{
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
    let (mut ws_write, mut ws_read) = ws.split();
    let to_tcp = async {
        while let Some(Ok(message)) = ws_read.next().await {
            let bytes = match message {
                Message::Binary(b) => b.to_vec(),
                Message::Text(t) => t.as_bytes().to_vec(),
                Message::Close(_) => break,
                _ => continue,
            };
            if tcp_write.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = tcp_write.shutdown().await;
    };
    let to_ws = async {
        let mut buf = vec![0u8; 64 * 1024];
        while let Ok(n @ 1..) = tcp_read.read(&mut buf).await {
            if ws_write.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                return;
            }
        }
        let _ = ws_write.close().await;
    };
    tokio::select! { _ = to_tcp => {}, _ = to_ws => {} }
}

/// Listen on an ephemeral 127.0.0.1 port and proxy each WebSocket client to `target`. Returns the port.
pub async fn serve(target: SocketAddr) -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (Ok(ws), Ok(tcp)) = (accept(client).await, TcpStream::connect(target).await)
                else {
                    return;
                };
                relay(tcp, ws).await;
            });
        }
    });
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;
    use tokio_tungstenite::tungstenite::protocol::Role;

    /// (proxy task, the "VNC server" end of the TCP side, the browser end of the WebSocket side)
    async fn setup() -> (tokio::task::JoinHandle<()>, tokio::io::DuplexStream, WebSocketStream<tokio::io::DuplexStream>)
    {
        let (tcp_proxy_end, tcp_server_end) = duplex(1024);
        let (ws_proxy_end, ws_browser_end) = duplex(1024);
        let proxy_ws = WebSocketStream::from_raw_socket(ws_proxy_end, Role::Server, None).await;
        let browser = WebSocketStream::from_raw_socket(ws_browser_end, Role::Client, None).await;
        (tokio::spawn(relay(tcp_proxy_end, proxy_ws)), tcp_server_end, browser)
    }

    #[tokio::test]
    async fn relays_both_ways_and_closes_when_the_tcp_side_closes() {
        let (task, mut server, mut browser) = setup().await;
        browser.send(Message::Binary(b"hello vnc".to_vec().into())).await.unwrap();
        let mut buf = [0u8; 9];
        server.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello vnc");

        server.write_all(b"frame").await.unwrap();
        assert_eq!(browser.next().await.unwrap().unwrap(), Message::Binary(b"frame".to_vec().into()));

        drop(server);
        // The browser sees the close (a Close frame and/or end of stream), and the relay ends.
        while let Some(Ok(msg)) = browser.next().await {
            assert!(msg.is_close(), "unexpected {msg:?}");
        }
        task.await.unwrap();
    }

    #[tokio::test]
    async fn only_the_app_webview_may_connect() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        for (origin, allowed) in [("tauri://localhost", true), ("https://evil.example", false), ("", false)] {
            let (server, client) = duplex(4096);
            let mut request = "ws://127.0.0.1/".into_client_request().unwrap();
            if !origin.is_empty() {
                request.headers_mut().insert("origin", origin.parse().unwrap());
            }
            let (accepted, connected) = tokio::join!(accept(server), tokio_tungstenite::client_async(request, client));
            assert_eq!((accepted.is_ok(), connected.is_ok()), (allowed, allowed), "{origin:?}");
        }
    }

    #[tokio::test]
    async fn closes_the_tcp_side_when_the_websocket_closes() {
        let (task, mut server, mut browser) = setup().await;
        browser.close(None).await.unwrap();
        let mut rest = Vec::new();
        server.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        task.await.unwrap();
    }
}
