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
}
