# Application icons

The source artwork, one per module, at the size it was drawn.

Every icon a build needs is generated from these, sixteen variants per
module, including the `.ico` Windows wants and the `.icns` macOS wants:

    cd modules/grt-<name> && npx tauri icon ../../assets/icons/<name>.png

for each of `read`, `graphs`, `slides`, `paper`, `dates`, `notes`, `grid` and
`tables`. Regenerate after replacing any of these files: the module's own
`src-tauri/icons/` is what a build reads, and it does not update itself.

The generator also writes iOS assets. They are deleted and gitignored: §12 puts
iOS out of scope because Apple requires a verified real identity to sign, which
this project cannot supply. Android variants are kept, since §12 does plan for
it.

The corners outside the circle are transparent, which matters: a desktop that
does not mask icons itself would otherwise show a coloured square.
