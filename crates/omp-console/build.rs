//! `rust-embed` needs `web/dist` to exist when this crate compiles. A clean
//! checkout has no bundle yet, so debug/test builds get a clearly-labelled
//! placeholder; a release build refuses to embed it.

use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=../../web/dist");
    println!("cargo:rerun-if-changed=../../web/dist/index.html");
    println!("cargo:rerun-if-env-changed=PROFILE");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    let index = root.join("index.html");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    if index.is_file() {
        if release
            && fs::read_to_string(&index).is_ok_and(|text| text.contains("OMP_CONSOLE_NO_BUNDLE"))
        {
            panic!(
                "web/dist contains the build placeholder; run `make web-build` before a release build"
            );
        }
        return;
    }
    if release {
        panic!("web/dist is missing; run `make web-build` before `cargo build --release`");
    }
    fs::create_dir_all(&root).expect("create web/dist");
    fs::write(
        &index,
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>omp-console — no web bundle</title></head>\
         <body style=\"font-family:system-ui;padding:2rem\"><h1>OMP_CONSOLE_NO_BUNDLE</h1>\
         <p>The web bundle was not built. Run <code>make web-build</code>; this placeholder is never embedded in a release build.</p></body></html>\n",
    )
    .expect("write placeholder");
}
