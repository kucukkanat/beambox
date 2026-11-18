//! Shared logic for the GUI and the CLI: defaults, naming, port picking, snapshots, agents and take-over.
use crate::agent::{self, Harness};
use crate::backend::{Port, Result, SandboxBackend, SandboxInfo, Spec, Status};
use crate::credentials::Secrets;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

/// Template images.
pub const TEMPLATES: &[(&str, &str, u32, &[u16])] = &[
    // (name, image, default memory MiB, guest ports published by default)
    ("base", "alpine:3.22", 256, &[]),
    // Pulled from the registry; built locally into a snapshot when that fails (see `create`).
    ("desktop", DESKTOP_IMAGE, 2048, &[VNC_PORT]),
];
/// The Desktop template's image: `images/desktop/` on Debian, built and published by
/// `.github/workflows/desktop-image.yml`. Its tag follows the desktop snapshot's member (`snapshot_key`): bump
/// both when `images/desktop/` changes.
pub const DESKTOP_IMAGE: &str = "ghcr.io/OWNER/beambox-desktop:5";
pub const VNC_PORT: u16 = 5900;

/// Sandboxes with this name prefix are Beambox's own build machines, hidden from the GUI and the CLI.
pub const BUILD_PREFIX: &str = "beambox-build-";

/// The local snapshot a (harness, desktop) pair boots from, as `(build sandbox, member)`. microsandbox names
/// snapshots `<group>:<member>`, the group being the build sandbox. Bump a member's suffix whenever its setup
/// changes, so existing installs build it anew.
pub fn snapshot_key(harness: Option<&str>, desktop: bool) -> Option<(String, String)> {
    match (harness, desktop) {
        (None, false) => None,
        (None, true) => Some(("beambox-build-desktop".into(), "beambox-desktop-5".into())),
        (Some(h), false) => Some((format!("{BUILD_PREFIX}{h}"), format!("beambox-{h}-5"))),
        (Some(h), true) => Some((format!("{BUILD_PREFIX}{h}-desktop"), format!("beambox-{h}-desktop-6"))),
    }
}

pub fn snapshot_name(harness: Option<&str>, desktop: bool) -> Option<String> {
    snapshot_key(harness, desktop).map(|(group, member)| format!("{group}:{member}"))
}

/// Optional settings for a new sandbox. Everything left out gets the one-click default.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpts {
    /// Sandbox name. Defaults to `sandbox-<n>`.
    pub name: Option<String>,
    /// `base` (default) or `desktop` (the same as `desktop: true`).
    pub template: Option<String>,
    /// `claude-code`, `codex` or `opencode`: make an agent sandbox with that harness.
    pub harness: Option<String>,
    /// The harness's first prompt.
    pub task: Option<String>,
    /// Add a desktop (the `desktop` template for plain sandboxes).
    pub desktop: Option<bool>,
    /// vCPUs, default 1 (2 for agents).
    pub cpus: Option<u8>,
    /// Memory in MiB, default 256 (512 for `desktop`, 2048 for agents, 4096 for agents with a desktop).
    pub memory_mib: Option<u32>,
    /// Host folder to mount at /workspace.
    pub mount: Option<String>,
    /// `public` (default: internet, no host LAN), `none` or `all`.
    pub network: Option<String>,
    /// Guest ports to publish on 127.0.0.1.
    pub ports: Option<Vec<u16>>,
}

/// The harness's processes: the process group of tmux's pane, without the pane's own shell. tmux sends SIGCONT
/// to a pane process it sees stop, so that one must keep running.
const HARNESS_PIDS: &str = "$(p=\"$(tmux display-message -p -t agent:0.0 '#{pane_pid}')\" && pgrep -g \"$p\" | grep -vx \"$p\")";

pub struct Core {
    pub backend: Arc<dyn SandboxBackend>,
    pub secrets: Arc<dyn Secrets>,
    is_port_free: fn(u16) -> bool,
    /// Holds `snapshot-build.lock`, which serialises snapshot builds across the app and CLI processes, so
    /// concurrent creates build each snapshot once, and `logins/<harness>`, each harness's latest sign-in.
    lock_dir: PathBuf,
    /// Picking a free name and ports happens one create at a time, and what's picked stays `pending` until its
    /// sandbox exists, so two creates never pick the same ones. Booting (and pulling an image) runs unlocked.
    picking: tokio::sync::Mutex<()>,
    pending: std::sync::Mutex<(Vec<String>, Vec<u16>)>,
}

impl Core {
    /// `data_dir` holds the snapshot build lock shared by every Beambox process.
    pub fn new(backend: Arc<dyn SandboxBackend>, secrets: Arc<dyn Secrets>, data_dir: PathBuf) -> Self {
        Self { lock_dir: data_dir, ..Self::with_port_probe(backend, secrets, crate::ports::is_free) }
    }

    pub fn with_port_probe(backend: Arc<dyn SandboxBackend>, secrets: Arc<dyn Secrets>, probe: fn(u16) -> bool) -> Self {
        Self { backend, secrets, is_port_free: probe, lock_dir: std::env::temp_dir(), picking: Default::default(), pending: Default::default() }
    }

    /// The harness's credential as `(variable, value)`, or which key is missing.
    pub fn credential_env(&self, harness: &Harness) -> Result<(String, String)> {
        for provider in harness.credentials {
            if let Some(env) = self.secrets.get(provider)?.and_then(|value| agent::credential_env(harness, provider, &value)) {
                return Ok(env);
            }
        }
        // Said in the app's words: the app asks for the key before creating, and the CLI adds its own command.
        Err(format!(
            "{} needs an {} key. Add one under Settings → Credentials.",
            harness.name,
            harness.credentials.join(" or ")
        ))
    }

    /// The keys `harness` could use when it has neither a usable stored key nor a saved login, in order of
    /// preference; empty when it starts signed in. A stored key it can't use (OpenCode and a Claude subscription
    /// token) counts as missing.
    pub fn missing_credentials(&self, harness: &str) -> Result<Vec<&'static str>> {
        let harness = agent::harness(harness)?;
        let ready = self.credential_env(harness).is_ok() || self.login_file(harness).exists();
        Ok(if ready { vec![] } else { harness.credentials.to_vec() })
    }

    pub async fn create(&self, opts: CreateOpts) -> Result<SandboxInfo> {
        let harness = opts.harness.as_deref().map(agent::harness).transpose()?;
        // No usable stored key is fine: the harness then shows its own sign-in in its terminal.
        let env = harness.and_then(|h| self.credential_env(h).ok());
        let desktop = opts.desktop.unwrap_or(false) || opts.template.as_deref() == Some("desktop");
        let template = if desktop { "desktop".to_string() } else { opts.template.clone().unwrap_or_else(|| "base".into()) };
        let &(_, mut image, mut memory, default_ports) =
            TEMPLATES.iter().find(|t| t.0 == template).ok_or_else(|| format!("unknown template {template}"))?;
        if harness.is_some() {
            (image, memory) = (agent::IMAGE, if desktop { 4096 } else { 2048 });
        }
        let boot = |image: &str, snapshot: Option<String>| Spec {
            name: opts.name.clone().unwrap_or_default(),
            template: template.clone(),
            image: image.into(),
            cpus: opts.cpus.unwrap_or(if harness.is_some() { 2 } else { 1 }),
            memory_mib: opts.memory_mib.unwrap_or(memory),
            mount: opts.mount.clone(),
            network: opts.network.clone().unwrap_or_else(|| "public".into()),
            ports: vec![],
            harness: harness.map(|h| h.name.to_string()),
            snapshot,
        };
        let ports: Vec<u16> = default_ports.iter().copied().chain(opts.ports.clone().unwrap_or_default()).collect();
        let info = if harness.is_none() && desktop {
            // A plain desktop boots from the published image, unless it was built here before (the same desktop).
            // If creating from the image fails, the same desktop is built here.
            let local = snapshot_name(None, true).expect("the desktop has a snapshot");
            if self.backend.has_snapshot(&local).await? {
                self.boot(self.reserve(boot(image, Some(local)), &ports).await?).await?
            } else {
                let spec = self.reserve(boot(image, None), &ports).await?;
                let name = spec.name.clone();
                match self.boot(spec).await {
                    Ok(info) => info,
                    Err(e) => {
                        // It may have booted and then failed to start its desktop.
                        let _ = self.backend.delete(&name).await;
                        let snapshot = self.snapshot_for(None, true).await?;
                        let mut info = self.boot(self.reserve(boot(image, Some(snapshot)), &ports).await?).await?;
                        info.notice = Some(format!(
                            "Couldn't start the desktop from {image} ({}), so Beambox built the desktop on this \
                             computer.",
                            e.trim()
                        ));
                        info
                    }
                }
            }
        } else {
            // The snapshot first: building one can take minutes, and other creates finish meanwhile.
            let snapshot = match snapshot_key(harness.map(|h| h.name), desktop) {
                Some(_) => Some(self.snapshot_for(harness, desktop).await?),
                None => None,
            };
            self.boot(self.reserve(boot(image, snapshot), &ports).await?).await?
        };
        if let Some(h) = harness {
            // Signed in once already? Reuse that login, unless a stored key is used instead.
            if env.is_none() {
                self.reuse_login(&info, h).await?;
            }
            self.start_agent(&info, h, opts.task.as_deref(), env).await?;
        }
        Ok(info)
    }

    /// Give `spec` a free name (unless it has one) and host ports for `guest_ports`, held as pending until `boot`.
    async fn reserve(&self, mut spec: Spec, guest_ports: &[u16]) -> Result<Spec> {
        let _one_at_a_time = self.picking.lock().await;
        if spec.name.is_empty() {
            spec.name = self.free_name("sandbox").await?;
        } else if self.pending.lock().unwrap().0.contains(&spec.name)
            || self.backend.list().await?.iter().any(|s| s.name == spec.name)
        {
            return Err(format!("sandbox {} already exists", spec.name));
        }
        spec.ports = self.pick_ports(guest_ports.iter().copied()).await?;
        let mut pending = self.pending.lock().unwrap();
        pending.0.push(spec.name.clone());
        pending.1.extend(spec.ports.iter().map(|p| p.host));
        Ok(spec)
    }

    /// Create a sandbox `reserve` named, then release its name and ports.
    async fn boot(&self, spec: Spec) -> Result<SandboxInfo> {
        let (name, hosts): (String, Vec<u16>) = (spec.name.clone(), spec.ports.iter().map(|p| p.host).collect());
        let result = self.backend.create(spec).await;
        let mut pending = self.pending.lock().unwrap();
        pending.0.retain(|n| *n != name);
        pending.1.retain(|p| !hosts.contains(p));
        result
    }

    fn login_file(&self, harness: &Harness) -> PathBuf {
        self.lock_dir.join("logins").join(harness.name)
    }

    /// Keep the sign-in in an agent sandbox as its harness's latest, so new sandboxes of that harness start
    /// signed in. A sandbox that isn't running or isn't signed in has nothing to give.
    async fn save_login(&self, info: &SandboxInfo) -> Result<()> {
        let Some(harness) = info.harness.as_deref().map(agent::harness).transpose()? else { return Ok(()) };
        if info.status != Status::Running {
            return Ok(());
        }
        let Ok(login) = self.backend.read_file(&info.name, harness.login_path).await else { return Ok(()) };
        let file = self.login_file(harness);
        if login.is_empty() || std::fs::read(&file).is_ok_and(|saved| saved == login) {
            return Ok(());
        }
        write_private(&file, &login).map_err(|e| format!("can't save the {} login: {e}", harness.name))
    }

    /// Give a new sandbox its harness's latest sign-in: first collect it from the other running sandboxes of that
    /// harness (a harness refreshes its login as it runs), then copy the newest one in.
    async fn reuse_login(&self, new: &SandboxInfo, harness: &Harness) -> Result<()> {
        let others = self.backend.list().await?;
        for other in others.iter().filter(|s| s.name != new.name && s.harness.as_deref() == Some(harness.name)) {
            self.save_login(other).await?;
        }
        let Ok(login) = std::fs::read(self.login_file(harness)) else { return Ok(()) };
        let (path, dir) = (harness.login_path, harness.login_path.rsplit_once('/').map_or("/", |(dir, _)| dir));
        self.backend.exec(&new.name, &format!("mkdir -p {dir}")).await?;
        self.backend.write_file(&new.name, path, login).await?;
        // As private as the harness's own copy.
        self.backend.exec(&new.name, &format!("chmod 600 {path}")).await.map(|_| ())
    }

    /// Stop a sandbox, keeping its harness's sign-in first.
    pub async fn stop(&self, name: &str) -> Result<()> {
        self.save_login_of(name).await;
        self.backend.stop(name).await
    }

    /// A login is a convenience: failing to save one never blocks stopping or deleting.
    async fn save_login_of(&self, name: &str) {
        if let Ok(all) = self.backend.list().await {
            if let Some(info) = all.iter().find(|s| s.name == name) {
                let _ = self.save_login(info).await;
            }
        }
    }

    /// Start the harness in tmux session `agent`. A stored credential goes into that one process's environment
    /// only; without one, the harness asks you to sign in.
    async fn start_agent(
        &self,
        info: &SandboxInfo,
        harness: &Harness,
        task: Option<&str>,
        env: Option<(String, String)>,
    ) -> Result<()> {
        let details = serde_json::json!({ "name": info.name, "harness": harness.name, "desktop": info.template == "desktop" });
        self.backend.write_file(&info.name, agent::INFO_PATH, details.to_string().into_bytes()).await?;
        let out = self.backend.exec_env(&info.name, &harness.start_command(task, env.is_none()), env.as_slice()).await?;
        if out.exit_code != 0 {
            return Err(format!("couldn't start {}: {}", harness.name, out.stderr.trim()));
        }
        Ok(())
    }

    /// Start a stopped sandbox. An agent sandbox restarts its harness in a new session, without the task.
    pub async fn start(&self, name: &str) -> Result<()> {
        self.backend.start(name).await?;
        self.restart_agent(name).await
    }

    async fn restart_agent(&self, name: &str) -> Result<()> {
        let all = self.backend.list().await?;
        let info = all.iter().find(|s| s.name == name).ok_or(format!("no sandbox named {name}"))?;
        match &info.harness {
            Some(h) => {
                let harness = agent::harness(h)?;
                self.start_agent(info, harness, None, self.credential_env(harness).ok()).await
            }
            None => Ok(()),
        }
    }

    /// The local snapshot for a (harness, desktop) pair, built on first use: boot the base image, set it up,
    /// stop, snapshot, delete the build sandbox. Every sandbox after that boots from it in seconds.
    pub async fn snapshot_for(&self, harness: Option<&Harness>, desktop: bool) -> Result<String> {
        let (builder, member) = snapshot_key(harness.map(|h| h.name), desktop).ok_or("nothing to build")?;
        let reference = format!("{builder}:{member}");
        let file = self.lock_dir.join("snapshot-build.lock");
        let _one_at_a_time = tokio::task::spawn_blocking(move || {
            let lock = std::fs::File::create(&file)?;
            lock.lock().map(|_| lock)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("can't lock snapshot builds: {e}"))?;
        if self.backend.has_snapshot(&reference).await? {
            return Ok(reference);
        }
        // A build interrupted by quitting the app leaves its sandbox behind.
        let _ = self.backend.delete(&builder).await;
        let (image, script) = match harness {
            Some(h) => (agent::IMAGE, agent::agent_setup(h, desktop)),
            None => (agent::IMAGE, agent::desktop_setup()),
        };
        let spec = Spec {
            name: builder.clone(),
            template: "build".into(),
            image: image.into(),
            cpus: 2,
            memory_mib: 2048,
            mount: None,
            network: "public".into(),
            ports: vec![],
            harness: None,
            snapshot: None,
        };
        self.backend.create(spec).await?;
        let built = async {
            let out = self.backend.exec(&builder, &script).await?;
            if out.exit_code != 0 {
                return Err(format!("preparing the snapshot failed: {}", out.stderr.trim()));
            }
            if let Some(h) = harness {
                self.backend.write_file(&builder, agent::MCP_PATH, agent::MCP_JS.as_bytes().to_vec()).await?;
                let (path, config) = h.config();
                self.backend.write_file(&builder, path, config.as_bytes().to_vec()).await?;
            }
            self.backend.stop(&builder).await?;
            self.backend.snapshot(&builder, &member).await
        }
        .await;
        let _ = self.backend.delete(&builder).await;
        built.map(|_| reference)
    }

    /// Take over: freeze the harness's processes (SIGSTOP) and switch the session to a new shell window, so what you
    /// type doesn't queue up for the agent. Hand back: continue them (SIGCONT) and switch back to the agent.
    pub async fn set_takeover(&self, name: &str, on: bool) -> Result<()> {
        let out = self.backend.exec(name, &takeover_command(on)).await?;
        if out.exit_code != 0 {
            return Err(format!("no agent is running in {name}"));
        }
        Ok(())
    }

    /// Whether the harness is frozen: its process state is `T`.
    pub async fn is_taken_over(&self, name: &str) -> Result<bool> {
        let out = self.backend.exec(name, &takeover_probe()).await?;
        Ok(out.stdout.trim_start().starts_with('T'))
    }

/// Fork into `<name>-fork-<n>`; the child gets its own free host ports for the same guest ports.
    pub async fn fork(&self, name: &str) -> Result<SandboxInfo> {
        let all = self.backend.list().await?;
        let source = all.iter().find(|s| s.name == name).ok_or(format!("no sandbox named {name}"))?;
        let child = self.free_name(&format!("{name}-fork")).await?;
        let ports = self.pick_ports(source.ports.iter().map(|p| p.guest)).await?;
        let info = self.backend.fork(name, &child, &ports).await?;
        // The child boots fresh, so its harness starts again like after a restart.
        self.restart_agent(&child).await?;
        Ok(info)
    }

    /// A host port per guest port: the guest's own number when free, else the next free one. Skips ports
    /// other sandboxes (running or not) already publish.
    async fn pick_ports(&self, guests: impl Iterator<Item = u16>) -> Result<Vec<Port>> {
        let mut taken: Vec<u16> =
            self.backend.list().await?.iter().flat_map(|s| s.ports.iter().map(|p| p.host)).collect();
        taken.extend(self.pending.lock().unwrap().1.iter());
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
        let mut names: Vec<String> = self.backend.list().await?.into_iter().map(|s| s.name).collect();
        names.extend(self.pending.lock().unwrap().0.iter().cloned());
        Ok((1..).map(|n| format!("{prefix}-{n}")).find(|n| !names.contains(n)).expect("unbounded"))
    }

    /// Save the sandbox's disk as `<name>-<unix seconds>` and return that name.
    pub async fn snapshot(&self, name: &str, unix_secs: u64) -> Result<String> {
        let snapshot = format!("{name}-{unix_secs}");
        self.backend.snapshot(name, &snapshot).await.map(|_| snapshot)
    }

    /// Delete a sandbox, keeping its harness's sign-in first.
    pub async fn delete(&self, name: &str) -> Result<()> {
        self.save_login_of(name).await;
        self.backend.delete(name).await
    }
}

/// Write a file only the current user can read: logins are as good as passwords.
fn write_private(file: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(file.parent().expect("has a parent"))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(file)?, data)
}

pub fn takeover_command(on: bool) -> String {
    let signal = if on { "STOP" } else { "CONT" };
    let window = if on { "tmux new-window -t agent" } else { "tmux select-window -t agent:0" };
    format!("pids={HARNESS_PIDS}; [ -n \"$pids\" ] && kill -{signal} $pids && {window}")
}

/// Prints the state of each harness process (`T` when stopped).
pub fn takeover_probe() -> String {
    format!("for p in {HARNESS_PIDS}; do ps -o stat= -p \"$p\"; done")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{ExecResult, Status, fake::FakeBackend};
    use crate::credentials::fake::FakeSecrets;

    const KEY: &str = "sk-ant-api03-secret-value";

    fn core_with(probe: fn(u16) -> bool) -> (Arc<FakeBackend>, Core) {
        let fake = Arc::new(FakeBackend::default());
        (fake.clone(), Core::with_port_probe(fake, Arc::new(FakeSecrets::with("anthropic", KEY)), probe))
    }

    /// A Core whose logins and locks live in a fresh folder.
    fn core_in_fresh_dir(fake: Arc<FakeBackend>, secrets: Arc<FakeSecrets>) -> (Core, std::path::PathBuf) {
        use std::hash::{BuildHasher, RandomState};
        let dir = std::env::temp_dir().join(format!("beambox-test-{:x}", RandomState::new().hash_one(0u8)));
        std::fs::create_dir_all(&dir).unwrap();
        let mut core = Core::with_port_probe(fake, secrets, |_| true);
        core.lock_dir = dir.clone();
        (core, dir)
    }

    fn named(name: &str, harness: &str) -> CreateOpts {
        CreateOpts { name: Some(name.into()), harness: Some(harness.into()), ..Default::default() }
    }

    const CLAUDE_LOGIN: &str = "/root/.claude/.credentials.json";

    #[tokio::test]
    async fn creates_waiting_on_snapshot_builds_still_get_their_own_names_and_ports() {
        let fake = Arc::new(FakeBackend::default());
        let (core, _dir) = core_in_fresh_dir(fake.clone(), Arc::new(FakeSecrets::default()));
        let desktop = |h: &str| CreateOpts { harness: Some(h.into()), desktop: Some(true), ..Default::default() };
        // Both build their snapshot first; neither sandbox exists while the other picks its name and port.
        let (a, b) = tokio::join!(core.create(desktop("opencode")), core.create(desktop("codex")));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_ne!(a.name, b.name);
        assert_ne!(a.ports[0].host, b.ports[0].host);
    }

    #[tokio::test]
    async fn signing_in_once_signs_in_every_new_sandbox_of_that_harness() {
        let fake = Arc::new(FakeBackend::default());
        let (core, dir) = core_in_fresh_dir(fake.clone(), Arc::new(FakeSecrets::default()));
        core.create(named("a", "claude-code")).await.unwrap();
        // You sign in inside `a`; the harness writes its login file.
        fake.write_file("a", CLAUDE_LOGIN, b"{\"token\":1}".to_vec()).await.unwrap();
        assert_eq!(core.missing_credentials("claude-code").unwrap(), ["anthropic"], "not saved until it's seen");
        core.create(named("b", "claude-code")).await.unwrap();
        assert_eq!(fake.read_file("b", CLAUDE_LOGIN).await.unwrap(), b"{\"token\":1}");
        assert!(fake.execs.lock().unwrap().iter().any(|(n, c)| n == "b" && c == "chmod 600 /root/.claude/.credentials.json"));
        // Signed in now: the app stops offering a key and doesn't open the terminal to sign in.
        assert!(core.missing_credentials("claude-code").unwrap().is_empty());
        assert_eq!(core.missing_credentials("codex").unwrap(), ["openai"]);
        // Kept for later, readable by you alone.
        let saved = dir.join("logins").join("claude-code");
        assert_eq!(std::fs::read(&saved).unwrap(), b"{\"token\":1}");
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&saved).unwrap().permissions()) & 0o777, 0o600);
        // Another harness doesn't get it.
        core.create(named("c", "codex")).await.unwrap();
        assert!(fake.read_file("c", CLAUDE_LOGIN).await.is_err());
        assert!(fake.read_file("c", "/root/.codex/auth.json").await.is_err());
    }

    #[tokio::test]
    async fn a_refreshed_login_is_kept_when_its_sandbox_stops_or_is_deleted() {
        let fake = Arc::new(FakeBackend::default());
        let (core, _dir) = core_in_fresh_dir(fake.clone(), Arc::new(FakeSecrets::default()));
        core.create(named("a", "codex")).await.unwrap();
        fake.write_file("a", "/root/.codex/auth.json", b"v1".to_vec()).await.unwrap();
        core.stop("a").await.unwrap();
        core.create(named("b", "codex")).await.unwrap();
        assert_eq!(fake.read_file("b", "/root/.codex/auth.json").await.unwrap(), b"v1");
        // `b` refreshes its login, then is deleted: the next sandbox gets the refreshed one.
        fake.write_file("b", "/root/.codex/auth.json", b"v2".to_vec()).await.unwrap();
        core.delete("b").await.unwrap();
        core.create(named("c", "codex")).await.unwrap();
        assert_eq!(fake.read_file("c", "/root/.codex/auth.json").await.unwrap(), b"v2");
    }

    #[tokio::test]
    async fn a_stored_key_wins_over_a_reused_login() {
        let fake = Arc::new(FakeBackend::default());
        let secrets = Arc::new(FakeSecrets::default());
        let (core, _dir) = core_in_fresh_dir(fake.clone(), secrets.clone());
        core.create(named("a", "claude-code")).await.unwrap();
        fake.write_file("a", CLAUDE_LOGIN, b"login".to_vec()).await.unwrap();
        secrets.set("anthropic", "sk-ant-api03-x").unwrap();
        core.create(named("b", "claude-code")).await.unwrap();
        assert!(fake.read_file("b", CLAUDE_LOGIN).await.is_err(), "the key is used, so no login is copied in");
    }

    fn agent(task: &str) -> CreateOpts {
        CreateOpts { harness: Some("claude-code".into()), task: Some(task.into()), ..Default::default() }
    }

    #[tokio::test]
    async fn lifecycle_create_list_fork_delete() {
        let (_, core) = core_with(|_| true);
        let created = core.create(CreateOpts { name: Some("a".into()), ..Default::default() }).await.unwrap();
        assert_eq!(created.status, Status::Running);
        core.fork("a").await.unwrap();
        let names: Vec<_> = core.backend.list().await.unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["a", "a-fork-1"]);
        core.delete("a").await.unwrap();
        assert_eq!(core.backend.list().await.unwrap().len(), 1);
        assert!(core.delete("a").await.is_err());
    }

    #[tokio::test]
    async fn one_click_create_uses_defaults_and_reaches_running() {
        let (fake, core) = core_with(|_| true);
        let first = core.create(CreateOpts::default()).await.unwrap();
        let second = core.create(CreateOpts::default()).await.unwrap();
        assert_eq!((first.name.as_str(), second.name.as_str()), ("sandbox-1", "sandbox-2"));
        assert_eq!(first.status, Status::Running);
        let spec = fake.specs.lock().unwrap()[0].clone();
        assert_eq!(
            (spec.template.as_str(), spec.image.as_str(), spec.cpus, spec.memory_mib, spec.network.as_str()),
            ("base", "alpine:3.22", 1, 256, "public")
        );
        assert!(spec.ports.is_empty() && spec.mount.is_none() && spec.harness.is_none());
    }

    #[tokio::test]
    async fn desktop_template_gets_more_memory_and_a_vnc_port() {
        let (_, core) = core_with(|_| true);
        let info = core.create(CreateOpts { template: Some("desktop".into()), ..Default::default() }).await.unwrap();
        // A browser needs more than the base 256 MiB.
        assert_eq!(info.memory_mib, 2048);
        assert_eq!(info.ports, [Port { guest: VNC_PORT, host: VNC_PORT }]);
        // `desktop: true` without a harness is the same thing.
        let info = core.create(CreateOpts { desktop: Some(true), ..Default::default() }).await.unwrap();
        assert_eq!((info.template.as_str(), info.memory_mib), ("desktop", 2048));
    }

    #[tokio::test]
    async fn base_template_never_builds_a_snapshot() {
        let (fake, core) = core_with(|_| true);
        core.create(CreateOpts::default()).await.unwrap();
        assert!(fake.execs.lock().unwrap().is_empty());
        assert_eq!(fake.specs.lock().unwrap()[0].snapshot, None);
    }

    #[tokio::test]
    async fn create_with_a_harness_boots_its_snapshot_and_starts_it_in_tmux_on_the_task() {
        let (fake, core) = core_with(|_| true);
        let info = core.create(agent("fix the tests")).await.unwrap();
        assert_eq!(info.harness.as_deref(), Some("claude-code"));
        let spec = fake.specs.lock().unwrap().last().unwrap().clone();
        assert_eq!(spec.snapshot.as_deref(), Some("beambox-build-claude-code:beambox-claude-code-5"));
        assert_eq!((spec.image.as_str(), spec.cpus, spec.memory_mib), ("debian:trixie-slim", 2, 2048));
        assert_eq!(spec.harness.as_deref(), Some("claude-code"));
        let execs = fake.execs.lock().unwrap().clone();
        let (sandbox, start) = execs.last().unwrap();
        assert_eq!(sandbox, "sandbox-1");
        assert!(start.starts_with("tmux new-session -d -s agent -c /workspace "), "{start}");
        assert!(start.contains("claude -- '\\''fix the tests'\\''"), "{start}");
        let info_json = fake.files.lock().unwrap()[&("sandbox-1".to_string(), agent::INFO_PATH.to_string())].clone();
        let details: serde_json::Value = serde_json::from_slice(&info_json).unwrap();
        assert_eq!(details, serde_json::json!({ "name": "sandbox-1", "harness": "claude-code", "desktop": false }));
    }

    #[tokio::test]
    async fn the_snapshot_gets_mcp_js_and_the_harness_config() {
        let (fake, core) = core_with(|_| true);
        core.create(agent("x")).await.unwrap();
        let files = fake.files.lock().unwrap();
        let builder = "beambox-build-claude-code".to_string();
        assert_eq!(files[&(builder.clone(), agent::MCP_PATH.to_string())], agent::MCP_JS.as_bytes());
        assert!(String::from_utf8_lossy(&files[&(builder, "/root/.claude.json".to_string())]).contains("\"beambox\""));
    }

    #[tokio::test]
    async fn the_credential_is_only_in_the_harness_environment() {
        let (fake, core) = core_with(|_| true);
        let info = core.create(agent("fix the tests")).await.unwrap();
        core.backend.stop(&info.name).await.unwrap();
        core.start(&info.name).await.unwrap();
        core.fork(&info.name).await.unwrap();

        let envs = fake.envs.lock().unwrap().clone();
        assert_eq!(envs.len(), 3, "create, restart and fork each start the harness");
        assert!(envs.iter().all(|(_, env)| env == &[("ANTHROPIC_API_KEY".to_string(), KEY.to_string())]));
        let leaks = |text: &str| text.contains(KEY) || text.contains("secret-value");
        assert!(!fake.execs.lock().unwrap().iter().any(|(_, c)| leaks(c)), "no exec argument");
        assert!(!fake.files.lock().unwrap().values().any(|d| leaks(&String::from_utf8_lossy(d))), "no file");
        assert!(!fake.specs.lock().unwrap().iter().any(|s| leaks(&format!("{s:?}"))), "no sandbox config");
    }

    #[tokio::test]
    async fn without_a_stored_key_the_harness_starts_and_signs_in_itself() {
        let fake = Arc::new(FakeBackend::default());
        let core = Core::with_port_probe(fake.clone(), Arc::new(FakeSecrets::default()), |_| true);
        let info = core.create(agent("x")).await.unwrap();
        assert_eq!(info.harness.as_deref(), Some("claude-code"));
        // Started in tmux like any agent, with nothing in its environment: it shows its own login.
        let envs = fake.envs.lock().unwrap().clone();
        assert_eq!(envs, [(info.name.clone(), vec![])]);
        assert!(fake.execs.lock().unwrap().iter().any(|(n, c)| *n == info.name && c.contains("tmux new-session -d -s agent")));
        // The app still offers the key it could use.
        assert_eq!(core.missing_credentials("claude-code").unwrap(), ["anthropic"]);
        assert_eq!(core.missing_credentials("opencode").unwrap(), ["anthropic", "openai"]);
    }

    #[tokio::test]
    async fn opencode_skips_a_claude_subscription_token() {
        let fake = Arc::new(FakeBackend::default());
        let secrets = Arc::new(FakeSecrets::with("anthropic", "sk-ant-oat01-subscription"));
        let core = Core::with_port_probe(fake.clone(), secrets.clone(), |_| true);
        let opencode = |name: &str| CreateOpts { name: Some(name.into()), harness: Some("opencode".into()), ..Default::default() };
        // The subscription token is never handed to OpenCode, which then signs in on its own.
        core.create(opencode("a")).await.unwrap();
        assert_eq!(fake.envs.lock().unwrap()[0].1, []);
        assert_eq!(core.missing_credentials("opencode").unwrap(), ["anthropic", "openai"]);
        assert!(core.missing_credentials("claude-code").unwrap().is_empty());
        secrets.set("openai", "sk-proj-x").unwrap();
        assert!(core.missing_credentials("opencode").unwrap().is_empty());
        core.create(opencode("b")).await.unwrap();
        assert_eq!(fake.envs.lock().unwrap()[1].1, [("OPENAI_API_KEY".to_string(), "sk-proj-x".to_string())]);
    }

    #[tokio::test]
    async fn the_desktop_template_with_a_harness_is_an_agent_desktop() {
        let (fake, core) = core_with(|_| true);
        let opts = CreateOpts { template: Some("desktop".into()), ..agent("x") };
        let info = core.create(opts).await.unwrap();
        assert_eq!((info.template.as_str(), info.memory_mib), ("desktop", 4096));
        let spec = fake.specs.lock().unwrap().last().unwrap().clone();
        assert_eq!(spec.snapshot.as_deref(), Some("beambox-build-claude-code-desktop:beambox-claude-code-desktop-6"));
    }

    #[tokio::test]
    async fn each_snapshot_is_built_once_even_by_concurrent_creates() {
        let (fake, core) = core_with(|_| true);
        core.secrets.set("openai", "sk-proj-x").unwrap();
        let named = |name: &str, harness: Option<&str>, desktop| CreateOpts {
            name: Some(name.into()),
            harness: harness.map(String::from),
            desktop: Some(desktop),
            ..Default::default()
        };
        let (a, b) = tokio::join!(core.create(named("a", Some("codex"), false)), core.create(named("b", Some("codex"), false)));
        (a.unwrap(), b.unwrap());
        core.create(named("c", Some("codex"), true)).await.unwrap();
        core.create(named("d", Some("codex"), true)).await.unwrap();

        let builds: Vec<_> = fake.execs.lock().unwrap().iter().filter(|(_, c)| c.starts_with("set -e")).map(|(s, _)| s.clone()).collect();
        assert_eq!(builds, ["beambox-build-codex", "beambox-build-codex-desktop"]);
        let specs = fake.specs.lock().unwrap().clone();
        let snapshot = |name: &str| specs.iter().find(|s| s.name == name).unwrap().snapshot.clone().unwrap();
        assert_eq!(snapshot("a"), snapshot("b"));
        assert_eq!(snapshot("c"), "beambox-build-codex-desktop:beambox-codex-desktop-6");
        let c = specs.iter().find(|s| s.name == "c").unwrap();
        assert_eq!((c.memory_mib, c.ports.len(), c.template.as_str()), (4096, 1, "desktop"));
        let names: Vec<_> = core.backend.list().await.unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["a", "b", "c", "d"], "build sandboxes are deleted");
    }

    fn plain_desktop() -> CreateOpts {
        CreateOpts { desktop: Some(true), ..Default::default() }
    }

    #[tokio::test]
    async fn a_desktop_boots_from_the_published_image() {
        let (fake, core) = core_with(|_| true);
        let info = core.create(plain_desktop()).await.unwrap();
        assert_eq!((info.template.as_str(), info.notice.as_deref()), ("desktop", None));
        let spec = fake.specs.lock().unwrap()[0].clone();
        assert_eq!((spec.image.as_str(), spec.snapshot.as_deref()), (DESKTOP_IMAGE, None));
        assert!(fake.execs.lock().unwrap().is_empty(), "nothing is built");
    }

    #[tokio::test]
    async fn when_the_image_cant_be_pulled_the_desktop_is_built_locally_and_says_so() {
        let (fake, core) = core_with(|_| true);
        fake.failing_images.lock().unwrap().insert(DESKTOP_IMAGE.into());
        let info = core.create(plain_desktop()).await.unwrap();
        let notice = info.notice.unwrap();
        assert!(notice.contains("built the desktop on this computer"), "{notice}");
        assert!(notice.contains(DESKTOP_IMAGE) && notice.contains("registry unreachable"), "{notice}");
        assert_eq!((info.name.as_str(), info.ports.as_slice()), ("sandbox-1", &[Port { guest: VNC_PORT, host: VNC_PORT }][..]));
        let spec = fake.specs.lock().unwrap().last().unwrap().clone();
        assert_eq!(spec.snapshot.as_deref(), Some("beambox-build-desktop:beambox-desktop-5"));
        assert_eq!((spec.template.as_str(), spec.memory_mib), ("desktop", 2048));
        // The next one boots from that snapshot straight away: the same desktop, without asking the registry again.
        let second = core.create(plain_desktop()).await.unwrap();
        assert_eq!(second.notice, None);
        assert_eq!(fake.specs.lock().unwrap().last().unwrap().snapshot, spec.snapshot);
        let builds = fake.execs.lock().unwrap().iter().filter(|(_, c)| c.starts_with("set -e")).count();
        assert_eq!(builds, 1);
        let names: Vec<_> = core.backend.list().await.unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["sandbox-1", "sandbox-2"]);
    }

    #[tokio::test]
    async fn concurrent_desktops_falling_back_build_once_and_get_their_own_names_and_ports() {
        let fake = Arc::new(FakeBackend::default());
        let (core, _dir) = core_in_fresh_dir(fake.clone(), Arc::new(FakeSecrets::default()));
        fake.failing_images.lock().unwrap().insert(DESKTOP_IMAGE.into());
        let (a, b) = tokio::join!(core.create(plain_desktop()), core.create(plain_desktop()));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_ne!(a.name, b.name);
        assert_ne!(a.ports[0].host, b.ports[0].host);
        assert!(a.notice.is_some() && b.notice.is_some());
        let builds = fake.execs.lock().unwrap().iter().filter(|(_, c)| c.starts_with("set -e")).count();
        assert_eq!(builds, 1);
    }

    #[tokio::test]
    async fn a_taken_name_is_refused_before_anything_is_pulled_or_built() {
        let (fake, core) = core_with(|_| true);
        fake.failing_images.lock().unwrap().insert(DESKTOP_IMAGE.into());
        core.create(CreateOpts { name: Some("a".into()), ..Default::default() }).await.unwrap();
        let taken = CreateOpts { name: Some("a".into()), ..plain_desktop() };
        assert_eq!(core.create(taken).await.unwrap_err(), "sandbox a already exists");
        assert!(fake.execs.lock().unwrap().is_empty(), "nothing built");
        assert_eq!(fake.specs.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_desktop_image_tag_follows_the_desktop_snapshot() {
        let (_, member) = snapshot_key(None, true).unwrap();
        let (repo, tag) = DESKTOP_IMAGE.rsplit_once(':').unwrap();
        assert_eq!(repo, "ghcr.io/OWNER/beambox-desktop");
        assert_eq!(Some(tag), member.rsplit('-').next());
    }

    #[test]
    fn snapshot_names_are_group_and_member() {
        assert_eq!(snapshot_name(None, false), None);
        assert_eq!(snapshot_name(Some("opencode"), true).unwrap(), "beambox-build-opencode-desktop:beambox-opencode-desktop-6");
        for (h, d) in [(None, true), (Some("codex"), false)] {
            assert!(snapshot_key(h, d).unwrap().0.starts_with(BUILD_PREFIX));
        }
    }

    #[tokio::test]
    async fn take_over_stops_the_harness_process_group_and_hand_back_continues_it() {
        let (fake, core) = core_with(|_| true);
        core.create(agent("x")).await.unwrap();
        core.set_takeover("sandbox-1", true).await.unwrap();
        core.set_takeover("sandbox-1", false).await.unwrap();
        let execs = fake.execs.lock().unwrap().clone();
        let signals: Vec<_> = execs.iter().rev().take(2).rev().map(|(_, c)| c.clone()).collect();
        assert_eq!(signals, [takeover_command(true), takeover_command(false)]);
        assert!(signals[0].ends_with("kill -STOP $pids && tmux new-window -t agent"));
        assert!(signals[1].ends_with("kill -CONT $pids && tmux select-window -t agent:0"));
        assert!(signals[0].contains("pgrep -g \"$p\" | grep -vx \"$p\""), "the pane's own shell keeps running");

        assert!(!core.is_taken_over("sandbox-1").await.unwrap());
        let stopped = ExecResult { stdout: "Ts\n".into(), stderr: String::new(), exit_code: 0 };
        fake.replies.lock().unwrap().insert(takeover_probe(), stopped);
        assert!(core.is_taken_over("sandbox-1").await.unwrap());
        // No harness: the kill fails.
        fake.replies.lock().unwrap().insert(takeover_command(true), ExecResult { stdout: String::new(), stderr: String::new(), exit_code: 1 });
        assert!(core.set_takeover("sandbox-1", true).await.unwrap_err().contains("no agent"));
    }

    #[tokio::test]
    async fn port_collision_retries_next_free_port() {
        // 8080 and 8081 are taken on the host.
        let (_, core) = core_with(|p| p != 8080 && p != 8081);
        let opts = CreateOpts { ports: Some(vec![8080, 8082]), ..Default::default() };
        let info = core.create(opts).await.unwrap();
        // 8082 went to the first port, so the second one moves on to 8083.
        assert_eq!(info.ports, [Port { guest: 8080, host: 8082 }, Port { guest: 8082, host: 8083 }]);
    }

    #[tokio::test]
    async fn fork_gets_its_own_name_and_host_ports() {
        let (_, core) = core_with(|_| true);
        core.create(CreateOpts { name: Some("a".into()), ports: Some(vec![3000]), ..Default::default() }).await.unwrap();
        let child = core.fork("a").await.unwrap();
        assert_eq!(child.name, "a-fork-1");
        assert_eq!(child.ports, [Port { guest: 3000, host: 3001 }]);
        assert_eq!(core.fork("a").await.unwrap().ports, [Port { guest: 3000, host: 3002 }]);
    }
}
