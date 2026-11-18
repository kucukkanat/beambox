//! `beambox <command>`: the command line, over the same core as the GUI.
use crate::agent::sh_quote;
use crate::backend::{Result, SandboxInfo};
use crate::core::{Core, CreateOpts};
use crate::credentials;
use clap::{Parser, Subcommand, ValueEnum};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(name = "beambox", version, about = "microVM sandboxes for AI agents. Run with no command to open the app.")]
pub struct Cli {
    /// Print JSON instead of text.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug, PartialEq)]
pub enum Command {
    /// List sandboxes.
    List,
    /// Create and boot a sandbox. Everything left out gets the one-click default.
    Create {
        /// Defaults to sandbox-<n>.
        name: Option<String>,
        /// `base` (Debian, 1 GiB) or `desktop` (X desktop over VNC, 4 GiB).
        #[arg(short, long, value_parser = ["base", "desktop"])]
        template: Option<String>,
        /// Make an agent sandbox: install this harness and start it in tmux session `agent`.
        #[arg(long, value_parser = ["claude-code", "codex", "opencode"])]
        harness: Option<String>,
        /// The harness's first prompt.
        #[arg(long, requires = "harness")]
        task: Option<String>,
        /// Add a desktop (Xvnc; agent sandboxes also get Chrome or Chromium).
        #[arg(long)]
        desktop: bool,
        /// vCPUs (default 1).
        #[arg(long)]
        cpus: Option<u8>,
        /// Memory in MiB.
        #[arg(long, value_name = "MIB")]
        memory: Option<u32>,
        /// Host folder to mount at /workspace.
        #[arg(long, value_name = "FOLDER")]
        mount: Option<PathBuf>,
        /// `public` (internet, no local network), `none` or `all`.
        #[arg(long, value_parser = ["public", "none", "all"])]
        network: Option<String>,
        /// Guest port to publish on 127.0.0.1. Repeat for more.
        #[arg(short, long = "port", value_name = "PORT")]
        ports: Vec<u16>,
        /// Also serve the desktop to a browser on 127.0.0.1, and print its link.
        #[arg(long)]
        web: bool,
    },
    /// Start a stopped sandbox.
    Start { name: String },
    /// Stop a running sandbox.
    Stop { name: String },
    /// Copy a sandbox into `<name>-fork-<n>`.
    Fork { name: String },
    /// Save a sandbox's disk as a snapshot.
    Snapshot { name: String },
    /// Delete a sandbox and its disk.
    Delete { name: String },
    /// Run a command in a sandbox and exit with its exit code.
    Exec {
        name: String,
        /// One shell string (`'make && make test'`), or a program and its arguments after `--`.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        command: Vec<String>,
    },
    /// Open an interactive shell in a sandbox.
    Shell { name: String },
    /// Join the agent's terminal (tmux session `agent`) in an agent sandbox. Detach with Ctrl-b d.
    Attach { name: String },
    /// List a folder in a sandbox.
    Ls {
        name: String,
        #[arg(default_value = "/")]
        path: String,
    },
    /// Print a file from a sandbox.
    Cat { name: String, path: String },
    /// Write a file into a sandbox from a local file, or from stdin.
    Put { name: String, path: String, file: Option<PathBuf> },
    /// Print a sandbox's logs.
    Logs {
        name: String,
        /// Keep printing new lines.
        #[arg(short, long)]
        follow: bool,
    },
    /// Show CPU and memory use.
    Stats { name: String },
    /// Show or change take-over. `on` freezes the agent so you can use the sandbox; `off` hands it back.
    Takeover { name: String, state: Option<Toggle> },
    /// Store harness credentials in the OS keychain.
    Credentials {
        #[command(subcommand)]
        action: Credentials,
    },
    /// Open a sandbox's desktop in the Beambox app.
    Desktop { name: String },
    /// Check that this computer can run sandboxes.
    Doctor,
}

#[derive(Subcommand, Debug, PartialEq)]
pub enum Credentials {
    /// Store a key or token, read from stdin (never echoed). `anthropic` takes an API key or a
    /// `claude setup-token` token.
    Set {
        #[arg(value_parser = credentials::PROVIDERS.to_vec())]
        name: String,
    },
    /// Names of the stored credentials.
    List,
    /// Forget a credential.
    Remove {
        #[arg(value_parser = credentials::PROVIDERS.to_vec())]
        name: String,
    },
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq)]
pub enum Toggle {
    On,
    Off,
}

/// What a `beambox` process should be, from its arguments (without the program name).
#[derive(Debug, PartialEq)]
pub enum Mode {
    /// The window, optionally opened on a sandbox's desktop.
    Gui(Option<String>),
    Cli,
}

pub fn mode(args: &[String]) -> Mode {
    match args.first().map(String::as_str) {
        // macOS passes `-psn_…` to apps launched from Finder on older versions.
        None => Mode::Gui(None),
        Some(arg) if arg.starts_with("-psn_") => Mode::Gui(None),
        Some("--open") => Mode::Gui(args.get(1).cloned()),
        Some(_) => Mode::Cli,
    }
}

/// Where a command's output goes. Tests pass buffers.
pub struct Io<'a> {
    pub stdin: &'a mut dyn Read,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
}

fn io_err(e: std::io::Error) -> String {
    e.to_string()
}

fn json(io: &mut Io, value: impl serde::Serialize) -> Result<()> {
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    writeln!(io.stdout, "{text}").map_err(io_err)
}

/// One argument is a shell string as typed; several are a program and its arguments, quoted as given.
pub fn shell_command(args: &[String]) -> String {
    match args {
        [one] => one.clone(),
        many => many.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" "),
    }
}

/// The lines of `next` that come after what `prev` already showed. Both are tails of the same log.
pub fn new_lines<'a>(prev: &[String], next: &'a [String]) -> &'a [String] {
    let overlap = (0..=prev.len().min(next.len())).rev().find(|&k| prev[prev.len() - k..] == next[..k]).unwrap_or(0);
    &next[overlap..]
}

fn table(sandboxes: &[SandboxInfo]) -> String {
    let rows: Vec<[String; 6]> = sandboxes
        .iter()
        .map(|s| {
            let ports: Vec<_> = s.ports.iter().map(|p| format!("{}→{}", p.host, p.guest)).collect();
            [
                s.name.clone(),
                format!("{:?}", s.status).to_lowercase(),
                s.template.clone(),
                format!("{} vCPU, {} MiB", s.cpus, s.memory_mib),
                s.harness.clone().unwrap_or_else(|| "-".into()),
                if ports.is_empty() { "-".into() } else { ports.join(", ") },
            ]
        })
        .collect();
    let header = ["NAME", "STATUS", "TEMPLATE", "SIZE", "HARNESS", "PORTS"].map(String::from);
    let all: Vec<&[String; 6]> = std::iter::once(&header).chain(&rows).collect();
    let widths: Vec<usize> = (0..6).map(|i| all.iter().map(|r| r[i].chars().count()).max().unwrap_or(0)).collect();
    all.iter()
        .map(|row| {
            let cells: Vec<_> = row.iter().zip(&widths).map(|(c, w)| format!("{c:w$}")).collect();
            format!("{}\n", cells.join("  ").trim_end())
        })
        .collect()
}

fn describe(s: &SandboxInfo) -> String {
    let ports: Vec<_> = s.ports.iter().map(|p| format!("127.0.0.1:{} → {}", p.host, p.guest)).collect();
    let ports = if ports.is_empty() { String::new() } else { format!(", ports {}", ports.join(", ")) };
    let kind = match &s.harness {
        Some(h) => format!("{h}, {}", s.template),
        None => s.template.clone(),
    };
    format!("{} is running ({kind}{ports})", s.name)
}

/// Run a non-interactive command and return the process exit code. `Shell`, `Attach`, `Desktop` and `Doctor`
/// need a real terminal, app or hypervisor and are handled by `main`.
pub async fn run(cli: &Cli, core: &Core, io: &mut Io<'_>) -> Result<i32> {
    let done = |io: &mut Io, text: String| if cli.json { Ok(()) } else { writeln!(io.stdout, "{text}").map_err(io_err) };
    match &cli.command {
        Command::List => {
            let all = core.backend.list().await?;
            if cli.json {
                json(io, all)?
            } else if all.is_empty() {
                writeln!(io.stdout, "No sandboxes yet. Create one with `beambox create`.").map_err(io_err)?
            } else {
                write!(io.stdout, "{}", table(&all)).map_err(io_err)?
            }
        }
        Command::Create { name, template, harness, task, desktop, cpus, memory, mount, network, ports, web } => {
            let mount = match mount {
                Some(folder) => Some(std::path::absolute(folder).map_err(io_err)?.to_string_lossy().into_owned()),
                None => None,
            };
            // The first sandbox builds the base snapshot every sandbox boots from (the app builds it at startup).
            if !core.base_ready().await? {
                writeln!(io.stderr, "Preparing Beambox's base sandbox. This takes a few minutes, once.").map_err(io_err)?;
            }
            let opts = CreateOpts {
                name: name.clone(),
                template: template.clone(),
                harness: harness.clone(),
                task: task.clone(),
                desktop: Some(*desktop),
                cpus: *cpus,
                memory_mib: *memory,
                mount,
                network: network.clone(),
                ports: if ports.is_empty() { None } else { Some(ports.clone()) },
                web: Some(*web),
            };
            let info = core.create(opts).await?;
            if cli.json { json(io, &info)? } else { done(io, describe(&info))? }
            if let (Some(url), false) = (&info.web_url, cli.json) {
                writeln!(io.stdout, "The desktop in a browser: {url}").map_err(io_err)?;
            }
            // Neither a stored key nor a saved login: the harness signs in inside the sandbox, so say where.
            let sign_in = match harness {
                Some(h) if !core.missing_credentials(h)?.is_empty() => Some(h),
                _ => None,
            };
            if let Some(h) = sign_in {
                writeln!(
                    io.stderr,
                    "No {h} key is stored, so {h} asks you to sign in. Open the sandbox's Terminal tab in the app, or \
                     run `beambox attach {}`.",
                    info.name
                )
                .map_err(io_err)?;
            }
        }
        Command::Start { name } => {
            core.start(name).await?;
            done(io, format!("Started {name}"))?
        }
        Command::Stop { name } => {
            core.stop(name).await?;
            done(io, format!("Stopped {name}"))?
        }
        Command::Fork { name } => {
            let info = core.fork(name).await?;
            if cli.json { json(io, &info)? } else { done(io, describe(&info))? }
        }
        Command::Snapshot { name } => {
            let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?;
            let snapshot = core.snapshot(name, secs.as_secs()).await?;
            if cli.json { json(io, serde_json::json!({ "snapshot": snapshot }))? } else { done(io, format!("Saved snapshot {snapshot}"))? }
        }
        Command::Delete { name } => {
            core.delete(name).await?;
            done(io, format!("Deleted {name}"))?
        }
        Command::Exec { name, command } => {
            let command = shell_command(command);
            let out = core.backend.exec(name, &command).await?;
            if cli.json {
                json(io, &out)?;
            } else {
                io.stdout.write_all(out.stdout.as_bytes()).map_err(io_err)?;
                io.stderr.write_all(out.stderr.as_bytes()).map_err(io_err)?;
            }
            return Ok(out.exit_code);
        }
        Command::Ls { name, path } => {
            let entries = core.backend.list_dir(name, path).await?;
            if cli.json {
                json(io, &entries)?
            } else {
                for e in entries {
                    writeln!(io.stdout, "{}{}", e.path, if e.dir { "/" } else { "" }).map_err(io_err)?;
                }
            }
        }
        Command::Cat { name, path } => {
            let bytes = core.backend.read_file(name, path).await?;
            io.stdout.write_all(&bytes).map_err(io_err)?
        }
        Command::Put { name, path, file } => {
            let data = match file {
                Some(file) => std::fs::read(file).map_err(|e| format!("{}: {e}", file.display()))?,
                None => {
                    let mut data = Vec::new();
                    io.stdin.read_to_end(&mut data).map_err(io_err)?;
                    data
                }
            };
            let size = data.len();
            core.backend.write_file(name, path, data).await?;
            done(io, format!("Wrote {size} bytes to {name}:{path}"))?
        }
        Command::Logs { name, follow } => {
            let mut shown: Vec<String> = Vec::new();
            loop {
                let lines = core.backend.logs(name).await?;
                for line in new_lines(&shown, &lines) {
                    writeln!(io.stdout, "{}", line.trim_end_matches('\n')).map_err(io_err)?;
                }
                io.stdout.flush().map_err(io_err)?;
                if !follow {
                    break;
                }
                shown = lines;
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
        Command::Stats { name } => {
            let m = core.backend.metrics(name).await?;
            if cli.json {
                json(io, m)?
            } else {
                let mib = m.memory_bytes as f64 / 1024.0 / 1024.0;
                writeln!(io.stdout, "CPU {:.1}%  Memory {mib:.1} MiB", m.cpu_percent).map_err(io_err)?
            }
        }
        Command::Takeover { name, state } => {
            if let Some(state) = state {
                core.set_takeover(name, *state == Toggle::On).await?;
            }
            let on = core.is_taken_over(name).await?;
            if cli.json {
                json(io, serde_json::json!({ "takeover": on }))?
            } else {
                let text = if on { "on: the agent is paused" } else { "off: the agent is running" };
                writeln!(io.stdout, "Take-over of {name} is {text}").map_err(io_err)?
            }
        }
        Command::Credentials { action } => match action {
            Credentials::Set { name } => {
                let mut value = String::new();
                io.stdin.read_to_string(&mut value).map_err(io_err)?;
                let value = value.trim();
                if value.is_empty() {
                    return Err(format!("no {name} credential on stdin"));
                }
                core.secrets.set(name, value)?;
                done(io, format!("Stored the {name} credential in the keychain"))?
            }
            Credentials::List => {
                let names = credentials::stored(core.secrets.as_ref())?;
                if cli.json {
                    json(io, &names)?
                } else {
                    for name in names {
                        writeln!(io.stdout, "{name}").map_err(io_err)?;
                    }
                }
            }
            Credentials::Remove { name } => {
                core.secrets.remove(name)?;
                done(io, format!("Removed the {name} credential"))?
            }
        },
        Command::Shell { .. } | Command::Attach { .. } | Command::Desktop { .. } | Command::Doctor => {
            return Err("this command needs a terminal; run it from `beambox`".into());
        }
    }
    Ok(0)
}

/// `beambox shell` and `beambox attach`: a program in the sandbox with the host terminal in raw mode, resized
/// as the window changes. Attach joins the agent's tmux session.
pub async fn shell(core: &Core, name: &str, attach: bool) -> Result<i32> {
    let harness = match attach {
        true => {
            let all = core.backend.list().await?;
            let sandbox = all.iter().find(|s| s.name == name).ok_or(format!("no sandbox named {name}"))?;
            Some(sandbox.harness.clone().ok_or(format!("{name} has no agent. Use `beambox shell {name}`."))?)
        }
        false => None,
    };
    interactive(name, crate::agent::terminal_command(harness.as_deref())).await
}

/// Read a secret from the terminal without echoing it.
pub fn read_hidden(prompt: &str) -> Result<String> {
    use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, read};
    eprint!("{prompt}");
    crossterm::terminal::enable_raw_mode().map_err(io_err)?;
    let _raw = RawMode;
    let mut value = String::new();
    loop {
        if let Event::Key(key) = read().map_err(io_err)? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Enter => break,
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Err("cancelled".into()),
                KeyCode::Char(c) => value.push(c),
                KeyCode::Backspace => {
                    value.pop();
                }
                _ => {}
            }
        }
    }
    eprint!("\r\n");
    Ok(value)
}

struct RawMode;

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

async fn interactive(name: &str, program: Vec<String>) -> Result<i32> {
    use microsandbox::ExecEvent;
    use std::io::IsTerminal;
    let tty = std::io::stdin().is_terminal();
    let sandbox = crate::micro::connect(name).await?;
    let mut handle = sandbox
        .exec_stream_with(&program[0], |o| o.args(&program[1..]).tty(tty).stdin_pipe())
        .await
        .map_err(|e| e.to_string())?;
    let stdin = handle.take_stdin().ok_or("no stdin")?;
    let control = handle.control();
    let mut size = crossterm::terminal::size().ok();
    if let (true, Some((cols, rows))) = (tty, size) {
        control.resize(rows, cols).await.map_err(|e| e.to_string())?;
    }
    let _raw = if tty {
        crossterm::terminal::enable_raw_mode().map_err(io_err)?;
        Some(RawMode)
    } else {
        None
    };
    // Reading stdin blocks, so it runs on its own thread. An empty chunk means end of input.
    let (tx, mut input) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let (mut buf, mut stdin) = ([0u8; 4096], std::io::stdin().lock());
        loop {
            let n = stdin.read(&mut buf).unwrap_or(0);
            if tx.blocking_send(buf[..n].to_vec()).is_err() || n == 0 {
                break;
            }
        }
    });
    let mut resize = tokio::time::interval(std::time::Duration::from_millis(250));
    let mut out = std::io::stdout();
    let mut input_open = true;
    loop {
        tokio::select! {
            event = handle.recv() => match event {
                Some(ExecEvent::Stdout(data) | ExecEvent::Stderr(data)) => {
                    out.write_all(&data).and_then(|_| out.flush()).map_err(io_err)?;
                }
                Some(ExecEvent::Exited { code }) => return Ok(code),
                Some(ExecEvent::Failed(failed)) => return Err(format!("the shell didn't start: {failed:?}")),
                Some(_) => {}
                None => return Ok(0),
            },
            Some(data) = input.recv(), if input_open => {
                if data.is_empty() {
                    input_open = false;
                    stdin.close().await.map_err(|e| e.to_string())?;
                } else {
                    stdin.write(data).await.map_err(|e| e.to_string())?;
                }
            }
            _ = resize.tick(), if tty => {
                let now = crossterm::terminal::size().ok();
                if let (true, Some((cols, rows))) = (now != size, now) {
                    let _ = control.resize(rows, cols).await;
                }
                size = now;
            }
        }
    }
}

/// The program to launch for the window: the AppImage file itself, since an AppImage runs from a per-launch
/// mount, else this executable.
pub fn app_executable() -> Result<PathBuf> {
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return Ok(appimage.into());
    }
    std::env::current_exe().map_err(io_err)
}

/// `beambox desktop`: launch the window on the sandbox's Desktop tab. A running window takes the request
/// over (single-instance plugin) and this launch exits.
pub async fn desktop(core: &Core, name: &str, io: &mut Io<'_>) -> Result<i32> {
    let sandboxes = core.backend.list().await?;
    let sandbox = sandboxes.iter().find(|s| s.name == name).ok_or(format!("no sandbox named {name}"))?;
    if sandbox.template != "desktop" {
        return Err(format!("{name} has no desktop. Create one with `beambox create --template desktop`."));
    }
    std::process::Command::new(app_executable()?)
        .args(["--open", name])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(io_err)?;
    writeln!(io.stdout, "Opening the desktop of {name} in Beambox").map_err(io_err)?;
    Ok(0)
}

/// `beambox doctor`: can this computer run sandboxes?
pub fn doctor(paths: &crate::paths::RuntimePaths, io: &mut Io<'_>) -> Result<i32> {
    use crate::hypervisor::{HypervisorState, check, probe};
    let os = std::env::consts::OS;
    let hypervisor = match check(os, std::env::consts::ARCH, probe) {
        HypervisorState::Ok => Ok("available".to_string()),
        HypervisorState::Missing => Err(match os {
            "windows" => "missing: enable Windows Hypervisor Platform (the app can do it for you), then restart",
            "linux" => "missing: /dev/kvm isn't usable; enable virtualisation and add yourself to the kvm group",
            _ => "missing: Hypervisor.framework isn't available on this Mac",
        }
        .to_string()),
        HypervisorState::Unsupported => Err("unsupported: Beambox needs an Apple Silicon Mac".to_string()),
    };
    let file = |p: &Path| if p.exists() { Ok(p.display().to_string()) } else { Err(format!("missing: {}", p.display())) };
    let checks = [
        ("Hypervisor", hypervisor),
        ("Runtime", file(&paths.msb)),
        ("Kernel", file(&paths.libkrunfw)),
        ("Data", Ok(paths.home.display().to_string())),
    ];
    let ok = checks.iter().all(|(_, r)| r.is_ok());
    for (label, result) in &checks {
        let (mark, text) = match result {
            Ok(text) => ("✓", text),
            Err(text) => ("✗", text),
        };
        writeln!(io.stdout, "{mark} {label:<10} {text}").map_err(io_err)?;
    }
    Ok(if ok { 0 } else { 1 })
}

/// A two-line launcher rather than a symlink: Tauri refuses to start from a symlinked executable on macOS,
/// and the real path is what finds the bundled runtime.
pub fn launcher(exe: &Path) -> String {
    format!("#!/bin/sh\nexec {} \"$@\"\n", sh_quote(&exe.to_string_lossy()))
}

/// Put `beambox` on the PATH: `/usr/local/bin` on macOS (one admin prompt), `~/.local/bin` on Linux, the
/// user PATH on Windows. Returns what to tell the user.
pub fn install_cli() -> Result<String> {
    let exe = app_executable()?;
    match std::env::consts::OS {
        "windows" => {
            let dir = exe.parent().ok_or("no exe dir")?.to_string_lossy().replace('\'', "''");
            let script = format!(
                "$p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
                 if (-not (($p -split ';') -contains '{dir}')) {{ \
                 [Environment]::SetEnvironmentVariable('Path', (($p, '{dir}') -ne '' -join ';'), 'User') }}"
            );
            let status = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).status();
            if !status.map_err(io_err)?.success() {
                return Err("Couldn't add Beambox to your PATH".into());
            }
            Ok("Installed. Open a new terminal and run `beambox --help`.".into())
        }
        "macos" => {
            let script = std::env::temp_dir().join("beambox-launcher");
            std::fs::write(&script, launcher(&exe)).map_err(io_err)?;
            let shell = format!(
                "mkdir -p /usr/local/bin && install -m 755 {} /usr/local/bin/beambox",
                sh_quote(&script.to_string_lossy())
            );
            let apple = format!(
                "do shell script \"{}\" with administrator privileges",
                shell.replace('\\', "\\\\").replace('"', "\\\"")
            );
            let status = std::process::Command::new("osascript").args(["-e", &apple]).status().map_err(io_err)?;
            let _ = std::fs::remove_file(&script);
            if !status.success() {
                return Err("Installing the command was cancelled".into());
            }
            Ok("Installed. Run `beambox --help` in a terminal.".into())
        }
        _ => {
            if exe.parent() == Some(Path::new("/usr/bin")) {
                return Ok("Already installed. Run `beambox --help` in a terminal.".into());
            }
            let dir = dirs::home_dir().ok_or("no home dir")?.join(".local/bin");
            std::fs::create_dir_all(&dir).map_err(io_err)?;
            let file = dir.join("beambox");
            std::fs::write(&file, launcher(&exe)).map_err(io_err)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).map_err(io_err)?;
            }
            Ok(format!("Installed {}. Run `beambox --help` in a new terminal.", file.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::FakeBackend;
    use crate::credentials::fake::FakeSecrets;
    use std::sync::Arc;

    fn core() -> Core {
        Core::with_port_probe(Arc::new(FakeBackend::default()), Arc::new(FakeSecrets::default()), |_| true)
    }

    struct Out {
        code: Result<i32>,
        stdout: String,
        stderr: String,
    }

    async fn beambox(core: &Core, args: &str, stdin: &str) -> Out {
        beambox_args(core, &args.split_whitespace().collect::<Vec<_>>(), stdin).await
    }

    async fn beambox_args(core: &Core, args: &[&str], stdin: &str) -> Out {
        let cli = Cli::try_parse_from(std::iter::once(&"beambox").chain(args)).unwrap();
        let (mut stdin, mut stdout, mut stderr) = (stdin.as_bytes(), Vec::new(), Vec::new());
        let code = run(&cli, core, &mut Io { stdin: &mut stdin, stdout: &mut stdout, stderr: &mut stderr }).await;
        Out { code, stdout: String::from_utf8(stdout).unwrap(), stderr: String::from_utf8(stderr).unwrap() }
    }

    #[test]
    fn no_arguments_open_the_window() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(mode(&args(&[])), Mode::Gui(None));
        assert_eq!(mode(&args(&["-psn_0_12345"])), Mode::Gui(None));
        assert_eq!(mode(&args(&["--open", "a"])), Mode::Gui(Some("a".into())));
        assert_eq!(mode(&args(&["list"])), Mode::Cli);
        assert_eq!(mode(&args(&["--mcp"])), Mode::Cli);
    }

    #[test]
    fn the_host_mcp_server_and_agent_flag_are_gone() {
        for line in ["mcp", "--mcp", "--agent claude-code list", "list --agent x"] {
            let args = std::iter::once("beambox").chain(line.split_whitespace());
            let err = Cli::try_parse_from(args).unwrap_err();
            assert!(
                matches!(err.kind(), clap::error::ErrorKind::InvalidSubcommand | clap::error::ErrorKind::UnknownArgument),
                "{line}: {err}"
            );
        }
    }

    #[test]
    fn every_documented_command_parses() {
        for line in [
            "list",
            "create",
            "create web -t desktop --cpus 2 --memory 1024 --mount . --network none -p 3000 -p 8080",
            "create fixer --harness claude-code --task fix --desktop --mount .",
            "create shared -t desktop --web",
            "start a",
            "stop a",
            "fork a",
            "snapshot a",
            "delete a",
            "exec a -- ls -la /",
            "shell a",
            "attach a",
            "ls a",
            "ls a /etc",
            "cat a /etc/os-release",
            "put a /x local.txt",
            "logs a -f",
            "stats a",
            "takeover a on",
            "desktop a",
            "doctor",
            "credentials set anthropic",
            "credentials list",
            "credentials remove openai",
            "--json list",
        ] {
            let args = std::iter::once("beambox").chain(line.split_whitespace());
            assert!(Cli::try_parse_from(args).is_ok(), "{line}");
        }
        assert!(Cli::try_parse_from(["beambox", "create", "-t", "windows"]).is_err());
        assert!(Cli::try_parse_from(["beambox", "create", "--harness", "gemini"]).is_err());
        assert!(Cli::try_parse_from(["beambox", "create", "--task", "x"]).is_err(), "a task needs a harness");
        assert!(Cli::try_parse_from(["beambox", "credentials", "set", "google"]).is_err());
        assert!(Cli::try_parse_from(["beambox", "exec", "a"]).is_err());
    }

    #[test]
    fn exec_keeps_one_shell_string_and_quotes_separate_arguments() {
        let s = |a: &[&str]| shell_command(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(s(&["make && make test"]), "make && make test");
        assert_eq!(s(&["ls", "-la", "/tmp"]), "ls -la /tmp");
        assert_eq!(s(&["sh", "-c", "echo it's here"]), r"sh -c 'echo it'\''s here'");
        assert_eq!(s(&["printf", ""]), "printf ''");
    }

    #[test]
    fn following_logs_prints_only_lines_not_shown_yet() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(new_lines(&v(&[]), &v(&["a", "b"])), v(&["a", "b"]));
        assert_eq!(new_lines(&v(&["a", "b"]), &v(&["a", "b", "c"])), v(&["c"]));
        // The tail window slid: "a" fell off the front.
        assert_eq!(new_lines(&v(&["a", "b", "c"]), &v(&["b", "c", "d", "e"])), v(&["d", "e"]));
        assert_eq!(new_lines(&v(&["a"]), &v(&["a"])), v(&[]));
    }

    #[tokio::test]
    async fn create_list_fork_and_delete_like_the_app() {
        let core = core();
        let out = beambox(&core, "create web -p 3000", "").await;
        assert_eq!(out.code, Ok(0));
        assert_eq!(out.stdout, "web is running (base, ports 127.0.0.1:3000 → 3000)\n");
        beambox(&core, "fork web", "").await;
        let list = beambox(&core, "list", "").await.stdout;
        let lines: Vec<_> = list.lines().collect();
        assert!(lines[0].starts_with("NAME") && lines[0].contains("PORTS"), "{list}");
        assert!(lines[1].starts_with("web ") && lines[1].contains("3000→3000"), "{list}");
        assert!(lines[2].starts_with("web-fork-1 ") && lines[2].contains("3001→3000"), "{list}");
        assert_eq!(beambox(&core, "delete web", "").await.stdout, "Deleted web\n");
        let json: serde_json::Value = serde_json::from_str(&beambox(&core, "list --json", "").await.stdout).unwrap();
        assert_eq!(json[0]["name"], "web-fork-1");
        assert_eq!(json.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_passes_every_option_and_an_absolute_mount() {
        let fake = Arc::new(FakeBackend::default());
        let core = Core::with_port_probe(fake.clone(), Arc::new(FakeSecrets::default()), |_| true);
        let out = beambox(&core, "create big --cpus 4 --memory 2048 --network none --mount .", "").await;
        assert_eq!(out.code, Ok(0), "{}", out.stderr);
        let spec = fake.specs.lock().unwrap().last().unwrap().clone();
        assert_eq!((spec.cpus, spec.memory_mib, spec.network.as_str()), (4, 2048, "none"));
        let mount = PathBuf::from(spec.mount.unwrap());
        assert!(mount.is_absolute() && mount == std::env::current_dir().unwrap(), "{mount:?}");
    }

    #[tokio::test]
    async fn create_web_prints_the_browser_link() {
        let out = beambox(&core(), "create shared -t desktop --web", "").await;
        assert_eq!(out.code, Ok(0), "{}", out.stderr);
        let link = out.stdout.lines().nth(1).unwrap();
        assert!(link.starts_with("The desktop in a browser: http://127.0.0.1:6080/vnc.html?"), "{}", out.stdout);
        assert!(beambox(&core(), "create plain -t desktop", "").await.stdout.lines().count() == 1);
    }

    #[tokio::test]
    async fn only_the_first_create_says_it_prepares_the_base_sandbox() {
        let core = core();
        let out = beambox(&core, "create d1 -t desktop", "").await;
        assert_eq!(out.code, Ok(0), "{}", out.stderr);
        assert!(out.stderr.contains("Preparing Beambox's base sandbox"), "{}", out.stderr);
        assert_eq!(beambox(&core, "create d2 -t desktop", "").await.stderr, "");
    }

    #[tokio::test]
    async fn exec_prints_both_streams_and_exits_with_the_command_code() {
        let core = core();
        beambox(&core, "create a", "").await;
        let out = beambox_args(&core, &["exec", "a", "echo hi; echo oops >&2; exit 3"], "").await;
        assert_eq!((out.code, out.stdout.as_str(), out.stderr.as_str()), (Ok(3), "hi\n", "oops\n"));
        let out = beambox(&core, "--json exec a echo hi", "").await;
        let json: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(json, serde_json::json!({ "stdout": "hi\n", "stderr": "", "exitCode": 0 }));
    }

    #[tokio::test]
    async fn put_from_stdin_then_cat_and_ls() {
        let core = core();
        beambox(&core, "create a", "").await;
        assert_eq!(beambox(&core, "put a /notes.txt", "hello").await.stdout, "Wrote 5 bytes to a:/notes.txt\n");
        assert_eq!(beambox(&core, "cat a /notes.txt", "").await.stdout, "hello");
        assert!(beambox(&core, "ls a /", "").await.stdout.lines().any(|l| l.contains("notes.txt")));
    }

    #[tokio::test]
    async fn credentials_set_reads_stdin_and_list_prints_names_only() {
        let core = core();
        let out = beambox(&core, "credentials set anthropic", "sk-ant-api03-hidden\n").await;
        assert_eq!(out.code, Ok(0));
        assert_eq!(out.stdout, "Stored the anthropic credential in the keychain\n");
        assert!(!out.stdout.contains("hidden") && !out.stderr.contains("hidden"), "never echoed");
        assert_eq!(core.secrets.get("anthropic").unwrap().as_deref(), Some("sk-ant-api03-hidden"));
        let list = beambox(&core, "credentials list", "").await;
        assert_eq!(list.stdout, "anthropic\n");
        assert_eq!(beambox(&core, "--json credentials list", "").await.stdout.trim(), "[\n  \"anthropic\"\n]");
        assert!(beambox(&core, "credentials set openai", "\n").await.code.unwrap_err().contains("no openai credential"));
        beambox(&core, "credentials remove anthropic", "").await;
        assert_eq!(beambox(&core, "credentials list", "").await.stdout, "");
    }

    #[tokio::test]
    async fn create_with_a_harness_says_where_to_sign_in_without_a_key() {
        let core = core();
        let out = beambox_args(&core, &["create", "signin", "--harness", "claude-code", "--task", "fix the tests"], "").await;
        assert_eq!(out.code, Ok(0), "{}", out.stderr);
        assert!(out.stderr.contains("asks you to sign in") && out.stderr.contains("beambox attach signin"), "{}", out.stderr);
        beambox(&core, "credentials set anthropic", "sk-ant-api03-x").await;
        let out = beambox_args(&core, &["create", "fixer", "--harness", "claude-code", "--task", "fix the tests"], "").await;
        assert_eq!(out.code, Ok(0), "{}", out.stderr);
        assert!(!out.stdout.contains("sk-ant") && !out.stderr.contains("sk-ant"), "the key is never printed");
        assert!(!out.stderr.contains("sign in"), "a stored key needs no sign-in: {}", out.stderr);
        assert_eq!(out.stdout, "fixer is running (claude-code, base)\n");
        assert!(beambox(&core, "list", "").await.stdout.lines().nth(1).unwrap().contains("claude-code"));
    }

    #[tokio::test]
    async fn takeover_freezes_and_hands_back_the_agent() {
        let fake = Arc::new(FakeBackend::default());
        let core = Core::with_port_probe(fake.clone(), Arc::new(FakeSecrets::with("openai", "sk-x")), |_| true);
        beambox(&core, "create a --harness codex", "").await;
        assert_eq!(beambox(&core, "takeover a on", "").await.code, Ok(0));
        let last = fake.execs.lock().unwrap().iter().rev().nth(1).unwrap().1.clone();
        assert_eq!(last, crate::core::takeover_command(true));
        let out = beambox(&core, "takeover a off", "").await;
        assert_eq!(out.stdout, "Take-over of a is off: the agent is running\n");
        assert!(fake.execs.lock().unwrap().iter().any(|(_, c)| c == &crate::core::takeover_command(false)));
    }

    #[tokio::test]
    async fn errors_from_the_backend_are_returned_not_swallowed() {
        let core = core();
        assert!(beambox(&core, "stop nope", "").await.code.is_err());
        assert!(beambox(&core, "cat nope /x", "").await.code.is_err());
    }

    #[test]
    fn the_launcher_runs_the_real_executable_with_every_argument() {
        assert_eq!(
            launcher(Path::new("/Applications/Beambox.app/Contents/MacOS/beambox")),
            "#!/bin/sh\nexec /Applications/Beambox.app/Contents/MacOS/beambox \"$@\"\n"
        );
        assert_eq!(launcher(Path::new("/home/u/My Apps/Beambox.AppImage")), "#!/bin/sh\nexec '/home/u/My Apps/Beambox.AppImage' \"$@\"\n");
    }
}
