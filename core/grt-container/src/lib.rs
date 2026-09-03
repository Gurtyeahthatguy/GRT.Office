//! The `.grt` container.

pub mod manifest;
pub mod zip;

pub use manifest::{Link, Manifest, Part};
pub use zip::{read_archive, write_archive, Entry};

/// Text placed first in every archive, in the clear.
pub const README_NAME: &str = "README.txt";

pub const README_TEXT: &str = "\
This file is a GRT document.

It is an ordinary ZIP archive. Rename it to .zip and any archiving tool will
open it. Inside:

  manifest.json   what kind of document this is, and what the parts are
  content/        the document itself, as indented JSON
  resources/      images and fonts, as ordinary files
  embedded/       parts belonging to other GRT programs, same structure

The JSON is meant to be read by a person. Nothing here is encrypted or
obfuscated, and no part of this file records who made it or when.

GRT is free software, licensed under the MIT licence.
";
