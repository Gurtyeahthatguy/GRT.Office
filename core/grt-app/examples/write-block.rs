//! Writes a package from a block saved to a file, for tests that hand the result to LibreOffice.

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let (Some(block), Some(target)) = (args.next(), args.next()) else {
        eprintln!("usage: write-block <block file> <package file>");
        std::process::exit(2);
    };
    grt_app::package::write_block(std::path::Path::new(&target), &std::fs::read(block)?)
}
