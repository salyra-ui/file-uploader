#!/usr/bin/env bash
set -euo pipefail
language="${1:?Choose a backend language}"
root="$(cd "$(dirname "$0")/.." && pwd)"
container="salyra-upload-contract-${language}-$$"
port="${SALYRA_NATIVE_PORT:-4445}"
case "$language" in
  go) image=golang:1.25-alpine; directory=go; command='go test ./... && exec go run ./cmd/example' ;;
  rust) image=rust:1.90-slim; directory=rust; command='cargo test --features http && exec cargo run --features http --bin example' ;;
  jvm) image=maven:3.9-eclipse-temurin-21; directory=jvm; command='mvn -q install && mvn -q -f integrations/kotlin/pom.xml package && mvn -q -f integrations/scala/pom.xml package && exec mvn -q exec:java -Dexec.mainClass=ui.salyra.upload.HttpAdapter' ;;
  python) image=python:3.12-slim; directory=python; command='python -m compileall -q salyra_upload && exec python example.py' ;;
  # php -S serves one request at a time unless it has workers, and it buffers a request body whole
  php) image=php:8.4-cli; directory=php; export SALYRA_BUFFERED_BODIES=1; command='find src -name "*.php" -exec php -l {} \; && exec env PHP_CLI_SERVER_WORKERS=8 php -S 0.0.0.0:4335 example.php' ;;
  ruby) image=ruby:3.4-slim; directory=ruby; command='gem install webrick --no-document && gem build salyra-upload-server.gemspec && exec ruby example.rb' ;;
  dotnet) image=mcr.microsoft.com/dotnet/sdk:9.0; directory=dotnet; command='dotnet build Salyra.Upload/Salyra.Upload.csproj && exec dotnet run --project Example' ;;
  elixir) image=elixir:1.18; directory=elixir; command='mix local.hex --force && mix local.rebar --force && mix deps.get && mix compile --warnings-as-errors && exec mix run --no-halt example.exs' ;;
  c) image=debian:bookworm-slim; directory=c; command='apt-get update -qq && apt-get install -y -qq cmake build-essential pkg-config libssl-dev libcjson-dev >/dev/null && cmake -S . -B build-ci -DCMAKE_C_FLAGS="-Werror -fsanitize=address,undefined" -DCMAKE_CXX_FLAGS="-Werror -fsanitize=address,undefined" && cmake --build build-ci -j2 && ctest --test-dir build-ci --output-on-failure && exec build-ci/salyra_upload_example' ;;
  *) echo "Unknown language: $language" >&2; exit 1 ;;
esac
data=$(mktemp -d)
cleanup() {
  # Remove root-owned container fixtures inside their private bind mount.
  docker exec "$container" sh -c 'find /upload-data -mindepth 1 -delete' >/dev/null 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$data"
}
trap cleanup EXIT
mkdir -p "$root/artifacts"
fixture="$root/artifacts/restart-$language.json"
docker run -d --name "$container" -p "127.0.0.1:$port:4335" -v "$data:/upload-data" -e UPLOAD_DIRECTORY=/upload-data -e HOST=0.0.0.0 -e PORT=4335 -e ASPNETCORE_URLS=http://0.0.0.0:4335 -v "$root/backend/$directory:/workspace" -w /workspace "$image" sh -c "$command" >/dev/null
ready() {
  for attempt in $(seq 1 240); do
    if curl --silent --max-time 1 "http://127.0.0.1:$port/uploads/missing" >/dev/null; then return; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then docker logs "$container"; return 1; fi
    sleep 1
  done
  docker logs "$container"; return 1
}
ready
node --import tsx "$root/scripts/compatibility.ts" "http://127.0.0.1:$port/uploads"
node --import tsx "$root/scripts/parallel.ts" "http://127.0.0.1:$port/uploads" "$container"
node --import tsx "$root/scripts/restart.ts" prepare "http://127.0.0.1:$port/uploads" "$fixture"
docker restart "$container" >/dev/null
ready
node --import tsx "$root/scripts/restart.ts" recover "http://127.0.0.1:$port/uploads" "$fixture"

node --import tsx "$root/scripts/restart.ts" expire "http://127.0.0.1:$port/uploads" "$fixture" "$data" "$container"
