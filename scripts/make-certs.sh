#!/usr/bin/env bash
# Local CA + server certificate for the fake Compta API (https://localhost / https://127.0.0.1).
# Writes .certs/{ca.pem,ca-key.pem,server.pem,server-key.pem} at the repo root. Idempotent:
# does nothing if they exist, unless --force. The CA is trusted only by the processes we start
# (NODE_EXTRA_CA_CERTS); nothing is added to the system trust store.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/.certs"
force=0
[[ "${1:-}" == "--force" ]] && force=1

if [[ $force -eq 0 && -s "$dir/ca.pem" && -s "$dir/server.pem" && -s "$dir/server-key.pem" ]]; then
  echo "certs present in $dir (use --force to regenerate)"
  exit 0
fi

mkdir -p "$dir"
chmod 700 "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = french-cfo-bench local CA (synthetic, do not trust globally)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF

cat >"$tmp/server.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[v3_server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF

openssl ecparam -name prime256v1 -genkey -noout -out "$dir/ca-key.pem"
openssl req -new -x509 -sha256 -days 825 -key "$dir/ca-key.pem" -config "$tmp/ca.cnf" \
  -out "$dir/ca.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$dir/server-key.pem"
openssl req -new -sha256 -key "$dir/server-key.pem" -config "$tmp/server.cnf" -out "$tmp/server.csr"
openssl x509 -req -sha256 -days 825 -in "$tmp/server.csr" \
  -CA "$dir/ca.pem" -CAkey "$dir/ca-key.pem" -CAcreateserial -CAserial "$tmp/ca.srl" \
  -extfile "$tmp/server.cnf" -extensions v3_server -out "$dir/server.pem"

chmod 600 "$dir"/*-key.pem
echo "wrote $dir/{ca.pem,ca-key.pem,server.pem,server-key.pem}"
