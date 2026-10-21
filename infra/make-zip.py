"""Zip a staging folder with forward-slash paths (PowerShell's Compress-Archive writes backslashes that break on Linux).
Usage: python infra/make-zip.py <stage-dir> <out.zip>"""
import os
import sys
import zipfile

stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(stage):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, stage).replace(os.sep, '/'))
print(os.path.getsize(out) // 1024 // 1024, 'MB')
