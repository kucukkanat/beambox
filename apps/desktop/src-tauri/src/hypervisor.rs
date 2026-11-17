//! Is the host's hypervisor usable? The probe is injected so every OS can be tested anywhere.
use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HypervisorState {
    Ok,
    Missing,
    Unsupported,
}

/// `os`/`arch` are `std::env::consts` values. `available` probes Hypervisor.framework, /dev/kvm or WHP.
pub fn check(os: &str, arch: &str, available: impl Fn() -> bool) -> HypervisorState {
    match (os, arch) {
        ("macos", "aarch64") | ("linux", _) | ("windows", _) if available() => HypervisorState::Ok,
        ("macos", "aarch64") | ("linux", _) | ("windows", _) => HypervisorState::Missing,
        _ => HypervisorState::Unsupported,
    }
}

/// The real probe for the current OS.
pub fn probe() -> bool {
    match std::env::consts::OS {
        "macos" => std::process::Command::new("sysctl")
            .args(["-n", "kern.hv_support"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "1"),
        "linux" => std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").is_ok(),
        // WinHvPlatform.dll only exists once "Windows Hypervisor Platform" is enabled.
        "windows" => std::path::Path::new(r"C:\Windows\System32\WinHvPlatform.dll").exists(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use HypervisorState::*;

    #[test]
    fn reports_each_state_per_os() {
        let cases = [
            ("macos", "aarch64", true, Ok),
            ("macos", "aarch64", false, Missing),
            ("macos", "x86_64", true, Unsupported),
            ("linux", "x86_64", true, Ok),
            ("linux", "aarch64", false, Missing),
            ("windows", "x86_64", true, Ok),
            ("windows", "aarch64", false, Missing),
            ("freebsd", "x86_64", true, Unsupported),
        ];
        for (os, arch, available, want) in cases {
            assert_eq!(check(os, arch, || available), want, "{os}/{arch}/{available}");
        }
    }
}
