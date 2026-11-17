//! Where the bundled microsandbox runtime lives. Nothing outside the app bundle and its data dir is used,
//! so `~/.microsandbox` is never read.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimePaths {
    /// The `msb` sidecar. Tauri puts sidecars next to the app executable.
    pub msb: PathBuf,
    /// `libkrunfw`, bundled as a resource under `runtime/`.
    pub libkrunfw: PathBuf,
    /// microsandbox state (images, sandboxes, database).
    pub home: PathBuf,
}

/// `os` is a `std::env::consts::OS` value: `macos`, `linux` or `windows`.
///
/// microsandbox derives Unix socket paths from `MSB_HOME` that add ~50 bytes, and macOS/Linux cap socket paths at
/// 104/108 bytes, so `~/Library/Application Support/<id>/…` is too long there. macOS and Linux use `~/.beambox`;
/// Windows keeps the app data dir.
pub fn resolve(os: &str, exe_dir: &Path, resource_dir: &Path, data_dir: &Path, home_dir: &Path) -> RuntimePaths {
    RuntimePaths {
        msb: exe_dir.join(microsandbox_utils::msb_binary_filename(os)),
        libkrunfw: resource_dir.join("runtime").join(microsandbox_utils::libkrunfw_filename(os)),
        home: if os == "windows" { data_dir.join("microsandbox") } else { home_dir.join(".beambox") },
    }
}

impl RuntimePaths {
    pub fn env(&self) -> [(&'static str, &Path); 3] {
        [("MSB_PATH", &self.msb), ("MSB_LIBKRUNFW_PATH", &self.libkrunfw), ("MSB_HOME", &self.home)]
    }

    /// Point microsandbox at the bundled runtime. Call before any other thread starts.
    pub fn apply(&self) {
        for (key, value) in self.env() {
            // SAFETY: called once at startup, before the async runtime spawns threads.
            unsafe { std::env::set_var(key, value) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_bundled_paths_per_os_and_never_the_home_runtime() {
        let mac_data = "/Users/a.long.user.name/Library/Application Support/app.beambox.desktop";
        let cases = [
            ("macos", "/A.app/Contents/MacOS", "/A.app/Contents/Resources", mac_data, "/Users/a.long.user.name", "msb", "libkrunfw.5.dylib", "/Users/a.long.user.name/.beambox"),
            ("linux", "/usr/bin", "/usr/lib/beambox", "/home/u/.local/share/x", "/home/u", "msb", "libkrunfw.so.5.6.1", "/home/u/.beambox"),
            ("windows", r"C:\P\Beambox", r"C:\P\Beambox", r"C:\U\AppData\Roaming\x", r"C:\U", "msb.exe", "libkrunfw.dll", ""),
        ];
        for (os, exe, res, data, home, msb, lib, msb_home) in cases {
            let p = resolve(os, Path::new(exe), Path::new(res), Path::new(data), Path::new(home));
            assert_eq!(p.msb, Path::new(exe).join(msb), "{os}");
            assert_eq!(p.libkrunfw, Path::new(res).join("runtime").join(lib), "{os}");
            let want = if os == "windows" { Path::new(data).join("microsandbox") } else { PathBuf::from(msb_home) };
            assert_eq!(p.home, want, "{os}");
            // Socket paths add ~50 bytes to MSB_HOME and must stay under 104 bytes on macOS.
            if os != "windows" {
                assert!(p.home.as_os_str().len() + 50 < 104, "{os}: {:?} too long for sockets", p.home);
            }
            let keys: Vec<_> = p.env().iter().map(|(k, _)| *k).collect();
            assert_eq!(keys, ["MSB_PATH", "MSB_LIBKRUNFW_PATH", "MSB_HOME"]);
            for (_, value) in p.env() {
                assert!(!value.to_string_lossy().contains(".microsandbox"), "{os}: {value:?}");
            }
        }
    }
}
