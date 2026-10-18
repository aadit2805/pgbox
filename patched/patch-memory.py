import sys

WASM_HEADER_BYTES = 8
IMPORT_SECTION = 2
IMPORT_KIND_FUNCTION = 0
IMPORT_KIND_TABLE = 1
IMPORT_KIND_MEMORY = 2
IMPORT_KIND_GLOBAL = 3
IMPORT_KIND_TAG = 4
LIMITS_HAS_MAX = 0x01
PAGE_KIB = 64


def read_uleb(buf, i):
    result = shift = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def encode_uleb(n):
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def skip_name(buf, i):
    length, i = read_uleb(buf, i)
    return i + length


def skip_limits(buf, i):
    flags = buf[i]
    _, i = read_uleb(buf, i + 1)
    return read_uleb(buf, i)[1] if flags & LIMITS_HAS_MAX else i


def skip_import(buf, kind, i):
    if kind == IMPORT_KIND_FUNCTION:
        return read_uleb(buf, i)[1]
    if kind == IMPORT_KIND_TABLE:
        return skip_limits(buf, i + 1)
    if kind == IMPORT_KIND_GLOBAL:
        return i + 2
    if kind == IMPORT_KIND_TAG:
        return read_uleb(buf, i + 1)[1]
    raise ValueError(f"unknown import kind {kind}")


def find_memory_minimum(buf):
    i = WASM_HEADER_BYTES
    while i < len(buf):
        section = buf[i]
        size, body = read_uleb(buf, i + 1)
        if section == IMPORT_SECTION:
            count, j = read_uleb(buf, body)
            for _ in range(count):
                j = skip_name(buf, skip_name(buf, j))
                kind = buf[j]
                j += 1
                if kind == IMPORT_KIND_MEMORY:
                    start = j + 1
                    old, end = read_uleb(buf, start)
                    return start, end, old
                j = skip_import(buf, kind, j)
        i = body + size
    raise ValueError("no imported memory")


def main(src, dst, pages):
    buf = bytearray(open(src, "rb").read())
    start, end, old = find_memory_minimum(buf)
    new = encode_uleb(pages)
    if len(new) != end - start:
        raise ValueError(f"{pages} pages encodes to {len(new)} bytes, the binary has room for {end - start}")
    buf[start:end] = new
    open(dst, "wb").write(buf)
    print(f"memory minimum {old} -> {pages} pages ({pages * PAGE_KIB // 1024} MB)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]))
