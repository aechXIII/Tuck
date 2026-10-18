use std::ffi::{OsStr, OsString};
use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tokio::process::{Child, Command};

/// How WebKitGTK draws the window, chosen once per launch before the WebView starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Renderer {
    /// GPU compositing and the DMABUF renderer
    Full,
    /// GPU compositing without the DMABUF renderer, which leaves NVIDIA's own driver
    /// with a blank window
    Compositing,
    /// software drawing only. Video previews are much slower, but it starts under
    /// virtual GPUs and software GL
    Portable,
}

#[derive(Clone, Copy, Debug)]
struct RendererChoice {
    renderer: Renderer,
    /// a renderer the user forced is kept even after a crash, so restarting can't loop
    automatic: bool,
}

static RENDERER: OnceLock<RendererChoice> = OnceLock::new();

/// Display drivers of virtual machines and firmware framebuffers. WebKitGTK's GPU
/// renderer crashes or falls back to software GL on these.
const VIRTUAL_DISPLAY_DRIVERS: &[&str] = &[
    "virtio_gpu",
    "vmwgfx",
    "vboxvideo",
    "qxl",
    "bochs-drm",
    "cirrus",
    "cirrus-qemu",
    "hyperv_drm",
    "simple-framebuffer",
    "simpledrm",
    "vkms",
    "vgem",
];

// must match the identifier in tauri.conf.json, which also names WebKit's own cache folder
const APP_IDENTIFIER: &str = "com.tuck.app";
const RENDERER_FAILURE_FILE: &str = "gpu-renderer-failed";

/// Prepare process-wide environment before the WebView and its child processes
/// start. Every child WebKit process inherits this environment, so it must be
/// set before `tauri::Builder` runs.
///
/// - `WEBKIT_DISABLE_DMABUF_RENDERER` / `WEBKIT_DISABLE_COMPOSITING_MODE`:
///   WebKitGTK's GPU renderer makes video previews far smoother, but under
///   virtual-machine display drivers (VMware, VirtualBox, virgl) and software GL
///   it crashes the web process, which the user sees as a white window or an
///   editor that never reacts to imports. The renderer is picked from the
///   machine's display drivers, and a GPU crash is remembered for this version
///   so later launches draw in software (see [`watch_gpu_renderer`]).
/// - `GIO_MODULE_DIR`: an AppImage built on the oldest supported distribution
///   ships an older GLib than newer hosts. The host's GIO modules under
///   `/usr/lib` then fail to load with `undefined symbol` errors and can take
///   the web process down with them, so an AppImage run uses only the GIO
///   modules it bundled.
/// - `GST_PLUGIN_SYSTEM_PATH_1_0` / `GST_PLUGIN_PATH_1_0` / `GST_REGISTRY_1_0`:
///   an AppImage run loads its bundled GStreamer plugins through a fixed path,
///   so GStreamer's plugin cache stays valid between launches (see
///   [`stable_gstreamer_plugins`]).
/// - `GTK_THEME`: WebKitGTK paints native `<select>` popups, option lists, and
///   number spinners with the system GTK theme. Tuck's UI is always dark, so on
///   a session with no dark GTK theme configured those controls render light and
///   unreadable. Default to `Adwaita:dark`. Set `GTK_THEME` yourself to override.
/// - `GDK_BACKEND`: the AppImage's GTK hook forces X11, working around a WebKitGTK
///   crash on some Wayland setups (Tauri issue 8541). With the native player on,
///   Tuck runs GTK natively on a Wayland desktop instead: under X11, GTK 3's GL
///   area uses GLX, which can't take decoded GPU frames, so every frame shown
///   would be copied through memory (see [`gdk_backend`]).
///
/// Each value is only set when the user has not already chosen one, so setting
/// `WEBKIT_DISABLE_COMPOSITING_MODE=1` yourself forces software drawing. Because
/// WebKitGTK treats any value of its `WEBKIT_DISABLE_*` variables (even `0`) as
/// "disable", two opt-ins are read from the launch environment:
/// - `TUCK_WEBKIT_ACCELERATED=1` forces the full GPU renderer.
/// - `TUCK_WEBKIT_COMPOSITING=1` forces GPU compositing without the DMABUF
///   renderer.
pub fn prepare_runtime_environment() {
    let choice = renderer_choice();
    let _ = RENDERER.set(choice);
    eprintln!("WebKit renderer: {:?}", choice.renderer);
    for (key, value) in webkit_env_defaults(choice.renderer) {
        set_default_env(key, value);
    }
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    if let Some(modules) = bundled_gio_module_dir(appdir.clone()) {
        set_default_env("GIO_MODULE_DIR", modules);
    }
    if let (Some(appdir), Some(cache)) = (appdir, tuck_cache_dir()) {
        match stable_gstreamer_plugins(&appdir, &cache) {
            Ok(Some(gstreamer)) => {
                // the AppImage's own launcher sets both to the mounted folder, so they
                // are replaced rather than defaulted
                std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &gstreamer.plugins);
                let search = std::iter::once(&gstreamer.plugins).chain(&gstreamer.tuck_plugins);
                match std::env::join_paths(search) {
                    Ok(paths) => std::env::set_var("GST_PLUGIN_PATH_1_0", paths),
                    Err(_) => std::env::set_var("GST_PLUGIN_PATH_1_0", &gstreamer.plugins),
                }
                set_default_env("GST_REGISTRY_1_0", &gstreamer.registry);
            }
            Ok(None) => {}
            Err(error) => eprintln!("could not keep the GStreamer plugin cache: {error}"),
        }
    }
    set_default_env("GTK_THEME", "Adwaita:dark");
    let player = crate::player::preview_mode() == crate::player::PreviewMode::Player;
    if let Some(backend) = gdk_backend(player, std::env::var_os("WAYLAND_DISPLAY").as_deref()) {
        // replaced, not defaulted: the AppImage's launcher has already set it to x11
        std::env::set_var("GDK_BACKEND", backend);
    }
}

/// The GTK backend Tuck asks for, or `None` to keep what the launcher chose.
fn gdk_backend(native_player: bool, wayland_display: Option<&OsStr>) -> Option<&'static str> {
    let wayland = wayland_display.is_some_and(|display| !display.is_empty());
    (native_player && wayland).then_some("wayland")
}

#[derive(Debug, PartialEq, Eq)]
struct GstreamerPaths {
    /// the GStreamer plugins bundled from the build distribution
    plugins: PathBuf,
    /// plugins Tuck builds itself, such as the dav1d AV1 decoder, which
    /// replaces the much slower libaom one for previews
    tuck_plugins: Option<PathBuf>,
    registry: PathBuf,
}

/// Tauri bundles Tuck's resources under `usr/lib/<product name>` in the AppImage.
const TUCK_PLUGIN_DIR: &str = "usr/lib/Tuck/gstreamer";

/// Points symlinks at fixed paths in Tuck's cache folder to the bundled GStreamer
/// plugins and to Tuck's own, and returns them with a plugin cache file of Tuck's own.
///
/// GStreamer caches each plugin by its file path. An AppImage mounts at a new
/// random path on every launch, so the cache never matched and the first video of
/// every launch froze the page for about a second while all bundled plugins were
/// loaded again. Through the symlink the paths stay the same. The host's own
/// GStreamer uses the default cache file, so it must not be shared either.
/// Returns `None` when the AppImage has no bundled plugins.
fn stable_gstreamer_plugins(appdir: &Path, cache: &Path) -> io::Result<Option<GstreamerPaths>> {
    let bundled = appdir.join("usr/lib/gstreamer-1.0");
    if !bundled.is_dir() {
        return Ok(None);
    }
    let folder = cache.join("gstreamer");
    std::fs::create_dir_all(&folder)?;
    let plugins = point_link(&folder, "plugins", &bundled)?;
    let own = appdir.join(TUCK_PLUGIN_DIR);
    let tuck_plugins = if own.is_dir() {
        Some(point_link(&folder, "tuck-plugins", &own)?)
    } else {
        None
    };
    Ok(Some(GstreamerPaths {
        plugins,
        tuck_plugins,
        registry: folder.join("registry.bin"),
    }))
}

fn point_link(folder: &Path, name: &str, target: &Path) -> io::Result<PathBuf> {
    let link = folder.join(name);
    // replace the link in one step, so it never points nowhere
    let pending = folder.join(format!("{name}.{}", std::process::id()));
    let _ = std::fs::remove_file(&pending);
    std::os::unix::fs::symlink(target, &pending)?;
    if let Err(error) = std::fs::rename(&pending, &link) {
        let _ = std::fs::remove_file(&pending);
        return Err(error);
    }
    Ok(link)
}

fn renderer_choice() -> RendererChoice {
    let forced = if env_flag_is_set("TUCK_WEBKIT_ACCELERATED") {
        Some(Renderer::Full)
    } else if env_flag_is_set("TUCK_WEBKIT_COMPOSITING") {
        Some(Renderer::Compositing)
    } else {
        None
    };
    if let Some(renderer) = forced {
        return RendererChoice {
            renderer,
            automatic: false,
        };
    }
    let failed_before = renderer_failure_path().is_some_and(|path| gpu_renderer_failed(&path));
    let gpus = probe_gpus(Path::new("/sys/class/drm"), Path::new("/dev/dri"));
    RendererChoice {
        renderer: choose_renderer(failed_before, &gpus),
        automatic: true,
    }
}

#[derive(Debug, Default)]
struct GpuInfo {
    /// kernel driver of each display card, such as `amdgpu`, `i915` or `virtio_gpu`
    drivers: Vec<String>,
    /// a `/dev/dri/renderD*` node, which GPU rendering needs
    render_node: bool,
}

fn probe_gpus(drm_class: &Path, dri_dev: &Path) -> GpuInfo {
    let names = |dir: &Path| -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    };
    let drivers = names(drm_class)
        .into_iter()
        // card0 is a card; card0-HDMI-A-1 is one of its outputs
        .filter(|name| {
            name.strip_prefix("card")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .filter_map(|card| std::fs::read_link(drm_class.join(card).join("device/driver")).ok())
        .filter_map(|driver| Some(driver.file_name()?.to_string_lossy().into_owned()))
        .collect();
    let render_node = names(dri_dev)
        .iter()
        .any(|name| name.starts_with("renderD"));
    GpuInfo {
        drivers,
        render_node,
    }
}

fn choose_renderer(failed_before: bool, gpus: &GpuInfo) -> Renderer {
    let mut real_gpus = gpus
        .drivers
        .iter()
        .filter(|driver| !VIRTUAL_DISPLAY_DRIVERS.contains(&driver.as_str()))
        .peekable();
    if failed_before || !gpus.render_node || real_gpus.peek().is_none() {
        return Renderer::Portable;
    }
    // hybrid laptops can render on either GPU, so any NVIDIA driver decides
    if real_gpus.any(|driver| driver == "nvidia") {
        Renderer::Compositing
    } else {
        Renderer::Full
    }
}

fn webkit_env_defaults(renderer: Renderer) -> Vec<(&'static str, &'static str)> {
    match renderer {
        Renderer::Full => Vec::new(),
        Renderer::Compositing => vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")],
        Renderer::Portable => vec![
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
        ],
    }
}

fn tuck_cache_dir() -> Option<PathBuf> {
    let cache = user_cache_dir(std::env::var_os("XDG_CACHE_HOME"), std::env::var_os("HOME"))?;
    Some(cache.join(APP_IDENTIFIER))
}

fn renderer_failure_path() -> Option<PathBuf> {
    Some(tuck_cache_dir()?.join(RENDERER_FAILURE_FILE))
}

/// The same folder Tauri and WebKit use: `$XDG_CACHE_HOME`, or `~/.cache`.
fn user_cache_dir(xdg_cache_home: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    match xdg_cache_home.map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => Some(dir),
        _ => Some(PathBuf::from(home.filter(|home| !home.is_empty())?).join(".cache")),
    }
}

/// A crash only counts for the version that had it, so an update with a newer
/// WebKit or a fix gets to try the GPU again.
fn gpu_renderer_failed(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|version| version.trim() == env!("CARGO_PKG_VERSION"))
}

fn remember_gpu_renderer_failure(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, env!("CARGO_PKG_VERSION"))
}

/// Calls `on_crash` when the web process crashes while drawing with a GPU renderer
/// Tuck picked by itself, after saving the failure so the next launch draws in
/// software. Nothing is watched when software drawing is already in use or the
/// user forced a renderer, and nothing is called when the failure can't be saved,
/// since a restart would then crash again.
pub fn watch_gpu_renderer(
    window: &tauri::WebviewWindow,
    on_crash: impl Fn() + Send + 'static,
) -> tauri::Result<()> {
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    let Some(choice) = RENDERER.get().copied() else {
        return Ok(());
    };
    if !choice.automatic || choice.renderer == Renderer::Portable {
        return Ok(());
    }
    window.with_webview(move |webview| {
        webview
            .inner()
            .connect_web_process_terminated(move |_, reason| {
                if reason != WebProcessTerminationReason::Crashed {
                    return;
                }
                let Some(path) = renderer_failure_path() else {
                    eprintln!("the GPU renderer crashed and its failure could not be saved");
                    return;
                };
                match remember_gpu_renderer_failure(&path) {
                    Ok(()) => on_crash(),
                    Err(error) => {
                        eprintln!(
                            "the GPU renderer crashed and its failure could not be saved: {error}"
                        )
                    }
                }
            });
    })
}

/// Resolve the AppImage's own GIO module directory, or `None` when not running
/// from an AppImage or when the bundle has no such directory.
fn bundled_gio_module_dir(appdir: Option<PathBuf>) -> Option<PathBuf> {
    let modules = appdir?.join("usr/lib/x86_64-linux-gnu/gio/modules");
    modules.is_dir().then_some(modules)
}

fn set_default_env(key: &str, value: impl AsRef<OsStr>) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

/// A launch-environment flag counts as set for any value except empty or `0`.
fn env_flag_is_set(key: &str) -> bool {
    match std::env::var(key) {
        Ok(value) => !value.is_empty() && value != "0",
        Err(_) => false,
    }
}

pub struct ProcessTreeGuard {
    process_group: libc::pid_t,
    armed: bool,
}

impl ProcessTreeGuard {
    pub fn attach(child: &Child) -> io::Result<Self> {
        let process_group = child.id().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "child process ID is unavailable")
        })? as libc::pid_t;
        Ok(Self {
            process_group,
            armed: true,
        })
    }

    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = kill_process_group(self.process_group);
            reap_process(self.process_group);
        }
    }
}

pub fn configure_child_process(command: &mut Command) {
    // the sidecar is the leader so one signal reaches its FFmpeg descendants
    command.as_std_mut().process_group(0);
}

pub async fn terminate_process_tree(child: &mut Child) -> io::Result<()> {
    let Some(process_id) = child.id() else {
        return Ok(());
    };
    kill_process_group(process_id as libc::pid_t)?;
    child.wait().await.map(|_| ())
}

fn kill_process_group(process_group: libc::pid_t) -> io::Result<()> {
    // the sidecar PID is its process-group ID, so the negative ID targets only its tree
    let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

fn reap_process(process_id: libc::pid_t) {
    let mut status = 0;
    loop {
        // this PID came from the child owned by the guard
        let result = unsafe { libc::waitpid(process_id, &mut status, 0) };
        if result >= 0 || io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gtk_runs_on_wayland_only_with_the_native_player_on_a_wayland_desktop() {
        let display = Some(OsStr::new("wayland-1"));
        assert_eq!(gdk_backend(true, display), Some("wayland"));
        assert_eq!(gdk_backend(false, display), None);
        assert_eq!(gdk_backend(true, None), None);
        assert_eq!(gdk_backend(true, Some(OsStr::new(""))), None);
    }

    fn gpus(drivers: &[&str], render_node: bool) -> GpuInfo {
        GpuInfo {
            drivers: drivers.iter().map(|d| d.to_string()).collect(),
            render_node,
        }
    }

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tuck-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test folder should be creatable");
        dir
    }

    #[test]
    fn real_gpus_get_the_gpu_renderer() {
        assert_eq!(
            choose_renderer(false, &gpus(&["amdgpu"], true)),
            Renderer::Full
        );
        assert_eq!(
            choose_renderer(false, &gpus(&["i915"], true)),
            Renderer::Full
        );
        assert_eq!(
            choose_renderer(false, &gpus(&["simple-framebuffer", "xe"], true)),
            Renderer::Full
        );
    }

    #[test]
    fn nvidia_driver_keeps_compositing_without_dmabuf() {
        assert_eq!(
            choose_renderer(false, &gpus(&["nvidia"], true)),
            Renderer::Compositing
        );
        assert_eq!(
            choose_renderer(false, &gpus(&["i915", "nvidia"], true)),
            Renderer::Compositing
        );
        assert_eq!(
            choose_renderer(false, &gpus(&["nouveau"], true)),
            Renderer::Full
        );
    }

    #[test]
    fn virtual_or_missing_gpus_and_past_crashes_draw_in_software() {
        assert_eq!(
            choose_renderer(false, &gpus(&["virtio_gpu"], true)),
            Renderer::Portable
        );
        assert_eq!(
            choose_renderer(false, &gpus(&["vmwgfx", "simple-framebuffer"], true)),
            Renderer::Portable
        );
        assert_eq!(choose_renderer(false, &gpus(&[], true)), Renderer::Portable);
        assert_eq!(
            choose_renderer(false, &gpus(&["amdgpu"], false)),
            Renderer::Portable
        );
        assert_eq!(
            choose_renderer(true, &gpus(&["amdgpu"], true)),
            Renderer::Portable
        );
    }

    #[test]
    fn each_renderer_sets_only_its_webkit_switches() {
        assert!(webkit_env_defaults(Renderer::Full).is_empty());
        assert_eq!(
            webkit_env_defaults(Renderer::Compositing),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        assert_eq!(
            webkit_env_defaults(Renderer::Portable),
            vec![
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            ]
        );
    }

    #[test]
    fn probe_reads_card_drivers_and_render_nodes() {
        let base = test_dir("gpu-probe");
        let drm = base.join("drm");
        let dri = base.join("dri");
        for (card, driver) in [("card0", "simple-framebuffer"), ("card1", "amdgpu")] {
            let device = base.join("devices").join(card);
            std::fs::create_dir_all(&device).unwrap();
            std::os::unix::fs::symlink(base.join("drivers").join(driver), device.join("driver"))
                .unwrap();
            std::fs::create_dir_all(drm.join(card)).unwrap();
            std::os::unix::fs::symlink(&device, drm.join(card).join("device")).unwrap();
        }
        // outputs of a card are not cards themselves
        std::fs::create_dir_all(drm.join("card1-HDMI-A-1/device")).unwrap();
        std::fs::create_dir_all(&dri).unwrap();

        let mut found = probe_gpus(&drm, &dri);
        found.drivers.sort();
        assert_eq!(found.drivers, ["amdgpu", "simple-framebuffer"]);
        assert!(!found.render_node);

        std::fs::write(dri.join("renderD128"), "").unwrap();
        assert!(probe_gpus(&drm, &dri).render_node);
        assert!(probe_gpus(&base.join("absent"), &base.join("absent"))
            .drivers
            .is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn gpu_crash_is_remembered_only_for_this_version() {
        let base = test_dir("renderer-failure");
        let path = base.join(APP_IDENTIFIER).join(RENDERER_FAILURE_FILE);
        assert!(!gpu_renderer_failed(&path));
        remember_gpu_renderer_failure(&path).expect("failure should be saved");
        assert!(gpu_renderer_failed(&path));
        std::fs::write(&path, "0.0.1").unwrap();
        assert!(!gpu_renderer_failed(&path));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cache_dir_follows_xdg_then_home() {
        assert_eq!(
            user_cache_dir(Some("/x/cache".into()), Some("/home/a".into())),
            Some(PathBuf::from("/x/cache"))
        );
        // the XDG spec says relative values are ignored
        assert_eq!(
            user_cache_dir(Some("rel".into()), Some("/home/a".into())),
            Some(PathBuf::from("/home/a/.cache"))
        );
        assert_eq!(user_cache_dir(None, Some("".into())), None);
        assert_eq!(user_cache_dir(None, None), None);
    }

    #[test]
    fn identifier_matches_the_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }

    #[test]
    fn bundled_gio_module_dir_needs_an_appimage_with_that_directory() {
        assert_eq!(bundled_gio_module_dir(None), None);

        let base = std::env::temp_dir().join(format!("tuck-gio-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(bundled_gio_module_dir(Some(base.join("absent"))), None);

        let appdir = base.join("AppDir");
        let modules = appdir.join("usr/lib/x86_64-linux-gnu/gio/modules");
        std::fs::create_dir_all(&modules).expect("test AppDir should be creatable");
        assert_eq!(bundled_gio_module_dir(Some(appdir)), Some(modules));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn gstreamer_plugins_keep_one_path_across_mounts() {
        let base = test_dir("gstreamer-link");
        let cache = base.join("cache");
        assert_eq!(
            stable_gstreamer_plugins(&base.join("no-plugins"), &cache).unwrap(),
            None
        );

        let first = base.join("mount-a");
        let second = base.join("mount-b");
        for mount in [&first, &second] {
            std::fs::create_dir_all(mount.join("usr/lib/gstreamer-1.0")).unwrap();
        }
        std::fs::create_dir_all(first.join(TUCK_PLUGIN_DIR)).unwrap();
        let expected = GstreamerPaths {
            plugins: cache.join("gstreamer/plugins"),
            tuck_plugins: Some(cache.join("gstreamer/tuck-plugins")),
            registry: cache.join("gstreamer/registry.bin"),
        };
        assert_eq!(
            stable_gstreamer_plugins(&first, &cache).unwrap().as_ref(),
            Some(&expected)
        );
        assert_eq!(
            std::fs::read_link(&expected.plugins).unwrap(),
            first.join("usr/lib/gstreamer-1.0")
        );
        assert_eq!(
            std::fs::read_link(cache.join("gstreamer/tuck-plugins")).unwrap(),
            first.join(TUCK_PLUGIN_DIR)
        );
        // the next launch mounts somewhere else; the links follow it. A build
        // without plugins of its own leaves Tuck's plugin folder off the path
        let next = stable_gstreamer_plugins(&second, &cache).unwrap().unwrap();
        assert_eq!(
            std::fs::read_link(&expected.plugins).unwrap(),
            second.join("usr/lib/gstreamer-1.0")
        );
        assert_eq!(next.tuck_plugins, None);
        assert_eq!(
            std::fs::read_dir(cache.join("gstreamer")).unwrap().count(),
            2
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn set_default_env_keeps_an_explicit_choice() {
        let key = "TUCK_TEST_SET_DEFAULT_ENV";
        std::env::remove_var(key);
        set_default_env(key, "portable");
        assert_eq!(std::env::var(key).as_deref(), Ok("portable"));
        set_default_env(key, "accelerated");
        assert_eq!(std::env::var(key).as_deref(), Ok("portable"));
        std::env::remove_var(key);
    }

    #[test]
    fn env_flag_treats_empty_and_zero_as_unset() {
        let key = "TUCK_TEST_ENV_FLAG";
        std::env::remove_var(key);
        assert!(!env_flag_is_set(key));
        std::env::set_var(key, "");
        assert!(!env_flag_is_set(key));
        std::env::set_var(key, "0");
        assert!(!env_flag_is_set(key));
        std::env::set_var(key, "1");
        assert!(env_flag_is_set(key));
        std::env::remove_var(key);
    }

    #[tokio::test]
    async fn child_is_its_own_process_group_and_guard_reaps_it() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        configure_child_process(&mut command);
        let child = command.spawn().expect("test child should start");
        let process_id = child.id().expect("test child should have an ID") as libc::pid_t;
        assert_eq!(unsafe { libc::getpgid(process_id) }, process_id);

        let guard = ProcessTreeGuard::attach(&child).expect("child should be supervised");
        drop(guard);

        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(process_id, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}
