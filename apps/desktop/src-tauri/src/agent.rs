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
    /// npm package with the harness's CLI, and the command it installs.
    package: &'static str,
    bin: &'static str,
    /// Credentials it can use, in order of preference.
    pub credentials: &'static [&'static str],
    /// Where it keeps its sign-in (subscription or key) after you log in inside the sandbox.
    pub login_path: &'static str,
    /// Runs before the harness when no key is stored: signs in unless already signed in (a reused login).
    /// `None` when the harness works without signing in and offers it inside (OpenCode's free models, `/connect`).
    sign_in: Option<&'static str>,
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
        bin: "claude",
        credentials: &["anthropic"],
        login_path: "/root/.claude/.credentials.json",
        sign_in: Some("claude auth status >/dev/null 2>&1 || claude auth login"),
        config_path: "/root/.claude.json",
        config: r#"{
  "hasCompletedOnboarding": true,
  "projects": { "/workspace": { "hasTrustDialogAccepted": true } },
  "mcpServers": { "beambox": { "type": "stdio", "command": "node", "args": ["/opt/beambox/mcp.js"] } }
}
"#,
        command: |task| task.map_or("claude".into(), |t| format!("claude -- {t}")),
    },
    Harness {
        name: "codex",
        package: "@openai/codex",
        bin: "codex",
        credentials: &["openai"],
        login_path: "/root/.codex/auth.json",
        // Device code: the browser step needs no callback into the sandbox.
        sign_in: Some("codex login status >/dev/null 2>&1 || codex login --device-auth"),
        config_path: "/root/.codex/config.toml",
        config: "[mcp_servers.beambox]\ncommand = \"node\"\nargs = [\"/opt/beambox/mcp.js\"]\n",
        command: |task| task.map_or("codex".into(), |t| format!("codex -- {t}")),
    },
    Harness {
        name: "opencode",
        package: "opencode-ai",
        bin: "opencode",
        credentials: &["anthropic", "openai"],
        login_path: "/root/.local/share/opencode/auth.json",
        sign_in: None,
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
    /// from tmux's global environment and the shell after it, so only the harness has it. With `sign_in` (no key
    /// stored), the harness's own login runs first; links it opens go to the computer's browser (`beambox-open`).
    pub fn start_command(&self, task: Option<&str>, sign_in: bool) -> String {
        let mut harness = (self.command)(task.map(sh_quote).as_deref());
        if let (true, Some(login)) = (sign_in, self.sign_in) {
            harness = format!("{login}; {harness}");
        }
        let unset = format!("unset {}", CREDENTIAL_VARS.join(" "));
        let forget: Vec<_> = CREDENTIAL_VARS.iter().map(|v| format!(" && tmux set-environment -g -u {v}")).collect();
        format!(
            "tmux new-session -d -s {SESSION} -c /workspace -e BROWSER={OPEN_PATH} {}{}",
            sh_quote(&format!("{harness}; {unset}; exec bash -l")),
            forget.concat()
        )
    }
}

/// The sandbox's browser: hands links to the Beambox app (see `images/agent/beambox-open`).
pub const OPEN_PATH: &str = "/usr/local/bin/beambox-open";

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

/// `packages/desktop-image/image/` as (path in that folder, contents): `install.sh` and the files it installs. The Dockerfile copies
/// the same folder.
const DESKTOP_FILES: &[(&str, &str)] = &[
    ("install.sh", include_str!("../../../../packages/desktop-image/image/install.sh")),
    ("beambox-desktop", include_str!("../../../../packages/desktop-image/image/beambox-desktop")),
    ("start-desktop", include_str!("../../../../packages/desktop-image/image/start-desktop")),
    ("desktop-watch", include_str!("../../../../packages/desktop-image/image/desktop-watch")),
    ("set-wallpaper", include_str!("../../../../packages/desktop-image/image/set-wallpaper")),
    ("set-wallpaper.desktop", include_str!("../../../../packages/desktop-image/image/set-wallpaper.desktop")),
    ("Xresources", include_str!("../../../../packages/desktop-image/image/Xresources")),
    ("openbox/themerc", include_str!("../../../../packages/desktop-image/image/openbox/themerc")),
    ("openbox/close.xbm", include_str!("../../../../packages/desktop-image/image/openbox/close.xbm")),
    ("openbox/iconify.xbm", include_str!("../../../../packages/desktop-image/image/openbox/iconify.xbm")),
    ("openbox/max.xbm", include_str!("../../../../packages/desktop-image/image/openbox/max.xbm")),
    ("openbox/max_toggled.xbm", include_str!("../../../../packages/desktop-image/image/openbox/max_toggled.xbm")),
    ("tint2rc", include_str!("../../../../packages/desktop-image/image/tint2rc")),
    ("plank.dconf", include_str!("../../../../packages/desktop-image/image/plank.dconf")),
    ("applications/xterm.desktop", include_str!("../../../../packages/desktop-image/image/applications/xterm.desktop")),
    ("applications/files.desktop", include_str!("../../../../packages/desktop-image/image/applications/files.desktop")),
    ("chromium-flags", include_str!("../../../../packages/desktop-image/image/chromium-flags")),
    ("browser-preferences.json", include_str!("../../../../packages/desktop-image/image/browser-preferences.json")),
    ("browser-policies.json", include_str!("../../../../packages/desktop-image/image/browser-policies.json")),
];
const DESKTOP_DIR: &str = "/tmp/beambox-desktop";
const INSTALL_SH: &str = DESKTOP_FILES[0].1;

/// Shell script that turns `debian:trixie-slim` into Beambox's one base snapshot, which every sandbox boots from:
/// the desktop's packages (`install.sh packages`), Node 24, tmux, git and every harness. Packages only: the files
/// that configure them go in when each sandbox is created (`sandbox_setup`), so changing those never needs a new
/// snapshot.
pub fn base_setup() -> String {
    let apt = "apt-get install -y --no-install-recommends";
    let harnesses: String = HARNESSES.iter().map(install_harness).collect();
    format!(
        "set -e\nexport DEBIAN_FRONTEND=noninteractive\n{}sh {DESKTOP_DIR}/install.sh packages\nrm -rf {DESKTOP_DIR}\n\
         apt-get update\n{apt} ca-certificates curl gnupg git tmux procps\n\
         curl -fsSL https://deb.nodesource.com/setup_24.x | bash -\n{apt} nodejs\n\
         {harnesses}mkdir -p /workspace /opt/beambox /etc/beambox\napt-get clean\nrm -rf /var/lib/apt/lists/*\n",
        file(&format!("{DESKTOP_DIR}/install.sh"), INSTALL_SH),
    )
}

/// Install the harness and check that it runs. npm skips a platform binary it can't fetch without failing (a new
/// release published before its arm64 binary did that to Codex), so a snapshot could keep a harness that never
/// starts. Retry a few times, then fail the build instead.
fn install_harness(harness: &Harness) -> String {
    let (package, bin) = (harness.package, harness.bin);
    format!(
        "for try in 1 2 3; do\n\
         \x20 if npm install -g {package} && {bin} --version >/dev/null 2>&1; then break; fi\n\
         \x20 if [ \"$try\" = 3 ]; then echo \"{bin} doesn't run after installing {package}\" >&2; false; fi\n\
         \x20 sleep 20\n\
         done\n"
    )
}

/// Shell script that sets up a new sandbox from the base snapshot, before its desktop starts: a desktop gets the
/// desktop's files (`install.sh files`: its scripts, theme, dock and browser settings), an agent sandbox the
/// sandbox's browser (`beambox-open`) and tmux's passthrough for it. `mcp.js` and the harness's MCP config are
/// written as files afterwards. These come from the app itself, so a new version of Beambox changes them in new
/// sandboxes without building the snapshot again.
pub fn sandbox_setup(harness: Option<&Harness>, desktop: bool) -> Option<String> {
    let mut script = String::new();
    if desktop {
        let files: String = DESKTOP_FILES.iter().map(|(path, body)| file(&format!("{DESKTOP_DIR}/{path}"), body)).collect();
        script += &format!("{files}sh {DESKTOP_DIR}/install.sh files\nrm -rf {DESKTOP_DIR}\n");
    }
    if let Some(h) = harness {
        script += &format!(
            "echo 'set -g allow-passthrough all' > /etc/tmux.conf\n{}chmod +x {OPEN_PATH}\nmkdir -p \"$(dirname {})\"\n",
            file(OPEN_PATH, include_str!("../../images/agent/beambox-open")),
            h.config_path,
        );
    }
    (!script.is_empty()).then(|| format!("set -e\n{script}"))
}

/// The program the Terminal tab and `beambox attach` run: the agent's tmux session for agent sandboxes (a
/// shell if the session is gone), a login shell otherwise.
pub fn terminal_command(harness: Option<&str>) -> Vec<String> {
    let args: &[&str] = match harness {
        Some(_) => &["/bin/sh", "-c", "tmux attach -t agent 2>/dev/null || exec /bin/sh -l"],
        // bash when the image has it (desktops do), for its prompt and line editing; Alpine has only sh. The window
        // sends its size just after opening, and bash loses its first prompt to that resize, so it starts a moment
        // later, at the right size (exec sessions can't be given a size up front).
        None => &["/bin/sh", "-c", "sleep 0.2; command -v bash >/dev/null && exec bash -l || exec /bin/sh -l"],
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
        let start = |h: &str, task| harness(h).unwrap().start_command(task, false);
        let unset = "unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY; exec bash -l";
        let forget = " && tmux set-environment -g -u ANTHROPIC_API_KEY && tmux set-environment -g -u CLAUDE_CODE_OAUTH_TOKEN \
                      && tmux set-environment -g -u OPENAI_API_KEY";
        let session = "tmux new-session -d -s agent -c /workspace -e BROWSER=/usr/local/bin/beambox-open";
        assert_eq!(
            start("claude-code", Some("fix the tests")),
            format!(r#"{session} 'claude -- '\''fix the tests'\''; {unset}'{forget}"#)
        );
        assert_eq!(start("codex", None), format!("{session} 'codex; {unset}'{forget}"));
        // A task that looks like a flag is still the prompt.
        assert!(start("codex", Some("-v is broken")).contains("codex -- '\\''-v is broken'\\''"));
        assert!(start("opencode", Some("go")).contains("opencode --prompt go;"));
        assert!(harness("gemini").err().unwrap().contains("claude-code, codex, opencode"));
    }

    #[test]
    fn without_a_key_the_harness_signs_in_first_unless_already_signed_in() {
        let start = |h: &str| harness(h).unwrap().start_command(Some("go"), true);
        assert!(start("claude-code").contains("'claude auth status >/dev/null 2>&1 || claude auth login; claude -- go;"));
        assert!(start("codex").contains("'codex login status >/dev/null 2>&1 || codex login --device-auth; codex -- go;"));
        // OpenCode runs on its free models and offers /connect inside, so it starts straight away.
        assert!(start("opencode").contains("-e BROWSER=/usr/local/bin/beambox-open 'opencode --prompt go;"));
        // With a stored key there's nothing to sign in to.
        assert!(!harness("claude-code").unwrap().start_command(None, false).contains("auth"));
    }

    #[test]
    fn a_snapshot_build_fails_rather_than_keep_a_harness_that_doesnt_run() {
        let setup = base_setup();
        for (package, bin) in [("@anthropic-ai/claude-code", "claude"), ("@openai/codex", "codex"), ("opencode-ai", "opencode")] {
            assert!(setup.contains(&format!("npm install -g {package} && {bin} --version >/dev/null 2>&1; then break; fi")), "{bin}");
            assert!(setup.contains(&format!("{bin} doesn't run after installing")), "{bin}");
        }
    }

    #[test]
    fn links_opened_in_the_sandbox_reach_the_app_through_tmux() {
        let setup = sandbox_setup(Some(harness("codex").unwrap()), false).unwrap();
        assert!(setup.contains("echo 'set -g allow-passthrough all' > /etc/tmux.conf"));
        assert!(setup.contains("cat > /usr/local/bin/beambox-open <<'EOF'\n#!/bin/sh\n"));
        assert!(setup.contains("chmod +x /usr/local/bin/beambox-open"));
        assert!(setup.contains("mkdir -p \"$(dirname /root/.codex/config.toml)\""));
        let script = include_str!("../../images/agent/beambox-open");
        assert!(script.contains("https://*) ;;"), "only https links");
        assert!(script.contains("]1337;BeamboxOpen=%s"));
        // Claude Code doesn't ask whether to trust /workspace.
        let config: serde_json::Value = serde_json::from_str(harness("claude-code").unwrap().config().1).unwrap();
        assert_eq!(config["projects"]["/workspace"]["hasTrustDialogAccepted"], true);
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
    fn the_base_snapshot_has_the_desktops_packages_node_and_every_harness_but_no_files() {
        let base = base_setup();
        assert!(base.starts_with("set -e\n"));
        for part in ["tmux", "git", "ca-certificates", "setup_24.x", "sh /tmp/beambox-desktop/install.sh packages\n"] {
            assert!(base.contains(part), "{part}");
        }
        assert_eq!(base.matches("\nEOF\n").count(), 1, "install.sh alone");
        assert!(base.ends_with("rm -rf /var/lib/apt/lists/*\n"));
    }

    #[test]
    fn each_sandbox_gets_only_the_files_it_needs() {
        assert_eq!(sandbox_setup(None, false), None);
        let desktop = sandbox_setup(None, true).unwrap();
        assert!(desktop.contains("sh /tmp/beambox-desktop/install.sh files\n") && !desktop.contains("beambox-open"));
        let agent = sandbox_setup(Some(harness("claude-code").unwrap()), false).unwrap();
        assert!(!agent.contains("install.sh") && agent.contains("beambox-open"));
        let both = sandbox_setup(Some(harness("claude-code").unwrap()), true).unwrap();
        assert!(both.contains("install.sh files") && both.contains("beambox-open"));
    }

    /// The files in `packages/desktop-image/image/` (what the Dockerfile copies), relative to it, without the Dockerfile.
    fn desktop_folder() -> Vec<String> {
        fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    out.push(path.strip_prefix(root).unwrap().to_string_lossy().into_owned());
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/desktop-image/image");
        let mut files = vec![];
        walk(&root, &root, &mut files);
        files.retain(|f| f != "Dockerfile");
        files.sort();
        files
    }

    #[test]
    fn a_new_desktop_runs_install_sh_with_every_file_beside_it() {
        let mut embedded: Vec<String> = DESKTOP_FILES.iter().map(|(path, _)| path.to_string()).collect();
        embedded.sort();
        assert_eq!(embedded, desktop_folder());
        let script = sandbox_setup(None, true).unwrap();
        assert!(script.starts_with("set -e\n"));
        assert!(script.contains("cat > /tmp/beambox-desktop/install.sh <<'EOF'\n#!/bin/sh\n"));
        assert!(script.contains("cat > /tmp/beambox-desktop/openbox/themerc <<'EOF'\n"));
        assert!(script.ends_with("sh /tmp/beambox-desktop/install.sh files\nrm -rf /tmp/beambox-desktop\n"));
        // Every embedded file ends in a newline, so its EOF marker stands on a line of its own.
        assert_eq!(script.matches("\nEOF\n").count(), DESKTOP_FILES.len());
        assert!(DESKTOP_FILES.iter().all(|(_, body)| body.ends_with('\n')));
    }

    #[test]
    fn install_sh_installs_chromium_and_never_google_chrome() {
        let install = include_str!("../../../../packages/desktop-image/image/install.sh");
        assert!(install.contains(" chromium \\\n") || install.contains(" chromium\n"), "{install}");
        assert!(install.contains("/etc/chromium/policies/managed/beambox.json"));
        assert!(install.contains("/etc/chromium/master_preferences"));
        for (path, body) in DESKTOP_FILES {
            let body = body.to_lowercase();
            assert!(!body.contains("google-chrome") && !body.contains("dl.google.com"), "{path}");
        }
    }

    #[test]
    fn the_desktop_looks_like_macos_and_its_browser_runs_as_root() {
        let install = include_str!("../../../../packages/desktop-image/image/install.sh");
        // Traffic-light buttons on the left, a top bar, a dock with the browser, files and terminal, an app launcher.
        assert!(install.contains("<titleLayout>CIML</titleLayout>"));
        for part in ["plank", "tint2", "rofi", "fonts-inter", "papirus-icon-theme", "librsvg2-common", "dconf-gsettings-backend"] {
            assert!(install.contains(part), "{part}");
        }
        let plank = include_str!("../../../../packages/desktop-image/image/plank.dconf");
        assert!(plank.contains("dock-items=['browser.dockitem', 'files.dockitem', 'terminal.dockitem']"));
        assert!(plank.contains("hide-mode='none'"));
        assert!(install.contains("Launcher=file:///usr/share/applications/chromium.desktop"));
        // Everything runs as root, where Chromium refuses to start with its own sandbox on.
        assert!(include_str!("../../../../packages/desktop-image/image/chromium-flags").contains("export CHROMIUM_FLAGS=\"$CHROMIUM_FLAGS --no-sandbox --test-type\""));
        assert!(include_str!("../../../../packages/desktop-image/image/browser-preferences.json").contains("\"custom_chrome_frame\": false"));
        assert!(include_str!("../../../../packages/desktop-image/image/browser-policies.json").contains("\"BrowserSignin\": 0"));
        let start = include_str!("../../../../packages/desktop-image/image/start-desktop");
        for part in ["Xvnc :0 -geometry 1280x800", "xcompmgr", "tint2 -c /etc/xdg/tint2/tint2rc", "eval \"$(dbus-launch --sh-syntax)\"", "setsid desktop-watch"] {
            assert!(start.contains(part), "{part}");
        }
        // The image's CMD starts the same desktop, then stays in the foreground while Xvnc runs.
        let foreground = include_str!("../../../../packages/desktop-image/image/beambox-desktop");
        assert!(foreground.contains("start-desktop\n") && foreground.contains("while pgrep Xvnc"), "{foreground}");
        assert!(install.contains("/usr/local/bin/beambox-desktop"));
    }

    #[test]
    fn the_terminal_joins_the_agent_session_only_in_agent_sandboxes() {
        assert!(terminal_command(None)[2].ends_with("command -v bash >/dev/null && exec bash -l || exec /bin/sh -l"));
        assert!(terminal_command(Some("codex"))[2].starts_with("tmux attach -t agent"));
    }

    #[test]
    fn the_bundled_mcp_server_is_embedded() {
        assert!(MCP_JS.len() > 10_000 && MCP_JS.contains("sandbox_info"));
    }
}
