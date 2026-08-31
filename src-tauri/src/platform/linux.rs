use tokio::process::Child;

pub async fn terminate_process_tree(child: &mut Child) -> std::io::Result<()> {
    child.kill().await?;
    child.wait().await.map(|_| ())
}
