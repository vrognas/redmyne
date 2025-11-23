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

  # Download and install latest gh CLI
  GH_VERSION=$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')
  echo "Downloading gh v${GH_VERSION} for ${GH_ARCH}..."

  curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${GH_ARCH}.tar.gz" -o /tmp/gh.tar.gz
  tar -xzf /tmp/gh.tar.gz -C /tmp
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
