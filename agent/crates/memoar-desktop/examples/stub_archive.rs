//! Serves the stand-in archive the headless UI tests sign in to.
//!
//! cargo run --example stub_archive -- 127.0.0.1:47613
//!
//! Prints the endpoint once it is listening, then serves until killed.

#[path = "../tests/support/stub.rs"]
mod stub;

fn main() {
    let address = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:47613".to_owned());
    let endpoint = stub::serve(&address);
    println!("stub archive listening at {endpoint}");
    loop {
        std::thread::park();
    }
}
