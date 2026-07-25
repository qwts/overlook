#!/usr/bin/env bash

set -Eeuo pipefail

echo "==> Codex setup starting"

# Codex should already run from the checked-out repo, but this keeps it safe.
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  cd "$(git rev-parse --show-toplevel)"
fi

echo "==> Working directory: $(pwd)"

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required but was not found on PATH"
  exit 1
fi

echo "==> Git: $(git --version)"

# Load nvm explicitly because setup scripts are non-interactive shells.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
else
  echo "ERROR: nvm not found at $NVM_DIR/nvm.sh"
  exit 1
fi

if [ ! -f ".nvmrc" ]; then
  echo "ERROR: .nvmrc not found in repo root."
  exit 1
fi

echo "==> Installing/using Node from .nvmrc: $(cat .nvmrc)"
nvm install
nvm use

# Later agent commands run in fresh shells; without a default alias they would fall back to the
# image's stock Node instead of .nvmrc's (misleading lint/knip failures follow).
nvm alias default "$(nvm current)"

# Fresh agent commands run in new shells. Install one idempotent initialization
# file and source it from the common shell profiles so nvm, node, npm, and npx
# stay available after setup completes.
CODEX_DEV_INIT="$HOME/.codex-photos-dev.sh"
cat > "$CODEX_DEV_INIT" <<'EOF'
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use default --silent >/dev/null 2>&1 || true
fi
if [ -d "/opt/homebrew/bin" ]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi
EOF

for shell_profile in \
  "$HOME/.profile" \
  "$HOME/.bash_profile" \
  "$HOME/.bashrc" \
  "$HOME/.zprofile" \
  "$HOME/.zshrc"; do
  touch "$shell_profile"
  if ! grep -Fqx '. "$HOME/.codex-photos-dev.sh"' "$shell_profile"; then
    printf '\n%s\n' '. "$HOME/.codex-photos-dev.sh"' >> "$shell_profile"
  fi
done

. "$CODEX_DEV_INIT"

echo "==> Node: $(node --version)"
echo "==> npm:  $(npm --version)"

install_dev_package() {
  local label="$1"
  local brew_package="$2"
  local apt_package="$3"
  local dnf_package="$4"
  local apk_package="$5"
  local windows_install_command="${6:-}"

  echo "==> $label not found; installing"
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      echo "ERROR: $label is a prerequisite on native Windows."
      if [ -n "$windows_install_command" ]; then
        echo "Install it first: $windows_install_command"
      fi
      exit 1
      ;;
  esac

  if command -v brew >/dev/null 2>&1; then
    brew install "$brew_package"
  elif command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      apt-get update
      apt-get install -y "$apt_package"
    elif command -v sudo >/dev/null 2>&1; then
      sudo apt-get update
      sudo apt-get install -y "$apt_package"
    else
      echo "ERROR: installing $label with apt-get requires root or sudo"
      exit 1
    fi
  elif command -v dnf >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      dnf install -y "$dnf_package"
    elif command -v sudo >/dev/null 2>&1; then
      sudo dnf install -y "$dnf_package"
    else
      echo "ERROR: installing $label with dnf requires root or sudo"
      exit 1
    fi
  elif command -v apk >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      apk add "$apk_package"
    elif command -v sudo >/dev/null 2>&1; then
      sudo apk add "$apk_package"
    else
      echo "ERROR: installing $label with apk requires root or sudo"
      exit 1
    fi
  else
    echo "ERROR: $label is required and no supported package manager was found"
    exit 1
  fi
}

# The protected command rules use /bin/zsh explicitly on Unix hosts.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    echo "==> zsh: not required for native Windows"
    ;;
  *)
    if [ ! -x "/bin/zsh" ]; then
      install_dev_package "zsh" "zsh" "zsh" "zsh" "zsh"
    fi

    if [ ! -x "/bin/zsh" ]; then
      echo "ERROR: zsh was installed but /bin/zsh is still unavailable"
      exit 1
    fi

    echo "==> zsh: $(/bin/zsh --version)"
    ;;
esac

# GitHub CLI is part of the expected development environment.
if ! command -v gh >/dev/null 2>&1; then
  install_dev_package \
    "GitHub CLI" \
    "gh" \
    "gh" \
    "gh" \
    "github-cli" \
    "winget install --id GitHub.cli --exact --source winget"
fi

echo "==> GitHub CLI: $(gh --version | head -n 1)"

# Deterministic package install based on lockfile.
if [ -f "package-lock.json" ]; then
  echo "==> Installing dependencies with npm ci"
  npm ci --no-audit --no-fund
elif [ -f "package.json" ]; then
  echo "==> Installing dependencies with npm install"
  npm install
else
  echo "==> No package.json found; skipping dependency install"
fi

# Browser automation support, only when Playwright is present.
if [ -f "package.json" ] && grep -qiE '"@playwright/test"|"playwright"' package.json; then
  echo "==> Playwright detected; installing Chromium (with system deps for fresh containers)"
  npx playwright install --with-deps chromium || npx playwright install chromium || true
fi

# Initial build is deliberately FATAL: a broken build should fail setup loudly instead of
# wasting the session.
if [ -f "package.json" ] && npm run | grep -qE '^[[:space:]]+build$'; then
  echo "==> build script detected; running initial build"
  npm run build
fi

echo "==> Codex setup complete"
