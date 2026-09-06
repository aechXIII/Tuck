use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlatformCapabilities {
    pub platform: String,
    pub architecture: String,
    #[serde(rename = "sendToIntegration")]
    pub send_to_integration: bool,
    #[serde(rename = "publicCli")]
    pub public_cli: bool,
    #[serde(rename = "automaticUpdater")]
    pub automatic_updater: bool,
    pub packaged: bool,
}

pub fn is_packaged() -> bool {
    // in debug builds we are in development; packaged only in release
    !cfg!(debug_assertions)
}

pub fn capabilities_for_target(platform: &str, packaged: bool) -> PlatformCapabilities {
    let (send_to, public_cli, updater) = match platform {
        "windows" => (true, true, true),
        "linux" => (false, false, false),
        _ => (false, false, false),
    };
    PlatformCapabilities {
        platform: platform.to_owned(),
        architecture: "x86_64".to_owned(),
        send_to_integration: send_to,
        public_cli,
        automatic_updater: updater,
        packaged,
    }
}

pub fn current_capabilities() -> PlatformCapabilities {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    capabilities_for_target(platform, is_packaged())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_capabilities_have_expected_features() {
        let caps = capabilities_for_target("windows", false);
        assert_eq!(caps.platform, "windows");
        assert_eq!(caps.architecture, "x86_64");
        assert!(caps.send_to_integration);
        assert!(caps.public_cli);
        assert!(caps.automatic_updater);
        assert!(!caps.packaged);
    }

    #[test]
    fn linux_capabilities_hide_windows_features() {
        let caps = capabilities_for_target("linux", false);
        assert_eq!(caps.platform, "linux");
        assert_eq!(caps.architecture, "x86_64");
        assert!(!caps.send_to_integration);
        assert!(!caps.public_cli);
        assert!(!caps.automatic_updater);
    }

    #[test]
    fn packaged_flag_reflects_build() {
        let dev = capabilities_for_target("windows", false);
        let pkg = capabilities_for_target("windows", true);
        assert!(!dev.packaged);
        assert!(pkg.packaged);
    }
}
