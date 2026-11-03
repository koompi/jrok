//! `jrok-connector --version` is how install.sh and the deploy worker see that
//! the binary runs on a machine: it answers first and alone, even where the
//! open-file limit is low (which the connector otherwise warns about).

use std::os::unix::process::CommandExt;
use std::process::Command;

#[test]
fn version_is_answered_first_and_alone() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_jrok-connector"));
    command.arg("--version");
    // SAFETY: setrlimit is async-signal-safe; it only touches the child.
    unsafe {
        command.pre_exec(|| {
            let low = libc::rlimit { rlim_cur: 1024, rlim_max: 4096 };
            libc::setrlimit(libc::RLIMIT_NOFILE, &low);
            Ok(())
        });
    }
    let out = command.output().unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("jrok-connector {}\n", env!("CARGO_PKG_VERSION")));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
}
