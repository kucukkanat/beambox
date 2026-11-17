//! `beambox --mcp`: a stdio MCP server over the same core as the GUI.
use crate::core::{Core, CreateOpts};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, schemars, tool, tool_handler, tool_router};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize, schemars::JsonSchema)]
pub struct Name {
    /// Sandbox name.
    pub name: String,
}

/// What an agent may choose. Host folder mounts and network policy stay GUI-only, so an agent can't widen
/// its own sandbox's access to the host.
#[derive(Deserialize, schemars::JsonSchema)]
pub struct Create {
    /// Sandbox name. Defaults to `sandbox-<n>`.
    pub name: Option<String>,
    /// `base` (default: Alpine, 256 MiB) or `desktop` (X desktop over VNC, 512 MiB).
    pub template: Option<String>,
    /// Guest ports to publish on the host's 127.0.0.1.
    pub ports: Option<Vec<u16>>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct Exec {
    /// Sandbox name.
    pub name: String,
    /// Shell command, run with `/bin/sh -c`.
    pub command: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct FileRead {
    pub name: String,
    /// Absolute path inside the sandbox.
    pub path: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct FileWrite {
    pub name: String,
    /// Absolute path inside the sandbox.
    pub path: String,
    /// UTF-8 file contents.
    pub content: String,
}

#[derive(Clone)]
pub struct McpServer {
    core: Arc<Core>,
    tool_router: ToolRouter<Self>,
}

type Out = Result<String, String>;

fn json(value: impl serde::Serialize) -> Out {
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

fn client(ctx: &RequestContext<RoleServer>) -> String {
    ctx.peer.peer_info().map_or_else(|| "unknown".into(), |info| info.client_info.name.clone())
}

#[tool_router(router = tool_router)]
impl McpServer {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core, tool_router: Self::tool_router() }
    }

    /// One agent call, guarded by take-over and shown in the activity feed (see `Core::agent_call`).
    async fn on<T>(
        &self,
        ctx: &RequestContext<RoleServer>,
        sandbox: &str,
        command: &str,
        call: impl Future<Output = Result<T, String>>,
        exit: impl Fn(&T) -> i32,
    ) -> Result<T, String> {
        self.core.agent_call(&client(ctx), sandbox, command, call, exit).await
    }

    #[tool(description = "Create and boot a microVM sandbox. All fields are optional; defaults: base template, 1 vCPU, 256 MiB.")]
    async fn sandbox_create(&self, Parameters(p): Parameters<Create>, ctx: RequestContext<RoleServer>) -> Out {
        let agent = client(&ctx);
        let opts = CreateOpts { name: p.name, template: p.template, ports: p.ports, ..Default::default() };
        let info = self.core.create(opts, Some(agent.clone())).await?;
        self.core.record(&self.core.new_activity_id(), &info.name, &agent, "sandbox_create", Some(0));
        json(info)
    }

    #[tool(description = "List all sandboxes with status, template and published ports.")]
    async fn sandbox_list(&self) -> Out {
        json(self.core.backend.list().await?)
    }

    #[tool(description = "Run a shell command in a sandbox. Returns stdout, stderr and exitCode.")]
    async fn sandbox_exec(&self, Parameters(p): Parameters<Exec>, ctx: RequestContext<RoleServer>) -> Out {
        let run = self.core.backend.exec(&p.name, &p.command);
        json(self.on(&ctx, &p.name, &p.command, run, |r| r.exit_code).await?)
    }

    #[tool(description = "Read a UTF-8 file from a sandbox.")]
    async fn file_read(&self, Parameters(p): Parameters<FileRead>, ctx: RequestContext<RoleServer>) -> Out {
        let read = self.core.backend.read_file(&p.name, &p.path);
        let bytes = self.on(&ctx, &p.name, &format!("read {}", p.path), read, |_| 0).await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tool(description = "Write a UTF-8 file into a sandbox, replacing it if it exists.")]
    async fn file_write(&self, Parameters(p): Parameters<FileWrite>, ctx: RequestContext<RoleServer>) -> Out {
        let write = self.core.backend.write_file(&p.name, &p.path, p.content.into_bytes());
        self.on(&ctx, &p.name, &format!("write {}", p.path), write, |_| 0).await?;
        Ok("ok".into())
    }

    #[tool(description = "Stop a running sandbox. It can be started again from the app.")]
    async fn sandbox_stop(&self, Parameters(p): Parameters<Name>, ctx: RequestContext<RoleServer>) -> Out {
        let stop = self.core.backend.stop(&p.name);
        self.on(&ctx, &p.name, "sandbox_stop", stop, |_| 0).await?;
        Ok("ok".into())
    }

    #[tool(description = "Delete a sandbox and its disk.")]
    async fn sandbox_delete(&self, Parameters(p): Parameters<Name>, ctx: RequestContext<RoleServer>) -> Out {
        let delete = self.core.delete(&p.name);
        self.on(&ctx, &p.name, "sandbox_delete", delete, |_| 0).await?;
        Ok("ok".into())
    }
}

#[tool_handler(
    router = self.tool_router,
    name = "beambox",
    instructions = "Each sandbox is a microVM. Create one with sandbox_create, then run commands with sandbox_exec."
)]
impl ServerHandler for McpServer {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::FakeBackend;
    use rmcp::ServiceExt;
    use rmcp::model::{CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation};
    use serde_json::{Value, json};

    struct Agent {
        client: rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>,
        core: Arc<Core>,
        fake: Arc<FakeBackend>,
    }

    async fn connect(name: &str) -> Agent {
        let fake = Arc::new(FakeBackend::default());
        let core = Arc::new(Core::with_port_probe(fake.clone(), crate::core::temp_dir(), |_| true));
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let server = McpServer::new(core.clone());
        tokio::spawn(async move { server.serve(server_io).await.unwrap().waiting().await });
        let info = ClientConfig::new(ClientCapabilities::default(), Implementation::new(name, "1.0"));
        Agent { client: info.serve(client_io).await.unwrap(), core, fake }
    }

    impl Agent {
        async fn call(&self, tool: &'static str, args: Value) -> CallToolResult {
            let params = CallToolRequestParams::new(tool).with_arguments(args.as_object().unwrap().clone());
            self.client.call_tool(params).await.unwrap()
        }
    }

    fn text(result: &CallToolResult) -> String {
        result.content.iter().filter_map(|c| c.as_text()).map(|t| t.text.clone()).collect()
    }

    #[tokio::test]
    async fn lists_the_seven_tools() {
        let agent = connect("claude-code").await;
        let mut names: Vec<String> =
            agent.client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
        names.sort();
        let want = [
            "file_read", "file_write", "sandbox_create", "sandbox_delete", "sandbox_exec", "sandbox_list", "sandbox_stop",
        ];
        assert_eq!(names, want);
    }

    #[tokio::test]
    async fn create_labels_the_sandbox_with_the_client_name() {
        let agent = connect("cursor").await;
        let created: Value = serde_json::from_str(&text(&agent.call("sandbox_create", json!({})).await)).unwrap();
        assert_eq!(created["agent"], "cursor");
        assert_eq!(agent.core.backend.list().await.unwrap()[0].agent.as_deref(), Some("cursor"));
    }

    #[tokio::test]
    async fn agents_cannot_mount_host_folders_or_open_the_network() {
        let agent = connect("cursor").await;
        agent.call("sandbox_create", json!({ "mount": "/", "network": "all" })).await;
        let spec = agent.fake.specs.lock().unwrap()[0].clone();
        assert_eq!((spec.mount, spec.network.as_str()), (None, "public"));
    }

    #[tokio::test]
    async fn exec_returns_stdout_stderr_and_exit_code() {
        let agent = connect("claude-code").await;
        agent.call("sandbox_create", json!({ "name": "a" })).await;
        let out = agent.call("sandbox_exec", json!({ "name": "a", "command": "echo hi; echo oops >&2; exit 3" })).await;
        let out: Value = serde_json::from_str(&text(&out)).unwrap();
        assert_eq!(out, json!({ "stdout": "hi\n", "stderr": "oops\n", "exitCode": 3 }));
    }

    #[tokio::test]
    async fn calls_are_rejected_during_take_over() {
        let agent = connect("claude-code").await;
        agent.call("sandbox_create", json!({ "name": "a" })).await;
        agent.core.set_takeover("a", true).unwrap();
        for (tool, args) in [
            ("sandbox_exec", json!({ "name": "a", "command": "echo hi" })),
            ("file_write", json!({ "name": "a", "path": "/x", "content": "y" })),
            ("sandbox_delete", json!({ "name": "a" })),
        ] {
            let result = agent.call(tool, args).await;
            assert_eq!(result.is_error, Some(true), "{tool}");
            assert!(text(&result).contains("taken over sandbox 'a'"), "{tool}: {}", text(&result));
        }
        agent.core.set_takeover("a", false).unwrap();
        assert_ne!(agent.call("sandbox_exec", json!({ "name": "a", "command": "echo hi" })).await.is_error, Some(true));
    }

    #[tokio::test]
    async fn activity_feed_receives_exec_events_in_order() {
        let agent = connect("claude-code").await;
        let mut feed = agent.core.events.subscribe();
        agent.call("sandbox_create", json!({ "name": "a" })).await;
        for command in ["echo 1", "echo 2; exit 1", "echo 3"] {
            agent.call("sandbox_exec", json!({ "name": "a", "command": command })).await;
        }
        let mut seen = Vec::new();
        for _ in 0..7 {
            let event = feed.recv().await.unwrap();
            assert_eq!((event.sandbox.as_str(), event.agent.as_str()), ("a", "claude-code"));
            seen.push((event.id, event.command, event.exit_code));
        }
        let commands: Vec<_> = seen.iter().map(|(_, c, e)| (c.as_str(), *e)).collect();
        // Each exec shows up when it starts (no exit code yet) and again when it ends.
        assert_eq!(
            commands,
            [
                ("sandbox_create", Some(0)),
                ("echo 1", None),
                ("echo 1", Some(0)),
                ("echo 2; exit 1", None),
                ("echo 2; exit 1", Some(1)),
                ("echo 3", None),
                ("echo 3", Some(0)),
            ]
        );
        let ids: Vec<_> = seen.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!((ids[1], ids[3], ids[5]), (ids[2], ids[4], ids[6]));
        assert_eq!(ids.iter().collect::<std::collections::BTreeSet<_>>().len(), 4);
    }
}
