#!/usr/bin/env python3
"""Builds the .vsix without vsce (a .vsix is a zip with a small manifest). Run after `node esbuild.mjs --production`.
   Usage: python3 scripts/make-vsix.py [output-dir]      The standard route is `pnpm package` (vsce); this is the offline one."""
import json, os, sys, zipfile
from xml.dom import minidom
base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
m = json.load(open(f'{base}/package.json'))
name, ver, pub = m['name'], m['version'], m['publisher']
bundle = f'{base}/dist/extension.js'
if not os.path.exists(bundle): sys.exit('dist/extension.js is missing: run `node esbuild.mjs --production` first')
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{ver}" Publisher="{pub}" />
    <DisplayName>{m['displayName']}</DisplayName>
    <Description xml:space="preserve">{m['description']}</Description>
    <Tags>chat,ai,local,roaster</Tags>
    <Categories>{",".join(m['categories'])}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{m['engines']['vscode']}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
'''
types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".html" ContentType="text/html" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
</Types>
'''
for x in (manifest, types): minidom.parseString(x.encode())  # must be well-formed
out_dir = sys.argv[1] if len(sys.argv) > 1 else base
out = os.path.join(out_dir, f'{name}-{ver}.vsix')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('extension.vsixmanifest', manifest)
    z.write(f'{base}/package.json', 'extension/package.json')
    z.write(f'{base}/README.md', 'extension/README.md')
    z.write(bundle, 'extension/dist/extension.js')
    for f in sorted(os.listdir(f'{base}/media')): z.write(f'{base}/media/{f}', f'extension/media/{f}')
print(f'wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB)')
