//! The `SandboxBackend` trait that the GUI and the MCP server both talk to, plus its data types.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Booting,
    Running,
    Stopped,
    Crashed,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Port {
    pub guest: u16,
    pub host: u16,
}

/// A fully resolved sandbox definition: every default is already applied.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Spec {
    pub name: String,
    pub template: String,
    pub image: String,
    pub cpus: u8,
    pub memory_mib: u32,
    /// Host folder mounted at `/workspace`.
    pub mount: Option<String>,
    /// `public` (internet, no host LAN), `none` or `all`.
    pub network: String,
    pub ports: Vec<Port>,
    pub agent: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxInfo {
    pub name: String,
    pub template: String,
    pub status: Status,
    pub cpus: u8,
    pub memory_mib: u32,
    pub agent: Option<String>,
    pub ports: Vec<Port>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DirEntry {
    pub path: String,
    pub dir: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[async_trait]
pub trait SandboxBackend: Send + Sync {
    /// Create and boot a sandbox; returns once it is running.
    async fn create(&self, spec: Spec) -> Result<SandboxInfo>;
    async fn list(&self) -> Result<Vec<SandboxInfo>>;
    async fn start(&self, name: &str) -> Result<()>;
    async fn stop(&self, name: &str) -> Result<()>;
    /// Fork a running sandbox into `child`, which publishes its guest ports on the given host `ports`.
    async fn fork(&self, name: &str, child: &str, ports: &[Port]) -> Result<SandboxInfo>;
    async fn snapshot(&self, name: &str, snapshot: &str) -> Result<()>;
    async fn delete(&self, name: &str) -> Result<()>;
    /// Run `command` through `/bin/sh -c`.
    async fn exec(&self, name: &str, command: &str) -> Result<ExecResult>;
    async fn read_file(&self, name: &str, path: &str) -> Result<Vec<u8>>;
    async fn write_file(&self, name: &str, path: &str, data: Vec<u8>) -> Result<()>;
    async fn list_dir(&self, name: &str, path: &str) -> Result<Vec<DirEntry>>;
    async fn logs(&self, name: &str) -> Result<Vec<String>>;
    async fn metrics(&self, name: &str) -> Result<Metrics>;
}

/// In-memory backend for tests.
#[cfg(test)]
pub mod fake {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeBackend {
        pub sandboxes: Mutex<BTreeMap<String, SandboxInfo>>,
        pub specs: Mutex<Vec<Spec>>,
        pub files: Mutex<BTreeMap<(String, String), Vec<u8>>>,
    }

    impl FakeBackend {
        fn with<T>(&self, name: &str, f: impl FnOnce(&mut SandboxInfo) -> T) -> Result<T> {
            let mut all = self.sandboxes.lock().unwrap();
            all.get_mut(name).map(f).ok_or_else(|| format!("no sandbox named {name}"))
        }
    }

    #[async_trait]
    impl SandboxBackend for FakeBackend {
        async fn create(&self, spec: Spec) -> Result<SandboxInfo> {
            let info = SandboxInfo {
                name: spec.name.clone(),
                template: spec.template.clone(),
                status: Status::Running,
                cpus: spec.cpus,
                memory_mib: spec.memory_mib,
                agent: spec.agent.clone(),
                ports: spec.ports.clone(),
            };
            self.specs.lock().unwrap().push(spec);
            self.sandboxes.lock().unwrap().insert(info.name.clone(), info.clone());
            Ok(info)
        }
        async fn list(&self) -> Result<Vec<SandboxInfo>> {
            Ok(self.sandboxes.lock().unwrap().values().cloned().collect())
        }
        async fn start(&self, name: &str) -> Result<()> {
            self.with(name, |s| s.status = Status::Running)
        }
        async fn stop(&self, name: &str) -> Result<()> {
            self.with(name, |s| s.status = Status::Stopped)
        }
        async fn fork(&self, name: &str, child: &str, ports: &[Port]) -> Result<SandboxInfo> {
            let mut copy = self.with(name, |s| s.clone())?;
            copy.name = child.to_string();
            copy.ports = ports.to_vec();
            self.sandboxes.lock().unwrap().insert(child.to_string(), copy.clone());
            Ok(copy)
        }
        async fn snapshot(&self, name: &str, _snapshot: &str) -> Result<()> {
            self.with(name, |_| ())
        }
        async fn delete(&self, name: &str) -> Result<()> {
            self.sandboxes.lock().unwrap().remove(name).map(|_| ()).ok_or_else(|| format!("no sandbox named {name}"))
        }
        async fn exec(&self, name: &str, command: &str) -> Result<ExecResult> {
            self.with(name, |_| ())?;
            // `echo out; echo err >&2; exit 3` style commands, enough to prove the plumbing.
            let mut result = ExecResult { stdout: String::new(), stderr: String::new(), exit_code: 0 };
            for part in command.split(';').map(str::trim) {
                if let Some(text) = part.strip_prefix("echo ").and_then(|t| t.strip_suffix(" >&2")) {
                    result.stderr.push_str(&format!("{text}\n"));
                } else if let Some(text) = part.strip_prefix("echo ") {
                    result.stdout.push_str(&format!("{text}\n"));
                } else if let Some(code) = part.strip_prefix("exit ") {
                    result.exit_code = code.parse().unwrap_or(1);
                }
            }
            Ok(result)
        }
        async fn read_file(&self, name: &str, path: &str) -> Result<Vec<u8>> {
            let files = self.files.lock().unwrap();
            files.get(&(name.into(), path.into())).cloned().ok_or_else(|| format!("{path}: not found"))
        }
        async fn write_file(&self, name: &str, path: &str, data: Vec<u8>) -> Result<()> {
            self.with(name, |_| ())?;
            self.files.lock().unwrap().insert((name.into(), path.into()), data);
            Ok(())
        }
        async fn list_dir(&self, _name: &str, _path: &str) -> Result<Vec<DirEntry>> {
            Ok(vec![])
        }
        async fn logs(&self, _name: &str) -> Result<Vec<String>> {
            Ok(vec![])
        }
        async fn metrics(&self, _name: &str) -> Result<Metrics> {
            Ok(Metrics::default())
        }
    }
}
