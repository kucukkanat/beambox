//! Host port picking. Published ports bind to 127.0.0.1 only.

/// True when nothing on the host listens on `127.0.0.1:port`.
pub fn is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The first port at or after `start` that `free` accepts.
pub fn first_free(start: u16, free: impl Fn(u16) -> bool) -> Option<u16> {
    (start..=u16::MAX).find(|&p| free(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_a_port_that_is_really_in_use() {
        let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = busy.local_addr().unwrap().port();
        assert!(!is_free(port));
        let picked = first_free(port, is_free).unwrap();
        assert!(picked > port);
    }
}
