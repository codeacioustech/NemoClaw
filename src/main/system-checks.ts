import { spawn } from 'child_process'
import * as os from 'os'
import type { SystemCheckResult, SystemCheckResponse } from '../shared/types'

const EXEC_TIMEOUT_MS = 10000

function execCommand(command: string, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let resolved = false
    const proc = spawn(command, args, { shell: false })
    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        proc.kill()
        resolve({ stdout: '', stderr: 'Command timed out', code: 124 })
      }
    }, EXEC_TIMEOUT_MS)

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 })
      }
    })
    proc.on('error', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        resolve({ stdout: '', stderr: 'Command not found', code: 1 })
      }
    })
  })
}

function wslCmd(cmd: string, login = false): { command: string; args: string[] } {
  const flag = login ? '-l' : ''
  if (process.platform === 'win32') {
    return { command: 'wsl', args: flag ? ['bash', flag, '-c', cmd] : ['bash', '-c', cmd] }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { command: shell, args: flag ? [flag, '-c', cmd] : ['-c', cmd] }
}

function parseVersion(v: string): number[] {
  return v.replace(/^v/, '').split('.').map(Number)
}

function versionGte(current: string, minimum: string): boolean {
  const c = parseVersion(current)
  const m = parseVersion(minimum)
  for (let i = 0; i < m.length; i++) {
    if ((c[i] || 0) > (m[i] || 0)) return true
    if ((c[i] || 0) < (m[i] || 0)) return false
  }
  return true
}

async function checkOS(): Promise<SystemCheckResult> {
  console.log('[system-check] checkOS: start')
  const platform = process.platform
  const release = os.release()
  const arch = os.arch()
  const labels: Record<string, string> = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux'
  }
  const name = labels[platform] || platform
  console.log('[system-check] checkOS: done')

  // Block Intel Mac — OpenShell has no x86_64-apple-darwin binary
  if (platform === 'darwin' && arch === 'x64') {
    return {
      id: 'os',
      name: 'Operating System',
      status: 'fail',
      value: `${name} ${release} (Intel x86_64)`,
      message: 'macOS Intel is not supported — NemoClaw requires Apple Silicon (M1/M2/M3/M4). OpenShell has no x86_64 macOS binary.',
      fixUrl: 'https://docs.nvidia.com/nemoclaw/latest/'
    }
  }

  // Warn on Linux aarch64 — some NIM containers expect amd64
  if (platform === 'linux' && arch === 'arm64') {
    return {
      id: 'os',
      name: 'Operating System',
      status: 'warn',
      value: `${name} ${release} (ARM64)`,
      message: 'Some NIM containers are amd64-only and may fail to run on Linux ARM64.'
    }
  }

  return {
    id: 'os',
    name: 'Operating System',
    status: 'pass',
    value: `${name} ${release} (${arch})`,
    message: 'Detected'
  }
}

async function checkGit(): Promise<SystemCheckResult> {
  console.log('[system-check] checkGit: start')
  const { command, args } = wslCmd('git --version')
  const result = await execCommand(command, args)
  console.log('[system-check] checkGit: done, code=' + result.code)
  if (result.code !== 0) {
    return {
      id: 'git',
      name: 'Git',
      status: 'fail',
      value: 'Not found',
      message: 'Git is required to clone the NemoClaw repository',
      fixUrl: 'https://git-scm.com/downloads'
    }
  }
  return {
    id: 'git',
    name: 'Git',
    status: 'pass',
    value: result.stdout.trim(),
    message: 'Installed'
  }
}

async function checkXcodeCLT(): Promise<SystemCheckResult | null> {
  if (process.platform !== 'darwin') return null
  console.log('[system-check] checkXcodeCLT: start')
  const result = await execCommand('xcode-select', ['-p'])
  console.log('[system-check] checkXcodeCLT: done, code=' + result.code)
  if (result.code !== 0) {
    return {
      id: 'xcode-clt',
      name: 'Xcode Command Line Tools',
      status: 'fail',
      value: 'Not installed',
      message: 'Required on macOS for compiling native modules',
      fixCommand: 'xcode-select --install'
    }
  }
  return {
    id: 'xcode-clt',
    name: 'Xcode Command Line Tools',
    status: 'pass',
    value: result.stdout.trim(),
    message: 'Installed'
  }
}

async function checkNodeJS(): Promise<SystemCheckResult> {
  console.log('[system-check] checkNodeJS: start')
  const { command, args } = wslCmd('node --version')
  const result = await execCommand(command, args)
  console.log('[system-check] checkNodeJS: done, code=' + result.code)
  if (result.code !== 0) {
    return {
      id: 'nodejs',
      name: 'Node.js',
      status: 'warn',
      value: 'Not found',
      message: 'Node.js >= 22.16.0 required — installer will install via nvm',
      fixUrl: 'https://nodejs.org/'
    }
  }
  const version = result.stdout.trim()
  const pass = versionGte(version, '22.16.0')
  return {
    id: 'nodejs',
    name: 'Node.js',
    status: pass ? 'pass' : 'warn',
    value: version,
    message: pass ? 'Version OK' : 'Node.js >= 22.16.0 required — installer will upgrade via nvm',
    fixUrl: pass ? undefined : 'https://nodejs.org/'
  }
}

async function checkNpm(): Promise<SystemCheckResult> {
  console.log('[system-check] checkNpm: start')
  const { command, args } = wslCmd('npm --version')
  const result = await execCommand(command, args)
  console.log('[system-check] checkNpm: done, code=' + result.code)
  if (result.code !== 0) {
    return {
      id: 'npm',
      name: 'npm',
      status: 'warn',
      value: 'Not found',
      message: 'npm >= 10.0.0 required — will be installed with Node.js',
      fixUrl: 'https://docs.npmjs.com/downloading-and-installing-node-js-and-npm'
    }
  }
  const version = result.stdout.trim()
  const pass = versionGte(version, '10.0.0')
  return {
    id: 'npm',
    name: 'npm',
    status: pass ? 'pass' : 'warn',
    value: version,
    message: pass ? 'Version OK' : 'npm >= 10.0.0 required — will be upgraded with Node.js',
    fixUrl: pass ? undefined : 'https://docs.npmjs.com/downloading-and-installing-node-js-and-npm'
  }
}

async function checkContainerRuntime(): Promise<SystemCheckResult> {
  console.log('[system-check] checkContainerRuntime: start')

  // Check Docker first
  const { command, args } = wslCmd('docker info')
  const dockerResult = await execCommand(command, args)
  console.log('[system-check] checkContainerRuntime: docker code=' + dockerResult.code)
  if (dockerResult.code === 0) {
    return {
      id: 'runtime',
      name: 'Container Runtime',
      status: 'pass',
      value: 'Docker',
      message: 'Docker is running'
    }
  }

  // On macOS, also check Colima
  if (process.platform === 'darwin') {
    const colimaResult = await execCommand('colima', ['status'])
    console.log('[system-check] checkContainerRuntime: colima code=' + colimaResult.code)
    if (colimaResult.code === 0) {
      return {
        id: 'runtime',
        name: 'Container Runtime',
        status: 'pass',
        value: 'Colima',
        message: 'Colima is running'
      }
    }
  }

  const hint = process.platform === 'darwin'
    ? 'Start Docker Desktop or Colima before running the installer.'
    : 'Docker is not running. Start Docker Desktop and try again.'

  return {
    id: 'runtime',
    name: 'Container Runtime',
    status: 'fail',
    value: 'Not available',
    message: hint,
    fixUrl: 'https://docs.docker.com/get-docker/'
  }
}

async function checkWSL(): Promise<SystemCheckResult | null> {
  if (process.platform !== 'win32') return null
  console.log('[system-check] checkWSL: start')
  const result = await execCommand('wsl', ['--status'])
  console.log('[system-check] checkWSL: --status done, code=' + result.code)
  const output = result.stdout + result.stderr
  const hasWSL2 = output.toLowerCase().includes('wsl') || result.code === 0

  if (!hasWSL2) {
    return {
      id: 'wsl',
      name: 'WSL2',
      status: 'fail',
      value: 'Not installed',
      message: 'WSL2 is required on Windows',
      fixCommand: 'wsl --install',
      fixUrl: 'https://learn.microsoft.com/en-us/windows/wsl/install'
    }
  }

  const distroResult = await execCommand('wsl', ['-l', '-v'])
  console.log('[system-check] checkWSL: done, distro code=' + distroResult.code)
  const hasDistro = distroResult.stdout.length > 0 && distroResult.code === 0

  return {
    id: 'wsl',
    name: 'WSL2',
    status: hasDistro ? 'pass' : 'fail',
    value: hasDistro ? 'Installed with distro' : 'No distro found',
    message: hasDistro ? 'WSL2 ready' : 'Install a WSL2 Linux distro (e.g., Ubuntu)',
    fixCommand: hasDistro ? undefined : 'wsl --install -d Ubuntu',
    fixUrl: hasDistro ? undefined : 'https://learn.microsoft.com/en-us/windows/wsl/install'
  }
}

async function checkCgroup(): Promise<SystemCheckResult> {
  console.log('[system-check] checkCgroup: start')
  const { command, args } = wslCmd("docker info --format '{{.CgroupDriver}}'")
  const result = await execCommand(command, args)
  console.log('[system-check] checkCgroup: done, code=' + result.code)

  if (result.code !== 0) {
    return {
      id: 'cgroup',
      name: 'cgroup v2',
      status: 'warn',
      value: 'Unknown',
      message: 'Could not check cgroup config (Docker may not be running)'
    }
  }

  const driver = result.stdout.replace(/'/g, '').trim()
  return {
    id: 'cgroup',
    name: 'cgroup v2',
    status: 'pass',
    value: driver,
    message: `cgroup driver: ${driver}`
  }
}

async function checkDisk(): Promise<SystemCheckResult> {
  console.log('[system-check] checkDisk: start')
  let command: string
  let args: string[]

  if (process.platform === 'win32') {
    command = 'wsl'
    args = ['df', '-k', '/']
  } else {
    command = 'df'
    args = ['-k', '/']
  }

  const result = await execCommand(command, args)
  console.log('[system-check] checkDisk: done, code=' + result.code)
  if (result.code !== 0) {
    return {
      id: 'disk',
      name: 'Disk Space',
      status: 'warn',
      value: 'Unknown',
      message: 'Could not check disk space'
    }
  }

  const lines = result.stdout.split('\n')
  if (lines.length < 2) {
    return {
      id: 'disk',
      name: 'Disk Space',
      status: 'warn',
      value: 'Unknown',
      message: 'Could not parse disk space output'
    }
  }

  const parts = lines[1].split(/\s+/)
  const availableKB = parseInt(parts[3], 10)
  const availableGB = Math.round(availableKB / 1024 / 1024)
  const pass = availableGB >= 20

  return {
    id: 'disk',
    name: 'Disk Space',
    status: pass ? 'pass' : 'fail',
    value: `${availableGB} GB free`,
    message: pass ? 'Sufficient disk space' : 'At least 20 GB free space required'
  }
}

async function checkRAM(): Promise<SystemCheckResult> {
  console.log('[system-check] checkRAM: start')
  const totalBytes = os.totalmem()
  const totalGB = Math.round(totalBytes / 1024 / 1024 / 1024)
  const pass = totalGB >= 8
  console.log('[system-check] checkRAM: done')

  return {
    id: 'ram',
    name: 'System Memory',
    status: pass ? 'pass' : 'fail',
    value: `${totalGB} GB`,
    message: pass ? 'Sufficient memory' : 'At least 8 GB RAM required'
  }
}

async function checkOllama(): Promise<SystemCheckResult> {
  console.log('[system-check] checkOllama: start')
  const { command, args } = wslCmd('ollama --version')
  const result = await execCommand(command, args)
  console.log('[system-check] checkOllama: done, code=' + result.code)

  if (result.code !== 0) {
    return {
      id: 'ollama',
      name: 'Ollama',
      status: 'warn',
      value: 'Not found',
      message: 'Ollama not detected — required for local inference. Install from ollama.com',
      fixUrl: 'https://ollama.com/download'
    }
  }

  const version = result.stdout.trim()

  // Also check if Ollama is actually serving (running)
  const { command: srvCmd, args: srvArgs } = wslCmd('curl -sf http://localhost:11434')
  const srvResult = await execCommand(srvCmd, srvArgs)
  const running = srvResult.code === 0

  return {
    id: 'ollama',
    name: 'Ollama',
    status: 'pass',
    value: `${version}${running ? ' (running)' : ' (installed, not running)'}`,
    message: running ? 'Ollama is installed and serving' : 'Ollama is installed but not running — start it before using local inference'
  }
}

export async function runSystemChecks(): Promise<SystemCheckResponse> {
  console.log('[system-check] runSystemChecks: starting all checks in parallel')
  const [osResult, nodeResult, npmResult, gitResult, xcodeResult, wslResult, runtimeResult, ollamaResult, cgroupResult, diskResult, ramResult] =
    await Promise.all([
      checkOS(),
      checkNodeJS(),
      checkNpm(),
      checkGit(),
      checkXcodeCLT(),
      checkWSL(),
      checkContainerRuntime(),
      checkOllama(),
      checkCgroup(),
      checkDisk(),
      checkRAM()
    ])

  const checks: SystemCheckResult[] = [osResult, gitResult, nodeResult, npmResult]
  if (xcodeResult) checks.push(xcodeResult)
  if (wslResult) checks.push(wslResult)
  checks.push(runtimeResult, ollamaResult, cgroupResult, diskResult, ramResult)

  const allPassed = checks.every((c) => c.status !== 'fail')
  console.log('[system-check] runSystemChecks: complete, allPassed=' + allPassed)

  return {
    platform: process.platform,
    checks,
    allPassed
  }
}
