[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Local', 'Server')][string]$Edition,
  [Parameter(Mandatory = $true)][string]$PythonPath,
  [string]$RuntimeDirectory = 'C:\Software\UltimateCalendarWeChat\calendar-runtime',
  [switch]$UseExistingRuntime,
  [string]$DataDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-LocalPath([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\x00-\x1f]' -or $Value.Substring(2).Contains(':')) {
    throw 'Use an absolute local drive path, not a network, device, or relative path.'
  }
  $resolved = [IO.Path]::GetFullPath($Value)
  if ($resolved.TrimEnd('\', '/') -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')) {
    throw 'Choose a dedicated directory or file, not a drive root.'
  }
  $current = $resolved
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Paths through symbolic links, junctions, or application aliases are not supported.'
      }
    }
    $current = [IO.Path]::GetDirectoryName($current.TrimEnd('\', '/'))
  }
  return $resolved
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This reader requires Windows.' }
if (-not $DataDirectory) {
  $documents = [Environment]::GetFolderPath('MyDocuments')
  if (-not $documents) { throw 'Windows Documents directory was not found. Specify -DataDirectory explicitly.' }
  # Unicode escapes keep this script compatible with Windows PowerShell 5.1 without a BOM.
  $calendarName = -join ([char[]](0x7ec8, 0x6781, 0x65e5, 0x5386))
  if ($Edition -eq 'Local') { $calendarName += -join ([char[]](0x672c, 0x5730, 0x7248)) }
  $dataName = -join ([char[]](0x6570, 0x636e))
  $DataDirectory = Join-Path (Join-Path $documents $calendarName) $dataName
}
$DataDirectory = Assert-LocalPath $DataDirectory
$manifest = Join-Path $DataDirectory 'wechat-runtime.json'
if (Test-Path -LiteralPath $manifest) {
  Write-Output 'Existing wechat-runtime.json preserved. No runtime or calendar settings were changed.'
  return
}
$PythonPath = Assert-LocalPath $PythonPath
if ([IO.Path]::GetFileName($PythonPath) -ine 'python.exe' -or -not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
  throw '-PythonPath must point to an existing 64-bit python.exe, not a launcher or Windows Store alias.'
}
& $PythonPath -I -c "import struct,sys; assert struct.calcsize('P') == 8 and sys.version_info >= (3,12), '64-bit Python 3.12 or newer is required'"
if ($LASTEXITCODE -ne 0) { throw 'Python version or architecture check failed.' }

if (-not $UseExistingRuntime) {
  $RuntimeDirectory = Assert-LocalPath $RuntimeDirectory
  if (Test-Path -LiteralPath $RuntimeDirectory) {
    throw 'Runtime directory already exists and was preserved. Use -UseExistingRuntime with its python.exe, or choose a new -RuntimeDirectory.'
  }
  $requirements = Join-Path $PSScriptRoot 'requirements.txt'
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { throw 'Keep requirements.txt beside setup.ps1.' }
  & $PythonPath -I -c 'import venv,ensurepip'
  if ($LASTEXITCODE -ne 0) { throw 'Creating an environment requires the full Python Windows installer, including venv and pip. An embeddable runtime can only be used with -UseExistingRuntime after preparing its dependencies.' }
  & $PythonPath -I -m venv $RuntimeDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated Python environment; no calendar configuration was written.' }
  $PythonPath = Assert-LocalPath (Join-Path $RuntimeDirectory 'Scripts\python.exe')
  & $PythonPath -I -m pip --isolated --disable-pip-version-check install --requirement $requirements
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; no calendar configuration was written. The partial runtime was retained for inspection.' }
}
& $PythonPath -I -c "from importlib.metadata import version; import cryptography,zstandard; assert version('cryptography') == '50.0.2' and version('zstandard') == '0.25.0', 'Install the versions in requirements.txt'"
if ($LASTEXITCODE -ne 0) { throw 'Required reader dependencies are missing or have different versions; no calendar configuration was written.' }

[IO.Directory]::CreateDirectory($DataDirectory) | Out-Null
$temporary = Join-Path $DataDirectory ('.wechat-runtime-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
  $json = @{ python = $PythonPath } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  # This overload fails if another setup creates the target. Never overwrite it.
  [IO.File]::Move($temporary, $manifest)
} finally {
  if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary }
}
Write-Output "WeChat reader configured for $Edition. Restart only the calendar, then connect and choose groups."
Write-Output "Python: $PythonPath"
Write-Output "Manifest: $manifest"
if (-not (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($PythonPath)) 'ffmpeg.exe') -PathType Leaf)) {
  Write-Output 'Optional HEVC image decoding is unavailable until ffmpeg.exe is installed beside this python.exe. See docs/wechat-capture.md.'
}
