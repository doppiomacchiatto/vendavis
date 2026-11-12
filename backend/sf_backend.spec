# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Vendavis backend.
#
#   npm run build:backend
#
# Produces a single-file executable at backend/dist/sf_backend (sf_backend.exe
# on Windows), which Tauri bundles as a resource (see src-tauri/tauri.conf.json
# and tauri.windows.conf.json) and spawns from src-tauri/src/main.rs.
#
# Single-file builds run a bootloader process plus the real Python process, so
# the Rust side must kill the whole process tree on exit (platform.rs).

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = [
    # uvicorn picks loops/protocols/lifespan implementations by string name at
    # runtime, which static analysis cannot see.
    *collect_submodules("uvicorn"),
    # imported lazily inside functions
    "lxml",
    "lxml.etree",
    "openpyxl",
    "sqlite3",
]

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=[],
    datas=[
        # Bundled Salesforce skill markdown files (forcedotcom/sf-skills)
        # Destination path must match SKILLS_DIR in sf_skills.py:
        #   Path(__file__).parent / "sf_skills"
        # PyInstaller unpacks datas relative to sys._MEIPASS, and __file__
        # in a frozen build points to sys._MEIPASS, so "sf_skills" is correct.
        ("sf_skills", "sf_skills"),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Legacy Anthropic client is kept in the repo but never imported.
    excludes=["anthropic", "tkinter", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="sf_backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    # Keep the console subsystem: uvicorn logs to stdout/stderr, which are None
    # in a windowed build. The Rust launcher hides the window on Windows.
    console=True,
)
