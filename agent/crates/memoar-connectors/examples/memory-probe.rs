use std::path::PathBuf;

fn main() {
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let workspaces: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    let files = memoar_connectors::memory::memory_files(&home, &workspaces);
    println!("{} memory files", files.len());
    for file in &files {
        println!(
            "  [{}] {} <- {}",
            file.scope.as_str(),
            file.path.display(),
            file.readers.join(", ")
        );
    }
}
