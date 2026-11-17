# Third-party components bundled with Beambox

| Component | Licence | Source |
| --- | --- | --- |
| libkrunfw (Linux kernel packaged as a library, bundled as `runtime/libkrunfw.*`) | LGPL-2.1; the bundled kernel is GPL-2.0 | https://github.com/containers/libkrunfw (version 5.6.1, as pinned by microsandbox 0.7.15) |
| microsandbox (`msb` sidecar and Rust crate) | Apache-2.0 | https://github.com/superradcompany/microsandbox |
| noVNC | MPL-2.0 | https://github.com/novnc/noVNC |
| Tauri, React, xterm.js, Motion, sonner, Radix UI, Tailwind CSS | MIT / Apache-2.0 | see each package's licence in `node_modules` and `~/.cargo/registry` |

libkrunfw is loaded at runtime as a separate shared library and can be replaced by a compatible build. The
corresponding source for the bundled kernel is available at the libkrunfw link above.
