//! Agent harnesses: how each one is installed into a snapshot, wired to Beambox's MCP server and started.
use crate::backend::Result;

/// Beambox's MCP server (`apps/sandbox-mcp`), bundled into one file and copied into every agent snapshot.
pub const MCP_JS: &str = include_str!("../../../sandbox-mcp/dist/mcp.js");
pub const MCP_PATH: &str = "/opt/beambox/mcp.js";
/// What the MCP server reports as `sandbox_info`; written at every start.
pub const INFO_PATH: &str = "/etc/beambox/sandbox.json";
/// The tmux session the harness runs in. The Terminal tab and `beambox attach` join it.
pub const SESSION: &str = "agent";
pub const IMAGE: &str = "debian:trixie-slim";

pub struct Harness {
    pub name: &'static str,
    /// npm package with the harness's CLI.
    package: &'static str,
    /// Credentials it can use, in order of preference.
    pub credentials: &'static [&'static str],
    /// Its user-level MCP config file and the contents that register `beambox`.
    pub config_path: &'static str,
    config: &'static str,
    /// The command line, given the shell-quoted task.
    command: fn(Option<&str>) -> String,
}

pub const HARNESSES: &[Harness] = &[
    Harness {
        name: "claude-code",
        package: "@anthropic-ai/claude-code",
        credentials: &["anthropic"],
        config_path: "/root/.claude.json",
        config: r#"{
  "hasCompletedOnboarding": true,
  "mcpServers": { "beambox": { "type": "stdio", "command": "node", "args": ["/opt/beambox/mcp.js"] } }
}
"#,
        command: |task| task.map_or("claude".into(), |t| format!("claude -- {t}")),
    },
    Harness {
        name: "codex",
        package: "@openai/codex",
        credentials: &["openai"],
        config_path: "/root/.codex/config.toml",
        config: "[mcp_servers.beambox]\ncommand = \"node\"\nargs = [\"/opt/beambox/mcp.js\"]\n",
        command: |task| task.map_or("codex".into(), |t| format!("codex -- {t}")),
    },
    Harness {
        name: "opencode",
        package: "opencode-ai",
        credentials: &["anthropic", "openai"],
        config_path: "/root/.config/opencode/opencode.json",
        config: r#"{
  "$schema": "https://opencode.ai/config.json",
  "mcp": { "beambox": { "type": "local", "command": ["node", "/opt/beambox/mcp.js"], "enabled": true } }
}
"#,
        command: |task| task.map_or("opencode".into(), |t| format!("opencode --prompt {t}")),
    },
];

pub fn harness(name: &str) -> Result<&'static Harness> {
    let names: Vec<_> = HARNESSES.iter().map(|h| h.name).collect();
    HARNESSES.iter().find(|h| h.name == name).ok_or_else(|| format!("unknown harness {name}; use one of {}", names.join(", ")))
}

impl Harness {
    pub fn config(&self) -> (&'static str, &'static str) {
        (self.config_path, self.config)
    }

    /// Starts the harness detached in tmux session `agent`, in `/workspace`. When it exits, a shell stays in
    /// the session. tmux passes the caller's environment (the credential) on to the harness; it is then removed
    /// from tmux's global environment and the shell after it, so only the harness has it.
    pub fn start_command(&self, task: Option<&str>) -> String {
        let harness = (self.command)(task.map(sh_quote).as_deref());
        let unset = format!("unset {}", CREDENTIAL_VARS.join(" "));
        let forget: Vec<_> = CREDENTIAL_VARS.iter().map(|v| format!(" && tmux set-environment -g -u {v}")).collect();
        format!(
            "tmux new-session -d -s {SESSION} -c /workspace {}{}",
            sh_quote(&format!("{harness}; {unset}; exec bash -l")),
            forget.concat()
        )
    }
}

const CREDENTIAL_VARS: &[&str] = &["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"];

/// The environment variable a credential is passed to `harness` as, or `None` if it can't use it. Claude
/// subscription tokens (`claude setup-token`, `sk-ant-oat…`) work only in Claude Code, as
/// `CLAUDE_CODE_OAUTH_TOKEN`; Anthropic API keys go in `ANTHROPIC_API_KEY`.
pub fn credential_env(harness: &Harness, provider: &str, value: &str) -> Option<(String, String)> {
    let key = match provider {
        "openai" => "OPENAI_API_KEY",
        _ if value.starts_with("sk-ant-oat") && harness.name == "claude-code" => "CLAUDE_CODE_OAUTH_TOKEN",
        _ if value.starts_with("sk-ant-oat") => return None,
        _ => "ANTHROPIC_API_KEY",
    };
    Some((key.into(), value.into()))
}

/// Quote `arg` for `/bin/sh` when it needs it.
pub fn sh_quote(arg: &str) -> String {
    let plain = !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:,@%+".contains(c));
    if plain { arg.into() } else { format!("'{}'", arg.replace('\'', r"'\''")) }
}

/// `cat > path <<'EOF'` for one embedded file.
fn file(path: &str, body: &str) -> String {
    format!("mkdir -p \"$(dirname {path})\"\ncat > {path} <<'EOF'\n{body}EOF\n")
}

fn desktop_files() -> String {
    format!(
        "{}{}{}chmod +x /usr/local/bin/start-desktop\n",
        file("/usr/local/bin/start-desktop", include_str!("../../images/desktop/start-desktop")),
        file("/etc/beambox/Xresources", include_str!("../../images/desktop/Xresources")),
        include_str!("../../images/desktop/theme.sh"),
    )
}

/// Shell script that turns plain Alpine into the desktop template: TigerVNC's Xvnc (X server and VNC server in
/// one), openbox with a dark theme, the tint2 panel and xterm.
pub fn desktop_setup() -> String {
    format!("set -e\napk add --no-cache tigervnc openbox tint2 xterm xsetroot font-dejavu\n{}", desktop_files())
}

/// Shell script that turns `debian:trixie-slim` into an agent snapshot: Node 24, the harness, tmux and git, and
/// optionally the same desktop as `desktop_setup` plus Chrome (x86-64) or Chromium (arm64). `mcp.js` and the
/// harness's MCP config are written as files afterwards.
pub fn agent_setup(harness: &Harness, desktop: bool) -> String {
    let apt = "apt-get install -y --no-install-recommends";
    let mut script = format!(
        "set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update\n\
         {apt} ca-certificates curl gnupg git tmux procps\n\
         curl -fsSL https://deb.nodesource.com/setup_24.x | bash -\n{apt} nodejs\n\
         npm install -g {}\nmkdir -p /workspace /opt/beambox /etc/beambox \"$(dirname {})\"\n",
        harness.package, harness.config_path,
    );
    if desktop {
        script += &format!(
            "{apt} tigervnc-standalone-server tigervnc-tools openbox tint2 xterm x11-xserver-utils fonts-dejavu-core \
             net-tools\n\
             if [ \"$(dpkg --print-architecture)\" = amd64 ]; then\n\
             curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb\n\
             {apt} /tmp/chrome.deb && rm /tmp/chrome.deb\nelse\n{apt} chromium\nfi\n\
             ln -sf debian-xterm.desktop /usr/share/applications/xterm.desktop\n{}",
            desktop_files()
        );
    }
    script + "apt-get clean\nrm -rf /var/lib/apt/lists/*\n"
}

/// The program the Terminal tab and `beambox attach` run: the agent's tmux session for agent sandboxes (a
/// shell if the session is gone), a login shell otherwise.
pub fn terminal_command(harness: Option<&str>) -> Vec<String> {
    let args: &[&str] = match harness {
        Some(_) => &["/bin/sh", "-c", "tmux attach -t agent 2>/dev/null || exec /bin/sh -l"],
        None => &["/bin/sh", "-l"],
    };
    args.iter().map(|a| a.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mcp_config_registers_node_mcp_js_as_beambox() {
        for h in HARNESSES {
            let (path, config) = h.config();
            assert!(path.starts_with("/root/"), "{path}");
            let beambox = if path.ends_with(".toml") {
                assert!(config.starts_with("[mcp_servers.beambox]\n"), "{config}");
                let command = config.lines().find_map(|l| l.strip_prefix("command = ")).unwrap();
                let args = config.lines().find_map(|l| l.strip_prefix("args = ")).unwrap();
                serde_json::json!({ "command": serde_json::from_str::<String>(command).unwrap(), "args": serde_json::from_str::<serde_json::Value>(args).unwrap() })
            } else {
                let json: serde_json::Value = serde_json::from_str(config).unwrap();
                let server = json.get("mcpServers").or(json.get("mcp")).unwrap()["beambox"].clone();
                match server["command"].as_array() {
                    // OpenCode: one array, the program first.
                    Some(all) => serde_json::json!({ "command": all[0], "args": all[1..] }),
                    None => serde_json::json!({ "command": server["command"], "args": server["args"] }),
                }
            };
            assert_eq!(beambox, serde_json::json!({ "command": "node", "args": [MCP_PATH] }), "{}", h.name);
        }
        assert_eq!(harness("codex").unwrap().config().0, "/root/.codex/config.toml");
        assert_eq!(harness("opencode").unwrap().config().0, "/root/.config/opencode/opencode.json");
        assert_eq!(harness("claude-code").unwrap().config().0, "/root/.claude.json");
    }

    #[test]
    fn harnesses_start_in_tmux_with_the_task_as_first_prompt() {
        let start = |h: &str, task| harness(h).unwrap().start_command(task);
        let unset = "unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY; exec bash -l";
        let forget = " && tmux set-environment -g -u ANTHROPIC_API_KEY && tmux set-environment -g -u CLAUDE_CODE_OAUTH_TOKEN \
                      && tmux set-environment -g -u OPENAI_API_KEY";
        assert_eq!(
            start("claude-code", Some("fix the tests")),
            format!(r#"tmux new-session -d -s agent -c /workspace 'claude -- '\''fix the tests'\''; {unset}'{forget}"#)
        );
        assert_eq!(start("codex", None), format!("tmux new-session -d -s agent -c /workspace 'codex; {unset}'{forget}"));
        // A task that looks like a flag is still the prompt.
        assert!(start("codex", Some("-v is broken")).contains("codex -- '\\''-v is broken'\\''"));
        assert!(start("opencode", Some("go")).contains("opencode --prompt go;"));
        assert!(harness("gemini").err().unwrap().contains("claude-code, codex, opencode"));
    }

    #[test]
    fn subscription_tokens_and_api_keys_use_their_own_variables() {
        let [claude, codex, opencode] = ["claude-code", "codex", "opencode"].map(|h| harness(h).unwrap());
        assert_eq!(credential_env(claude, "anthropic", "sk-ant-oat01-x").unwrap().0, "CLAUDE_CODE_OAUTH_TOKEN");
        assert_eq!(credential_env(claude, "anthropic", "sk-ant-api03-x").unwrap().0, "ANTHROPIC_API_KEY");
        assert_eq!(credential_env(codex, "openai", "sk-proj-x"), Some(("OPENAI_API_KEY".into(), "sk-proj-x".into())));
        // OpenCode can't use a Claude subscription token.
        assert_eq!(credential_env(opencode, "anthropic", "sk-ant-oat01-x"), None);
        assert_eq!(credential_env(opencode, "anthropic", "sk-ant-api03-x").unwrap().0, "ANTHROPIC_API_KEY");
    }

    #[test]
    fn agent_snapshots_get_node_the_harness_and_tmux_and_desktops_a_browser() {
        let plain = agent_setup(harness("claude-code").unwrap(), false);
        assert!(plain.starts_with("set -e\n"));
        for part in ["tmux", "git", "ca-certificates", "setup_24.x", "npm install -g @anthropic-ai/claude-code"] {
            assert!(plain.contains(part), "{part}");
        }
        assert!(!plain.contains("Xvnc") && !plain.contains("chrom"));
        let desktop = agent_setup(harness("codex").unwrap(), true);
        for part in ["tigervnc-standalone-server", "openbox", "tint2", "google-chrome-stable_current_amd64.deb", " chromium\n", "Xvnc :0", "<name>Onyx</name>"] {
            assert!(desktop.contains(part), "{part}");
        }
        assert!(desktop.ends_with("rm -rf /var/lib/apt/lists/*\n"));
    }

    #[test]
    fn desktop_setup_installs_the_start_script() {
        let script = desktop_setup();
        assert!(script.starts_with("set -e\napk add --no-cache tigervnc openbox tint2"));
        assert!(script.contains("cat > /usr/local/bin/start-desktop <<'EOF'\n#!/bin/sh\n"));
        assert!(script.contains("Xvnc :0 -geometry 1280x800"));
        assert!(script.contains("cat > /etc/beambox/Xresources <<'EOF'\n"));
        assert!(script.contains("<name>Onyx</name>"));
        assert!(script.ends_with("chmod +x /usr/local/bin/start-desktop\n"));
        // Every embedded file ends in a newline, so its EOF marker stands on a line of its own.
        assert_eq!(script.matches("\nEOF\n").count(), 2);
    }

    #[test]
    fn the_terminal_joins_the_agent_session_only_in_agent_sandboxes() {
        assert_eq!(terminal_command(None), ["/bin/sh", "-l"]);
        assert!(terminal_command(Some("codex"))[2].starts_with("tmux attach -t agent"));
    }

    #[test]
    fn the_bundled_mcp_server_is_embedded() {
        assert!(MCP_JS.len() > 10_000 && MCP_JS.contains("sandbox_info"));
    }
}
