# Test corpus

Real PDFs that once broke something. Every bug found in the wild should end up
here as a permanent regression case.

Worth collecting: malformed files, encrypted ones, very large ones, unusual or
missing fonts, crooked scans, files produced by Word, by LaTeX, by phone
scanner apps.

**Nothing in this directory is versioned.** `.gitignore` excludes the whole
folder except this file, so a document dropped here to reproduce a fault stays
on the machine it was dropped on. Adding one to the repository takes a
deliberate `git add -f`, and is rarely the right thing to do.
