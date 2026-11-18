pub mod agent;
pub mod backend;
pub mod cli;
pub mod core;
pub mod credentials;
pub mod hypervisor;
pub mod micro;
pub mod paths;
pub mod ports;
pub mod proxy;

use crate::backend::{DirEntry, Metrics, Result, SandboxInfo};
use crate::core::{Core, CreateOpts};
use microsandbox::sandbox::exec::{ExecControl, ExecSink};
use microsandbox::ExecEvent;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

type Terminals = Arc<tokio::sync::Mutex<HashMap<u64, (ExecSink, ExecControl)>>>;

struct App {
    core: Arc<Core>,
    terminals: Terminals,
    next_terminal: Mutex<u64>,
    /// One VNC WebSocket proxy per sandbox, reused across Desktop tab visits.
    desktop_proxies: tokio::sync::Mutex<HashMap<String, u16>>,
    /// The sandbox `beambox desktop` asked to open when it launched the window.
    open_at_launch: Mutex<Option<String>>,
}

fn context() -> tauri::Context {
    tauri::generate_context!()
}

/// Resolve the bundled runtime, point microsandbox at it, and build the core.
fn setup(context: &tauri::Context) -> (Arc<Core>, paths::RuntimePaths) {
    let data_dir = dirs::data_dir().expect("no data dir").join(&context.config().identifier);
    let exe = std::env::current_exe().expect("no current exe");
    let resource_dir = tauri::utils::platform::resource_dir(context.package_info(), &tauri::Env::default())
        .unwrap_or_else(|_| exe.parent().expect("exe dir").to_path_buf());
    let home_dir = dirs::home_dir().expect("no home dir");
    let paths = paths::resolve(std::env::consts::OS, exe.parent().expect("exe dir"), &resource_dir, &data_dir, &home_dir);
    paths.apply();
    std::fs::create_dir_all(&data_dir).expect("can't create the app data dir");
    (Arc::new(Core::new(Arc::new(micro::MicroBackend), Arc::new(credentials::Keychain), data_dir)), paths)
}

/// `beambox <command>`: run one CLI command and return the exit code.
pub fn run_cli() -> i32 {
    #[cfg(windows)]
    // SAFETY: plain Win32 call. Release builds are GUI-subsystem apps, so attach to the terminal we were run from.
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
    }
    use clap::Parser;
    let cli = cli::Cli::parse();
    let (core, paths) = setup(&context());
    let runtime = tokio::runtime::Runtime::new().expect("tokio");
    let (mut stdout, mut stderr) = (std::io::stdout(), std::io::stderr());
    let result = runtime.block_on(async {
        // `credentials set` typed at a terminal reads the secret without echoing it.
        let typed = match &cli.command {
            cli::Command::Credentials { action: cli::Credentials::Set { name } } if std::io::IsTerminal::is_terminal(&std::io::stdin()) => {
                Some(cli::read_hidden(&format!("Paste the {name} key or token (hidden), then press Enter: "))?)
            }
            _ => None,
        };
        let mut stdin: Box<dyn std::io::Read> = match &typed {
            Some(text) => Box::new(std::io::Cursor::new(text.clone().into_bytes())),
            None => Box::new(std::io::stdin()),
        };
        let mut io = cli::Io { stdin: &mut stdin, stdout: &mut stdout, stderr: &mut stderr };
        match &cli.command {
            cli::Command::Shell { name } => cli::shell(&core, name, false).await,
            cli::Command::Attach { name } => cli::shell(&core, name, true).await,
            cli::Command::Desktop { name } => cli::desktop(&core, name, &mut io).await,
            cli::Command::Doctor => cli::doctor(&paths, &mut io),
            _ => cli::run(&cli, &core, &mut io).await,
        }
    });
    result.unwrap_or_else(|e| {
        eprintln!("beambox: {e}");
        1
    })
}

#[tauri::command]
async fn list(app: State<'_, App>) -> Result<Vec<SandboxInfo>> {
    app.core.backend.list().await
}

#[tauri::command]
async fn create(app: State<'_, App>, opts: CreateOpts) -> Result<SandboxInfo> {
    app.core.create(opts).await
}

#[tauri::command]
async fn start(app: State<'_, App>, name: String) -> Result<()> {
    app.core.start(&name).await
}

#[tauri::command]
async fn stop(app: State<'_, App>, name: String) -> Result<()> {
    app.core.stop(&name).await
}

#[tauri::command]
async fn fork(app: State<'_, App>, name: String) -> Result<SandboxInfo> {
    app.core.fork(&name).await
}

#[tauri::command]
async fn snapshot(app: State<'_, App>, name: String) -> Result<String> {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?;
    app.core.snapshot(&name, secs.as_secs()).await
}

#[tauri::command]
async fn delete(app: State<'_, App>, name: String) -> Result<()> {
    app.core.delete(&name).await
}

#[tauri::command]
async fn list_dir(app: State<'_, App>, name: String, path: String) -> Result<Vec<DirEntry>> {
    app.core.backend.list_dir(&name, &path).await
}

/// Raw bytes over IPC, not a JSON array of numbers.
#[tauri::command]
async fn read_file(app: State<'_, App>, name: String, path: String) -> Result<tauri::ipc::Response> {
    app.core.backend.read_file(&name, &path).await.map(tauri::ipc::Response::new)
}

/// The body is the raw file; `name` and `path` come URI-encoded in headers.
#[tauri::command]
async fn write_file(app: State<'_, App>, request: tauri::ipc::Request<'_>) -> Result<()> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let header = |key: &str| {
        let value = request.headers().get(key).and_then(|v| v.to_str().ok()).ok_or(format!("missing {key}"))?;
        percent_encoding::percent_decode_str(value).decode_utf8().map(|v| v.into_owned()).map_err(|e| e.to_string())
    };
    app.core.backend.write_file(&header("name")?, &header("path")?, data.clone()).await
}

#[tauri::command]
async fn logs(app: State<'_, App>, name: String) -> Result<Vec<String>> {
    app.core.backend.logs(&name).await
}

#[tauri::command]
async fn metrics(app: State<'_, App>, name: String) -> Result<Metrics> {
    app.core.backend.metrics(&name).await
}

#[tauri::command]
async fn set_takeover(app: State<'_, App>, name: String, on: bool) -> Result<()> {
    app.core.set_takeover(&name, on).await
}

#[tauri::command]
async fn takeover(app: State<'_, App>, name: String) -> Result<bool> {
    app.core.is_taken_over(&name).await
}

/// `running`, `frozen` or `exited`.
#[tauri::command]
async fn agent_status(app: State<'_, App>, name: String) -> Result<&'static str> {
    app.core.agent_status(&name).await
}

#[tauri::command]
async fn restart_agent(app: State<'_, App>, name: String) -> Result<()> {
    app.core.restart_agent_session(&name).await
}

#[tauri::command]
fn credentials_list(app: State<'_, App>) -> Result<Vec<String>> {
    credentials::stored(app.core.secrets.as_ref())
}

/// The keys a harness could use when none it can use is stored yet; empty when it's ready to create.
#[tauri::command]
fn credentials_missing(app: State<'_, App>, harness: String) -> Result<Vec<&'static str>> {
    app.core.missing_credentials(&harness)
}

#[tauri::command]
fn credentials_set(app: State<'_, App>, name: String, value: String) -> Result<()> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Paste a key or token first".into());
    }
    app.core.secrets.set(&name, value)
}

#[tauri::command]
fn credentials_remove(app: State<'_, App>, name: String) -> Result<()> {
    app.core.secrets.remove(&name)
}

#[derive(serde::Serialize)]
struct HypervisorReport {
    state: hypervisor::HypervisorState,
    os: &'static str,
}

#[tauri::command]
async fn hypervisor_status() -> HypervisorReport {
    let os = std::env::consts::OS;
    HypervisorReport { state: hypervisor::check(os, std::env::consts::ARCH, hypervisor::probe), os }
}

/// Windows only: enable Windows Hypervisor Platform through an elevated PowerShell (UAC prompt).
#[tauri::command]
async fn enable_hypervisor() -> Result<()> {
    let script = "Start-Process powershell -Verb RunAs -Wait -ArgumentList \
        '-NoProfile -Command Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart'";
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("Enabling Windows Hypervisor Platform was cancelled or failed".into()) }
}

#[tauri::command]
async fn install_cli() -> Result<String> {
    cli::install_cli()
}

/// The sandbox to open once, if `beambox desktop` launched this window.
#[tauri::command]
fn take_open(app: State<'_, App>) -> Option<String> {
    app.open_at_launch.lock().expect("lock").take()
}

/// Start a WebSocket proxy to the sandbox's VNC port and return its local port.
#[tauri::command]
async fn desktop_port(app: State<'_, App>, name: String) -> Result<u16> {
    let mut proxies = app.desktop_proxies.lock().await;
    if let Some(port) = proxies.get(&name) {
        return Ok(*port);
    }
    let sandboxes = app.core.backend.list().await?;
    let vnc = sandboxes
        .iter()
        .find(|s| s.name == name)
        .and_then(|s| s.ports.iter().find(|p| p.guest == core::VNC_PORT))
        .ok_or("this sandbox has no desktop")?;
    let port = proxy::serve(([127, 0, 0, 1], vnc.host).into()).await.map_err(|e| e.to_string())?;
    proxies.insert(name, port);
    Ok(port)
}

#[tauri::command]
async fn terminal_open(app: State<'_, App>, name: String, output: Channel<Vec<u8>>) -> Result<u64> {
    // Agent sandboxes show the agent's own terminal.
    let harness = app.core.backend.list().await?.into_iter().find(|s| s.name == name).and_then(|s| s.harness);
    let program = agent::terminal_command(harness.as_deref());
    let sandbox = micro::connect(&name).await?;
    let mut handle = sandbox
        .exec_stream_with(&program[0], |o| o.args(&program[1..]).tty(true).stdin_pipe())
        .await
        .map_err(|e| e.to_string())?;
    let stdin = handle.take_stdin().ok_or("no stdin")?;
    let id = {
        let mut next = app.next_terminal.lock().expect("lock");
        *next += 1;
        *next
    };
    app.terminals.lock().await.insert(id, (stdin, handle.control()));
    let terminals = app.terminals.clone();
    tokio::spawn(async move {
        while let Some(event) = handle.recv().await {
            let sent = match event {
                ExecEvent::Stdout(data) | ExecEvent::Stderr(data) => output.send(data.to_vec()),
                ExecEvent::Exited { .. } | ExecEvent::Failed(_) => break,
                _ => Ok(()),
            };
            if sent.is_err() {
                break;
            }
        }
        terminals.lock().await.remove(&id);
    });
    Ok(id)
}

#[tauri::command]
async fn terminal_input(app: State<'_, App>, id: u64, data: String) -> Result<()> {
    let terminals = app.terminals.lock().await;
    let (stdin, _) = terminals.get(&id).ok_or("terminal closed")?;
    stdin.write(data).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn terminal_resize(app: State<'_, App>, id: u64, rows: u16, cols: u16) -> Result<()> {
    let terminals = app.terminals.lock().await;
    let (_, control) = terminals.get(&id).ok_or("terminal closed")?;
    control.resize(rows, cols).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn terminal_close(app: State<'_, App>, id: u64) -> Result<()> {
    if let Some((_, control)) = app.terminals.lock().await.remove(&id) {
        let _ = control.kill().await;
    }
    Ok(())
}

/// The window. `open` is a sandbox whose desktop to show first.
pub fn run(open: Option<String>) {
    let context = context();
    let (core, _) = setup(&context);
    // Free the disk space older versions' snapshots take, in the background.
    let pruning = core.clone();
    tauri::async_runtime::spawn(async move {
        match pruning.prune_snapshots().await {
            Ok(removed) if !removed.is_empty() => eprintln!("beambox: deleted old snapshots {}", removed.join(", ")),
            Ok(_) => {}
            Err(e) => eprintln!("beambox: couldn't delete old snapshots: {e}"),
        }
    });
    tauri::Builder::default()
        // First: a second launch (`beambox desktop`, a Dock click) focuses this window instead of opening another.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = (window.unminimize(), window.show(), window.set_focus());
            }
            if let cli::Mode::Gui(Some(name)) = cli::mode(argv.get(1..).unwrap_or_default()) {
                let _ = app.emit("open", name);
            }
        }))
        // Sign-in links in an agent's terminal open in the computer's own browser.
        .plugin(tauri_plugin_opener::init())
        // The New sandbox form's folder picker.
        .plugin(tauri_plugin_dialog::init())
        .manage(App {
            core,
            terminals: Default::default(),
            next_terminal: Mutex::new(0),
            desktop_proxies: Default::default(),
            open_at_launch: Mutex::new(open),
        })
        .invoke_handler(tauri::generate_handler![
            list,
            create,
            start,
            stop,
            fork,
            snapshot,
            delete,
            list_dir,
            read_file,
            write_file,
            logs,
            metrics,
            set_takeover,
            takeover,
            agent_status,
            restart_agent,
            credentials_list,
            credentials_set,
            credentials_remove,
            credentials_missing,
            hypervisor_status,
            enable_hypervisor,
            install_cli,
            take_open,
            desktop_port,
            terminal_open,
            terminal_input,
            terminal_resize,
            terminal_close,
        ])
        .run(context)
        .expect("error while running beambox");
}
