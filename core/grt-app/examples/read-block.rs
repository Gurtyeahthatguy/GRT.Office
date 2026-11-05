//! Reads a package into a block file, for tests that read what LibreOffice wrote.

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let (Some(package), Some(target)) = (args.next(), args.next()) else {
        eprintln!("usage: read-block <package file> <block file>");
        std::process::exit(2);
    };
    let block = grt_app::package::read_block(std::path::Path::new(&package), None).map_err(std::io::Error::other)?;
    std::fs::write(target, block)
}
