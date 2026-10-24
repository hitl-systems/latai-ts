#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0 OR MIT
"""Build the npm packages of the TypeScript SDK with the latai core (task 16.5.2).

    python3 sdk/tools/build_npm.py --core dist/core/latai-core-<v>-<target>.tar.gz [--core ...] --out dist/npm

For each core archive: `@latai/core-<platform>-<arch>`, whose `core/` folder holds the archive's
files (checked against its core.json) and whose `os`, `cpu` and `libc` fields let npm install it
only where it runs. Then `latai` itself (sdk/node as published) with every core package of
`TARGETS` as an optional dependency of the same version: npm installs the one that matches the
machine, and the loader finds it with `require.resolve` (`corePackageDir()`). Each package is
packed with `npm pack` into `<out>/`.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_wheel import read_core  # noqa: E402  (the same archive checks)

# In latai the SDK is sdk/node and this script sdk/tools; in the SDK's own public repository the
# SDK is the repository and this script tools/.
_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parents[1] if (_HERE.parents[1] / "sdk" / "node").is_dir() else _HERE.parent
NODE = ROOT / "sdk" / "node" if (ROOT / "sdk" / "node").is_dir() else ROOT
LICENSE_BINARY = ROOT / "sdk" / "LICENSE-BINARY" if (ROOT / "sdk").is_dir() else ROOT / "LICENSE-BINARY"
# Core target -> (process.platform, process.arch, libc or None): the platforms the published
# `latai` lists as optional dependencies.
TARGETS = {
    "x86_64-unknown-linux-gnu": ("linux", "x64", "glibc"),
    "aarch64-unknown-linux-gnu": ("linux", "arm64", "glibc"),
    "x86_64-apple-darwin": ("darwin", "x64", None),
    "aarch64-apple-darwin": ("darwin", "arm64", None),
    "x86_64-pc-windows-msvc": ("win32", "x64", None),
    "aarch64-pc-windows-msvc": ("win32", "arm64", None),
}


def core_package_name(platform: str, arch: str) -> str:
    return f"@latai/core-{platform}-{arch}"


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def npm_pack(folder: Path, out: Path) -> Path:
    res = subprocess.run(["npm", "pack", "--json", "--pack-destination", str(out.resolve())], cwd=folder,
                         capture_output=True, text=True, check=True)
    return out / json.loads(res.stdout)[0]["filename"]


def core_package(archive: Path, work: Path, out: Path) -> tuple[str, str, Path]:
    manifest, files = read_core(archive)
    target = manifest["target"]
    if target not in TARGETS:
        raise SystemExit(f"{archive}: no npm platform for {target}")
    platform, arch, libc = TARGETS[target]
    name = core_package_name(platform, arch)
    folder = work / name.replace("/", "__")
    shutil.rmtree(folder, ignore_errors=True)
    for rel, (data, exe) in files.items():
        if rel.startswith("include/"):
            continue
        dst = folder / "core" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        dst.chmod(0o755 if exe else 0o644)
    shutil.copy(LICENSE_BINARY, folder / "LICENSE-BINARY")
    pkg = {
        "name": name,
        "version": manifest["version"],
        "description": f"The prebuilt latai core for {platform} {arch}, used by the `latai` package.",
        "license": "SEE LICENSE IN LICENSE-BINARY",
        "os": [platform],
        "cpu": [arch],
        "files": ["core", "LICENSE-BINARY", "README.md"],
        "preferUnplugged": True,
    }
    if libc:
        pkg["libc"] = [libc]
    write_json(folder / "package.json", pkg)
    (folder / "README.md").write_text(
        f"# {name}\n\nThe prebuilt latai core ({target}) that the `latai` npm package loads on this "
        "platform. Install `latai`, not this package: npm picks the core of your machine.\n\n"
        "Licensed under `LICENSE-BINARY` (free to use and redistribute inside your software); the "
        "third-party notices are in `core/THIRD_PARTY_LICENSES` and `core/NOTICE`.\n",
        encoding="utf-8",
    )
    return name, manifest["version"], npm_pack(folder, out)


def main_package(version: str, work: Path, out: Path) -> Path:
    src = json.loads((NODE / "package.json").read_text())
    folder = work / "latai"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    for pattern in src["files"]:
        for p in NODE.glob(pattern):
            dst = folder / p.relative_to(NODE)
            if p.is_dir():
                shutil.copytree(p, dst, ignore=shutil.ignore_patterns("node_modules"))
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(p, dst)
    for lic in ("LICENSE-APACHE", "LICENSE-MIT"):
        shutil.copy(ROOT / lic, folder / lic)
    pkg = dict(src)
    pkg["version"] = version
    pkg["files"] = list(src["files"]) + ["LICENSE-APACHE", "LICENSE-MIT"]
    pkg["optionalDependencies"] = {core_package_name(p, a): version for (p, a, _) in TARGETS.values()}
    pkg.pop("scripts", None)
    write_json(folder / "package.json", pkg)
    return npm_pack(folder, out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--core", type=Path, action="append", required=True, help="a core archive (repeat)")
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "npm")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    work = args.out / "work"
    versions = set()
    for archive in args.core:
        name, version, tgz = core_package(archive, work, args.out)
        versions.add(version)
        print(f"wrote {tgz} ({name})")
    sdk_version = json.loads((NODE / "package.json").read_text())["version"]
    if versions != {sdk_version}:
        raise SystemExit(f"the cores are {sorted(versions)}, the SDK is {sdk_version}: one version for all")
    print(f"wrote {main_package(sdk_version, work, args.out)} (latai)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
