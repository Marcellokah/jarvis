#!/bin/zsh
# Reads an exported .shortcut file and prints the readable Shortcut.wflow path.
#
#   ./scripts/shortcut-unwrap.sh ~/Downloads/Jarvis.shortcut /tmp/out
#
# A .shortcut is an AEA1 archive on profile 0 (hkdf_sha256_hmac__none__ecdsa_p256):
# signed but NOT encrypted, so it opens with a key the file carries itself.
# See docs/ios-shortcut-format.md.
#
# The exported file contains JARVIS_TOKEN in plaintext — do not share it, and
# delete it when you are done.
set -e
SRC="${1:?használat: shortcut-unwrap.sh <fájl.shortcut> <célkönyvtár>}"
OUT="${2:?hiányzó célkönyvtár}"
mkdir -p "$OUT"

python3 - "$SRC" "$OUT/leaf.der" <<'PY'
import sys, struct, plistlib, pathlib
f = pathlib.Path(sys.argv[1]).read_bytes()
if f[:4] != b"AEA1":
    raise SystemExit("nem AEA1 fájl")
authlen, = struct.unpack_from("<I", f, 8)
chain = plistlib.loads(f[12:12+authlen])["SigningCertificateChain"]
pathlib.Path(sys.argv[2]).write_bytes(chain[0])
PY

openssl x509 -inform DER -in "$OUT/leaf.der" -pubkey -noout > "$OUT/sign.pem"
aea decrypt -i "$SRC" -o "$OUT/payload.aa" -sign-pub "$OUT/sign.pem"
aa extract -i "$OUT/payload.aa" -d "$OUT" >/dev/null
find "$OUT" -name "*.wflow" | head -1
