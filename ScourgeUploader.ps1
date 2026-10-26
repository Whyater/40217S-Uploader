# Scourge Uploader: a small Windows app that puts 40217S robot code on the V5 brain.
#
# How it works, in plain terms:
#   * The programmer pushes code to GitHub. A GitHub Action builds it and posts a
#     "release" with three core files: hot.package.bin, cold.package.bin,
#     project.pros. Newer releases may also carry the three Scourge Tester files.
#   * This app downloads the core files into <InstallDir>\project and tester
#     files into <InstallDir>\project\tester when they are present.
#   * When you click "Upload to robot", the app runs the official PROS tool
#     (pros.exe upload ...) in that folder. PROS sends the files over USB.
#
# Why the code looks the way it does:
#   * WinForms windows only like to be touched from the thread that made them
#     (the "UI thread"). Slow work (downloads, uploads, USB checks) runs on
#     background threads in a "runspace pool" so the window never freezes.
#   * Background threads never touch the window. They hand back a result, and
#     a WinForms Timer (which always fires on the UI thread) picks the result up
#     and updates the screen. That is our way of marshaling work back to the
#     UI thread, and it is safer in PowerShell than Control.Invoke because a
#     PowerShell script block cannot run on a thread that has no runspace.
#
# Options:
#   -SelfTest           build the window without showing it, run a few checks,
#                       print a summary, exit 0 (pass) or 1 (fail). Used by CI.
#   -InstallDir <path>  where pros-cli, the project files, and version.json live.
#                       Default: %LOCALAPPDATA%\ScourgeUploader
#
# Must run on Windows PowerShell 5.1 (the version built into Windows 10 and 11),
# so this file sticks to plain ASCII and 5.1 syntax.

param(
    [switch]$SelfTest,
    [string]$InstallDir = '',
    [switch]$AfterUpdate
)

$ErrorActionPreference = 'Stop'
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'ScourgeUploader'
}

# GitHub needs TLS 1.2. This setting covers every thread in this process.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
# Releases page of the public repo. Files are downloaded from
#   <ReleasesUrl>/latest/download/release.json and <ReleasesUrl>/download/<tag>/<file>
$script:ReleasesUrl = 'https://github.com/Whyater/40217S-Uploader/releases'
$script:AssetNames = @('hot.package.bin', 'cold.package.bin', 'project.pros')
$script:TesterAssetNames = @('tester-hot.package.bin', 'tester-cold.package.bin', 'tester-project.pros')
$script:UploaderVersion = '2.0.0'
$script:UploaderScriptPath = $PSCommandPath
$script:UploaderManifestUrl = 'https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/uploader.json'
$script:ProjectDir = Join-Path $InstallDir 'project'
$script:BinDir     = Join-Path $script:ProjectDir 'bin'
$script:VersionFile = Join-Path $InstallDir 'version.json'
$script:ProsDir    = Join-Path $InstallDir 'pros-cli'
$script:PollSeconds = 5        # how often to check for a plugged-in brain while idle
$script:UploadTimeoutSec = 600 # wireless uploads through a controller can take minutes

# ---------------------------------------------------------------------------
# Shared code. These functions are used in two places:
#   1. on background threads (the text of this block is copied into each job)
#   2. directly, in -SelfTest mode
# So they must not touch the window or use any $script: variables.
# ---------------------------------------------------------------------------
$SharedCode = {
    $ProgressPreference = 'SilentlyContinue'

    # Put one line into the shared log queue (the UI shows it in Details).
    function Add-SharedLog {
        param($Sync, [string]$Line)
        if ($null -ne $Sync) { $Sync.Log.Enqueue($Line) }
    }

    function Get-ReleaseAssetPath {
        param([string]$Root, [string]$AssetName)
        $assetRoot = $Root
        $fileName = $AssetName
        if ($AssetName -like 'tester-*') {
            $assetRoot = Join-Path $Root 'tester'
            $fileName = $AssetName.Substring(7)
        }
        if ($fileName -eq 'project.pros') { return Join-Path $assetRoot $fileName }
        return Join-Path $assetRoot ('bin\' + $fileName)
    }

    # Run pros.exe and collect what it prints.
    # Returns a hashtable: ExitCode, Output (last 2000 lines), TimedOut, StartError.
    #   -Sync   shared hashtable from the app. Lines go to $Sync.Log (unless
    #           -Quiet) and the running process is listed in $Sync.Procs so the
    #           app can kill it if the window is closed.
    function Invoke-Pros {
        param(
            [string]$ProsExe,
            [string]$Arguments,
            [string]$WorkDir,
            [int]$TimeoutSec = 60,
            [string]$StdinText = '',
            $Sync = $null,
            [switch]$Quiet
        )
        $result = @{ ExitCode = -1; Output = ''; TimedOut = $false; StartError = '' }
        # Only the newest lines are kept, so a process that prints forever
        # cannot use up all the memory. Error messages are at the end anyway.
        $maxLines = 2000
        $lines = New-Object 'System.Collections.Generic.Queue[string]'
        $logSync = $Sync
        if ($Quiet) { $logSync = $null }

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $ProsExe
        $psi.Arguments = $Arguments
        $psi.WorkingDirectory = $WorkDir
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardInput = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        # Ask Python (PROS is written in Python) to print lines right away and in UTF-8.
        $psi.EnvironmentVariables['PYTHONUNBUFFERED'] = '1'
        $psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        try {
            [void]$proc.Start()
        } catch {
            $result.StartError = $_.Exception.Message
            return $result
        }
        $procId = $proc.Id
        if ($null -ne $Sync) { $Sync.Procs[$procId] = $proc }

        try {
            # PROS can ask yes/no questions (for example "remove old libraries to
            # make room?"). We pre-type the answers, then close the input so any
            # other question ends right away instead of waiting forever.
            try {
                if ($StdinText) { $proc.StandardInput.Write($StdinText) }
                $proc.StandardInput.Close()
            } catch { }

            # Read normal output and error output at the same time. Each
            # ReadLineAsync() is a "Task" we can wait on for a short moment, so
            # neither stream can fill up and block PROS.
            $deadline = (Get-Date).AddSeconds($TimeoutSec)
            $outTask = $proc.StandardOutput.ReadLineAsync()
            $errTask = $proc.StandardError.ReadLineAsync()
            try {
                while (($null -ne $outTask) -or ($null -ne $errTask)) {
                    if ((Get-Date) -gt $deadline) {
                        $result.TimedOut = $true
                        try { $proc.Kill() } catch { }
                        break
                    }
                    if (($null -ne $outTask) -and $outTask.Wait(50)) {
                        $line = $outTask.Result
                        if ($null -eq $line) {
                            $outTask = $null
                        } else {
                            $lines.Enqueue($line)
                            if ($lines.Count -gt $maxLines) { [void]$lines.Dequeue() }
                            Add-SharedLog $logSync $line
                            $outTask = $proc.StandardOutput.ReadLineAsync()
                        }
                    }
                    if (($null -ne $errTask) -and $errTask.Wait(50)) {
                        $line = $errTask.Result
                        if ($null -eq $line) {
                            $errTask = $null
                        } else {
                            $lines.Enqueue($line)
                            if ($lines.Count -gt $maxLines) { [void]$lines.Dequeue() }
                            Add-SharedLog $logSync $line
                            $errTask = $proc.StandardError.ReadLineAsync()
                        }
                    }
                }
            } catch {
                $lines.Enqueue('(reading PROS output failed: ' + $_.Exception.Message + ')')
            }

            if (-not $result.TimedOut) { [void]$proc.WaitForExit(10000) }
            if ($proc.HasExited) { $result.ExitCode = $proc.ExitCode }
        } catch {
            # Most likely the app is closing and already killed this process.
            $lines.Enqueue('(PROS was stopped: ' + $_.Exception.Message + ')')
        } finally {
            # Runs even if the app stops this background job early: never
            # leave pros.exe running, because it would keep the USB port busy.
            try {
                if (-not $proc.HasExited) {
                    $proc.Kill()
                    [void]$proc.WaitForExit(3000)
                }
            } catch { }
            if ($null -ne $Sync) { $Sync.Procs.Remove($procId) }
            try { $proc.Dispose() } catch { }
        }
        $result.Output = ($lines.ToArray() -join "`n")
        return $result
    }

    # Upload the downloaded project to the brain. Never builds anything.
    function Invoke-RobotUpload {
        param([string]$ProsExe, [string]$ProjectDir, [int]$Slot, [string]$Name, [int]$TimeoutSec = 600, $Sync = $null)
        # PROS prefers bin\monolith.bin if it is newer than the hot/cold files,
        # so make sure one never sits in the folder.
        $mono = Join-Path $ProjectDir 'bin\monolith.bin'
        if (Test-Path $mono) { Remove-Item -Path $mono -Force }
        $arguments = 'upload --slot ' + $Slot + ' --name "' + $Name + '" --after screen --no-analytics --no-sentry'
        Add-SharedLog $Sync ('> pros ' + $arguments)
        # PROS (pros-cli 3.5.6) can ask two yes/no questions during an upload,
        # and we answer "y" to each (three y's to be safe):
        #   1. "There are too many files on the V5. PROS can remove the following
        #      suggested old files: ..." The brain holds at most 3 PROS
        #      libraries. If there are more, PROS offers to delete the oldest
        #      libraries AND the programs on the brain that use them (they could
        #      not run without them anyway). Saying yes is what a programmer
        #      uploading from the PROS VS Code extension normally clicks. It can
        #      remove older programs from other slots. (PROS also deletes broken
        #      leftover files on its own, without asking.)
        #   2. "You're about to upload ... bytes wirelessly" (only when going
        #      through a controller). Yes means wait for the slow upload.
        return Invoke-Pros -ProsExe $ProsExe -Arguments $arguments -WorkDir $ProjectDir -TimeoutSec $TimeoutSec -StdinText "y`ny`ny`n" -Sync $Sync
    }

    function Invoke-ProsRecording {
        param([string]$ProsExe, [string]$WorkDir, [string]$FilePath, $Sync)
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $ProsExe
        $psi.Arguments = 'terminal --no-banner --no-analytics --no-sentry'
        $psi.WorkingDirectory = $WorkDir
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        $psi.EnvironmentVariables['PYTHONUNBUFFERED'] = '1'
        $psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        try { [void]$proc.Start() } catch { return @{ Status = 'error'; Error = $_.Exception.Message } }
        $id = $proc.Id
        $Sync.Procs[$id] = $proc
        $writer = $null
        $stderrLines = New-Object 'System.Collections.Generic.Queue[string]'
        $requestedStop = $false
        $exitCode = -1
        try {
            $parent = Split-Path $FilePath -Parent
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            $writer = New-Object System.IO.StreamWriter($FilePath, $false, (New-Object System.Text.UTF8Encoding($false)))
            $writer.WriteLine('kind,test,key,value,unit')
            $writer.Flush()
            $outTask = $proc.StandardOutput.ReadLineAsync()
            $errTask = $proc.StandardError.ReadLineAsync()
            while (-not $Sync.RecordStop) {
                $didRead = $false
                foreach ($stream in @('out', 'err')) {
                    $task = if ($stream -eq 'out') { $outTask } else { $errTask }
                    if (($null -ne $task) -and $task.Wait(50)) {
                        $line = $task.Result
                        if ($stream -eq 'out') { if ($null -eq $line) { $outTask = $null } else { $outTask = $proc.StandardOutput.ReadLineAsync() } }
                        else { if ($null -eq $line) { $errTask = $null } else { $errTask = $proc.StandardError.ReadLineAsync() } }
                        if ($null -ne $line) {
                            if ($stream -eq 'err') {
                                $stderrLines.Enqueue([string]$line)
                                Add-SharedLog $Sync ('[pros] ' + [string]$line)
                            }
                            $match = [regex]::Match([string]$line, 'SCOURGE,.*$')
                            if ($match.Success) {
                                $clean = $match.Value.Trim()
                                $writer.WriteLine($clean)
                                $writer.Flush()
                                $parts = $clean.Split(',')
                                if (($parts.Count -ge 3) -and ($parts[1] -notin @('BEGIN', 'END', 'HELLO'))) {
                                    $Sync.RecordValues = [int]$Sync.RecordValues + 1
                                    [void]$Sync.RecordTests.TryAdd([string]$parts[1], $true)
                                } elseif (($parts.Count -ge 3) -and ($parts[1] -eq 'BEGIN')) {
                                    [void]$Sync.RecordTests.TryAdd([string]$parts[2], $true)
                                }
                            }
                        }
                        $didRead = $true
                    }
                }
                if ((-not $didRead) -and $proc.HasExited -and ($null -eq $outTask) -and ($null -eq $errTask)) { break }
            }
        } finally {
            $requestedStop = [bool]$Sync.RecordStop
            try { if (-not $proc.HasExited) { $proc.Kill(); [void]$proc.WaitForExit(3000) } } catch { }
            try { if ($proc.HasExited) { $exitCode = $proc.ExitCode } } catch { }
            if ($null -ne $writer) { try { $writer.Close() } catch { } }
            $Sync.Procs.Remove($id)
            try { $proc.Dispose() } catch { }
        }
        $stderr = ($stderrLines.ToArray() -join "`n")
        if ((-not $requestedStop) -and ($exitCode -ne 0)) {
            if (-not $stderr) { $stderr = 'pros terminal exited with code ' + $exitCode + '.' }
            return @{ Status = 'error'; ExitCode = $exitCode; Error = $stderr; FilePath = $FilePath }
        }
        return @{ Status = 'stopped'; ExitCode = $exitCode; Error = $stderr; FilePath = $FilePath }
    }

    function Get-FileSha256 {
        param([string]$Path)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = [System.IO.File]::ReadAllBytes($Path)
            return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
    }

    # Turn PROS output into a plain-English result.
    # Returns @{ Ok; Kind; Message; Detail }.
    function Get-UploadOutcome {
        param($Run, [int]$Slot)
        if ($null -eq $Run) {
            return @{ Ok = $false; Kind = 'Failed'; Message = 'Upload failed: nothing came back from the upload task.'; Detail = '' }
        }
        if ($Run.Error) {
            return @{ Ok = $false; Kind = 'Failed'; Message = ('Upload failed: ' + $Run.Error); Detail = '' }
        }
        if ($Run.StartError) {
            return @{ Ok = $false; Kind = 'NoPros'; Message = 'Could not start the PROS uploader. Run the install command again.'; Detail = $Run.StartError }
        }
        $out = [string]$Run.Output
        if ($Run.TimedOut) {
            return @{ Ok = $false; Kind = 'Timeout'; Message = 'The upload took too long and was stopped. Unplug the cable, plug it back in, and try again.'; Detail = '' }
        }
        if (($out -match 'Finished uploading') -and ($Run.ExitCode -eq 0)) {
            return @{ Ok = $true; Kind = 'Success'; Message = ('Uploaded to slot ' + $Slot + '. Run it from the brain screen.'); Detail = '' }
        }
        if ($out -match 'Multiple .* were found') {
            return @{ Ok = $false; Kind = 'Multiple'; Message = 'More than one VEX device is plugged in. Unplug everything except the brain, then try again.'; Detail = '' }
        }
        if (($out -match 'No v5 ports were found') -or ($out -match 'No port provided or located')) {
            return @{ Ok = $false; Kind = 'NoBrain'; Message = 'No brain found. Plug the USB cable into the brain (not the controller), turn the brain on, and close VEXcode. Still failing? Try another cable, since some only charge.'; Detail = '' }
        }
        if ($out -match "doesn't appear to be connected to a V5 Brain") {
            return @{ Ok = $false; Kind = 'NoLink'; Message = 'The controller is plugged in but is not linked to the brain. Plug the cable into the brain instead.'; Detail = '' }
        }
        if (($out -match 'could not open port') -or ($out -match 'Access is denied') -or ($out -match 'PermissionError')) {
            return @{ Ok = $false; Kind = 'PortBusy'; Message = 'Another program is using the brain. Close VEXcode or any other VEX app, then try again.'; Detail = '' }
        }
        if ($out -match 'No output files were found') {
            return @{ Ok = $false; Kind = 'NoCode'; Message = 'The robot code files are missing. Click Get latest code, then try again.'; Detail = '' }
        }
        # Anything else: show the last thing PROS said.
        $last = ''
        $all = @($out -split "`n" | Where-Object { $_.Trim() -ne '' })
        if ($all.Count -gt 0) { $last = $all[$all.Count - 1].Trim() }
        if ($last.Length -gt 140) { $last = $last.Substring(0, 140) + '...' }
        $msg = 'Upload failed. See Details for the full PROS output.'
        if ($last) { $msg = 'Upload failed. PROS said: ' + $last }
        return @{ Ok = $false; Kind = 'Failed'; Message = $msg; Detail = $out }
    }

    # Read "pros lsusb" output. Looks like:
    #   VEX EDR V5 System Ports:
    #   COM3 - VEX Robotics V5 Brain - 1234 (COM3)
    #   There are no connected VEX EDR V5 User Ports
    # Returns 'brain', 'controller', 'multiple', or 'none'.
    function Get-BrainState {
        param([string]$Output)
        $inSystem = $false
        $ports = New-Object System.Collections.Generic.List[string]
        foreach ($raw in ($Output -split "`n")) {
            $line = $raw.Trim()
            if ($line -match '^VEX EDR V5 System Ports:') { $inSystem = $true; continue }
            if (($line -match '^VEX EDR') -or ($line -match '^There are no')) { $inSystem = $false; continue }
            if ($inSystem -and ($line -match '^\S+ - ')) { $ports.Add($line) }
        }
        if ($ports.Count -eq 0) { return 'none' }
        if ($ports.Count -gt 1) { return 'multiple' }
        if ($ports[0] -match 'Controller') { return 'controller' }
        return 'brain'
    }

    # Ask GitHub about the newest release by downloading its small release.json
    # file. This goes through github.com release downloads (served from a CDN),
    # not the GitHub API, so there is no 60-requests-per-hour limit to hit on a
    # shared school network.
    # release.json fields: tag, title, notes, built_at (built_at may be missing
    # on older builds).
    # Returns @{ Status = 'ok' | 'none' | 'offline' | 'error'; Release; Error }.
    # 'none' means there is no release.json yet (no build published, or the
    # newest build is from before release.json existed).
    function Get-LatestRelease {
        param([string]$ReleasesUrl)
        $tmp = [System.IO.Path]::GetTempFileName()
        try {
            try {
                # GitHub caches the 'latest' redirect for a few minutes; a unique query string skips that
                # cache so a build published a moment ago shows up right away.
                $fresh = '?t=' + [DateTime]::UtcNow.Ticks
                Invoke-WebRequest -Uri ($ReleasesUrl + '/latest/download/release.json' + $fresh) -OutFile $tmp -UseBasicParsing -TimeoutSec 20
            } catch {
                $code = 0
                $resp = $_.Exception.Response
                if ($null -ne $resp) {
                    try { $code = [int]$resp.StatusCode } catch { }
                }
                if ($code -eq 404) { return @{ Status = 'none' } }
                if ($code -eq 0) { return @{ Status = 'offline'; Error = $_.Exception.Message } }
                return @{ Status = 'error'; Error = ('GitHub answered with HTTP ' + $code + '.') }
            }
            try {
                $rel = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            } catch {
                return @{ Status = 'error'; Error = 'The release information file is damaged.' }
            }
        } finally {
            Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
        }
        $tag = [string]$rel.tag
        # The tag becomes part of a web address, so only allow safe characters.
        if ($tag -notmatch '^[A-Za-z0-9._-]+$') {
            return @{ Status = 'error'; Error = 'The release information has no valid tag.' }
        }
        # Keep the date as text. Some PowerShell versions turn it into a DateTime.
        $built = $rel.built_at
        if ($built -is [datetime]) { $built = $built.ToUniversalTime().ToString('o') }
        # SHA-256 fingerprints of each file (newer builds only). $null = not given.
        $hashes = $null
        if ($null -ne $rel.sha256) {
            $hashes = @{}
            foreach ($prop in $rel.sha256.PSObject.Properties) {
                $hashes[[string]$prop.Name] = ([string]$prop.Value).ToLowerInvariant()
            }
        }
        return @{
            Status  = 'ok'
            Release = @{
                Tag     = $tag
                Name    = [string]$rel.title
                Notes   = [string]$rel.notes
                BuiltAt = [string]$built
                Sha256  = $hashes
            }
        }
    }

    function Get-RemoteUploaderManifest {
        param([string]$ManifestUrl)
        $tmp = [System.IO.Path]::GetTempFileName()
        try {
            try {
                Invoke-WebRequest -Uri ($ManifestUrl + '?t=' + [DateTime]::UtcNow.Ticks) -OutFile $tmp -UseBasicParsing -TimeoutSec 20
                $m = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            } catch {
                return @{ Status = 'offline'; Error = $_.Exception.Message }
            }
        } finally {
            Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
        }
        $version = [string]$m.version
        $hash = ([string]$m.sha256).ToLowerInvariant()
        if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { return @{ Status = 'error'; Error = 'The uploader manifest has an invalid version.' } }
        if ($hash -notmatch '^[0-9a-f]{64}$') { return @{ Status = 'error'; Error = 'The uploader manifest has an invalid SHA-256 fingerprint.' } }
        return @{ Status = 'ok'; Version = $version; Sha256 = $hash }
    }

    function Save-UploaderUpdate {
        param([string]$ScriptPath, [string]$ExpectedVersion, [string]$ExpectedSha256)
        $tmp = [System.IO.Path]::GetTempFileName()
        try {
            try {
                Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/ScourgeUploader.ps1?t=' + [DateTime]::UtcNow.Ticks) -OutFile $tmp -UseBasicParsing -TimeoutSec 60
            } catch { return @{ Status = 'error'; Error = ('Could not download the uploader update: ' + $_.Exception.Message) } }
            # The raw GitHub response is LF text. Hash those downloaded bytes exactly.
            $actual = Get-FileSha256 -Path $tmp
            if ($actual -ne $ExpectedSha256) { return @{ Status = 'error'; Error = ('Uploader update SHA-256 mismatch. Expected ' + $ExpectedSha256 + ' but got ' + $actual + '.') } }
            $bak = $ScriptPath + '.bak'
            try {
                if (Test-Path $bak) { Remove-Item -Path $bak -Force }
                Copy-Item -Path $ScriptPath -Destination $bak -Force
                Move-Item -Path $tmp -Destination $ScriptPath -Force
            } catch { return @{ Status = 'error'; Error = ('Could not replace the uploader script. The current copy was kept. ' + $_.Exception.Message) } }
            return @{ Status = 'updated'; Version = $ExpectedVersion }
        } finally { Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue }
    }

    # Download the newest release into <InstallDir>\project.
    # Returns @{ Status = 'downloaded' | 'current' | 'none' | 'offline' | 'error'; Release; Error }.
    function Save-LatestRelease {
        param([string]$ReleasesUrl, [string]$InstallDir, [string[]]$AssetNames, [string]$InstalledTag, $Sync = $null)
        $info = Get-LatestRelease -ReleasesUrl $ReleasesUrl
        if ($info.Status -ne 'ok') { return $info }
        $rel = $info.Release
        $testerNames = @('tester-hot.package.bin', 'tester-cold.package.bin', 'tester-project.pros')
        $testerMentioned = $false
        $testerCandidate = $false
        if ($null -ne $rel.Sha256) {
            $testerCandidate = $true
            foreach ($n in $testerNames) {
                if ($rel.Sha256.ContainsKey($n)) { $testerMentioned = $true } else { $testerCandidate = $false }
            }
        }

        $projectDir = Join-Path $InstallDir 'project'
        $haveAll = $true
        foreach ($n in $AssetNames) {
            if (-not (Test-Path (Get-ReleaseAssetPath -Root $projectDir -AssetName $n))) { $haveAll = $false }
        }
        if ($testerCandidate) {
            foreach ($n in $testerNames) {
                if (-not (Test-Path (Get-ReleaseAssetPath -Root $projectDir -AssetName $n))) { $haveAll = $false }
            }
        }
        if ($haveAll -and ($rel.Tag -eq $InstalledTag)) {
            return @{ Status = 'current'; Release = $rel; TesterAvailable = $testerCandidate }
        }

        # Download into a side folder first, then swap it in. If the download
        # breaks halfway, the old working code is still there. Every file comes
        # from the same tag, so all of them belong to one build.
        $stage = Join-Path $InstallDir 'project.download'
        if (Test-Path $stage) { Remove-Item -Path $stage -Recurse -Force }
        New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force | Out-Null
        try {
            foreach ($n in $AssetNames) {
                $dest = Get-ReleaseAssetPath -Root $stage -AssetName $n
                New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
                $url = $ReleasesUrl + '/download/' + $rel.Tag + '/' + $n
                try {
                    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 120
                } catch {
                    $resp = $_.Exception.Response
                    if (($null -ne $resp) -and ([int]$resp.StatusCode -eq 404)) {
                        throw ('The newest build (' + $rel.Tag + ') is missing ' + $n + '. Ask the programmer to check the build.')
                    }
                    throw
                }
                if ((-not (Test-Path $dest)) -or ((Get-Item $dest).Length -eq 0)) {
                    throw ('Downloaded file ' + $n + ' is empty.')
                }
            }
            if ($null -ne $rel.Sha256) {
                foreach ($n in $AssetNames) {
                    $file = Get-ReleaseAssetPath -Root $stage -AssetName $n
                    $expected = $rel.Sha256[$n]
                    $actual = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLowerInvariant()
                    if ((-not $expected) -or ($actual -ne $expected)) {
                        throw ('Download was damaged (' + $n + ' failed its SHA-256 check), try Get latest code again.')
                    }
                }
            }
        } catch {
            $err = $_.Exception
            Remove-Item -Path $stage -Recurse -Force -ErrorAction SilentlyContinue
            # No server answer at all means no internet.
            # (PowerShell 5.1 reports that as a WebException with no Response.)
            if ((($err -is [System.Net.WebException]) -and ($null -eq $err.Response)) -or
                ($err.GetType().Name -eq 'HttpRequestException')) {
                return @{ Status = 'offline'; Error = $err.Message }
            }
            return @{ Status = 'error'; Error = $err.Message }
        }

        $testerReady = $false
        if ($testerCandidate) {
            try {
                foreach ($n in $testerNames) {
                    $dest = Get-ReleaseAssetPath -Root $stage -AssetName $n
                    New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
                    $url = $ReleasesUrl + '/download/' + $rel.Tag + '/' + $n
                    try {
                        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 120
                    } catch {
                        $resp = $_.Exception.Response
                        if (($null -ne $resp) -and ([int]$resp.StatusCode -eq 404)) {
                            throw ('The newest build (' + $rel.Tag + ') is missing ' + $n + '.')
                        }
                        throw
                    }
                    if ((-not (Test-Path $dest)) -or ((Get-Item $dest).Length -eq 0)) {
                        throw ('Downloaded file ' + $n + ' is empty.')
                    }
                    $expected = $rel.Sha256[$n]
                    $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLowerInvariant()
                    if ($actual -ne $expected) {
                        throw ('Download was damaged (' + $n + ' failed its SHA-256 check).')
                    }
                }
                $testerReady = $true
            } catch {
                $testerError = $_.Exception.Message
                Remove-Item -Path (Join-Path $stage 'tester') -Recurse -Force -ErrorAction SilentlyContinue
                Add-SharedLog $Sync ('Tester download unavailable: ' + $testerError)
            }
        } elseif ($testerMentioned) {
            Add-SharedLog $Sync 'Tester download unavailable: the release tester fingerprints are incomplete.'
        }

        # Swap the new folder in without ever deleting the working one first:
        #   project -> project.old, new -> project, then delete project.old.
        # If the middle step fails, project.old goes back to being project.
        $old = Join-Path $InstallDir 'project.old'
        if (Test-Path $old) { Remove-Item -Path $old -Recurse -Force }
        $hadOld = Test-Path $projectDir
        try {
            if ($hadOld) { Move-Item -Path $projectDir -Destination $old }
        } catch {
            Remove-Item -Path $stage -Recurse -Force -ErrorAction SilentlyContinue
            return @{ Status = 'error'; Error = ('Could not replace the old code (is a file open?). Your old code is unchanged. ' + $_.Exception.Message) }
        }
        try {
            Move-Item -Path $stage -Destination $projectDir
        } catch {
            $moveError = $_.Exception.Message
            if ($hadOld) { Move-Item -Path $old -Destination $projectDir }
            Remove-Item -Path $stage -Recurse -Force -ErrorAction SilentlyContinue
            return @{ Status = 'error'; Error = ('Could not put the new code in place. Your old code is unchanged. ' + $moveError) }
        }
        if ($hadOld) { Remove-Item -Path $old -Recurse -Force -ErrorAction SilentlyContinue }

        $ver = @{
            tag           = $rel.Tag
            name          = $rel.Name
            notes         = $rel.Notes
            built_at      = $rel.BuiltAt
            downloaded_at = (Get-Date).ToUniversalTime().ToString('o')
        }
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText((Join-Path $InstallDir 'version.json'), ($ver | ConvertTo-Json), $utf8NoBom)
        return @{ Status = 'downloaded'; Release = $rel; TesterAvailable = $testerReady }
    }
}

# Make the shared functions available on this (main) thread too.
. $SharedCode

# Background job bodies. Each runs on a background thread with two inputs:
# $Sync (shared log queue) and $A (a hashtable of arguments). The last value a
# body outputs is its result.
$UploadBody   = { Invoke-RobotUpload -ProsExe $A.ProsExe -ProjectDir $A.ProjectDir -Slot $A.Slot -Name $A.Name -TimeoutSec $A.Timeout -Sync $Sync }
$RecordBody  = { Invoke-ProsRecording -ProsExe $A.ProsExe -WorkDir $A.WorkDir -FilePath $A.FilePath -Sync $Sync }
$LsusbBody    = { Invoke-Pros -ProsExe $A.ProsExe -Arguments 'lsusb --target v5 --no-analytics --no-sentry' -WorkDir $A.WorkDir -TimeoutSec 20 -Sync $Sync -Quiet }
$CheckBody    = { Get-LatestRelease -ReleasesUrl $A.ReleasesUrl }
$UploaderCheckBody = { Get-RemoteUploaderManifest -ManifestUrl $A.ManifestUrl }
$DownloadBody = { Save-LatestRelease -ReleasesUrl $A.ReleasesUrl -InstallDir $A.InstallDir -AssetNames $A.AssetNames -InstalledTag $A.InstalledTag -Sync $Sync }

# ---------------------------------------------------------------------------
# Small helpers used by the window and by -SelfTest
# ---------------------------------------------------------------------------
function Find-ProsExe {
    if (Test-Path $script:ProsDir) {
        $f = Get-ChildItem -Path $script:ProsDir -Filter 'pros.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $f) { return $f.FullName }
    }
    return $null
}

function Test-HaveCode {
    return (Test-Path (Join-Path $script:ProjectDir 'project.pros')) -and
           (Test-Path (Join-Path $script:BinDir 'hot.package.bin')) -and
           (Test-Path (Join-Path $script:BinDir 'cold.package.bin'))
}

function Test-HaveTester {
    foreach ($n in $script:TesterAssetNames) {
        if (-not (Test-Path (Get-ReleaseAssetPath -Root $script:ProjectDir -AssetName $n))) { return $false }
    }
    return $true
}

# Reads version.json. Returns $null if there is none.
function Get-InstalledBuild {
    if (-not (Test-Path $script:VersionFile)) { return $null }
    try {
        $text = [System.IO.File]::ReadAllText($script:VersionFile, [System.Text.Encoding]::UTF8)
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    }
}

# The CI notes look like "Built from <sha>: <commit subject>".
function Split-ReleaseNotes {
    param([string]$Notes)
    $first = ''
    if ($Notes) { $first = ($Notes -split "`n")[0].Trim() }
    if ($first -match '^Built from ([0-9a-fA-F]+):\s*(.*)$') {
        $sha = $Matches[1]
        if ($sha.Length -gt 7) { $sha = $sha.Substring(0, 7) }
        return @{ Sha = $sha; Subject = $Matches[2] }
    }
    return @{ Sha = ''; Subject = $first }
}

function Format-BuildDate {
    param([string]$Text)
    if (-not $Text) { return '' }
    try {
        $styles = [System.Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal'
        $d = [datetime]::Parse($Text, [System.Globalization.CultureInfo]::InvariantCulture, $styles)
        return $d.ToLocalTime().ToString('MMM d, yyyy h:mm tt')
    } catch {
        return $Text
    }
}

# ---------------------------------------------------------------------------
# Look and feel. One accent color; everything else is neutral gray.
# Sizes are in pixels at 100% scaling and follow an 8 px grid. Update-Layout
# multiplies them by the screen scale (see Px) on high-DPI screens.
# ---------------------------------------------------------------------------
$script:Colors = @{}
$script:Fonts = @{}

function Initialize-Theme {
    $c = $script:Colors
    $c.Back        = [System.Drawing.Color]::White
    $c.HeaderBack  = [System.Drawing.Color]::FromArgb(247, 248, 250)
    $c.Line        = [System.Drawing.Color]::FromArgb(228, 231, 236)
    $c.Text        = [System.Drawing.Color]::FromArgb(23, 26, 31)
    $c.Muted       = [System.Drawing.Color]::FromArgb(102, 110, 122)
    $c.Accent      = [System.Drawing.Color]::FromArgb(48, 86, 211)
    $c.AccentHover = [System.Drawing.Color]::FromArgb(38, 72, 186)
    $c.AccentDown  = [System.Drawing.Color]::FromArgb(30, 58, 156)
    $c.Disabled    = [System.Drawing.Color]::FromArgb(228, 231, 236)
    $c.SecHover    = [System.Drawing.Color]::FromArgb(242, 244, 247)
    $c.SecDown     = [System.Drawing.Color]::FromArgb(230, 233, 238)
    $c.Border      = [System.Drawing.Color]::FromArgb(200, 205, 213)
    $c.Good        = [System.Drawing.Color]::FromArgb(31, 138, 76)
    $c.Warn        = [System.Drawing.Color]::FromArgb(201, 138, 4)
    $c.Bad         = [System.Drawing.Color]::FromArgb(180, 35, 24)
    $c.Idle        = [System.Drawing.Color]::FromArgb(154, 161, 172)
    $c.LogBack     = [System.Drawing.Color]::FromArgb(247, 248, 250)

    $f = $script:Fonts
    $f.Base    = New-Object System.Drawing.Font('Segoe UI', 9)
    $f.Title   = New-Object System.Drawing.Font('Segoe UI Semibold', 15)
    $f.Sub     = New-Object System.Drawing.Font('Segoe UI', 9.5)
    $f.Section = New-Object System.Drawing.Font('Segoe UI Semibold', 8)
    $f.Strong  = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
    $f.Small   = New-Object System.Drawing.Font('Segoe UI', 8.5)
    $f.Button  = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
    $f.Status  = New-Object System.Drawing.Font('Segoe UI', 9.5)
    $f.Mono    = New-Object System.Drawing.Font('Consolas', 8.5)
}

function New-Label {
    param([string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H, $Font, $Color)
    $l = New-Object System.Windows.Forms.Label
    $l.AutoSize = $false
    $l.Text = $Text
    $l.Location = New-Object System.Drawing.Point($X, $Y)
    $l.Size = New-Object System.Drawing.Size($W, $H)
    $l.Font = $Font
    $l.ForeColor = $Color
    $l.BackColor = [System.Drawing.Color]::Transparent
    $l.AutoEllipsis = $true
    return $l
}

function New-Line {
    param([int]$X, [int]$Y, [int]$W)
    $l = New-Object System.Windows.Forms.Label
    $l.AutoSize = $false
    $l.Location = New-Object System.Drawing.Point($X, $Y)
    $l.Size = New-Object System.Drawing.Size($W, 1)
    $l.BackColor = $script:Colors.Line
    return $l
}

# Paints a button for its current state (normal or disabled).
function Update-ButtonLook {
    param($Button)
    $c = $script:Colors
    if ($Button.Tag -eq 'primary') {
        if ($Button.Enabled) { $Button.BackColor = $c.Accent } else { $Button.BackColor = $c.Disabled }
    } else {
        if ($Button.Enabled) { $Button.FlatAppearance.BorderColor = $c.Border } else { $Button.FlatAppearance.BorderColor = $c.Line }
    }
}

function New-FlatButton {
    param([string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H, [bool]$Primary)
    $c = $script:Colors
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.Location = New-Object System.Drawing.Point($X, $Y)
    $b.Size = New-Object System.Drawing.Size($W, $H)
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $b.UseVisualStyleBackColor = $false
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    if ($Primary) {
        $b.Tag = 'primary'
        $b.Font = $script:Fonts.Button
        $b.ForeColor = [System.Drawing.Color]::White
        $b.FlatAppearance.BorderSize = 0
        $b.FlatAppearance.MouseOverBackColor = $c.AccentHover
        $b.FlatAppearance.MouseDownBackColor = $c.AccentDown
    } else {
        $b.Tag = 'secondary'
        $b.Font = $script:Fonts.Base
        $b.ForeColor = $c.Text
        $b.BackColor = $c.Back
        $b.FlatAppearance.BorderSize = 1
        $b.FlatAppearance.MouseOverBackColor = $c.SecHover
        $b.FlatAppearance.MouseDownBackColor = $c.SecDown
    }
    Update-ButtonLook $b
    $b.Add_EnabledChanged({ param($s, $e) Update-ButtonLook $s })
    return $b
}

# A small rounded "S" tile used as the window icon.
function New-AppIcon {
    $size = 32
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 14
    $e = $size - 1
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($e - $d, 0, $d, $d, 270, 90)
    $path.AddArc($e - $d, $e - $d, $d, $d, 0, 90)
    $path.AddArc(0, $e - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.SolidBrush($script:Colors.Accent)
    $g.FillPath($brush, $path)
    $font = New-Object System.Drawing.Font('Segoe UI Semibold', 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString('S', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 0, $size, $size)), $fmt)
    $g.Dispose(); $brush.Dispose(); $font.Dispose(); $fmt.Dispose(); $path.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# ---------------------------------------------------------------------------
# The window. All controls are stored in $script:Ui so other functions can
# reach them. New-MainForm only creates the controls; Update-Layout (below)
# decides where each one goes, top to bottom:
#   header
#   ROBOT CODE: build title + Get latest code button, build details,
#               newer-code notice (only when there is one)
#   UPLOAD:     slot + program name, name problem message (only when needed),
#               big upload button
#   brain connection indicator
#   status line (only when it has text)
#   Show details link, then the raw PROS log (only when expanded)
# Hidden items take no space, and the window height always fits the content.
# ---------------------------------------------------------------------------
$script:Ui = @{}
$script:Scale = 1.0
$script:NoticeShown = $false
$script:NameErrorShown = $false
$script:DetailsShown = $false
$script:UploaderUpdateReady = $false
$script:UploaderCheckForClick = $false
$script:LatestUploaderVersion = ''
$script:TesterBuildTag = ''
$script:Recording = $false
$script:ResultsPath = ''
$script:RecordValues = 0
$script:RecordTests = 0

# Converts a size picked at 100% scaling into real pixels for this screen.
function Px {
    param([double]$Value)
    return [int][math]::Round($Value * $script:Scale)
}

# Places a wrapping label and makes it exactly as tall as its text needs.
function Set-WrappedLabel {
    param($Label, [int]$X, [int]$Y, [int]$W)
    $pref = $Label.GetPreferredSize((New-Object System.Drawing.Size($W, 0)))
    $Label.SetBounds($X, $Y, $W, [math]::Max($pref.Height, 1))
}

function New-MainForm {
    $c = $script:Colors
    $f = $script:Fonts
    $ui = $script:Ui

    # How big is a "pixel at 100%" on this screen? 96 DPI = 100%, 144 DPI = 150%.
    # Fonts are in points, so Windows already draws them at the right size.
    try {
        $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
        $script:Scale = $g.DpiX / 96.0
        $g.Dispose()
    } catch {
        $script:Scale = 1.0
    }

    $form = New-Object System.Windows.Forms.Form
    $form.SuspendLayout()
    # We place everything ourselves (Update-Layout), so no automatic scaling.
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $form.Text = 'Scourge Uploader'
    $form.Font = $f.Base
    $form.BackColor = $c.Back
    $form.ForeColor = $c.Text
    # Fixed size: no resizing and no maximize, but minimize still works.
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
    $form.MaximizeBox = $false
    $form.MinimizeBox = $true
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    try { $form.Icon = New-AppIcon } catch { }
    $ui.Form = $form

    # Header band
    $ui.Header = New-Object System.Windows.Forms.Panel
    $ui.Header.BackColor = $c.HeaderBack
    $ui.HeaderTitle = New-Label 'Scourge Uploader' 0 0 10 10 $f.Title $c.Text
    $ui.HeaderSub = New-Label '40217S robot code' 0 0 10 10 $f.Sub $c.Muted
    $ui.Header.Controls.AddRange(@($ui.HeaderTitle, $ui.HeaderSub))
    $ui.HeaderLine = New-Line 0 0 10
    $form.Controls.AddRange(@($ui.Header, $ui.HeaderLine))

    # Robot code section
    $ui.CodeLabel = New-Label 'ROBOT CODE' 0 0 10 10 $f.Section $c.Muted
    $ui.BuildTitle = New-Label 'No robot code downloaded yet' 0 0 10 10 $f.Strong $c.Text
    $ui.BuildMeta = New-Label '' 0 0 10 10 $f.Small $c.Muted
    $ui.BuildMeta.AutoEllipsis = $false
    $ui.GetButton = New-FlatButton 'Get latest code' 0 0 10 10 $false
    $ui.Notice = New-Label '' 0 0 10 10 $f.Small $c.Accent
    $ui.Notice.AutoEllipsis = $false
    $ui.Notice.Visible = $false
    $ui.MidLine = New-Line 0 0 10
    $form.Controls.AddRange(@($ui.CodeLabel, $ui.BuildTitle, $ui.BuildMeta, $ui.GetButton, $ui.Notice, $ui.MidLine))

    # Upload section
    $ui.UploadLabel = New-Label 'UPLOAD' 0 0 10 10 $f.Section $c.Muted
    $ui.SlotLabel = New-Label 'Slot' 0 0 10 10 $f.Base $c.Muted
    $ui.NameLabel = New-Label 'Program name' 0 0 10 10 $f.Base $c.Muted
    $ui.SlotBox = New-Object System.Windows.Forms.ComboBox
    $ui.SlotBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    foreach ($n in 1..8) { [void]$ui.SlotBox.Items.Add([string]$n) }
    $ui.SlotBox.SelectedIndex = 0
    $ui.NameBox = New-Object System.Windows.Forms.TextBox
    # AutoSize off so the text box can be made exactly as tall as the slot box.
    $ui.NameBox.AutoSize = $false
    $ui.NameBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $ui.NameBox.MaxLength = 20
    $ui.NameBox.Text = 'Scourge'
    $ui.NameError = New-Label '' 0 0 10 10 $f.Small $c.Bad
    $ui.NameError.AutoEllipsis = $false
    $ui.NameError.Visible = $false
    $ui.UploadButton = New-FlatButton 'Upload to robot' 0 0 10 10 $true
    $form.Controls.AddRange(@($ui.UploadLabel, $ui.SlotLabel, $ui.NameLabel, $ui.SlotBox, $ui.NameBox, $ui.NameError, $ui.UploadButton))

    # Robot tests section
    $ui.TestsLine = New-Line 0 0 10
    $ui.TestsLabel = New-Label 'ROBOT TESTS' 0 0 10 10 $f.Section $c.Muted
    $ui.TestsHelper = New-Label 'Measure the robot with the Scourge Tester program, then send the results.' 0 0 10 10 $f.Small $c.Muted
    $ui.TesterButton = New-FlatButton 'Put tester on robot' 0 0 10 10 $false
    $ui.RecordButton = New-FlatButton 'Record results' 0 0 10 10 $false
    $ui.ResultsStatus = New-Label 'No results yet' 0 0 10 10 $f.Base $c.Muted
    $ui.SendButton = New-FlatButton 'Send results' 0 0 10 10 $false
    $ui.OpenFolderLink = New-Object System.Windows.Forms.LinkLabel
    $ui.OpenFolderLink.Text = 'Open folder'
    $ui.OpenFolderLink.AutoSize = $true
    $ui.OpenFolderLink.LinkColor = $c.Accent
    $ui.OpenFolderLink.ActiveLinkColor = $c.AccentDown
    $ui.OpenFolderLink.LinkBehavior = [System.Windows.Forms.LinkBehavior]::HoverUnderline
    $form.Controls.AddRange(@($ui.TestsLine, $ui.TestsLabel, $ui.TestsHelper, $ui.TesterButton, $ui.RecordButton, $ui.ResultsStatus, $ui.SendButton, $ui.OpenFolderLink))

    # Connection indicator: a small colored dot plus a label.
    $ui.Dot = New-Object System.Windows.Forms.Panel
    $ui.Dot.BackColor = $c.Back
    $ui.Dot.Tag = $c.Idle
    $ui.Dot.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $brush = New-Object System.Drawing.SolidBrush($s.Tag)
        $e.Graphics.FillEllipse($brush, 0, 0, $s.Width - 1, $s.Height - 1)
        $brush.Dispose()
    })
    $ui.ConnLabel = New-Label 'Checking for a brain...' 0 0 10 10 $f.Base $c.Muted
    $form.Controls.AddRange(@($ui.Dot, $ui.ConnLabel))

    # Status line (as tall as its text)
    $ui.Status = New-Label '' 0 0 10 10 $f.Status $c.Text
    $ui.Status.AutoEllipsis = $false
    $ui.Status.Visible = $false
    $form.Controls.Add($ui.Status)

    # Collapsible details log (collapsed by default)
    $ui.DetailsLink = New-Object System.Windows.Forms.LinkLabel
    $ui.DetailsLink.Text = 'Show details'
    $ui.DetailsLink.AutoSize = $true
    $ui.DetailsLink.LinkColor = $c.Accent
    $ui.DetailsLink.ActiveLinkColor = $c.AccentDown
    $ui.DetailsLink.LinkBehavior = [System.Windows.Forms.LinkBehavior]::HoverUnderline
    $ui.Log = New-Object System.Windows.Forms.TextBox
    $ui.Log.Multiline = $true
    $ui.Log.ReadOnly = $true
    $ui.Log.WordWrap = $true
    $ui.Log.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $ui.Log.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $ui.Log.BackColor = $c.LogBack
    $ui.Log.Font = $f.Mono
    $ui.Log.Visible = $false
    $form.Controls.AddRange(@($ui.DetailsLink, $ui.Log))

    Update-Layout
    $form.ResumeLayout($false)

    # Timers fire on the UI thread, so their handlers may touch controls.
    $ui.JobTimer = New-Object System.Windows.Forms.Timer
    $ui.JobTimer.Interval = 100
    $ui.JobTimer.Add_Tick({ Invoke-Safe { Update-Jobs } })
    $ui.PollTimer = New-Object System.Windows.Forms.Timer
    $ui.PollTimer.Interval = $script:PollSeconds * 1000
    $ui.PollTimer.Add_Tick({ Invoke-Safe { Start-ConnectionCheck } })

    # Button, text box, and link handlers
    $ui.GetButton.Add_Click({ Invoke-Safe { Start-Download } })
    $ui.UploadButton.Add_Click({ Invoke-Safe { Start-Upload } })
    $ui.TesterButton.Add_Click({ Invoke-Safe { Start-TesterUpload } })
    $ui.RecordButton.Add_Click({ Invoke-Safe { if ($script:Recording) { Stop-Recording } else { Start-Recording } } })
    $ui.SendButton.Add_Click({ Invoke-Safe { Send-Results } })
    $ui.OpenFolderLink.Add_LinkClicked({ Invoke-Safe { Open-ResultsFolder } })
    $ui.NameBox.Add_TextChanged({ Invoke-Safe { Update-NameError } })
    $ui.DetailsLink.Add_LinkClicked({ Invoke-Safe { Set-DetailsVisible (-not $script:DetailsShown) } })
    # Shown: the controls now have their real sizes, so lay out again. In
    # -SelfTest the window may be shown for a screenshot; do not start the app.
    $form.Add_Shown({
        Invoke-Safe {
            Update-Layout
            if (-not $SelfTest) { Start-App }
        }
    })
    $form.Add_FormClosing({
        param($s, $e)
        if ($script:Busy -and ($script:BusyKind -eq 'upload')) {
            $answer = [System.Windows.Forms.MessageBox]::Show($s,
                'An upload is still running. If you close now, the program on the brain may be incomplete. Close anyway?',
                'Scourge Uploader',
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Warning)
            if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { $e.Cancel = $true; return }
        }
        $script:Ui.JobTimer.Stop()
        $script:Ui.PollTimer.Stop()
        # Kill any pros.exe still running. Otherwise it could keep holding the
        # brain's USB port and the next upload would fail.
        Stop-Background
    })

    return $form
}

# Puts every control in place, top to bottom, skipping hidden ones, then sizes
# the window to fit. Called whenever something that changes height changes.
# (We track visibility in our own flags because WinForms reports every
# control as hidden until the window itself is on screen.)
function Update-Layout {
    $ui = $script:Ui
    $form = $ui.Form
    if ($null -eq $form) { return }
    $W = Px 480
    $M = Px 24
    $inner = $W - 2 * $M

    $form.SuspendLayout()

    # Header
    $ui.Header.SetBounds(0, 0, $W, (Px 72))
    $ui.HeaderTitle.SetBounds($M, (Px 12), $inner, (Px 30))
    $ui.HeaderSub.SetBounds($M, (Px 42), $inner, (Px 20))
    $ui.HeaderLine.SetBounds(0, (Px 72), $W, 1)

    # Robot code section
    $y = Px 88
    $ui.CodeLabel.SetBounds($M, $y, $inner, (Px 16))
    $y += Px 24
    $btnW = Px 128
    $ui.GetButton.SetBounds(($M + $inner - $btnW), ($y - (Px 4)), $btnW, (Px 32))
    $textW = $inner - $btnW - (Px 16)
    $ui.BuildTitle.SetBounds($M, $y, $textW, (Px 22))
    $y += Px 24
    Set-WrappedLabel $ui.BuildMeta $M $y $textW
    $y += $ui.BuildMeta.Height
    # Keep clear of the button even when the details text is short.
    $y = [math]::Max($y, $ui.GetButton.Bottom)
    $ui.Notice.Visible = $script:NoticeShown
    if ($script:NoticeShown) {
        $y += Px 8
        Set-WrappedLabel $ui.Notice $M $y $inner
        $y += $ui.Notice.Height
    }
    $y += Px 16
    $ui.MidLine.SetBounds($M, $y, $inner, 1)
    $y += Px 16

    # Upload section
    $ui.UploadLabel.SetBounds($M, $y, $inner, (Px 16))
    $y += Px 24
    $slotW = Px 96
    $nameX = $M + $slotW + (Px 16)
    $nameW = $M + $inner - $nameX
    $ui.SlotLabel.SetBounds($M, $y, $slotW, (Px 18))
    $ui.NameLabel.SetBounds($nameX, $y, $nameW, (Px 18))
    $y += Px 22
    # A drop-down list sets its own height from the font; match the text box to it.
    $ui.SlotBox.SetBounds($M, $y, $slotW, $ui.SlotBox.Height)
    $inputH = $ui.SlotBox.Height
    $ui.NameBox.SetBounds($nameX, $y, $nameW, $inputH)
    $y += $inputH
    $ui.NameError.Visible = $script:NameErrorShown
    if ($script:NameErrorShown) {
        $y += Px 4
        Set-WrappedLabel $ui.NameError $nameX $y $nameW
        $y += $ui.NameError.Height
    }
    $y += Px 16
    $ui.UploadButton.SetBounds($M, $y, $inner, (Px 48))
    $y += Px 48

    # Robot tests section
    $y += Px 20
    $ui.TestsLine.SetBounds($M, $y, $inner, 1)
    $y += Px 16
    $ui.TestsLabel.SetBounds($M, $y, $inner, (Px 16))
    $y += Px 22
    Set-WrappedLabel $ui.TestsHelper $M $y $inner
    $y += $ui.TestsHelper.Height + (Px 12)
    $half = [int](($inner - (Px 8)) / 2)
    $ui.TesterButton.SetBounds($M, $y, $half, (Px 34))
    $ui.RecordButton.SetBounds(($M + $half + (Px 8)), $y, $half, (Px 34))
    $y += (Px 34) + (Px 12)
    $sendW = Px 112
    $ui.SendButton.SetBounds(($M + $inner - $sendW), $y - (Px 4), $sendW, (Px 30))
    $ui.ResultsStatus.SetBounds($M, $y, ($inner - $sendW - (Px 12)), (Px 22))
    $y += Px 24
    $ui.OpenFolderLink.Location = New-Object System.Drawing.Point($M, $y)
    $y += $ui.OpenFolderLink.PreferredSize.Height

    # Connection row
    $y += Px 16
    $rowH = Px 20
    $dot = Px 10
    $ui.Dot.SetBounds($M, ($y + [int](($rowH - $dot) / 2)), $dot, $dot)
    $ui.ConnLabel.SetBounds(($M + $dot + (Px 8)), $y, ($inner - $dot - (Px 8)), $rowH)
    $y += $rowH

    # Status line
    $hasStatus = [bool]$ui.Status.Text
    $ui.Status.Visible = $hasStatus
    if ($hasStatus) {
        $y += Px 8
        Set-WrappedLabel $ui.Status $M $y $inner
        $y += $ui.Status.Height
    }

    # Details
    $y += Px 12
    $ui.DetailsLink.Location = New-Object System.Drawing.Point($M, $y)
    $y += $ui.DetailsLink.PreferredSize.Height
    $ui.Log.Visible = $script:DetailsShown
    if ($script:DetailsShown) {
        $y += Px 8
        $ui.Log.SetBounds($M, $y, $inner, (Px 176))
        $y += Px 176
    }
    $y += Px 16

    $size = New-Object System.Drawing.Size($W, $y)
    if ($form.ClientSize -ne $size) { $form.ClientSize = $size }
    $form.ResumeLayout($false)
}

# ---------------------------------------------------------------------------
# Screen updates (UI thread only)
# ---------------------------------------------------------------------------
$script:Busy = $false
$script:BusyKind = ''
$script:BusyStarted = Get-Date
$script:BusyMessage = ''
$script:LastElapsed = -1
$script:LsusbRunning = $false
$script:InstalledTag = ''
$script:LatestTag = ''
$script:UploadSlot = 1
$script:ProsExe = $null
$script:Jobs = New-Object System.Collections.ArrayList
$script:Pool = $null
# Shared with background threads: Log = lines for the Details box,
# Procs = every pros.exe that is running right now (process id -> Process).
$script:Sync = [hashtable]::Synchronized(@{
    Log   = (New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]')
    Procs = [hashtable]::Synchronized(@{})
    RecordStop = $false
    RecordValues = 0
    RecordTests = (New-Object 'System.Collections.Concurrent.ConcurrentDictionary[string,bool]')
})

# Runs a handler and turns any error into a status message instead of a crash.
function Invoke-Safe {
    param([scriptblock]$Action)
    try {
        & $Action
    } catch {
        try {
            Set-Status ('Something went wrong: ' + $_.Exception.Message) 'error'
            Add-LogText ('Error: ' + ($_ | Out-String))
        } catch { }
    }
}

function Set-Status {
    param([string]$Text, [string]$Kind = 'info')
    $c = $script:Colors
    $color = $c.Text
    if ($Kind -eq 'success') { $color = $c.Good }
    if ($Kind -eq 'error') { $color = $c.Bad }
    if ($Kind -eq 'working') { $color = $c.Muted }
    $script:Ui.Status.ForeColor = $color
    if ($script:Ui.Status.Text -ne $Text) {
        $script:Ui.Status.Text = $Text
        Update-Layout
    }
}

function Add-LogText {
    param([string]$Text)
    $log = $script:Ui.Log
    if ($log.TextLength -gt 200000) { $log.Text = $log.Text.Substring($log.TextLength - 100000) }
    $clean = $Text -replace "`r?`n", "`r`n"
    if (-not $clean.EndsWith("`r`n")) { $clean += "`r`n" }
    $log.AppendText($clean)
}

function Set-DetailsVisible {
    param([bool]$Show)
    $script:DetailsShown = $Show
    if ($Show) { $script:Ui.DetailsLink.Text = 'Hide details' } else { $script:Ui.DetailsLink.Text = 'Show details' }
    Update-Layout
}

function Update-RecordingStatus {
    if ($script:ResultsPath) {
        $script:RecordValues = [int]$script:Sync.RecordValues
        $script:RecordTests = $script:Sync.RecordTests.Keys.Count
        $newText = 'Recorded ' + $script:RecordValues + ' values from ' + $script:RecordTests + ' tests'
        $textChanged = $script:Ui.ResultsStatus.Text -ne $newText
        $script:Ui.ResultsStatus.Text = $newText
        $script:Ui.OpenFolderLink.Visible = $true
        if ($textChanged) { Update-Layout }
    }
}

# Program names: start with a letter or number, then letters, numbers, spaces,
# underscores, periods, or hyphens, 20 characters max. PROS itself allows a bit
# more, but these are always safe on the brain screen and on the command line
# (a name starting with "-" would look like an option to PROS).
function Test-ProgramName {
    param([string]$Name)
    return ($Name -cmatch '^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,19}\z')
}

# Shows or hides the small red message under the program name box.
function Update-NameError {
    $name = $script:Ui.NameBox.Text.Trim()
    $bad = -not (Test-ProgramName $name)
    if ($bad) {
        if (-not $name) {
            $script:Ui.NameError.Text = 'Enter a program name.'
        } else {
            $script:Ui.NameError.Text = 'Use letters, numbers, spaces, - _ or . (20 max), starting with a letter or number.'
        }
    }
    $script:NameErrorShown = $bad
    Update-Layout
}

# Closing time: kill every pros.exe we started, stop background jobs, and close
# the runspace pool. Each wait is capped so closing never hangs.
function Stop-Background {
    $procs = $script:Sync.Procs
    $ids = @()
    [System.Threading.Monitor]::Enter($procs.SyncRoot)
    try { $ids = @($procs.Keys) } finally { [System.Threading.Monitor]::Exit($procs.SyncRoot) }
    foreach ($id in $ids) {
        $p = $procs[$id]
        if ($null -eq $p) { continue }
        try { if (-not $p.HasExited) { $p.Kill() } } catch { }
        try { [void]$p.WaitForExit(3000) } catch { }
        try { $p.Dispose() } catch { }
        $procs.Remove($id)
    }
    foreach ($job in @($script:Jobs)) {
        try {
            $h = $job.PS.BeginStop($null, $null)
            [void]$h.AsyncWaitHandle.WaitOne(2000)
        } catch { }
        try { $job.PS.Dispose() } catch { }
    }
    $script:Jobs.Clear()
    if ($null -ne $script:Pool) {
        try {
            $h = $script:Pool.BeginClose($null, $null)
            [void]$h.AsyncWaitHandle.WaitOne(3000)
        } catch { }
        try { $script:Pool.Dispose() } catch { }
        $script:Pool = $null
    }
}

function Set-Busy {
    param([bool]$On, [string]$Kind = '', [string]$Message = '')
    $ui = $script:Ui
    $script:Busy = $On
    $script:BusyKind = $Kind
    $script:BusyMessage = $Message
    $script:BusyStarted = Get-Date
    $script:LastElapsed = -1
    foreach ($ctl in @($ui.GetButton, $ui.UploadButton, $ui.TesterButton, $ui.RecordButton, $ui.SendButton, $ui.SlotBox, $ui.NameBox)) { $ctl.Enabled = -not $On }
    if ($script:Recording) { $ui.RecordButton.Enabled = $true }
    if (-not $On) {
        $ui.TesterButton.Enabled = Test-HaveTester
        $ui.SendButton.Enabled = (-not $script:Recording) -and $script:ResultsPath -and (Test-Path $script:ResultsPath)
    }
    if ($On -and ($Kind -eq 'upload')) { $ui.UploadButton.Text = 'Uploading...' } else { $ui.UploadButton.Text = 'Upload to robot' }
    if ($On -and ($Kind -eq 'download')) { $ui.GetButton.Text = 'Downloading...' } else { $ui.GetButton.Text = 'Get latest code' }
    if ($On) { Set-Status $Message 'working' }
}

function Set-Connection {
    param([string]$State)
    $c = $script:Colors
    $ui = $script:Ui
    $color = $c.Idle
    $text = 'No brain found'
    if ($State -eq 'brain') { $color = $c.Good; $text = 'Brain connected' }
    elseif ($State -eq 'controller') { $color = $c.Warn; $text = 'Controller connected (uploads go over radio, slower)' }
    elseif ($State -eq 'multiple') { $color = $c.Warn; $text = 'More than one VEX device plugged in' }
    elseif ($State -eq 'unknown') { $text = 'Connection status unavailable' }
    $ui.Dot.Tag = $color
    $ui.Dot.Invalidate()
    $ui.ConnLabel.Text = $text
    if ($State -eq 'brain') { $ui.ConnLabel.ForeColor = $c.Text } else { $ui.ConnLabel.ForeColor = $c.Muted }
}

# Shows what is downloaded, from version.json.
function Update-BuildInfo {
    $ui = $script:Ui
    $ui.TesterButton.Enabled = (Test-HaveTester) -and (-not $script:Busy)
    $ui.SendButton.Enabled = (-not $script:Recording) -and $script:ResultsPath -and (Test-Path $script:ResultsPath)
    $b = Get-InstalledBuild
    if (($null -eq $b) -or (-not (Test-HaveCode))) {
        $script:InstalledTag = ''
        $ui.BuildTitle.Text = 'No robot code downloaded yet'
        $ui.BuildMeta.Text = 'Click Get latest code to download it.'
    } else {
        $script:InstalledTag = [string]$b.tag
        $script:TesterBuildTag = if (Test-HaveTester) { $script:InstalledTag } else { '' }
        $parts = Split-ReleaseNotes ([string]$b.notes)
        $title = $parts.Subject
        if (-not $title) { $title = [string]$b.name }
        if (-not $title) { $title = 'Build ' + $b.tag }
        $ui.BuildTitle.Text = $title
        $meta = 'Build ' + $b.tag
        if ($parts.Sha) { $meta += ', commit ' + $parts.Sha }
        # built_at comes from release.json. Older version.json files have published_at.
        $stamp = [string]$b.built_at
        if (-not $stamp) { $stamp = [string]$b.published_at }
        $when = Format-BuildDate $stamp
        if ($when) { $meta += "`n" + 'Built ' + $when }
        $ui.BuildMeta.Text = $meta
    }
    Update-Notice
}

function Update-Notice {
    $messages = New-Object System.Collections.Generic.List[string]
    if ($script:UploaderUpdateReady) { [void]$messages.Add('A newer uploader is ready. Click Get latest code to update.') }
    if ($script:LatestTag -and ($script:LatestTag -ne $script:InstalledTag) -and $script:InstalledTag) { [void]$messages.Add('Newer code is available (' + $script:LatestTag + '). Click Get latest code to download it.') }
    $show = $messages.Count -gt 0
    if ($show) { $script:Ui.Notice.Text = ($messages -join "`n") }
    $script:NoticeShown = $show
    Update-Layout
}

# ---------------------------------------------------------------------------
# Background jobs
# ---------------------------------------------------------------------------

# Starts $Body on a background thread. When it finishes, Update-Jobs (on the
# UI thread) calls $OnDone with the result.
function Start-BgJob {
    param([scriptblock]$Body, [hashtable]$JobArgs, [scriptblock]$OnDone)
    if ($null -eq $script:Pool) {
        $script:Pool = [runspacefactory]::CreateRunspacePool(1, 4)
        $script:Pool.Open()
    }
    # Each job gets the shared functions plus its own body, as plain text, so
    # nothing from the UI thread leaks onto the background thread.
    $code = 'param($Sync, $A)' + "`n" + $SharedCode.ToString() + "`n" + $Body.ToString()
    $ps = [powershell]::Create()
    $ps.RunspacePool = $script:Pool
    [void]$ps.AddScript($code).AddArgument($script:Sync).AddArgument($JobArgs)
    $handle = $ps.BeginInvoke()
    [void]$script:Jobs.Add(@{ PS = $ps; Handle = $handle; OnDone = $OnDone })
}

# Called every 100 ms by JobTimer (UI thread).
function Update-Jobs {
    # 1. Move new log lines from the background queue into the Details box.
    $line = $null
    $sb = New-Object System.Text.StringBuilder
    while ($script:Sync.Log.TryDequeue([ref]$line)) { [void]$sb.AppendLine($line) }
    if ($sb.Length -gt 0) { Add-LogText $sb.ToString() }
    if ($script:Recording) { Update-RecordingStatus }

    # 2. Show elapsed time while busy so it is clear the app is still working.
    if ($script:Busy) {
        $secs = [int]((Get-Date) - $script:BusyStarted).TotalSeconds
        if ($secs -ne $script:LastElapsed) {
            $script:LastElapsed = $secs
            Set-Status ($script:BusyMessage + ' (' + $secs + ' s)') 'working'
        }
    }

    # 3. Finish any background job that is done.
    foreach ($job in @($script:Jobs)) {
        if (-not $job.Handle.IsCompleted) { continue }
        [void]$script:Jobs.Remove($job)
        $result = $null
        try {
            $out = $job.PS.EndInvoke($job.Handle)
            if ($out.Count -gt 0) { $result = $out[$out.Count - 1] }
            if (($null -eq $result) -and ($job.PS.Streams.Error.Count -gt 0)) {
                $result = @{ Status = 'error'; Error = [string]$job.PS.Streams.Error[0] }
            }
        } catch {
            $result = @{ Status = 'error'; Error = $_.Exception.Message }
        } finally {
            $job.PS.Dispose()
        }
        if ($null -eq $result) { $result = @{ Status = 'error'; Error = 'The background task returned nothing.' } }
        Invoke-Safe { & $job.OnDone $result }
    }
}

# Checks for a plugged-in brain. Only while idle, one check at a time.
function Start-ConnectionCheck {
    if ($script:Busy -or $script:LsusbRunning -or (-not $script:ProsExe)) { return }
    $script:LsusbRunning = $true
    Start-BgJob $LsusbBody @{ ProsExe = $script:ProsExe; WorkDir = $InstallDir } {
        param($r)
        $script:LsusbRunning = $false
        if ($r.StartError -or $r.TimedOut -or $r.Error) { Set-Connection 'unknown'; return }
        Set-Connection (Get-BrainState ([string]$r.Output))
    }
}

# Quietly asks GitHub whether newer code exists (on launch).
function Start-ReleaseCheck {
    Start-BgJob $CheckBody @{ ReleasesUrl = $script:ReleasesUrl } {
        param($r)
        if ($r.Status -eq 'ok') {
            $script:LatestTag = [string]$r.Release.Tag
            Update-Notice
        }
    }
}

function Start-UploaderCheck {
    param([bool]$ForClick = $false)
    $script:UploaderCheckForClick = [bool]$ForClick
    Start-BgJob $UploaderCheckBody @{ ManifestUrl = $script:UploaderManifestUrl } {
        param($r)
        if ($r.Status -eq 'ok') {
            try { $newer = ([version]$r.Version -gt [version]$script:UploaderVersion) } catch { $newer = $false }
            $script:LatestUploaderVersion = [string]$r.Version
            $script:UploaderUpdateReady = $newer
            Update-Notice
            if ($script:UploaderCheckForClick -and $newer) {
                Set-Busy $true 'update' 'Updating the uploader...'
                Start-BgJob { Save-UploaderUpdate -ScriptPath $A.ScriptPath -ExpectedVersion $A.Version -ExpectedSha256 $A.Sha256 } @{ ScriptPath = $script:UploaderScriptPath; Version = $r.Version; Sha256 = $r.Sha256 } {
                    param($u)
                    if ($u.Status -eq 'updated') {
                        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
                        $relaunchArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script:UploaderScriptPath + '" -InstallDir "' + $InstallDir + '" -AfterUpdate'
                        try {
                            Start-Process -FilePath $ps -ArgumentList $relaunchArgs -WorkingDirectory $InstallDir -WindowStyle Hidden
                            [System.Windows.Forms.Application]::Exit()
                        } catch {
                            Set-Busy $false
                            Add-LogText ('Uploader relaunch: ' + $_.Exception.Message)
                            Set-Status 'The uploader updated, but could not relaunch. Continuing with the robot code download.' 'error'
                            Start-Download -SkipUploaderUpdate
                        }
                    } else {
                        Set-Busy $false
                        Add-LogText ('Uploader update: ' + [string]$u.Error)
                        Set-Status 'The uploader update could not be installed. Continuing with the robot code download.' 'error'
                        Start-Download -SkipUploaderUpdate
                    }
                }
            } elseif ($script:UploaderCheckForClick) { Start-Download -SkipUploaderUpdate }
        } elseif ($script:UploaderCheckForClick) { Start-Download -SkipUploaderUpdate }
    }
}

function Start-Download {
    param([switch]$SkipUploaderUpdate)
    if ($script:Busy) { return }
    if (-not $SkipUploaderUpdate) {
        Start-UploaderCheck -ForClick $true
        return
    }
    Set-Busy $true 'download' 'Downloading the latest robot code...'
    Add-LogText ('[' + (Get-Date).ToString('HH:mm:ss') + '] Checking GitHub for the latest robot code')
    $jobArgs = @{
        ReleasesUrl  = $script:ReleasesUrl
        InstallDir   = $InstallDir
        AssetNames   = $script:AssetNames
        InstalledTag = $script:InstalledTag
    }
    Start-BgJob $DownloadBody $jobArgs {
        param($r)
        Set-Busy $false
        if ($r.Release) { $script:LatestTag = [string]$r.Release.Tag; $script:TesterBuildTag = [string]$r.Release.Tag }
        Update-BuildInfo
        switch ([string]$r.Status) {
            'downloaded' { Set-Status ('Downloaded build ' + $r.Release.Tag + '. Ready to upload.') 'success' }
            'current'    { Set-Status 'You already have the latest code.' 'info' }
            'none'       {
                if ($script:InstalledTag) {
                    Set-Status 'Waiting for the next build to be published. The code you have is still ready to upload.' 'info'
                } else {
                    Set-Status 'No robot code published yet. Waiting for the next build, so try Get latest code again later.' 'info'
                }
            }
            'offline'    { Set-Status 'No internet connection. Connect to Wi-Fi and click Get latest code. You can still upload the code you already have.' 'error' }
            default      { Set-Status ('Could not download the code. ' + [string]$r.Error) 'error' }
        }
        if ($r.Error) { Add-LogText ('Download: ' + [string]$r.Error) }
        Start-ConnectionCheck
    }
}

function Start-Upload {
    if ($script:Busy) { return }
    if ($script:Recording) { Set-Status 'Stop recording before uploading. The brain USB port is busy.' 'error'; return }
    if (-not $script:ProsExe) {
        Set-Status 'The PROS uploader is missing. Run the install command again.' 'error'
        return
    }
    if (-not (Test-HaveCode)) {
        Set-Status 'No robot code downloaded yet. Click Get latest code first.' 'error'
        return
    }
    # Check the program name first and explain any problem next to the box.
    $name = $script:Ui.NameBox.Text.Trim()
    if (-not (Test-ProgramName $name)) {
        Update-NameError
        Set-Status 'Fix the program name, then click Upload to robot.' 'error'
        [void]$script:Ui.NameBox.Focus()
        return
    }
    $script:UploadSlot = [int]$script:Ui.SlotBox.SelectedItem

    Set-Busy $true 'upload' ('Uploading to slot ' + $script:UploadSlot + '. Keep the cable plugged in.')
    Add-LogText ('[' + (Get-Date).ToString('HH:mm:ss') + '] Uploading ' + $script:InstalledTag + ' to slot ' + $script:UploadSlot)
    $jobArgs = @{
        ProsExe    = $script:ProsExe
        ProjectDir = $script:ProjectDir
        Slot       = $script:UploadSlot
        Name       = $name
        Timeout    = $script:UploadTimeoutSec
    }
    Start-BgJob $UploadBody $jobArgs {
        param($r)
        Set-Busy $false
        $outcome = Get-UploadOutcome -Run $r -Slot $script:UploadSlot
        $message = $outcome.Message
        # PROS asked to clean up old libraries (we answered yes): say so plainly.
        if ([string]$r.Output -match 'There are too many files on the V5') {
            $evictNote = 'PROS removed old libraries (and programs that used them) to make room.'
            Add-LogText $evictNote
            $message = $message + ' ' + $evictNote
        }
        if ($outcome.Ok) {
            Set-Status $message 'success'
        } else {
            Set-Status $message 'error'
            if ($outcome.Detail -and ($outcome.Kind -eq 'NoPros')) { Add-LogText $outcome.Detail }
            if ($outcome.Kind -eq 'Failed') { Set-DetailsVisible $true }
        }
        Start-ConnectionCheck
    }
}

function Start-TesterUpload {
    if ($script:Busy) { return }
    if ($script:Recording) { Set-Status 'Stop recording before uploading. The brain USB port is busy.' 'error'; return }
    if (-not $script:ProsExe) { Set-Status 'The PROS uploader is missing. Run the install command again.' 'error'; return }
    if (-not (Test-HaveTester)) { Set-Status 'The Scourge Tester is not in the latest release yet. Click Get latest code.' 'error'; return }
    Set-Busy $true 'upload' 'Uploading the Scourge Tester to slot 8. Keep the cable plugged in.'
    Add-LogText ('[' + (Get-Date).ToString('HH:mm:ss') + '] Uploading tester to slot 8')
    Start-BgJob $UploadBody @{ ProsExe = $script:ProsExe; ProjectDir = (Join-Path $script:ProjectDir 'tester'); Slot = 8; Name = 'Scourge Tester'; Timeout = $script:UploadTimeoutSec } {
        param($r)
        Set-Busy $false
        $outcome = Get-UploadOutcome -Run $r -Slot 8
        if ($outcome.Ok) { Set-Status 'Uploaded Scourge Tester to slot 8. Run it from the brain screen.' 'success' } else { Set-Status $outcome.Message 'error'; if ($outcome.Kind -eq 'Failed') { Set-DetailsVisible $true } }
        Start-ConnectionCheck
    }
}

function Start-Recording {
    if ($script:Busy) { return }
    if (-not $script:ProsExe) { Set-Status 'The PROS uploader is missing. Run the install command again.' 'error'; return }
    $folder = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scourge Robot Data'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $script:ResultsPath = Join-Path $folder ('results-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.csv')
    $script:Sync.RecordStop = $false
    $script:Sync.RecordValues = 0
    $script:Sync.RecordTests = New-Object 'System.Collections.Concurrent.ConcurrentDictionary[string,bool]'
    $script:RecordValues = 0
    $script:RecordTests = 0
    $script:Recording = $true
    $script:Ui.RecordButton.Text = 'Stop recording'
    $script:Ui.SendButton.Enabled = $false
    Set-Status 'Recording tester results. Keep the cable connected.' 'working'
    Start-BgJob $RecordBody @{ ProsExe = $script:ProsExe; WorkDir = $InstallDir; FilePath = $script:ResultsPath } {
        param($r)
        $script:Recording = $false
        $script:Ui.RecordButton.Text = 'Record results'
        $script:Ui.SendButton.Enabled = ((Test-Path $script:ResultsPath) -and ((Get-Item $script:ResultsPath).Length -gt 8))
        Update-RecordingStatus
        if ($r.Status -eq 'error') {
            Add-LogText ('Recording stderr: ' + [string]$r.Error)
            Set-DetailsVisible $true
            Set-Status ('Recording stopped: ' + [string]$r.Error) 'error'
        } else {
            Set-Status ('Results saved to ' + $script:ResultsPath) 'success'
        }
    }
}

function Stop-Recording {
    $script:Sync.RecordStop = $true
    Set-Status 'Stopping recording...' 'working'
}

function Open-ResultsFolder {
    $folder = Split-Path $script:ResultsPath -Parent
    if (-not $folder) { $folder = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scourge Robot Data' }
    if (Test-Path $folder) { Start-Process explorer.exe -ArgumentList ('"' + $folder + '"') }
}

function Send-Results {
    if ($script:Recording) { Set-Status 'Stop recording before sending results.' 'error'; return }
    if (-not $script:ResultsPath -or -not (Test-Path $script:ResultsPath)) { Set-Status 'No results yet.' 'error'; return }
    $lines = Get-Content -Path $script:ResultsPath -ErrorAction SilentlyContinue
    if ($lines.Count -le 1) { Set-Status 'No results yet.' 'error'; return }
    $date = (Get-Date).ToString('yyyy-MM-dd')
    $tag = if ($script:TesterBuildTag) { $script:TesterBuildTag } else { 'unknown' }
    $body = 'Uploader ' + $script:UploaderVersion + ', tester build ' + $tag + ', UTC ' + [DateTime]::UtcNow.ToString('o') + "`r`n`r`n" + (($lines | Select-Object -Skip 1) -join "`r`n")
    $title = 'Robot data ' + $date
    $url = 'https://github.com/Whyater/40217S-Robot-Data/issues/new?title=' + [uri]::EscapeDataString($title) + '&body=' + [uri]::EscapeDataString($body)
    if ($url.Length -gt 7000) {
        Set-Clipboard -Value $body
        Start-Process $url.Split('&')[0]
        Set-Status ('Paste the results into the box (Ctrl+V), then click Submit new issue. Saved at ' + $script:ResultsPath) 'info'
    } else {
        Start-Process $url
        Set-Status ('New issue page opened. Saved at ' + $script:ResultsPath) 'info'
    }
}

# Runs once, right after the window appears.
function Start-App {
    $script:ProsExe = Find-ProsExe
    Update-BuildInfo
    $script:Ui.JobTimer.Start()
    $script:Ui.PollTimer.Start()
    if (-not $script:ProsExe) {
        Set-Connection 'unknown'
        Set-Status 'The PROS uploader is missing. Run the install command again.' 'error'
    } else {
        Start-ConnectionCheck
    }
    if (-not (Test-HaveCode) -and (-not $AfterUpdate)) {
        # First launch: grab the code automatically.
        Start-Download -SkipUploaderUpdate
    } elseif (-not $AfterUpdate) {
        Set-Status 'Ready. Plug the USB cable into the brain, then click Upload to robot.' 'info'
        Start-ReleaseCheck
    }
    Start-UploaderCheck -ForClick:$false
    if ($AfterUpdate) { Start-Download -SkipUploaderUpdate }
}

# ---------------------------------------------------------------------------
# Start up
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Sharp text on high-DPI screens. Without this, Windows stretches a blurry
# 96 DPI picture of the window.
try {
    if (-not ('Scourge.NativeMethods' -as [type])) {
        Add-Type -Namespace Scourge -Name NativeMethods -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
    }
    [void][Scourge.NativeMethods]::SetProcessDPIAware()
} catch { }
[System.Windows.Forms.Application]::EnableVisualStyles()
try { [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false) } catch { }

Initialize-Theme

# If the app was closed in the middle of swapping in new code, finish the job:
# a leftover project.old is either the only copy (put it back) or junk (delete it).
function Repair-ProjectFolder {
    $old = Join-Path $InstallDir 'project.old'
    if (-not (Test-Path $old)) { return }
    try {
        if (Test-Path $script:ProjectDir) {
            Remove-Item -Path $old -Recurse -Force
        } else {
            Move-Item -Path $old -Destination $script:ProjectDir
        }
    } catch { }
}
Repair-ProjectFolder

if ($SelfTest) {
    # No window is shown here. Each check adds to $failures if it goes wrong.
    $failures = New-Object System.Collections.Generic.List[string]
    Write-Host ('Scourge Uploader self-test (install dir: ' + $InstallDir + ')')

    # 1. Build the whole window (catches WinForms mistakes) and fill it in.
    try {
        $testForm = New-MainForm
        Update-BuildInfo
        Set-Connection 'none'
        Set-Status 'Self-test' 'info'
        Set-DetailsVisible $true
        # CI only: save a picture of the window so its layout can be checked without a Windows PC.
        if ($env:SCOURGE_SCREENSHOT) {
            # Child controls only paint once the window has really been shown.
            $testForm.Show()
            [System.Windows.Forms.Application]::DoEvents()
            $testForm.Refresh()
            $bmp = New-Object System.Drawing.Bitmap $testForm.Width, $testForm.Height
            $testForm.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle 0, 0, $testForm.Width, $testForm.Height))
            $bmp.Save($env:SCOURGE_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            Write-Host ('  Screenshot saved: ' + $env:SCOURGE_SCREENSHOT)
            $testForm.Hide()
        }
        Set-DetailsVisible $false
        $testForm.Dispose()
        Write-Host '  Window build: OK'
    } catch {
        $failures.Add('window build failed: ' + $_.Exception.Message)
        Write-Host ('  Window build: FAIL (' + $_.Exception.Message + ')')
    }

    # 2. PROS runs and reports its version.
    $exe = Find-ProsExe
    if (-not $exe) {
        $failures.Add('pros.exe not found under ' + $script:ProsDir)
        Write-Host '  pros --version: FAIL (pros.exe not found)'
    } else {
        $v = Invoke-Pros -ProsExe $exe -Arguments '--version' -WorkDir $InstallDir -TimeoutSec 120
        if (($v.ExitCode -eq 0) -and ($v.Output -match 'version')) {
            Write-Host ('  pros --version: OK (' + ($v.Output -split "`n" | Where-Object { $_ -match 'version' } | Select-Object -First 1) + ')')
        } else {
            $failures.Add('pros --version failed (exit ' + $v.ExitCode + '): ' + $v.StartError + ' ' + $v.Output)
            Write-Host ('  pros --version: FAIL (exit ' + $v.ExitCode + ')')
        }

        # 3. USB scan (information only, CI has no robot).
        $ls = Invoke-Pros -ProsExe $exe -Arguments 'lsusb --target v5 --no-analytics --no-sentry' -WorkDir $InstallDir -TimeoutSec 120
        Write-Host ('  pros lsusb: exit ' + $ls.ExitCode + ', brain state = ' + (Get-BrainState $ls.Output))

        # 3b. CI only: download the latest release the same way a first launch does.
        if ($env:SCOURGE_SELFTEST_DOWNLOAD -eq '1') {
            $dl = Save-LatestRelease -ReleasesUrl $script:ReleasesUrl -InstallDir $InstallDir -AssetNames $script:AssetNames -InstalledTag $script:InstalledTag
            if (@('downloaded', 'current') -contains [string]$dl.Status) {
                Write-Host ('  Download: OK (' + $dl.Release.Tag + ')')
            } else {
                $failures.Add('download status ' + $dl.Status + ': ' + $dl.Error)
                Write-Host ('  Download: FAIL (' + $dl.Status + ': ' + $dl.Error + ')')
            }
        }

        # 4. Real upload, if code has been downloaded. "No brain found" is a
        #    pass here because it proves PROS read the project and looked for a brain.
        if (Test-Path (Join-Path $script:BinDir 'hot.package.bin')) {
            $run = Invoke-RobotUpload -ProsExe $exe -ProjectDir $script:ProjectDir -Slot 1 -Name 'Scourge' -TimeoutSec $script:UploadTimeoutSec -Sync $script:Sync
            $outcome = Get-UploadOutcome -Run $run -Slot 1
            if ($outcome.Ok -or ($outcome.Kind -eq 'NoBrain')) {
                Write-Host ('  Upload: PASS (' + $outcome.Kind + ': ' + $outcome.Message + ')')
            } else {
                $failures.Add('upload outcome ' + $outcome.Kind + ': ' + $outcome.Message)
                Write-Host ('  Upload: FAIL (' + $outcome.Kind + ': ' + $outcome.Message + ')')
                Write-Host '  PROS output:'
                foreach ($l in ($run.Output -split "`n")) { Write-Host ('    ' + $l) }
            }
        } else {
            Write-Host '  Upload: skipped (no project\bin\hot.package.bin downloaded)'
        }
    }

    if ($failures.Count -eq 0) {
        Write-Host 'SELFTEST PASS'
        exit 0
    }
    Write-Host ('SELFTEST FAIL: ' + ($failures -join '; '))
    exit 1
}

# Normal mode: show the window and run until it is closed.
# The shortcut starts PowerShell hidden, so if anything breaks here nobody would
# see an error. Show a message box instead and save the details to a file.
try {
    $mainForm = New-MainForm
    [System.Windows.Forms.Application]::Run($mainForm)
} catch {
    $errText = ($_ | Out-String)
    $errMsg = $_.Exception.Message
    try {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        [System.IO.File]::WriteAllText((Join-Path $InstallDir 'last-error.txt'), ($stamp + "`r`n" + $errText))
    } catch { }
    try {
        [void][System.Windows.Forms.MessageBox]::Show(
            ('Scourge Uploader could not start. Try running the install command again. If it keeps happening, send this to the programmer:' + "`r`n`r`n" + $errMsg),
            'Scourge Uploader',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch { }
}
# FormClosing already cleaned up; running it again is harmless and covers any
# other way the window might have closed.
Stop-Background
# End the process right away so no background thread keeps it alive.
[Environment]::Exit(0)
