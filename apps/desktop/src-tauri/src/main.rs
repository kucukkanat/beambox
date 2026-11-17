// Release builds on Windows have no console window. Piped stdio for `--mcp` still works.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        beambox_lib::run_mcp();
    } else {
        beambox_lib::run();
    }
}
