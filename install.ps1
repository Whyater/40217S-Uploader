# Scourge Uploader installer (team 40217S "Scourge")
# Written with help from Claude (AI) for team 40217S.
#
# What this does, in order:
#   1. Downloads the official PROS command line tool for Windows (pinned to
#      version 3.5.6) and checks its SHA-256 fingerprint so we know the file
#      is exactly the one we tested with.
#   2. Installs the Scourge Uploader app (ScourgeUploader.ps1).
#   3. Makes a Desktop shortcut and a Start Menu shortcut, then opens the app.
#
# How a teammate runs it (one line, in PowerShell):
#   irm https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/install.ps1 | iex
#
# Running it again is safe: it replaces the app script and keeps the PROS tool
# if it is already the right version.
#
# Settings for testing (environment variables, all optional):
#   SCOURGE_INSTALL_DIR     install somewhere other than %LOCALAPPDATA%\ScourgeUploader
#   SCOURGE_INSTALL_SOURCE  folder that holds ScourgeUploader.ps1 (copy it from
#                           there instead of downloading it from GitHub)
#   SCOURGE_NO_SHORTCUTS=1  skip the shortcuts and do not open the app at the end
#
# This file is run through "iex", so it must never call "exit" (that would
# close the teammate's PowerShell window). On any problem it uses "throw".
# Everything lives inside one function so settings like $ErrorActionPreference
# do not leak into the teammate's PowerShell session.

function Install-ScourgeUploader {
    $ErrorActionPreference = 'Stop'
    # The progress bar makes Invoke-WebRequest many times slower on PowerShell 5.1.
    $ProgressPreference = 'SilentlyContinue'

    # Pinned PROS CLI release. If you ever change the version, download the zip,
    # run Get-FileHash on it, and paste the new hash here.
    $ProsZipUrl = 'https://github.com/purduesigbots/pros-cli/releases/download/3.5.6/pros_cli-3.5.6-win-64bit.zip'
    $ProsZipSha256 = '47ab4db7f398d42ffb354ba8e2b6aa839282efb767dd2d8f97092f53a63ab0c2'
    $GuiUrl = 'https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/ScourgeUploader.ps1'

    # GitHub only accepts TLS 1.2 or newer. Older PowerShell defaults can be lower.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if ($env:OS -ne 'Windows_NT') {
        throw 'Scourge Uploader only runs on Windows.'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Scourge Uploader needs 64-bit Windows (the PROS tool is 64-bit only).'
    }

    # Where everything goes.
    if ($env:SCOURGE_INSTALL_DIR) {
        $installDir = $env:SCOURGE_INSTALL_DIR
    } else {
        $installDir = Join-Path $env:LOCALAPPDATA 'ScourgeUploader'
    }
    $prosDir = Join-Path $installDir 'pros-cli'
    $hashMarker = Join-Path $prosDir '.scourge-sha256'
    $guiPath = Join-Path $installDir 'ScourgeUploader.ps1'
    $iconPath = Join-Path $installDir 'ScourgeUploader.ico'

    Write-Host 'Installing Scourge Uploader...'
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null

    # A private temp folder for downloads, removed at the end no matter what.
    $tempDir = Join-Path $env:TEMP ('ScourgeUploader-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        # ---------- Step 1: PROS command line tool ----------
        $keepPros = $false
        if (Test-Path $hashMarker) {
            $savedHash = ([string](Get-Content -Path $hashMarker -Raw)).Trim()
            $existingExe = Get-ChildItem -Path $prosDir -Filter 'pros.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if (($savedHash -eq $ProsZipSha256) -and ($null -ne $existingExe)) {
                $keepPros = $true
            }
        }

        if ($keepPros) {
            Write-Host '  PROS uploader 3.5.6 is already installed, keeping it.'
        } else {
            Write-Host '  Downloading the PROS uploader (about 25 MB)...'
            $zipPath = Join-Path $tempDir 'pros_cli.zip'
            try {
                Invoke-WebRequest -Uri $ProsZipUrl -OutFile $zipPath -UseBasicParsing
            } catch {
                throw ('Could not download the PROS uploader. Check your internet connection and try again. Details: ' + $_.Exception.Message)
            }

            # Compare the file's fingerprint with the one we expect. If even one
            # byte is different, the hashes will not match and we stop.
            $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $ProsZipSha256) {
                throw ('The PROS uploader download is corrupted or has been changed (SHA-256 mismatch). Expected ' + $ProsZipSha256 + ' but got ' + $actualHash + '. Nothing was installed.')
            }
            Write-Host '  Download verified (SHA-256 matches).'

            # Replace any old copy with a clean one.
            if (Test-Path $prosDir) {
                try {
                    Remove-Item -Path $prosDir -Recurse -Force
                } catch {
                    throw 'Could not replace the old PROS uploader. Close Scourge Uploader and run the install command again.'
                }
            }
            Expand-Archive -Path $zipPath -DestinationPath $prosDir -Force

            # Find pros.exe wherever it landed (it is at the top of the 3.5.6 zip).
            $prosExe = Get-ChildItem -Path $prosDir -Filter 'pros.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -eq $prosExe) {
                throw 'The PROS uploader zip did not contain pros.exe. Nothing was installed.'
            }
            Set-Content -Path $hashMarker -Value $ProsZipSha256 -Encoding ASCII
            Write-Host '  PROS uploader installed.'
        }

        # ---------- Step 2: the app itself ----------
        Write-Host '  Installing the app...'
        $newGui = Join-Path $tempDir 'ScourgeUploader.ps1'
        if ($env:SCOURGE_INSTALL_SOURCE) {
            # Testing mode: copy the app from a local folder.
            $sourceGui = Join-Path $env:SCOURGE_INSTALL_SOURCE 'ScourgeUploader.ps1'
            if (-not (Test-Path $sourceGui)) {
                throw ('SCOURGE_INSTALL_SOURCE is set, but ' + $sourceGui + ' does not exist.')
            }
            Copy-Item -Path $sourceGui -Destination $newGui -Force
        } else {
            try {
                Invoke-WebRequest -Uri $GuiUrl -OutFile $newGui -UseBasicParsing
            } catch {
                throw ('Could not download the Scourge Uploader app. Check your internet connection and try again. Details: ' + $_.Exception.Message)
            }
        }
        # Sanity check: make sure we got the real script and not, say, a Wi-Fi
        # login page that some school networks show instead.
        $guiText = Get-Content -Path $newGui -Raw
        if (($null -eq $guiText) -or ($guiText -notmatch 'Scourge Uploader')) {
            throw 'The downloaded app file does not look right (maybe a Wi-Fi login page got in the way). Try again on a different network.'
        }
        Copy-Item -Path $newGui -Destination $guiPath -Force
        try { Unblock-File -Path $guiPath } catch { }

        # ---------- Step 3: shortcuts ----------
        if ($env:SCOURGE_NO_SHORTCUTS -eq '1') {
            Write-Host '  Skipping shortcuts (SCOURGE_NO_SHORTCUTS=1).'
        } else {
            Write-Host '  Creating shortcuts...'
            # The icon is optional. If drawing it fails for any reason, the
            # shortcuts just use the PowerShell icon.
            $haveIcon = $false
            try {
                Save-ScourgeIcon -Path $iconPath
                $haveIcon = $true
            } catch { }

            $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $psArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $guiPath + '"'
            $shell = New-Object -ComObject WScript.Shell
            $places = @(
                (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Scourge Uploader.lnk'),
                (Join-Path ([Environment]::GetFolderPath('Programs')) 'Scourge Uploader.lnk')
            )
            foreach ($lnkPath in $places) {
                $lnk = $shell.CreateShortcut($lnkPath)
                $lnk.TargetPath = $psExe
                $lnk.Arguments = $psArgs
                $lnk.WorkingDirectory = $installDir
                $lnk.Description = 'Upload 40217S robot code to the V5 brain'
                # 7 = start minimized, so the PowerShell window does not flash.
                $lnk.WindowStyle = 7
                if ($haveIcon) { $lnk.IconLocation = $iconPath + ',0' }
                $lnk.Save()
            }
        }
    } finally {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host ''
    Write-Host ('Scourge Uploader installed to ' + $installDir)

    if ($env:SCOURGE_NO_SHORTCUTS -ne '1') {
        Write-Host 'Opening Scourge Uploader. Next time, use the "Scourge Uploader" shortcut on your Desktop.'
        Start-Process -FilePath $psExe -ArgumentList $psArgs -WindowStyle Hidden
    }
}

# Draws a simple app icon (a rounded square in the team accent color with a
# white "S") and saves it as a .ico file for the shortcuts. A .ico file is a
# small header followed by an image; modern Windows accepts a PNG image inside.
function Save-ScourgeIcon {
    param([string]$Path)
    Add-Type -AssemblyName System.Drawing
    $size = 256
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $g.Clear([System.Drawing.Color]::Transparent)

        # Rounded square: four corner arcs joined into one closed shape.
        $r = 56
        $d = $r * 2
        $edge = $size - 1
        $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
        $shape.AddArc(0, 0, $d, $d, 180, 90)
        $shape.AddArc($edge - $d, 0, $d, $d, 270, 90)
        $shape.AddArc($edge - $d, $edge - $d, $d, $d, 0, 90)
        $shape.AddArc(0, $edge - $d, $d, $d, 90, 90)
        $shape.CloseFigure()
        $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(48, 86, 211))
        $g.FillPath($fill, $shape)

        $font = New-Object System.Drawing.Font('Segoe UI Semibold', 132, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = [System.Drawing.StringAlignment]::Center
        $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
        $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
        $g.DrawString('S', $font, [System.Drawing.Brushes]::White, $rect, $fmt)

        $fill.Dispose(); $font.Dispose(); $fmt.Dispose(); $shape.Dispose()
    } finally {
        $g.Dispose()
    }

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $png = $ms.ToArray()
    $ms.Dispose()

    # ICO header: reserved(0), type(1 = icon), image count(1). Then one
    # 16-byte directory entry (width/height 0 means 256), then the PNG bytes.
    $fs = [System.IO.File]::Create($Path)
    $bw = New-Object System.IO.BinaryWriter($fs)
    try {
        $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
        $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)
        $bw.Write([UInt16]1); $bw.Write([UInt16]32)
        $bw.Write([UInt32]($png.Length)); $bw.Write([UInt32]22)
        $bw.Write($png)
    } finally {
        $bw.Close()
        $fs.Close()
    }
}

try {
    Install-ScourgeUploader
} catch {
    Write-Host ''
    Write-Host ('Scourge Uploader install failed: ' + $_.Exception.Message)
    Write-Host 'Nothing on the robot was changed. Fix the problem above and run the same command again.'
    throw
}
