//! `cargo xtask <task>` — the Rust side's door to the project's automation.
//!
//! The xtask convention (a workspace binary behind a cargo alias, see
//! .cargo/config.toml) keeps project automation reachable with nothing but
//! cargo. The tasks themselves are the scripts in `scripts/`: `cargo xtask
//! ci` runs `scripts/ci.sh`, `cargo xtask dev` runs `scripts/dev.sh`, and so
//! on, so `npm run`, CI and this binary all run the same steps — one
//! definition of each, whatever layers the project was made from.
//!
//!   cargo xtask              list the tasks
//!   cargo xtask <task> ...   run scripts/<task>.sh with the remaining arguments
//!
//! `client` is kept as another name for `codegen` (the generated client).

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn root() -> PathBuf {
    // xtask/ sits one level below the workspace root.
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn tasks() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root().join("scripts"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".sh").map(str::to_string))
        .collect();
    names.sort();
    names
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let task = match args.next().as_deref() {
        Some("client") => "codegen".to_string(),
        Some(t) if !t.starts_with('-') => t.to_string(),
        _ => {
            eprintln!("usage: cargo xtask <task> [args]   — runs scripts/<task>.sh\n\ntasks:");
            for t in tasks() {
                eprintln!("  {t}");
            }
            return ExitCode::from(2);
        }
    };
    let script = root().join("scripts").join(format!("{task}.sh"));
    if !script.is_file() {
        eprintln!("xtask: no task '{task}' (no scripts/{task}.sh); tasks: {}", tasks().join(", "));
        return ExitCode::from(2);
    }
    match Command::new("bash").arg(&script).args(args).current_dir(root()).status() {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        Ok(s) => ExitCode::from(s.code().unwrap_or(1).clamp(1, 255) as u8),
        Err(e) => {
            eprintln!("xtask: could not run {}: {e}", script.display());
            ExitCode::FAILURE
        }
    }
}
