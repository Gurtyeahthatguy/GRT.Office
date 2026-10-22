"""Writes the archives the reader is tested against, with Python's own zipfile."""

import io
import sys
import zipfile
from pathlib import Path

here = Path(__file__).parent
TEXT = b"The quick brown fox jumps over the lazy dog.\n" * 40


class Unseekable(io.RawIOBase):
    """A stream that cannot go back, so zipfile writes data descriptors."""

    def __init__(self):
        self.buffer = bytearray()

    def writable(self):
        return True

    def write(self, data):
        self.buffer += data
        return len(data)


def streamed():
    sink = Unseekable()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", b"application/vnd.oasis.opendocument.text", zipfile.ZIP_STORED)
        archive.writestr("content.xml", TEXT)
        archive.writestr("Pictures/empty.png", b"")
    return bytes(sink.buffer)


def zip64():
    """A small archive rewritten the way ZIP64 writes big ones."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("big.txt", TEXT)
        archive.writestr("small.txt", b"small\n")
    data = out.getvalue()

    end = data.rindex(b"PK\x05\x06")
    count = int.from_bytes(data[end + 10:end + 12], "little")
    offset = int.from_bytes(data[end + 16:end + 20], "little")
    body, at, central = data[:offset], offset, b""
    for _ in range(count):
        name_len, extra_len, comment_len = (int.from_bytes(data[at + i:at + i + 2], "little") for i in (28, 30, 32))
        packed, size, local = (int.from_bytes(data[at + i:at + i + 4], "little") for i in (20, 24, 42))
        extra = (1).to_bytes(2, "little") + (24).to_bytes(2, "little") + size.to_bytes(8, "little") \
            + packed.to_bytes(8, "little") + local.to_bytes(8, "little")
        record = bytearray(data[at:at + 46])
        record[20:24] = record[24:28] = record[42:46] = b"\xff\xff\xff\xff"
        record[30:32] = len(extra).to_bytes(2, "little")
        central += bytes(record) + data[at + 46:at + 46 + name_len] + extra
        at += 46 + name_len + extra_len + comment_len

    end64_at = len(body) + len(central)
    end64 = b"PK\x06\x06" + (44).to_bytes(8, "little") + (45).to_bytes(2, "little") * 2 + bytes(8) \
        + count.to_bytes(8, "little") * 2 + len(central).to_bytes(8, "little") + offset.to_bytes(8, "little")
    locator = b"PK\x06\x07" + bytes(4) + end64_at.to_bytes(8, "little") + (1).to_bytes(4, "little")
    end = b"PK\x05\x06" + bytes(4) + b"\xff\xff" * 2 + b"\xff\xff\xff\xff" * 2 + bytes(2)
    return body + central + end64 + locator + end


def accented():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("Città/perché.txt", "è così\n".encode())
    return out.getvalue()


def commented():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("a.txt", b"a\n")
        archive.comment = b"PK\x05\x06 a signature inside the comment"
    return out.getvalue()


for name, build in [("streamed", streamed), ("zip64", zip64), ("accented", accented), ("commented", commented)]:
    (here / f"{name}.zip").write_bytes(build())
print("written", file=sys.stderr)
