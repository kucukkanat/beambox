//! `SandboxBackend` on the microsandbox SDK. Beambox metadata is stored as sandbox labels.
use crate::backend::{DirEntry, ExecResult, Metrics, Port, Result, SandboxBackend, SandboxInfo, Spec, Status};
use async_trait::async_trait;
use microsandbox::sandbox::{FsEntryKind, SandboxHandle, SandboxStatus, VolumeMount};
use microsandbox::{NetworkPolicy, NetworkProfile, Sandbox};
use std::net::{IpAddr, Ipv4Addr};

const TEMPLATE: &str = "beambox.template";
const HARNESS: &str = "beambox.harness";
/// The `Spec::network` name, as the stored policy can't be mapped back to it.
const NETWORK: &str = "beambox.network";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub struct MicroBackend;

/// A live connection to a running sandbox, for exec, files and the terminal.
pub async fn connect(name: &str) -> Result<Sandbox> {
    Sandbox::get(name).await.map_err(err)?.connect().await.map_err(err)
}

fn info(handle: &SandboxHandle) -> Result<SandboxInfo> {
    let spec = handle.config().map_err(err)?.spec;
    let label = |key: &str| spec.labels.get(key).cloned();
    let ports = spec.network.ports.iter().map(|p| Port { guest: p.guest_port, host: p.host_port }).collect();
    let mount = spec.mounts.iter().find_map(|m| match m {
        VolumeMount::Bind { host, guest, .. } if guest == "/workspace" => Some(host.to_string_lossy().into_owned()),
        _ => None,
    });
    let status = match handle.status_snapshot() {
        SandboxStatus::Created | SandboxStatus::Starting => Status::Booting,
        SandboxStatus::Running | SandboxStatus::Draining => Status::Running,
        SandboxStatus::Paused | SandboxStatus::Stopped => Status::Stopped,
        SandboxStatus::Crashed => Status::Crashed,
    };
    // The record changes when the sandbox starts or stops, so while it runs this is when it started.
    let started_at = handle.updated_at().filter(|_| matches!(status, Status::Running)).map(|t| t.timestamp_millis());
    Ok(SandboxInfo {
        name: handle.name().to_string(),
        template: label(TEMPLATE).unwrap_or_else(|| "custom".into()),
        status,
        cpus: spec.resources.cpus,
        memory_mib: spec.resources.memory_mib,
        harness: label(HARNESS),
        ports,
        mount,
        // Boxes made before the label existed got the default.
        network: label(NETWORK).unwrap_or_else(|| "public".into()),
        started_at,
        web_url: None,
    })
}

/// The desktop image ships a script that starts Xvnc, openbox, tint2 and a terminal in the background.
async fn after_boot(sandbox: &Sandbox, template: &str) -> Result<()> {
    if template == "desktop" {
        sandbox.shell("start-desktop").await.map_err(err)?;
    }
    Ok(())
}

#[async_trait]
impl SandboxBackend for MicroBackend {
    async fn create(&self, spec: Spec) -> Result<SandboxInfo> {
        let builder = Sandbox::builder(&spec.name);
        // `override_snapshot` boots from a disk snapshot like `msb restore`, but keeps the normal builder,
        // so labels, ports and mounts work. `Sandbox::restore` can't set labels.
        let mut builder = match &spec.snapshot {
            Some(snapshot) => builder.override_snapshot(snapshot),
            None => builder.image(spec.image.as_str()),
        }
            .cpus(spec.cpus)
            .memory(spec.memory_mib)
            .label(TEMPLATE, &spec.template)
            .label(NETWORK, &spec.network);
        if let Some(harness) = &spec.harness {
            builder = builder.label(HARNESS, harness);
        }
        if let Some(folder) = &spec.mount {
            builder = builder.volume("/workspace", |m| m.bind(folder));
        }
        for port in &spec.ports {
            builder = builder.port_bind(IpAddr::V4(Ipv4Addr::LOCALHOST), port.host, port.guest);
        }
        let policy = match spec.network.as_str() {
            "none" => NetworkPolicy::none(),
            "all" => NetworkPolicy::allow_all(),
            _ => NetworkPolicy::from_profiles([NetworkProfile::Public]),
        };
        builder = builder.network(|n| n.policy(policy));
        // The builder's own create resolves a snapshot before validating the image; `build()` doesn't.
        let sandbox = builder.create_detached().await.map_err(err)?;
        if let Some(setup) = &spec.setup {
            let out = sandbox.exec_with("/bin/sh", |o| o.args(["-c", setup.as_str()])).await.map_err(err)?;
            if !out.status().success {
                return Err(format!("setting up {} failed: {}", spec.name, String::from_utf8_lossy(out.stderr_bytes()).trim()));
            }
        }
        after_boot(&sandbox, &spec.template).await?;
        info(&Sandbox::get(&spec.name).await.map_err(err)?)
    }

    async fn list(&self) -> Result<Vec<SandboxInfo>> {
        let all = Sandbox::list().await.map_err(err)?.sandboxes;
        all.iter().filter(|h| !h.name().starts_with(crate::core::BUILD_PREFIX)).map(info).collect()
    }

    async fn start(&self, name: &str) -> Result<()> {
        let handle = Sandbox::get(name).await.map_err(err)?;
        let template = info(&handle)?.template;
        let sandbox = handle.start_detached().await.map_err(err)?;
        after_boot(&sandbox, &template).await
    }

    async fn stop(&self, name: &str) -> Result<()> {
        Sandbox::get(name).await.map_err(err)?.stop().await.map_err(err)
    }

    async fn fork(&self, name: &str, child: &str, ports: &[Port]) -> Result<SandboxInfo> {
        // The child keeps the source's network policy and mounts; only host ports must differ.
        let mut fork = Sandbox::get(name).await.map_err(err)?.fork(child).dangerously_inherit_resources();
        for port in ports {
            fork = fork.port_bind(IpAddr::V4(Ipv4Addr::LOCALHOST), port.host, port.guest);
        }
        fork.fork().await.map_err(err)?;
        let info = info(&Sandbox::get(child).await.map_err(err)?)?;
        // The child boots fresh, so its desktop must be started like after any boot.
        after_boot(&connect(child).await?, &info.template).await?;
        Ok(info)
    }

    async fn snapshot(&self, name: &str, snapshot: &str) -> Result<()> {
        Sandbox::get(name).await.map_err(err)?.snapshot(snapshot).await.map(|_| ()).map_err(err)
    }

    async fn has_snapshot(&self, snapshot: &str) -> Result<bool> {
        Ok(microsandbox::Snapshot::get(snapshot).await.is_ok())
    }

    async fn list_snapshots(&self) -> Result<Vec<String>> {
        let all = microsandbox::Snapshot::list().await.map_err(err)?;
        // A handle's name is the member alone: `<group>:<member>` is what lookups and removal take.
        Ok(all
            .iter()
            .filter_map(|s| match (s.group(), s.name()) {
                (Some(group), Some(member)) if !member.contains(':') => Some(format!("{group}:{member}")),
                (_, name) => name.map(str::to_string),
            })
            .collect())
    }

    async fn remove_snapshot(&self, snapshot: &str) -> Result<()> {
        // Not forced: microsandbox refuses a snapshot that's in use or has child snapshots.
        microsandbox::Snapshot::remove(snapshot, false).await.map_err(err)
    }

    async fn delete(&self, name: &str) -> Result<()> {
        Sandbox::get(name).await.map_err(err)?.destroy().await.map_err(err)
    }

    async fn exec(&self, name: &str, command: &str) -> Result<ExecResult> {
        self.exec_env(name, command, &[]).await
    }

    async fn exec_env(&self, name: &str, command: &str, env: &[(String, String)]) -> Result<ExecResult> {
        let sandbox = connect(name).await?;
        let out = sandbox.exec_with("/bin/sh", |o| o.args(["-c", command]).envs(env.iter().cloned())).await.map_err(err)?;
        Ok(ExecResult {
            stdout: String::from_utf8_lossy(out.stdout_bytes()).into_owned(),
            stderr: String::from_utf8_lossy(out.stderr_bytes()).into_owned(),
            exit_code: out.status().code,
        })
    }

    async fn read_file(&self, name: &str, path: &str) -> Result<Vec<u8>> {
        Ok(connect(name).await?.fs().read(path).await.map_err(err)?.to_vec())
    }

    async fn write_file(&self, name: &str, path: &str, data: Vec<u8>) -> Result<()> {
        connect(name).await?.fs().write(path, data).await.map_err(err)
    }

    async fn list_dir(&self, name: &str, path: &str) -> Result<Vec<DirEntry>> {
        let entries = connect(name).await?.fs().list(path).await.map_err(err)?;
        Ok(entries.into_iter().map(|e| DirEntry {
                path: e.path,
                dir: matches!(e.kind, FsEntryKind::Directory),
                link: matches!(e.kind, FsEntryKind::Symlink),
            }).collect())
    }

    async fn logs(&self, name: &str) -> Result<Vec<String>> {
        let opts = microsandbox::logs::LogOptions { tail: Some(500), ..Default::default() };
        let entries = Sandbox::get(name).await.map_err(err)?.logs(&opts).await.map_err(err)?;
        Ok(entries.into_iter().map(|e| String::from_utf8_lossy(&e.data).into_owned()).collect())
    }

    async fn metrics(&self, name: &str) -> Result<Metrics> {
        let m = Sandbox::get(name).await.map_err(err)?.metrics().await.map_err(err)?;
        Ok(Metrics { cpu_percent: m.cpu_percent, memory_bytes: m.memory_bytes })
    }
}

/// Real microsandbox, not run by default. Needs MSB_PATH, MSB_LIBKRUNFW_PATH and MSB_HOME (see README):
/// `cargo test real_ -- --ignored`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{CreateOpts, Core, base_snapshot_name};
    use crate::credentials::fake::FakeSecrets;
    use std::sync::Arc;

    fn core() -> Core {
        // A made-up key: the harness starts, it just can't reach the API.
        let secrets = Arc::new(FakeSecrets::with("anthropic", "sk-ant-api03-not-a-real-key"));
        Core::new(Arc::new(MicroBackend), secrets, std::env::temp_dir())
    }

    #[tokio::test]
    #[ignore = "reads the real snapshot store"]
    async fn real_snapshot_names_are_the_ones_lookups_take() {
        let names = MicroBackend.list_snapshots().await.unwrap();
        for name in &names {
            assert!(name.contains(':'), "{name} has no group");
            assert!(MicroBackend.has_snapshot(name).await.unwrap(), "{name} isn't found by its own name");
        }
    }

    #[tokio::test]
    #[ignore = "boots real microVMs"]
    async fn real_desktop_boots_from_the_base_snapshot() {
        let core = core();
        let opts = |name: &str| CreateOpts { name: Some(name.into()), template: Some("desktop".into()), ..Default::default() };
        for name in ["it-desktop-1", "it-desktop-2"] {
            let _ = core.backend.delete(name).await;
            let info = core.create(opts(name)).await.unwrap();
            assert_eq!(info.template.as_str(), "desktop");
            let out = core.backend.exec(name, "pgrep Xvnc >/dev/null && pgrep tint2 >/dev/null && pgrep plank >/dev/null && which openbox chromium").await.unwrap();
            assert_eq!(out.exit_code, 0, "{out:?}");
        }
        // The image's CMD stays in the foreground while the desktop runs (`timeout` ends it: 124).
        let out = core.backend.exec("it-desktop-1", "timeout 5 beambox-desktop; echo $?").await.unwrap();
        assert_eq!(out.stdout, "124\n", "{out:?}");
        // A restarted or forked desktop keeps the old X lock on disk; its desktop must still come up.
        let running = "pgrep Xvnc >/dev/null && pgrep openbox >/dev/null && netstat -ltn | grep -q ':5900 '";
        core.backend.stop("it-desktop-1").await.unwrap();
        core.start("it-desktop-1").await.unwrap();
        let fork = core.fork("it-desktop-2").await.unwrap();
        for name in ["it-desktop-1", fork.name.as_str()] {
            let out = core.backend.exec(name, running).await.unwrap();
            assert_eq!(out.exit_code, 0, "{name}: {out:?}");
        }
        core.backend.stop(&fork.name).await.unwrap();
        core.backend.delete(&fork.name).await.unwrap();
        assert!(core.backend.has_snapshot(&base_snapshot_name()).await.unwrap());
        let names: Vec<_> = core.backend.list().await.unwrap().into_iter().map(|s| s.name).collect();
        assert!(!names.iter().any(|n| n.starts_with(crate::core::BUILD_PREFIX)), "{names:?}");
        for name in ["it-desktop-1", "it-desktop-2"] {
            core.backend.stop(name).await.unwrap();
            core.backend.delete(name).await.unwrap();
        }
    }

    /// Answers `initialize` on stdin, then the pipe closes and the server exits.
    const MCP_INITIALIZE: &str = r#"printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"it","version":"0"}}}' | timeout 10 node /opt/beambox/mcp.js"#;

    async fn real_agent(name: &str, desktop: bool) {
        let core = core();
        let _ = core.backend.stop(name).await;
        let _ = core.backend.delete(name).await;
        let opts = CreateOpts {
            name: Some(name.into()),
            harness: Some("claude-code".into()),
            task: Some("say hi".into()),
            desktop: Some(desktop),
            ..Default::default()
        };
        let info = core.create(opts).await.unwrap();
        assert_eq!(info.harness.as_deref(), Some("claude-code"));
        let check = |command: &'static str| {
            let core = &core;
            async move { core.backend.exec(name, command).await.unwrap() }
        };
        let version = check("claude --version").await;
        assert_eq!(version.exit_code, 0, "{version:?}");
        assert!(check("cat /root/.claude.json").await.stdout.contains("/opt/beambox/mcp.js"));
        let mcp = check(MCP_INITIALIZE).await;
        assert!(mcp.stdout.contains(r#""serverInfo":{"name":"beambox""#), "{mcp:?}");
        let session = check("tmux list-sessions -F '#{session_name}' && tmux display-message -p -t agent '#{pane_current_path}'").await;
        assert_eq!(session.stdout, "agent\n/workspace\n", "{session:?}");
        // The key is in the harness's environment, not on disk.
        let on_disk = check("grep -rl not-a-real-key /root /etc /opt /workspace /tmp 2>/dev/null; true").await;
        assert_eq!(on_disk.stdout, "", "{on_disk:?}");
        let tmux_env = check("tmux show-environment -g; tmux show-environment -t agent").await;
        assert!(!tmux_env.stdout.contains("not-a-real-key"), "only the harness has the key");
        core.set_takeover(name, true).await.unwrap();
        assert!(core.is_taken_over(name).await.unwrap());
        assert_eq!(check("tmux display-message -p -t agent '#{window_index}'").await.stdout, "1\n", "a shell for you");
        core.set_takeover(name, false).await.unwrap();
        assert!(!core.is_taken_over(name).await.unwrap());
        if desktop {
            let browser = check("(command -v google-chrome || command -v chromium) && netstat -ltn | grep -q ':5900 '").await;
            assert_eq!(browser.exit_code, 0, "{browser:?}");
        }
        core.backend.stop(name).await.unwrap();
        core.backend.delete(name).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "boots real microVMs and downloads the harness"]
    async fn real_agent_runs_claude_code_with_the_mcp_server() {
        real_agent("it-agent", false).await;
    }

    #[tokio::test]
    #[ignore = "boots real microVMs and downloads the harness and a browser"]
    async fn real_agent_desktop_has_a_browser_and_vnc() {
        real_agent("it-agent-desktop", true).await;
    }
}
