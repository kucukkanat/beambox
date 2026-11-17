//! `SandboxBackend` on the microsandbox SDK. Beambox metadata is stored as sandbox labels.
use crate::backend::{DirEntry, ExecResult, Metrics, Port, Result, SandboxBackend, SandboxInfo, Spec, Status};
use async_trait::async_trait;
use microsandbox::sandbox::{FsEntryKind, SandboxHandle, SandboxStatus};
use microsandbox::{NetworkPolicy, NetworkProfile, Sandbox};
use std::net::{IpAddr, Ipv4Addr};

const TEMPLATE: &str = "beambox.template";
const AGENT: &str = "beambox.agent";

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
    Ok(SandboxInfo {
        name: handle.name().to_string(),
        template: label(TEMPLATE).unwrap_or_else(|| "custom".into()),
        status: match handle.status_snapshot() {
            SandboxStatus::Created | SandboxStatus::Starting => Status::Booting,
            SandboxStatus::Running | SandboxStatus::Draining => Status::Running,
            SandboxStatus::Paused | SandboxStatus::Stopped => Status::Stopped,
            SandboxStatus::Crashed => Status::Crashed,
        },
        cpus: spec.resources.cpus,
        memory_mib: spec.resources.memory_mib,
        agent: label(AGENT),
        ports,
    })
}

/// The desktop image ships a script that starts Xvfb, openbox and x11vnc in the background.
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
            .label(TEMPLATE, &spec.template);
        if let Some(agent) = &spec.agent {
            builder = builder.label(AGENT, agent);
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

    async fn delete(&self, name: &str) -> Result<()> {
        Sandbox::get(name).await.map_err(err)?.destroy().await.map_err(err)
    }

    async fn exec(&self, name: &str, command: &str) -> Result<ExecResult> {
        let out = connect(name).await?.exec("/bin/sh", ["-c", command]).await.map_err(err)?;
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
        Ok(entries.into_iter().map(|e| DirEntry { path: e.path, dir: matches!(e.kind, FsEntryKind::Directory) }).collect())
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
/// `cargo test real_desktop -- --ignored`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{CreateOpts, Core, DESKTOP_SNAPSHOT};
    use std::sync::Arc;

    #[tokio::test]
    #[ignore = "boots real microVMs"]
    async fn real_desktop_boots_from_the_local_snapshot() {
        let core = Core::new(Arc::new(MicroBackend), crate::core::temp_dir());
        let opts = |name: &str| CreateOpts { name: Some(name.into()), template: Some("desktop".into()), ..Default::default() };
        for name in ["it-desktop-1", "it-desktop-2"] {
            let _ = core.backend.delete(name).await;
            let info = core.create(opts(name), Some("it".into())).await.unwrap();
            assert_eq!((info.template.as_str(), info.agent.as_deref()), ("desktop", Some("it")));
            let out = core.backend.exec(name, "sleep 1; pgrep x11vnc >/dev/null && which Xvfb openbox").await.unwrap();
            assert_eq!(out.exit_code, 0, "{out:?}");
        }
        // A restarted or forked desktop keeps the old X lock on disk; its desktop must still come up.
        let running = "pgrep Xvfb >/dev/null && pgrep openbox >/dev/null && netstat -ltn | grep -q ':5900 '";
        core.backend.stop("it-desktop-1").await.unwrap();
        core.backend.start("it-desktop-1").await.unwrap();
        let fork = core.fork("it-desktop-2").await.unwrap();
        for name in ["it-desktop-1", fork.name.as_str()] {
            let out = core.backend.exec(name, running).await.unwrap();
            assert_eq!(out.exit_code, 0, "{name}: {out:?}");
        }
        core.backend.stop(&fork.name).await.unwrap();
        core.backend.delete(&fork.name).await.unwrap();
        assert!(core.backend.has_snapshot(DESKTOP_SNAPSHOT).await.unwrap());
        let names: Vec<_> = core.backend.list().await.unwrap().into_iter().map(|s| s.name).collect();
        assert!(!names.iter().any(|n| n.starts_with(crate::core::BUILD_PREFIX)), "{names:?}");
        for name in ["it-desktop-1", "it-desktop-2"] {
            core.backend.stop(name).await.unwrap();
            core.backend.delete(name).await.unwrap();
        }
    }
}
