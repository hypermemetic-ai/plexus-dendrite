//! With `embedded-app`, the frontend's build (`../frontend/dist`) is
//! compiled into the binary (plexus-shell's table, `embedded_app!()` in
//! main.rs); without it, an empty table. It only reads what a frontend
//! build left there — it never runs one: `cargo build` needs no Node.
fn main() {
    plexus_shell::build::embed_dir_with_feature("../frontend/dist", "embedded-app");
}
