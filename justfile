# Development and release tasks for attricat-extension-cutting-planner.
#
# Attricat installs a zstd-compressed tar archive whose root holds the
# manifest and every artifact path the manifest declares.

extension_id := "attricat-extension-cutting-planner"
version := `node -p "require('./manifest.json').version"`
dist_dir := "dist"
stage_dir := "dist/package"
archive := dist_dir / extension_id + "-" + version + ".tar.zst"

default: check

# Solver and client: typecheck and tests. Server: fmt and unit tests.
check:
  pnpm run check
  cargo fmt --check
  cargo test --workspace

manifest:
  node scripts/manifest.src.mjs

build-client:
  pnpm run build

# A component that imports only attricat:host@1.2.0. wasm32-wasip2 would
# import ambient WASI interfaces, which Attricat never links.
build-server:
  #!/usr/bin/env bash
  set -euo pipefail
  command -v wasm-tools >/dev/null || { echo "Install wasm-tools: cargo install wasm-tools --locked" >&2; exit 1; }
  rustup target add wasm32-unknown-unknown
  cargo build --release --target wasm32-unknown-unknown -p attricat-extension-cutting-planner-server
  mkdir -p {{dist_dir}}
  wasm-tools component new target/wasm32-unknown-unknown/release/attricat_extension_cutting_planner_server.wasm -o {{dist_dir}}/server.wasm
  if wasm-tools component wit {{dist_dir}}/server.wasm | grep -E '^\s*import ' | grep -v 'attricat:host/.*@1\.2\.0'; then
    echo "server.wasm imports something other than attricat:host@1.2.0" >&2; exit 1
  fi

verify-artifacts:
  node -e "const m=require('./manifest.json'),fs=require('fs');for(const a of m.artifacts){if(!fs.existsSync(a.path)||!fs.statSync(a.path).size){console.error('Missing '+a.path);process.exit(1)}}"

build: check manifest build-client build-server verify-artifacts

pack: build
  #!/usr/bin/env bash
  set -euo pipefail
  rm -rf {{stage_dir}}
  mkdir -p {{stage_dir}}
  cp manifest.json README.md {{stage_dir}}/
  cp -R assets {{stage_dir}}/
  files=$(node -p "require('./manifest.json').artifacts.map(a => a.path).join(' ')")
  for file in $files; do mkdir -p "{{stage_dir}}/$(dirname "$file")"; cp "$file" "{{stage_dir}}/$file"; done
  rm -f {{archive}}
  (cd {{stage_dir}} && tar -cf - manifest.json README.md assets $files) | zstd -q -o {{archive}}
  echo "Created {{archive}}"

clean:
  rm -rf {{dist_dir}} target

# Browser + API verification against a running dev server (see e2e/verify.mjs).
e2e:
  node e2e/verify.mjs
