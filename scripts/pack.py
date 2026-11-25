"""把扩展源码打包成符合 AMO 规范的 .xpi。

要点：
  1. zip 条目路径必须用正斜杠（/），否则 AMO 报
     "Invalid file name in archive: icons\\icon-128.png"
  2. manifest.json 必须在压缩包根目录
  3. 不打包开发用文件（README、本脚本等）

用法：
    python scripts/pack.py                    # 输出 dist/bookmark-<version>.xpi
    python scripts/pack.py --out custom.xpi   # 指定输出路径

注意：不要改用 PowerShell 的 Compress-Archive，它在 Windows 上会把
路径分隔符写成反斜杠，导致 AMO 校验失败。
"""

import argparse
import json
import os
import sys
import zipfile

# 仓库根目录（本脚本位于 scripts/ 下）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 这些不进包
EXCLUDE_FILES = {
    "README.md",
    "LICENSE",
    ".gitignore",
    "pack.py",
}
EXCLUDE_DIRS = {
    "scripts",
    "screenshots",
    ".git",
    "dist",
    "node_modules",
    ".vscode",
    ".idea",
}
# 以这些开头的也不进包
EXCLUDE_PREFIXES = (".",)


def collect(entries):
    for root, dirs, files in os.walk(ROOT):
        # 原地修改 dirs 以跳过排除目录
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        for name in sorted(files):
            if name in EXCLUDE_FILES:
                continue
            if name.lower().endswith((".xpi", ".zip")):
                continue
            if name.startswith(EXCLUDE_PREFIXES) and name not in (".gitignore",):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            entries.append((rel, full))


def main():
    parser = argparse.ArgumentParser(description="打包 Firefox 扩展为 xpi")
    parser.add_argument("--out", help="输出文件路径")
    args = parser.parse_args()

    manifest_path = os.path.join(ROOT, "manifest.json")
    if not os.path.exists(manifest_path):
        sys.exit(f"错误：找不到 {manifest_path}")

    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    version = manifest.get("version", "0.0.0")
    out = args.out or os.path.join(ROOT, "dist", f"bookmark-{version}.xpi")
    out = os.path.abspath(out)

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    if os.path.exists(out):
        os.remove(out)

    entries = []
    collect(entries)
    entries.sort(key=lambda x: x[0])

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel, full in entries:
            zf.write(full, arcname=rel)

    # 自检
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()

    problems = []
    if "manifest.json" not in names:
        problems.append("manifest.json 不在根目录")
    bad = [n for n in names if "\\" in n]
    if bad:
        problems.append(f"含反斜杠条目: {bad}")

    print(f"已生成: {out}")
    print(f"版本:   {version}")
    print(f"大小:   {os.path.getsize(out):,} 字节")
    print(f"条目:   {len(names)} 个")
    for n in names:
        print(f"  {n}")

    if problems:
        print("\n校验失败:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)

    print("\n校验通过：路径均为正斜杠，manifest.json 在根目录")


if __name__ == "__main__":
    main()
