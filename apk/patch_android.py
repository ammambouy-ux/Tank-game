#!/usr/bin/env python3
from pathlib import Path
import re

APK = Path(__file__).resolve().parent
ANDROID = APK / "android"

html = (APK / "www" / "index.html").read_text(encoding="utf-8")
m = re.search(r"const GAME_VERSION='([^']+)'", html)
if not m:
    raise SystemExit("GAME_VERSION missing")
version = m.group(1)
a,b,c = [int(x) for x in version.split(".")]
version_code = a*1000000 + b*1000 + c

gradle = ANDROID / "app" / "build.gradle"
s = gradle.read_text(encoding="utf-8")
s = re.sub(r"versionCode\s+\d+", f"versionCode {version_code}", s, count=1)
s = re.sub(r'versionName\s+"[^"]+"', f'versionName "{version}"', s, count=1)
gradle.write_text(s, encoding="utf-8")

manifest = ANDROID / "app" / "src" / "main" / "AndroidManifest.xml"
s = manifest.read_text(encoding="utf-8")
if "android.permission.INTERNET" not in s:
    s = s.replace("<manifest", '<manifest\n    <uses-permission android:name="android.permission.INTERNET" />', 1)
if "android:screenOrientation=" not in s:
    s = s.replace(
        'android:exported="true"',
        'android:exported="true"\n            android:screenOrientation="landscape"',
        1
    )
manifest.write_text(s, encoding="utf-8")

styles = ANDROID / "app" / "src" / "main" / "res" / "values" / "styles.xml"
s = styles.read_text(encoding="utf-8")
if "android:windowFullscreen" not in s:
    s = s.replace(
        "</style>",
        '    <item name="android:windowFullscreen">true</item>\n'
        '        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>\n'
        '    </style>',
        1
    )
styles.write_text(s, encoding="utf-8")

print(f"Patched Android project: Steel Frontier {version} ({version_code})")
