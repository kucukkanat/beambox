//! Shared logic for the GUI and the MCP server: defaults, naming, port picking, take-over and activity.
use crate::backend::{Port, Result, SandboxBackend, SandboxInfo, Spec};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Template images.
pub const TEMPLATES: &[(&str, &str, u32, &[u16])] = &[
    // (name, image, default memory MiB, guest ports published by default)
    ("base", "alpine:3.22", 256, &[]),
    // Built locally into DESKTOP_SNAPSHOT from this image the first time it is used; see `desktop_snapshot`.
    ("desktop", "alpine:3.22", 512, &[VNC_PORT]),
];
pub const VNC_PORT: u16 = 5900;

/// Sandboxes with this name prefix are Beambox's own build machines, hidden from the GUI and agents.
pub const BUILD_PREFIX: &str = "beambox-build-";
const DESKTOP_BUILDER: &str = "beambox-build-desktop";
/// Bump the suffix whenever `desktop_setup()` changes, so existing installs build the new desktop.
const DESKTOP_MEMBER: &str = "beambox-desktop-1";
/// microsandbox names snapshots `<group>:<member>`, and the group is the source sandbox's name.
pub const DESKTOP_SNAPSHOT: &str = "beambox-build-desktop:beambox-desktop-1";

/// Shell script that turns plain Alpine into the desktop template.
pub fn desktop_setup() -> String {
    let start = include_str!("../../images/desktop/start-desktop");
    format!(
        "set -e\napk add --no-cache xvfb x11vnc openbox xterm font-dejavu\n\
         cat > /usr/local/bin/start-desktop <<'EOF'\n{start}EOF\nchmod +x /usr/local/bin/start-desktop\n"
    )
}

/// Optional settings for a new sandbox. Everything left out gets the one-click default.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpts {
    /// Sandbox name. Defaults to `sandbox-<n>`.
    pub name: Option<String>,
    /// `base` (default) or `desktop`.
    pub template: Option<String>,
    /// vCPUs, default 1.
    pub cpus: Option<u8>,
    /// Memory in MiB, default 256 (512 for `desktop`).
    pub memory_mib: Option<u32>,
    /// Host folder to mount at /workspace.
    pub mount: Option<String>,
    /// `public` (default: internet, no host LAN), `none` or `all`.
    pub network: Option<String>,
    /// Guest ports to publish on 127.0.0.1.
    pub ports: Option<Vec<u16>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Unique across processes: a call's start event (no exit code) and finish event share it.
    pub id: String,
    pub sandbox: String,
    pub agent: String,
    pub command: String,
    pub exit_code: Option<i32>,
}

pub struct Core {
    pub backend: Arc<dyn SandboxBackend>,
    pub events: broadcast::Sender<Activity>,
    data_dir: PathBuf,
    is_port_free: fn(u16) -> bool,
    seq: std::sync::atomic::AtomicU64,
    /// Serialises desktop snapshot builds, so concurrent creates build it once.
    preparing: tokio::sync::Mutex<()>,
}

impl Core {
    pub fn new(backend: Arc<dyn SandboxBackend>, data_dir: PathBuf) -> Self {
        Self::with_port_probe(backend, data_dir, crate::ports::is_free)
    }

    pub fn with_port_probe(backend: Arc<dyn SandboxBackend>, data_dir: PathBuf, probe: fn(u16) -> bool) -> Self {
        Self { backend, events: broadcast::channel(1024).0, data_dir, is_port_free: probe, seq: 0.into(), preparing: Default::default() }
    }

    pub async fn create(&self, opts: CreateOpts, agent: Option<String>) -> Result<SandboxInfo> {
        let template = opts.template.unwrap_or_else(|| "base".into());
        let &(_, image, memory, default_ports) =
            TEMPLATES.iter().find(|t| t.0 == template).ok_or_else(|| format!("unknown template {template}"))?;
        let name = match opts.name {
            Some(name) => name,
            None => self.free_name("sandbox").await?,
        };
        let ports = self.pick_ports(default_ports.iter().copied().chain(opts.ports.unwrap_or_default())).await?;
        let spec = Spec {
            name,
            template,
            image: image.into(),
            cpus: opts.cpus.unwrap_or(1),
            memory_mib: opts.memory_mib.unwrap_or(memory),
            mount: opts.mount,
            network: opts.network.unwrap_or_else(|| "public".into()),
            ports,
            agent,
            snapshot: None,
        };
        let spec = if spec.template == "desktop" { Spec { snapshot: Some(self.desktop_snapshot().await?), ..spec } } else { spec };
        self.backend.create(spec).await
    }

    /// The desktop disk snapshot, built on first use: boot plain Alpine, install the desktop, stop, snapshot,
    /// delete the build sandbox. Takes ~10 s once; every Desktop sandbox after that boots from it in ~1 s.
    pub async fn desktop_snapshot(&self) -> Result<String> {
        let _one_at_a_time = self.preparing.lock().await;
        if self.backend.has_snapshot(DESKTOP_SNAPSHOT).await? {
            return Ok(DESKTOP_SNAPSHOT.into());
        }
        let name = DESKTOP_BUILDER.to_string();
        // A build interrupted by quitting the app leaves its sandbox behind.
        let _ = self.backend.delete(&name).await;
        let spec = Spec {
            name: name.clone(),
            template: "build".into(),
            image: "alpine:3.22".into(),
            cpus: 1,
            memory_mib: 512,
            mount: None,
            network: "public".into(),
            ports: vec![],
            agent: None,
            snapshot: None,
        };
        self.backend.create(spec).await?;
        let built = async {
            let out = self.backend.exec(&name, &desktop_setup()).await?;
            if out.exit_code != 0 {
                return Err(format!("preparing the desktop failed: {}", out.stderr.trim()));
            }
            self.backend.stop(&name).await?;
            self.backend.snapshot(&name, DESKTOP_MEMBER).await
        }
        .await;
        let _ = self.backend.delete(&name).await;
        built.map(|_| DESKTOP_SNAPSHOT.into())
    }

    /// Fork into `<name>-fork-<n>`; the child gets its own free host ports for the same guest ports.
    pub async fn fork(&self, name: &str) -> Result<SandboxInfo> {
        let all = self.backend.list().await?;
        let source = all.iter().find(|s| s.name == name).ok_or(format!("no sandbox named {name}"))?;
        let child = self.free_name(&format!("{name}-fork")).await?;
        let ports = self.pick_ports(source.ports.iter().map(|p| p.guest)).await?;
        self.backend.fork(name, &child, &ports).await
    }

    /// A host port per guest port: the guest's own number when free, else the next free one. Skips ports
    /// other sandboxes (running or not) already publish.
    async fn pick_ports(&self, guests: impl Iterator<Item = u16>) -> Result<Vec<Port>> {
        let mut taken: Vec<u16> =
            self.backend.list().await?.iter().flat_map(|s| s.ports.iter().map(|p| p.host)).collect();
        let mut ports = Vec::new();
        for guest in guests {
            let host = crate::ports::first_free(guest, |p| !taken.contains(&p) && (self.is_port_free)(p))
                .ok_or_else(|| format!("no free host port for guest port {guest}"))?;
            taken.push(host);
            ports.push(Port { guest, host });
        }
        Ok(ports)
    }

    /// `<prefix>-<n>` with the smallest unused n.
    pub async fn free_name(&self, prefix: &str) -> Result<String> {
        let names: Vec<String> = self.backend.list().await?.into_iter().map(|s| s.name).collect();
        Ok((1..).map(|n| format!("{prefix}-{n}")).find(|n| !names.contains(n)).expect("unbounded"))
    }

    fn takeover_file(&self, sandbox: &str) -> PathBuf {
        self.data_dir.join("takeover").join(sandbox)
    }

    /// A marker file, so the GUI and every `--mcp` process see the same state.
    pub fn set_takeover(&self, sandbox: &str, on: bool) -> Result<()> {
        let file = self.takeover_file(sandbox);
        let result = if on {
            std::fs::create_dir_all(file.parent().expect("has parent")).and_then(|_| std::fs::write(&file, b""))
        } else {
            std::fs::remove_file(&file).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
        };
        result.map_err(|e| e.to_string())
    }

    pub fn is_taken_over(&self, sandbox: &str) -> bool {
        self.takeover_file(sandbox).exists()
    }

    /// Reject agent calls on a sandbox the user has taken over.
    pub fn guard(&self, sandbox: &str) -> Result<()> {
        if self.is_taken_over(sandbox) {
            return Err(format!(
                "The user has taken over sandbox '{sandbox}'. Agent calls on it are paused until they hand control back."
            ));
        }
        Ok(())
    }

    /// Runs one agent call on `sandbox`: rejects it during take-over, and shows it in the activity feed when it
    /// starts and again with its exit code when it ends.
    pub async fn agent_call<T>(
        &self,
        agent: &str,
        sandbox: &str,
        command: &str,
        call: impl Future<Output = Result<T>>,
        exit: impl Fn(&T) -> i32,
    ) -> Result<T> {
        self.guard(sandbox)?;
        let id = self.new_activity_id();
        self.record(&id, sandbox, agent, command, None);
        let result = call.await;
        self.record(&id, sandbox, agent, command, Some(result.as_ref().map_or(-1, exit)));
        result
    }

    /// Save the sandbox's disk as `<name>-<unix seconds>` and return that name.
    pub async fn snapshot(&self, name: &str, unix_secs: u64) -> Result<String> {
        let snapshot = format!("{name}-{unix_secs}");
        self.backend.snapshot(name, &snapshot).await.map(|_| snapshot)
    }

    pub fn new_activity_id(&self) -> String {
        format!("{}-{}", std::process::id(), self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
    }

    pub fn record(&self, id: &str, sandbox: &str, agent: &str, command: &str, exit_code: Option<i32>) {
        let event = Activity { id: id.into(), sandbox: sandbox.into(), agent: agent.into(), command: command.into(), exit_code };
        // No subscribers is fine: nobody is watching yet.
        let _ = self.events.send(event);
    }

    /// Delete the sandbox and forget its take-over, so a new sandbox reusing the name starts free.
    pub async fn delete(&self, name: &str) -> Result<()> {
        self.backend.delete(name).await?;
        self.set_takeover(name, false)
    }

    pub fn activity_file(&self) -> PathBuf {
        self.data_dir.join("activity.jsonl")
    }
}

/// A fresh data dir for a test.
#[cfg(test)]
pub fn temp_dir() -> PathBuf {
    use std::hash::{BuildHasher, RandomState};
    let dir = std::env::temp_dir().join(format!("beambox-test-{:x}", RandomState::new().hash_one(0u8)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Status, fake::FakeBackend};

    fn core_with(probe: fn(u16) -> bool) -> (Arc<FakeBackend>, Core) {
        let fake = Arc::new(FakeBackend::default());
        (fake.clone(), Core::with_port_probe(fake, temp_dir(), probe))
    }

    #[tokio::test]
    async fn lifecycle_create_list_fork_delete() {
        let (_, core) = core_with(|_| true);
        let created = core.create(CreateOpts { name: Some("a".into()), ..Default::default() }, None).await.unwrap();
        assert_eq!(created.status, Status::Running);
        core.fork("a").await.unwrap();
        let names: Vec<_> = core.backend.list().await.unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["a", "a-fork-1"]);
        core.delete("a").await.unwrap();
        assert_eq!(core.backend.list().await.unwrap().len(), 1);
        assert!(core.delete("a").await.is_err());
    }

    #[tokio::test]
    async fn delete_clears_take_over_so_a_reused_name_starts_free() {
        let (_, core) = core_with(|_| true);
        core.create(CreateOpts::default(), None).await.unwrap();
        core.set_takeover("sandbox-1", true).unwrap();
        core.delete("sandbox-1").await.unwrap();
        let again = core.create(CreateOpts::default(), None).await.unwrap();
        assert_eq!(again.name, "sandbox-1");
        assert!(core.guard("sandbox-1").is_ok());
    }

    #[tokio::test]
    async fn one_click_create_uses_defaults_and_reaches_running() {
        let (fake, core) = core_with(|_| true);
        let first = core.create(CreateOpts::default(), None).await.unwrap();
        let second = core.create(CreateOpts::default(), None).await.unwrap();
        assert_eq!((first.name.as_str(), second.name.as_str()), ("sandbox-1", "sandbox-2"));
        assert_eq!(first.status, Status::Running);
        let spec = fake.specs.lock().unwrap()[0].clone();
        assert_eq!(
            (spec.template.as_str(), spec.cpus, spec.memory_mib, spec.network.as_str()),
            ("base", 1, 256, "public")
        );
        assert!(spec.ports.is_empty() && spec.mount.is_none());
    }

    #[tokio::test]
    async fn desktop_template_gets_more_memory_and_a_vnc_port() {
        let (_, core) = core_with(|_| true);
        let info = core.create(CreateOpts { template: Some("desktop".into()), ..Default::default() }, None).await.unwrap();
        assert_eq!(info.memory_mib, 512);
        assert_eq!(info.ports, [Port { guest: VNC_PORT, host: VNC_PORT }]);
    }

    #[tokio::test]
    async fn desktop_snapshot_is_built_once_then_reused() {
        let (fake, core) = core_with(|_| true);
        let desktop = || CreateOpts { template: Some("desktop".into()), ..Default::default() };
        core.create(desktop(), None).await.unwrap();
        core.create(desktop(), Some("cursor".into())).await.unwrap();

        let builds: Vec<_> = fake.execs.lock().unwrap().iter().filter(|(_, c)| c.contains("apk add")).cloned().collect();
        assert_eq!(builds.len(), 1, "setup runs once");
        assert_eq!(builds[0].0, DESKTOP_BUILDER);
        let specs = fake.specs.lock().unwrap().clone();
        let users: Vec<_> = specs.iter().filter(|s| s.template == "desktop").collect();
        assert!(users.iter().all(|s| s.snapshot.as_deref() == Some(DESKTOP_SNAPSHOT)), "{users:?}");
        assert_eq!(users[1].agent.as_deref(), Some("cursor"));
        let names: Vec<_> = core.backend.list().await.unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["sandbox-1", "sandbox-2"], "build sandbox is deleted");
    }

    #[tokio::test]
    async fn base_template_never_builds_a_snapshot() {
        let (fake, core) = core_with(|_| true);
        core.create(CreateOpts::default(), None).await.unwrap();
        assert!(fake.execs.lock().unwrap().is_empty());
        assert_eq!(fake.specs.lock().unwrap()[0].snapshot, None);
    }

    #[test]
    fn desktop_snapshot_reference_matches_its_builder() {
        assert_eq!(DESKTOP_SNAPSHOT, format!("{DESKTOP_BUILDER}:{DESKTOP_MEMBER}"));
        assert!(DESKTOP_BUILDER.starts_with(BUILD_PREFIX));
    }

    #[test]
    fn desktop_setup_installs_the_start_script() {
        let script = desktop_setup();
        assert!(script.starts_with("set -e\napk add --no-cache xvfb x11vnc openbox"));
        assert!(script.contains("cat > /usr/local/bin/start-desktop <<'EOF'\n#!/bin/sh\n"));
        assert!(script.contains("x11vnc -display :0 -rfbport 5900"));
        assert!(script.ends_with("EOF\nchmod +x /usr/local/bin/start-desktop\n"));
    }

    #[tokio::test]
    async fn port_collision_retries_next_free_port() {
        // 8080 and 8081 are taken on the host.
        let (_, core) = core_with(|p| p != 8080 && p != 8081);
        let opts = CreateOpts { ports: Some(vec![8080, 8082]), ..Default::default() };
        let info = core.create(opts, None).await.unwrap();
        // 8082 went to the first port, so the second one moves on to 8083.
        assert_eq!(info.ports, [Port { guest: 8080, host: 8082 }, Port { guest: 8082, host: 8083 }]);
    }

    #[tokio::test]
    async fn fork_gets_its_own_name_and_host_ports() {
        let (_, core) = core_with(|_| true);
        core.create(CreateOpts { name: Some("a".into()), ports: Some(vec![3000]), ..Default::default() }, None).await.unwrap();
        let child = core.fork("a").await.unwrap();
        assert_eq!(child.name, "a-fork-1");
        assert_eq!(child.ports, [Port { guest: 3000, host: 3001 }]);
        assert_eq!(core.fork("a").await.unwrap().ports, [Port { guest: 3000, host: 3002 }]);
    }

    #[tokio::test]
    async fn takeover_blocks_and_releases() {
        let (_, core) = core_with(|_| true);
        assert!(core.guard("a").is_ok());
        core.set_takeover("a", true).unwrap();
        assert!(core.guard("a").unwrap_err().contains("taken over"));
        core.set_takeover("a", false).unwrap();
        assert!(core.guard("a").is_ok());
    }
}
