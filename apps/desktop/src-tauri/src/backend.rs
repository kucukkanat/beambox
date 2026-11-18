//! The `SandboxBackend` trait that the GUI and the CLI both talk to, plus its data types.
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
    /// The agent harness installed in it (`claude-code`, `codex`, `opencode`), if any.
    pub harness: Option<String>,
    /// Boot from this local disk snapshot instead of `image`.
    pub snapshot: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxInfo {
    pub name: String,
    pub template: String,
    pub status: Status,
    pub cpus: u8,
    pub memory_mib: u32,
    pub harness: Option<String>,
    pub ports: Vec<Port>,
    /// Something the person creating it should know, such as the desktop being built locally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    /// The desktop in a browser, when it was created with `web`. Only known to the create that set it up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
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
    async fn has_snapshot(&self, snapshot: &str) -> Result<bool>;
    async fn delete(&self, name: &str) -> Result<()>;
    /// Run `command` through `/bin/sh -c`.
    async fn exec(&self, name: &str, command: &str) -> Result<ExecResult>;
    /// `exec` with extra environment variables for that one process. The only way a credential enters a sandbox.
    async fn exec_env(&self, name: &str, command: &str, env: &[(String, String)]) -> Result<ExecResult>;
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
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeBackend {
        pub sandboxes: Mutex<BTreeMap<String, SandboxInfo>>,
        pub specs: Mutex<Vec<Spec>>,
        pub files: Mutex<BTreeMap<(String, String), Vec<u8>>>,
        pub snapshots: Mutex<BTreeSet<String>>,
        /// Every `(sandbox, command)` passed to `exec` or `exec_env`.
        pub execs: Mutex<Vec<(String, String)>>,
        /// The environment of every `exec_env` call, by sandbox.
        pub envs: Mutex<Vec<(String, Vec<(String, String)>)>>,
        /// Canned results for exact commands, for commands the `echo` interpreter can't fake.
        pub replies: Mutex<BTreeMap<String, ExecResult>>,
        /// Images that can't be pulled: creating from one fails, like a registry that's down.
        pub failing_images: Mutex<BTreeSet<String>>,
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
            // Like microsandbox: a name is taken until its sandbox is deleted.
            if self.sandboxes.lock().unwrap().contains_key(&spec.name) {
                return Err(format!("sandbox {} already exists", spec.name));
            }
            // Like a real boot, give other tasks a turn, so concurrent creates really interleave.
            tokio::task::yield_now().await;
            match &spec.snapshot {
                Some(snapshot) if !self.snapshots.lock().unwrap().contains(snapshot) => {
                    return Err(format!("snapshot not found: {snapshot}"));
                }
                None if self.failing_images.lock().unwrap().contains(&spec.image) => {
                    return Err(format!("pulling {}: registry unreachable", spec.image));
                }
                _ => {}
            }
            let info = SandboxInfo {
                name: spec.name.clone(),
                template: spec.template.clone(),
                status: Status::Running,
                cpus: spec.cpus,
                memory_mib: spec.memory_mib,
                harness: spec.harness.clone(),
                ports: spec.ports.clone(),
                notice: None,
                web_url: None,
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
        async fn snapshot(&self, name: &str, snapshot: &str) -> Result<()> {
            self.with(name, |_| ())?;
            // Like microsandbox: `<group>:<member>`, the group being the source sandbox.
            self.snapshots.lock().unwrap().insert(format!("{name}:{snapshot}"));
            Ok(())
        }
        async fn has_snapshot(&self, snapshot: &str) -> Result<bool> {
            Ok(self.snapshots.lock().unwrap().contains(snapshot))
        }
        async fn delete(&self, name: &str) -> Result<()> {
            self.sandboxes.lock().unwrap().remove(name).map(|_| ()).ok_or_else(|| format!("no sandbox named {name}"))
        }
        async fn exec(&self, name: &str, command: &str) -> Result<ExecResult> {
            tokio::task::yield_now().await;
            self.with(name, |_| ())?;
            self.execs.lock().unwrap().push((name.to_string(), command.to_string()));
            if let Some(reply) = self.replies.lock().unwrap().get(command) {
                return Ok(reply.clone());
            }
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
        async fn exec_env(&self, name: &str, command: &str, env: &[(String, String)]) -> Result<ExecResult> {
            self.envs.lock().unwrap().push((name.to_string(), env.to_vec()));
            self.exec(name, command).await
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
        async fn list_dir(&self, name: &str, path: &str) -> Result<Vec<DirEntry>> {
            let files = self.files.lock().unwrap();
            let inside = files.keys().filter(|(n, p)| n == name && p.starts_with(path));
            Ok(inside.map(|(_, p)| DirEntry { path: p.clone(), dir: false }).collect())
        }
        async fn logs(&self, _name: &str) -> Result<Vec<String>> {
            Ok(vec![])
        }
        async fn metrics(&self, _name: &str) -> Result<Metrics> {
            Ok(Metrics::default())
        }
    }
}
