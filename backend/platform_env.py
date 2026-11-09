"""
platform_env.py — OS-specific environment helpers for Vendavis.

When Vendavis runs as a packaged .app / .exe / AppImage, the process
inherits a minimal PATH from the OS launcher rather than the shell the
developer normally works in.  This module provides an abstract interface
so each platform can supply:

  • augmented_path()  — a PATH string that includes all common tool dirs
  • sf_cli_candidates() — ordered list of absolute paths to check for sf/sfdx
  • node_candidates()   — ordered list of absolute paths to check for node

Usage:
    from platform_env import get_platform
    plat = get_platform()
    augmented = plat.augmented_path()
    sf_bin    = plat.find_tool("sf", "sfdx")
"""

from __future__ import annotations

import abc
import os
import shutil
import sys
from pathlib import Path
from typing import List, Optional


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class PlatformProvider(abc.ABC):
    """Abstract interface every OS-specific provider must implement."""

    @abc.abstractmethod
    def extra_paths(self) -> List[str]:
        """
        Return an ordered list of directory paths to prepend to PATH.
        Should cover all common locations for Node, npm-global, and CLI
        tools that the OS launcher might omit.
        """

    def augmented_path(self) -> str:
        """
        Return a PATH string combining extra_paths() with the current
        process PATH, deduplicating existing entries.
        """
        current = os.environ.get("PATH", "")
        current_parts = current.split(os.pathsep) if current else []
        current_set = set(current_parts)
        prepend = [p for p in self.extra_paths() if p not in current_set]
        parts = prepend + current_parts
        return os.pathsep.join(parts)

    def find_tool(self, *names: str) -> Optional[str]:
        """
        Locate the first binary found among *names using augmented_path().
        Falls back to checking absolute candidate paths from sf_cli_candidates().
        Returns the resolved path string, or None if not found.
        """
        augmented = self.augmented_path()
        for name in names:
            found = shutil.which(name, path=augmented)
            if found:
                return found
        # Hard-coded candidate list as last resort
        for p in self.sf_cli_candidates():
            path = Path(p)
            if path.exists() and path.is_file():
                return str(path)
        return None

    def sf_cli_candidates(self) -> List[str]:
        """
        Ordered list of absolute paths where sf/sfdx might live.
        Subclasses should override to add platform-specific locations.
        """
        return []


# ---------------------------------------------------------------------------
# macOS
# ---------------------------------------------------------------------------

class MacOSProvider(PlatformProvider):
    """
    macOS-specific environment provider.

    macOS .app bundles launch with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
    This provider prepends every common location that Homebrew, nvm, Volta, n,
    and npm-global use so that both sf and the node runtime it depends on are
    reachable.
    """

    def extra_paths(self) -> List[str]:
        home = Path.home()
        # Probe once — both calls share the same npm lookup
        node_dir    = self._node_bin_dir()   # dir containing `node` binary
        npm_bin_dir = self._npm_global_bin() # dir containing npm-installed globals (sf)
        paths = [
            # node runtime first — sf is a Node.js script; if node isn't on PATH
            # the shebang (#!/usr/bin/env node) fails immediately with rc=127
            *(p for p in [node_dir] if p),
            # Standard Unix locations
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            # Salesforce CLI official .pkg installer (developer.salesforce.com)
            "/usr/local/sf/bin",
            # Homebrew (Apple Silicon default, then Intel)
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/opt/node/bin",          # brew-installed node
            # npm global bin (queried from npm itself — covers any node version manager)
            *(p for p in [npm_bin_dir] if p),
            # npm global fallback well-known paths
            str(home / ".npm-global" / "bin"),
            str(home / "node_modules" / ".bin"),
            # nvm — enumerate currently installed versions so shutil.which can find node
            *self._nvm_node_bins(home),
            # Volta
            str(home / ".volta" / "bin"),
            # n (node version manager)
            "/usr/local/n/bin",
            # Yarn global
            str(home / ".yarn" / "bin"),
        ]
        return paths

    @staticmethod
    def _nvm_node_bins(home: Path) -> List[str]:
        """Return bin/ dirs for all nvm-managed node versions found on disk."""
        nvm_versions = home / ".nvm" / "versions" / "node"
        if not nvm_versions.is_dir():
            return []
        bins = []
        try:
            for version_dir in sorted(nvm_versions.iterdir(), reverse=True):
                bin_dir = version_dir / "bin"
                if bin_dir.is_dir():
                    bins.append(str(bin_dir))
        except OSError:
            pass
        return bins

    @staticmethod
    def _find_npm() -> Optional[str]:
        """Locate npm itself using a minimal bootstrap PATH."""
        home = Path.home()
        bootstrap = os.pathsep.join([
            "/usr/local/bin", "/usr/bin", "/bin",
            "/opt/homebrew/bin",
            str(home / ".volta" / "bin"),
            str(home / ".npm-global" / "bin"),
            "/usr/local/sf/bin",
        ])
        return shutil.which("npm", path=bootstrap)

    @staticmethod
    def _npm_global_bin() -> Optional[str]:
        """
        Ask npm where it installs global binaries for the active node version.
        Returns the bin directory string, or None if npm is not found.
        """
        import subprocess as _sp
        npm = MacOSProvider._find_npm()
        if not npm:
            return None
        try:
            result = _sp.run(
                [npm, "root", "-g"],
                capture_output=True, text=True, timeout=5,
            )
            root = result.stdout.strip()
            if root:
                # npm root -g gives e.g. /usr/local/lib/node_modules
                # the global bin dir is one level up: /usr/local/bin
                bin_dir = str(Path(root).parent / "bin")
                if Path(bin_dir).is_dir():
                    return bin_dir
        except Exception:
            pass
        return None

    @staticmethod
    def _node_bin_dir() -> Optional[str]:
        """
        Find the directory containing the `node` binary that npm is using.
        sf is a Node.js script — when the bundled app runs it, node must be
        on PATH or the shebang line (#!/usr/bin/env node) will fail with rc=127.

        Strategy: resolve the npm binary itself, then look for `node` in the
        same directory (nvm, Volta, and most node installers put npm and node
        side-by-side).
        """
        npm = MacOSProvider._find_npm()
        if not npm:
            return None
        npm_dir = str(Path(npm).parent)
        # node should be right next to npm
        node_candidate = Path(npm_dir) / "node"
        if node_candidate.exists():
            return npm_dir
        # Resolve symlinks — npm might be a symlink into a version-managed dir
        try:
            real_npm = Path(npm).resolve()
            real_dir = str(real_npm.parent)
            if (Path(real_dir) / "node").exists():
                return real_dir
        except Exception:
            pass
        return None

    def sf_cli_candidates(self) -> List[str]:
        home = Path.home()
        candidates = [
            # Salesforce CLI official pkg installer (most common on Mac)
            "/usr/local/sf/bin/sf",
            "/usr/local/bin/sf",
            "/usr/local/bin/sfdx",
            # Homebrew
            "/opt/homebrew/bin/sf",
            "/opt/homebrew/bin/sfdx",
            # npm global (queried dynamically)
        ]
        # Ask npm where it puts global packages — covers any active node version
        npm_bin_dir = self._npm_global_bin()
        if npm_bin_dir:
            candidates += [
                str(Path(npm_bin_dir) / "sf"),
                str(Path(npm_bin_dir) / "sfdx"),
            ]
        candidates += [
            # npm global well-known fallback
            str(home / ".npm-global" / "bin" / "sf"),
            str(home / ".npm-global" / "bin" / "sfdx"),
            # Volta
            str(home / ".volta" / "bin" / "sf"),
            str(home / ".volta" / "bin" / "sfdx"),
            # Home-based sf pkg installer (user-level install)
            str(home / "Library" / "sf" / "bin" / "sf"),
        ]
        return candidates


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------

class WindowsProvider(PlatformProvider):
    """
    Windows-specific environment provider.

    Windows packaged apps (.exe / .msi produced by Tauri) run with the
    system PATH, which may omit user-level npm-global, nvm-windows, and
    Volta locations.
    """

    def extra_paths(self) -> List[str]:
        home = Path.home()
        appdata  = Path(os.environ.get("APPDATA",  str(home / "AppData" / "Roaming")))
        localapp = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        paths = [
            # Node.js installer default
            r"C:\Program Files\nodejs",
            r"C:\Program Files (x86)\nodejs",
            # npm global on Windows
            str(appdata / "npm"),
            # nvm-windows
            str(localapp / "nvm"),
            # Volta
            str(localapp / "Volta" / "bin"),
            # Chocolatey
            r"C:\ProgramData\chocolatey\bin",
            # Scoop
            str(home / "scoop" / "shims"),
        ]
        return paths

    def sf_cli_candidates(self) -> List[str]:
        home = Path.home()
        appdata  = Path(os.environ.get("APPDATA",  str(home / "AppData" / "Roaming")))
        localapp = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        return [
            str(appdata / "npm" / "sf.cmd"),
            str(appdata / "npm" / "sf"),
            str(appdata / "npm" / "sfdx.cmd"),
            str(appdata / "npm" / "sfdx"),
            str(localapp / "Volta" / "bin" / "sf.exe"),
            str(localapp / "Volta" / "bin" / "sfdx.exe"),
            r"C:\Program Files\Salesforce CLI\bin\sf.exe",
            r"C:\Program Files (x86)\Salesforce CLI\bin\sf.exe",
        ]


# ---------------------------------------------------------------------------
# Linux
# ---------------------------------------------------------------------------

class LinuxProvider(PlatformProvider):
    """
    Linux-specific environment provider.

    Linux AppImage / deb packages may strip the user's shell PATH.
    This provider covers the most common Node / npm install locations.
    """

    def extra_paths(self) -> List[str]:
        home = Path.home()
        paths = [
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            # npm global
            str(home / ".npm-global" / "bin"),
            str(home / "node_modules" / ".bin"),
            # nvm
            str(home / ".nvm" / "versions" / "node"),
            # Volta
            str(home / ".volta" / "bin"),
            # n
            "/usr/local/n/bin",
            # Snap
            "/snap/bin",
        ]
        return paths

    def sf_cli_candidates(self) -> List[str]:
        home = Path.home()
        return [
            str(home / ".npm-global" / "bin" / "sf"),
            str(home / ".npm-global" / "bin" / "sfdx"),
            "/usr/local/bin/sf",
            "/usr/local/bin/sfdx",
            str(home / ".volta" / "bin" / "sf"),
            str(home / ".volta" / "bin" / "sfdx"),
            "/snap/bin/sf",
        ]


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

_PROVIDER: Optional[PlatformProvider] = None


def get_platform() -> PlatformProvider:
    """
    Return the singleton PlatformProvider for the current OS.
    Call this instead of instantiating providers directly.
    """
    global _PROVIDER
    if _PROVIDER is None:
        if sys.platform == "darwin":
            _PROVIDER = MacOSProvider()
        elif sys.platform == "win32":
            _PROVIDER = WindowsProvider()
        else:
            _PROVIDER = LinuxProvider()
    return _PROVIDER
