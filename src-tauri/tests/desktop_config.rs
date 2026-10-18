use serde_json::Value;

fn tauri_config() -> Value {
    serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON")
}

#[test]
fn desktop_config_keeps_native_drag_drop_and_local_sidecar_csp() {
    let config = tauri_config();
    let window = &config["app"]["windows"][0];
    assert_eq!(window["dragDropEnabled"], Value::Bool(true));

    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("desktop CSP must be configured");
    assert!(csp.contains("default-src 'self'"));
    assert!(csp.contains("connect-src 'self' http://127.0.0.1:*"));
    assert!(csp.contains("ipc: http://ipc.localhost"));
    assert!(!csp.contains("connect-src *"));
}

#[test]
fn production_csp_has_no_eval_dev_server_or_unused_asset_protocol() {
    let config = tauri_config();
    let security = &config["app"]["security"];
    let csp = security["csp"]
        .as_str()
        .expect("desktop CSP must be configured");
    assert!(!csp.contains("'unsafe-eval'"));
    assert!(
        !csp.contains("ws:"),
        "the Vite dev socket is development only"
    );
    assert!(!csp.contains("asset:") && !csp.contains("asset.localhost"));
    // the asset protocol stays off, so nothing in the CSP needs to name it
    assert!(security.get("assetProtocol").is_none());

    let dev_csp = security["devCsp"]
        .as_str()
        .expect("development keeps its own CSP for the Vite dev server");
    assert!(dev_csp.contains("ws://127.0.0.1:5173"));
    assert!(!dev_csp.contains("'unsafe-eval'"));
}

#[test]
fn main_window_has_only_the_permissions_needed_for_native_commands_and_events() {
    let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json"))
        .expect("main capability must be valid JSON");
    let permissions = capability["permissions"]
        .as_array()
        .expect("main capability must list permissions");
    let has_permission = |expected: &str| {
        permissions
            .iter()
            .any(|permission| permission.as_str() == Some(expected))
    };

    assert!(has_permission("core:event:allow-listen"));
    assert!(has_permission("core:event:allow-unlisten"));
    assert!(has_permission("allow-backend-request"));
    assert!(has_permission("allow-native-commands"));
    assert!(has_permission("allow-window-chrome"));
    assert!(has_permission("allow-app-lifecycle"));
    // dialogs open only through the typed pick_* commands, never from page script
    assert!(!permissions.iter().any(|permission| permission
        .as_str()
        .is_some_and(|name| name.starts_with("dialog:"))));
    // the title bar drags the window and maximizes it on double-click through Tauri's drag region
    assert!(has_permission("core:window:allow-start-dragging"));
    assert!(has_permission("core:window:allow-internal-toggle-maximize"));
}

#[test]
fn every_registered_command_is_allowed_for_the_main_window() {
    // a command left out of the permission files fails on every call from the page, and the
    // e2e suite's fake backend never notices
    let source = include_str!("../src/lib.rs");
    let list = "generate_handler![";
    let start = source.find(list).expect("lib.rs registers its commands") + list.len();
    let end = start
        + source[start..]
            .find(']')
            .expect("the command list is closed");
    let commands: Vec<&str> = source[start..end]
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    assert!(commands.contains(&"backend_request"));

    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let authority = context.runtime_authority_mut();
    let denied: Vec<&str> = commands
        .into_iter()
        .filter(|command| {
            authority
                .resolve_access(command, "main", "main", &tauri::ipc::Origin::Local)
                .is_none()
        })
        .collect();
    assert!(
        denied.is_empty(),
        "registered without a permission: {denied:?}"
    );
}

#[test]
fn bundled_documents_are_allowed_only_from_the_local_main_window() {
    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let authority = context.runtime_authority_mut();
    assert!(authority
        .resolve_access(
            "open_local_document",
            "main",
            "main",
            &tauri::ipc::Origin::Local
        )
        .is_some());
    assert!(authority
        .resolve_access(
            "open_local_document",
            "other",
            "other",
            &tauri::ipc::Origin::Local
        )
        .is_none());
    assert!(authority
        .resolve_access(
            "open_local_document",
            "main",
            "main",
            &tauri::ipc::Origin::Remote {
                url: tauri::Url::parse("https://example.com").unwrap(),
            },
        )
        .is_none());
}
