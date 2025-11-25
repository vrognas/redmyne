#!/bin/bash

# Only run in remote Claude Code environments
if [ -z "$CLAUDE_CODE_REMOTE" ]; then
  echo "Local environment detected. Skipping package installation."
  exit 0
fi

echo "Remote environment detected. Installing packages..."

# Install GitHub CLI
if ! command -v gh &> /dev/null; then
  echo "Installing GitHub CLI..."

  # Create local bin directory
  mkdir -p ~/.local/bin

  # Detect architecture
  ARCH=$(uname -m)
  case $ARCH in
    x86_64)
      GH_ARCH="linux_amd64"
      ;;
    aarch64)
      GH_ARCH="linux_arm64"
      ;;
    *)
      echo "Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac

  # Use stable fallback version (skip unreliable API)
  GH_VERSION="2.62.0"
  echo "Downloading gh v${GH_VERSION} for ${GH_ARCH}..."

  DOWNLOAD_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${GH_ARCH}.tar.gz"
  if ! curl -sfL "$DOWNLOAD_URL" -o /tmp/gh.tar.gz; then
    echo "Warning: Failed to download gh CLI (network restricted?)"
    echo "gh commands will not be available this session."
    exit 0  # Non-fatal - don't block startup
  fi

  if ! tar -xzf /tmp/gh.tar.gz -C /tmp; then
    echo "Failed to extract gh CLI (invalid archive)"
    rm -f /tmp/gh.tar.gz
    exit 1
  fi

  mv "/tmp/gh_${GH_VERSION}_${GH_ARCH}/bin/gh" ~/.local/bin/gh
  chmod +x ~/.local/bin/gh
  rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_${GH_ARCH}"

  # Add to PATH if not already there
  if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi

  echo "GitHub CLI installed successfully at ~/.local/bin/gh"
else
  echo "GitHub CLI already installed."
fi

echo "Package installation complete."
