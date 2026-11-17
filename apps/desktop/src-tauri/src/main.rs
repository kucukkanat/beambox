// Release builds on Windows have no console window; the CLI attaches to the terminal it was run from.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use beambox_lib::cli::{Mode, mode};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match mode(&args) {
        Mode::Gui(open) => beambox_lib::run(open),
        Mode::Cli => std::process::exit(beambox_lib::run_cli()),
    }
}
