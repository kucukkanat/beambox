//! `beambox <command>`: the command line, over the same core as the GUI and the MCP server.
use crate::backend::{Result, SandboxInfo};
use crate::core::{Core, CreateOpts, DESKTOP_SNAPSHOT};
use clap::{Parser, Subcommand, ValueEnum};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(name = "beambox", version, about = "microVM sandboxes for AI agents. Run with no command to open the app.")]
pub struct Cli {
    /// Act as this agent: the call shows in the app's activity feed and is refused while you have taken over
    /// the sandbox.
    #[arg(long, global = true, value_name = "NAME")]
    pub agent: Option<String>,
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
        /// `base` (Alpine, 256 MiB) or `desktop` (X desktop over VNC, 512 MiB).
        #[arg(short, long, value_parser = ["base", "desktop"])]
        template: Option<String>,
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
    /// Show or change take-over. While it's on, agent calls on the sandbox are paused.
    Takeover { name: String, state: Option<Toggle> },
    /// Open a sandbox's desktop in the Beambox app.
    Desktop { name: String },
    /// Check that this computer can run sandboxes.
    Doctor,
    /// Serve MCP on stdio, for an agent.
    Mcp,
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
    Mcp,
    Cli,
}

pub fn mode(args: &[String]) -> Mode {
    match args.first().map(String::as_str) {
        // macOS passes `-psn_…` to apps launched from Finder on older versions.
        None => Mode::Gui(None),
        Some(arg) if arg.starts_with("-psn_") => Mode::Gui(None),
        Some("--open") => Mode::Gui(args.get(1).cloned()),
        Some("--mcp") => Mode::Mcp,
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

/// Quote `arg` for `/bin/sh` when it needs it.
fn sh_quote(arg: &str) -> String {
    let plain = !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:,@%+".contains(c));
    if plain { arg.into() } else { format!("'{}'", arg.replace('\'', r"'\''")) }
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
                s.agent.clone().unwrap_or_else(|| "-".into()),
                if ports.is_empty() { "-".into() } else { ports.join(", ") },
            ]
        })
        .collect();
    let header = ["NAME", "STATUS", "TEMPLATE", "SIZE", "AGENT", "PORTS"].map(String::from);
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
    format!("{} is running ({}{ports})", s.name, s.template)
}

/// Run a non-interactive command and return the process exit code. `Shell`, `Desktop`, `Doctor` and `Mcp`
/// need a real terminal, app or hypervisor and are handled by `main`.
pub async fn run(cli: &Cli, core: &Core, io: &mut Io<'_>) -> Result<i32> {
    let agent = cli.agent.as_deref();
    // Calls on a sandbox are guarded and logged when made as an agent, like MCP calls.
    macro_rules! call {
        ($name:expr, $label:expr, $fut:expr) => {
            call!($name, $label, $fut, |_| 0)
        };
        ($name:expr, $label:expr, $fut:expr, $exit:expr) => {
            match agent {
                Some(agent) => core.agent_call(agent, $name, &$label, $fut, $exit).await,
                None => $fut.await,
            }
        };
    }
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
        Command::Create { name, template, cpus, memory, mount, network, ports } => {
            let mount = match mount {
                Some(folder) => Some(std::path::absolute(folder).map_err(io_err)?.to_string_lossy().into_owned()),
                None => None,
            };
            if template.as_deref() == Some("desktop") && !core.backend.has_snapshot(DESKTOP_SNAPSHOT).await? {
                writeln!(io.stderr, "Preparing the desktop. This takes about 10 seconds, once.").map_err(io_err)?;
            }
            let opts = CreateOpts {
                name: name.clone(),
                template: template.clone(),
                cpus: *cpus,
                memory_mib: *memory,
                mount,
                network: network.clone(),
                ports: if ports.is_empty() { None } else { Some(ports.clone()) },
            };
            let info = core.create(opts, agent.map(String::from)).await?;
            if let Some(agent) = agent {
                core.record(&core.new_activity_id(), &info.name, agent, "create", Some(0));
            }
            if cli.json { json(io, &info)? } else { done(io, describe(&info))? }
        }
        Command::Start { name } => {
            call!(name, "start", core.backend.start(name))?;
            done(io, format!("Started {name}"))?
        }
        Command::Stop { name } => {
            call!(name, "stop", core.backend.stop(name))?;
            done(io, format!("Stopped {name}"))?
        }
        Command::Fork { name } => {
            let info = call!(name, "fork", core.fork(name))?;
            if cli.json { json(io, &info)? } else { done(io, describe(&info))? }
        }
        Command::Snapshot { name } => {
            let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?;
            let snapshot = call!(name, "snapshot", core.snapshot(name, secs.as_secs()))?;
            if cli.json { json(io, serde_json::json!({ "snapshot": snapshot }))? } else { done(io, format!("Saved snapshot {snapshot}"))? }
        }
        Command::Delete { name } => {
            call!(name, "delete", core.delete(name))?;
            done(io, format!("Deleted {name}"))?
        }
        Command::Exec { name, command } => {
            let command = shell_command(command);
            let out = call!(name, command, core.backend.exec(name, &command), |r| r.exit_code)?;
            if cli.json {
                json(io, &out)?;
            } else {
                io.stdout.write_all(out.stdout.as_bytes()).map_err(io_err)?;
                io.stderr.write_all(out.stderr.as_bytes()).map_err(io_err)?;
            }
            return Ok(out.exit_code);
        }
        Command::Ls { name, path } => {
            let entries = call!(name, format!("ls {path}"), core.backend.list_dir(name, path))?;
            if cli.json {
                json(io, &entries)?
            } else {
                for e in entries {
                    writeln!(io.stdout, "{}{}", e.path, if e.dir { "/" } else { "" }).map_err(io_err)?;
                }
            }
        }
        Command::Cat { name, path } => {
            let bytes = call!(name, format!("read {path}"), core.backend.read_file(name, path))?;
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
            call!(name, format!("write {path}"), core.backend.write_file(name, path, data))?;
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
            if agent.is_some() {
                return Err("Agents can't change take-over; only you can, from the app or without --agent.".into());
            }
            if let Some(state) = state {
                core.set_takeover(name, *state == Toggle::On)?;
            }
            let on = core.is_taken_over(name);
            if cli.json {
                json(io, serde_json::json!({ "takeover": on }))?
            } else {
                let text = if on { "on: agent calls are paused" } else { "off: agents can use it" };
                writeln!(io.stdout, "Take-over of {name} is {text}").map_err(io_err)?
            }
        }
        Command::Shell { .. } | Command::Desktop { .. } | Command::Doctor | Command::Mcp => {
            return Err("this command needs a terminal; run it from `beambox`".into());
        }
    }
    Ok(0)
}

/// `beambox shell`: a login shell with the host terminal in raw mode, resized as the window changes.
pub async fn shell(core: &Core, agent: Option<&str>, name: &str) -> Result<i32> {
    match agent {
        Some(agent) => core.agent_call(agent, name, "shell", interactive_shell(name), |code| *code).await,
        None => interactive_shell(name).await,
    }
}

struct RawMode;

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

async fn interactive_shell(name: &str) -> Result<i32> {
    use microsandbox::ExecEvent;
    use std::io::IsTerminal;
    let tty = std::io::stdin().is_terminal();
    let sandbox = crate::micro::connect(name).await?;
    let mut handle = sandbox
        .exec_stream_with("/bin/sh", |o| o.arg("-l").tty(tty).stdin_pipe())
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
    use std::sync::Arc;

    fn core() -> Core {
        Core::with_port_probe(Arc::new(FakeBackend::default()), crate::core::temp_dir(), |_| true)
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
    fn no_arguments_open_the_window_and_mcp_keeps_its_flag() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(mode(&args(&[])), Mode::Gui(None));
        assert_eq!(mode(&args(&["-psn_0_12345"])), Mode::Gui(None));
        assert_eq!(mode(&args(&["--open", "a"])), Mode::Gui(Some("a".into())));
        assert_eq!(mode(&args(&["--mcp"])), Mode::Mcp);
        assert_eq!(mode(&args(&["list"])), Mode::Cli);
        // `--mcp` only counts as the first argument, not inside a command.
        assert_eq!(mode(&args(&["exec", "a", "--", "grep", "--mcp"])), Mode::Cli);
    }

    #[test]
    fn every_documented_command_parses() {
        for line in [
            "list",
            "create",
            "create web -t desktop --cpus 2 --memory 1024 --mount . --network none -p 3000 -p 8080",
            "start a",
            "stop a",
            "fork a",
            "snapshot a",
            "delete a",
            "exec a -- ls -la /",
            "shell a",
            "ls a",
            "ls a /etc",
            "cat a /etc/os-release",
            "put a /x local.txt",
            "logs a -f",
            "stats a",
            "takeover a on",
            "desktop a",
            "doctor",
            "mcp",
            "--json --agent claude-code list",
        ] {
            let args = std::iter::once("beambox").chain(line.split_whitespace());
            assert!(Cli::try_parse_from(args).is_ok(), "{line}");
        }
        assert!(Cli::try_parse_from(["beambox", "create", "-t", "windows"]).is_err());
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
        let core = Core::with_port_probe(fake.clone(), crate::core::temp_dir(), |_| true);
        let out = beambox(&core, "create big --cpus 4 --memory 2048 --network none --mount .", "").await;
        assert_eq!(out.code, Ok(0), "{}", out.stderr);
        let spec = fake.specs.lock().unwrap()[0].clone();
        assert_eq!((spec.cpus, spec.memory_mib, spec.network.as_str()), (4, 2048, "none"));
        let mount = PathBuf::from(spec.mount.unwrap());
        assert!(mount.is_absolute() && mount == std::env::current_dir().unwrap(), "{mount:?}");
    }

    #[tokio::test]
    async fn the_first_desktop_says_it_is_preparing_and_later_ones_do_not() {
        let core = core();
        assert!(beambox(&core, "create d1 -t desktop", "").await.stderr.contains("Preparing the desktop"));
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
    async fn agent_calls_are_logged_and_paused_by_take_over() {
        let core = core();
        let mut feed = core.events.subscribe();
        beambox(&core, "--agent claude-code create a", "").await;
        beambox(&core, "--agent claude-code exec a echo hi", "").await;
        let seen: Vec<_> = (0..3).map(|_| feed.try_recv().unwrap()).map(|e| (e.agent, e.command, e.exit_code)).collect();
        let want = [("create", Some(0)), ("echo hi", None), ("echo hi", Some(0))]
            .map(|(c, e)| ("claude-code".to_string(), c.to_string(), e));
        assert_eq!(seen, want);
        assert_eq!(core.backend.list().await.unwrap()[0].agent.as_deref(), Some("claude-code"));

        assert_eq!(beambox(&core, "takeover a on", "").await.stdout, "Take-over of a is on: agent calls are paused\n");
        let refused = beambox(&core, "--agent claude-code exec a echo hi", "").await;
        assert!(refused.code.unwrap_err().contains("taken over sandbox 'a'"));
        // You are not an agent: your own calls still work, and agents can't hand themselves control back.
        assert_eq!(beambox(&core, "exec a echo hi", "").await.code, Ok(0));
        assert!(beambox(&core, "--agent claude-code takeover a off", "").await.code.is_err());
        beambox(&core, "takeover a off", "").await;
        assert_eq!(beambox(&core, "--agent claude-code exec a echo hi", "").await.code, Ok(0));
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
