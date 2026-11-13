$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path $env:LOCALAPPDATA 'SAHA'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $src 'saha.html') (Join-Path $dst 'saha.html') -Force
Copy-Item (Join-Path $src 'saha.ico')  (Join-Path $dst 'saha.ico')  -Force

# Yedek klasoru (Belgelerim\SAHA-Yedek) - uygulamada bir kez secilecek
$docs = [Environment]::GetFolderPath('MyDocuments')
$bk = Join-Path $docs 'SAHA-Yedek'
New-Item -ItemType Directory -Force -Path $bk | Out-Null

# Varsayilan tarayici: veriler o tarayicida durur
$prog = ''
try { $prog = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice').ProgId } catch {}
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$edge   = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($prog -like 'Chrome*' -and $chrome) { $exe = $chrome }
elseif ($prog -like 'MSEdge*' -and $edge) { $exe = $edge }
elseif ($chrome) { $exe = $chrome }
else { $exe = $edge }
if (-not $exe) { Write-Host 'Chrome veya Edge bulunamadi. Lutfen birini kurun.'; exit 1 }

$url = ([Uri](Join-Path $dst 'saha.html')).AbsoluteUri
$ico = Join-Path $dst 'saha.ico'
$ws = New-Object -ComObject WScript.Shell
$targets = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SAHA.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'SAHA.lnk'))
foreach ($t in $targets) {
  $s = $ws.CreateShortcut($t)
  $s.TargetPath = $exe
  $s.Arguments = '--app="' + $url + '" --start-maximized'
  $s.WorkingDirectory = $dst
  $s.IconLocation = $ico
  $s.Description = 'SAHA voleybol analiz'
  $s.Save()
}
Write-Host ''
Write-Host 'SAHA kuruldu.' -ForegroundColor Green
Write-Host ('Masaustundeki SAHA simgesine cift tikla. Tarayici: ' + (Split-Path $exe -Leaf))
Write-Host ('Yedek klasoru hazir: ' + $bk)
Write-Host 'Uygulamada Sheetler > Yedek > "Yedek klasoru sec" ile bu klasoru bir kez sec.'
