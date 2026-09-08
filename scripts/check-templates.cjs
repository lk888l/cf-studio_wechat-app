#!/usr/bin/env node
'use strict';

// Compile locally with the compiler bundled in WeChat DevTools. This never
// opens a project, connects to a device, or uploads application code.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const appRoot = path.join(projectRoot, 'miniprogram');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/check-templates.cjs --devtools <WeChat DevTools directory>');
  console.log('Alternatively set WECHAT_DEVTOOLS_HOME to the installation directory.');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--devtools' || !args[1])) {
  console.error('Expected --devtools <directory>. Use --help for usage.');
  process.exit(2);
}

const explicitRoot = args[1] || process.env.WECHAT_DEVTOOLS_HOME;
const standardRoots =
  process.platform === 'win32'
    ? [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
        .filter(Boolean)
        .flatMap((root) => [
          path.join(root, 'Tencent', '微信web开发者工具'),
          path.join(root, 'Tencent', '微信开发者工具'),
        ])
    : ['/Applications/wechatwebdevtools.app/Contents', '/Applications/微信开发者工具.app/Contents'];
const roots = explicitRoot ? [path.resolve(explicitRoot)] : standardRoots;
const suffix = process.platform === 'win32' ? '.exe' : '';
const subdirectories = [
  'resources/app.asar.unpacked/node_modules/wcc-exec',
  'Resources/app.nw/node_modules/wcc-exec',
  'Resources/app.asar.unpacked/node_modules/wcc-exec',
  '',
];
const compilerRoot = roots
  .flatMap((root) => subdirectories.map((child) => path.join(root, child)))
  .find((root) => ['wcc', 'wcsc'].every((name) => fs.existsSync(path.join(root, name + suffix))));
if (!compilerRoot) {
  console.error(
    'WeChat template compilers not found. Set WECHAT_DEVTOOLS_HOME or pass --devtools <directory>.',
  );
  process.exit(2);
}

function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(full);
    return [path.relative(appRoot, full).split(path.sep).join('/')];
  });
}
const files = collectFiles(appRoot).sort();
let failed = false;
for (const [name, extension, flags] of [
  ['wcc', '.wxml', []],
  ['wcsc', '.wxss', ['-lc']],
]) {
  const inputs = files.filter((file) => file.endsWith(extension));
  if (!inputs.length) continue;
  const result = spawnSync(path.join(compilerRoot, name + suffix), [...flags, ...inputs], {
    cwd: appRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    failed = true;
    console.error(`${name}: compilation failed (${result.status ?? 'not started'})`);
    console.error(result.error?.message || result.stderr || result.stdout);
    continue;
  }
  if (result.stderr.trim()) console.error(result.stderr.trim());
  console.log(`${name}: ${inputs.length} ${extension} file(s) compiled successfully.`);
}
process.exitCode = failed ? 1 : 0;
