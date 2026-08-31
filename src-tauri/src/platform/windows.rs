use tokio::process::{Child, Command};

pub async fn terminate_process_tree(child: &mut Child) -> std::io::Result<()> {
    let Some(process_id) = child.id() else {
        return Ok(());
    };
    let status = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .status()
        .await?;
    if status.success() {
        child.wait().await.map(|_| ())
    } else {
        child.kill().await
    }
}
