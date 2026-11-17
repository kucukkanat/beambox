//! Where the bundled microsandbox runtime lives. Nothing outside the app bundle and its data dir is used,
//! so `~/.microsandbox` is never read.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimePaths {
    /// The `msb` sidecar. Tauri puts sidecars next to the app executable.
    pub msb: PathBuf,
    /// `libkrunfw`, bundled as a resource under `runtime/`.
    pub libkrunfw: PathBuf,
    /// microsandbox state (images, sandboxes, database) inside the app data dir.
    pub home: PathBuf,
}

/// `os` is a `std::env::consts::OS` value: `macos`, `linux` or `windows`.
pub fn resolve(os: &str, exe_dir: &Path, resource_dir: &Path, data_dir: &Path) -> RuntimePaths {
    RuntimePaths {
        msb: exe_dir.join(microsandbox_utils::msb_binary_filename(os)),
        libkrunfw: resource_dir.join("runtime").join(microsandbox_utils::libkrunfw_filename(os)),
        home: data_dir.join("microsandbox"),
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
        let cases = [
            ("macos", "/A.app/Contents/MacOS", "/A.app/Contents/Resources", "/u/Library/Application Support/x", "msb", "libkrunfw.5.dylib"),
            ("linux", "/usr/bin", "/usr/lib/beambox", "/home/u/.local/share/x", "msb", "libkrunfw.so.5.6.1"),
            ("windows", r"C:\P\Beambox", r"C:\P\Beambox", r"C:\U\AppData\Roaming\x", "msb.exe", "libkrunfw.dll"),
        ];
        for (os, exe, res, data, msb, lib) in cases {
            let p = resolve(os, Path::new(exe), Path::new(res), Path::new(data));
            assert_eq!(p.msb, Path::new(exe).join(msb), "{os}");
            assert_eq!(p.libkrunfw, Path::new(res).join("runtime").join(lib), "{os}");
            assert_eq!(p.home, Path::new(data).join("microsandbox"), "{os}");
            let keys: Vec<_> = p.env().iter().map(|(k, _)| *k).collect();
            assert_eq!(keys, ["MSB_PATH", "MSB_LIBKRUNFW_PATH", "MSB_HOME"]);
            for (_, value) in p.env() {
                assert!(!value.to_string_lossy().contains(".microsandbox"), "{os}: {value:?}");
            }
        }
    }
}
