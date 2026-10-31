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
#   -SendCtrlC <pid>    internal helper: sends Ctrl+C to the console of that process and
#                       exits. Record results starts it so the PROS terminal gets a normal
#                       Ctrl+C instead of being killed outright.
#
# Must run on Windows PowerShell 5.1 (the version built into Windows 10 and 11),
# so this file sticks to plain ASCII and 5.1 syntax.

param(
    [switch]$SelfTest,
    [string]$InstallDir = '',
    [switch]$AfterUpdate,
    [int]$SendCtrlC = 0
)

$ErrorActionPreference = 'Stop'

# Helper mode (see -SendCtrlC above). Runs before anything else loads. The app starts
# this in its own short-lived process, because attaching to another console changes
# the console of whoever does it and must never happen inside the app.
if ($SendCtrlC -gt 0) {
    $sent = $false
    try {
        Add-Type -Namespace Scourge -Name CtrlC -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint processId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
'@
        [void][Scourge.CtrlC]::FreeConsole()
        if ([Scourge.CtrlC]::AttachConsole([uint32]$SendCtrlC)) {
            # Ignore Ctrl+C in this helper, then send it to everything on that console.
            [void][Scourge.CtrlC]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true)
            $sent = [Scourge.CtrlC]::GenerateConsoleCtrlEvent([uint32]0, [uint32]0)
            Start-Sleep -Milliseconds 300
            [void][Scourge.CtrlC]::FreeConsole()
        }
    } catch { $sent = $false }
    if ($sent) { exit 0 }
    exit 1
}
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
# One robot source builds four programs that differ only in the hot file;
# cold.package.bin and project.pros are shared. Each mode has its own default
# slot and program name so the four can sit on the brain side by side.
$script:Modes = @(
    @{ Label = 'Competition';  Asset = 'hot.package.bin';            Slot = 1; Name = 'Scourge' },
    @{ Label = 'Auton Test';   Asset = 'auton-test-hot.package.bin'; Slot = 2; Name = 'Scourge Auton Test' },
    @{ Label = 'Drive Test';   Asset = 'drive-test-hot.package.bin'; Slot = 3; Name = 'Scourge Drive Test' },
    @{ Label = 'Auto Pathing'; Asset = 'autopath-hot.package.bin';   Slot = 4; Name = 'Scourge Auto Pathing' }
)
$script:UploaderVersion = '2.5.0'
$script:UploaderScriptPath = $PSCommandPath
$script:UploaderManifestUrl = 'https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/uploader.json'
$script:ProjectDir = Join-Path $InstallDir 'project'
$script:BinDir     = Join-Path $script:ProjectDir 'bin'
$script:VersionFile = Join-Path $InstallDir 'version.json'
$script:ProsDir    = Join-Path $InstallDir 'pros-cli'
$script:PollSeconds = 5        # how often to check for a plugged-in brain while idle
$script:UploadTimeoutSec = 600 # wireless uploads through a controller can take minutes
$script:ResultsUrl = ''

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
        # Test-mode hot files live outside bin so PROS never sees them when it
        # uploads the Competition project folder.
        if ($AssetName -like '*-test-hot.package.bin') { return Join-Path $Root ('modes\' + $AssetName) }
        if ($fileName -eq 'project.pros') { return Join-Path $assetRoot $fileName }
        return Join-Path $assetRoot ('bin\' + $fileName)
    }

    # Build a small project folder for a test mode: the shared files plus the
    # mode's hot file under the name PROS expects (bin\hot.package.bin).
    # Rebuilt from scratch each time so a stale file can never get uploaded.
    function New-ModeProject {
        param([string]$ProjectDir, [string]$ModeAsset, [string]$StageDir)
        if (Test-Path $StageDir) { Remove-Item -Path $StageDir -Recurse -Force }
        New-Item -ItemType Directory -Path (Join-Path $StageDir 'bin') -Force | Out-Null
        Copy-Item -Path (Get-ReleaseAssetPath -Root $ProjectDir -AssetName 'project.pros') -Destination (Join-Path $StageDir 'project.pros') -Force
        Copy-Item -Path (Get-ReleaseAssetPath -Root $ProjectDir -AssetName 'cold.package.bin') -Destination (Join-Path $StageDir 'bin\cold.package.bin') -Force
        Copy-Item -Path (Get-ReleaseAssetPath -Root $ProjectDir -AssetName $ModeAsset) -Destination (Join-Path $StageDir 'bin\hot.package.bin') -Force
        return $StageDir
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

    # Counting while recording. One state hashtable per recording session, shared with
    # the window through $Sync.Rec. AP, AM and AS lines are rows of ONE autopath
    # recording, so they are counted as rows, never as tests. Anything else is a
    # tester result: a value, grouped by test name.
    function New-RecordState {
        return @{
            Values = 0
            Tests = (New-Object 'System.Collections.Concurrent.ConcurrentDictionary[string,bool]')
            Seqs = (New-Object 'System.Collections.Generic.HashSet[int]')
            Expected = 0; Seen = 0; MaxSeq = -1; Begun = 0; Full = 0; Cut = 0; Open = $false; Last = ''; Orphan = $false
        }
    }

    # Feeds one cleaned "SCOURGE,..." line into the state.
    function Add-RecordLine {
        param($St, [string]$Line)
        if ($null -eq $St) { return }
        $parts = $Line.Split(',')
        if ($parts.Count -lt 3) { return }
        $tag = $parts[1]
        if ($tag -eq 'HELLO') { return }
        # A real record has 5 fields and ends with a comma. A line cut short does not.
        $wire = ($parts.Count -eq 5) -and ($parts[4].Length -eq 0)
        if (($tag -eq 'BEGIN') -and ($parts[2] -eq 'autopath')) {
            if ($St.Open) { $St.Cut = $St.Cut + 1; $St.Last = 'cut' }
            $expected = 0
            if ($wire) {
                $b = ConvertFrom-WireBegin $parts[3]
                if ($null -ne $b) { $expected = [int]$b.Expected }
            }
            $St.Seqs.Clear()
            $St.Expected = $expected; $St.Seen = 0; $St.MaxSeq = -1
            $St.Open = $true
            $St.Begun = $St.Begun + 1
            return
        }
        if (($tag -eq 'END') -and ($parts[2] -eq 'autopath')) {
            if (-not $St.Open) {
                # An END with no BEGIN before it: the radio attached late, so the recording is incomplete.
                $St.Orphan = $true
                if ($St.Full -eq 0) { $St.Last = 'cut' }
                return
            }
            $n = -1
            if ($wire) { [void][int]::TryParse($parts[3], [ref]$n) }
            $whole = ($St.Expected -gt 0) -and ($St.Seen -eq $St.Expected) -and ($St.MaxSeq -eq ($St.Expected - 1)) -and ($n -eq $St.Expected)
            if ($whole) { $St.Full = $St.Full + 1; $St.Last = 'full' } else { $St.Cut = $St.Cut + 1; $St.Last = 'cut' }
            $St.Open = $false
            return
        }
        if (($tag -eq 'AP') -or ($tag -eq 'AM') -or ($tag -eq 'AS')) {
            if ($St.Open -and $wire) {
                $seq = -1
                if ([int]::TryParse($parts[2], [ref]$seq) -and ($seq -ge 0)) {
                    if ($St.Seqs.Add($seq)) {
                        $St.Seen = $St.Seen + 1
                        if ($seq -gt $St.MaxSeq) { $St.MaxSeq = $seq }
                    }
                }
            } elseif ($wire) {
                # A row with no BEGIN before it: the radio attached late. Counts as cut off.
                $St.Orphan = $true
                if ($St.Full -eq 0) { $St.Last = 'cut' }
            }
            return
        }
        if ($tag -ne 'END') {
            if ($tag -ne 'BEGIN') {
                $St.Values = $St.Values + 1
                [void]$St.Tests.TryAdd([string]$tag, $true)
            } else {
                [void]$St.Tests.TryAdd([string]$parts[2], $true)
            }
        }
    }

    # The recording ended (Stop was clicked, or the terminal quit) with a recording still open.
    function Close-RecordState {
        param($St)
        if ($null -eq $St) { return }
        if ($St.Open) { $St.Cut = $St.Cut + 1; $St.Last = 'cut'; $St.Open = $false }
    }

    # Starts the helper process that sends Ctrl+C to another process's console.
    function Start-CtrlCHelper {
        param([string]$ScriptPath, [int]$TargetPid)
        if ((-not $ScriptPath) -or (-not (Test-Path -LiteralPath $ScriptPath))) { return $null }
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $ps)) { return $null }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $ps
        $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -SendCtrlC ' + $TargetPid
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        try { return [System.Diagnostics.Process]::Start($psi) } catch { return $null }
    }

    # Sends Ctrl+C to a process we started with CreateNoWindow (its own hidden
    # console), so PROS sees a normal interrupt rather than a kill. This does NOT put a
    # controller's radio back: PROS closes the port before it sends the command that
    # leaves the download channel, so a controller can stay laggy after a recording
    # (the person is told to turn it off and on). True when the helper says it was sent.
    function Send-ProsCtrlC {
        param([int]$TargetPid, [string]$ScriptPath)
        $helper = Start-CtrlCHelper -ScriptPath $ScriptPath -TargetPid $TargetPid
        if ($null -eq $helper) { return $false }
        try {
            if (-not $helper.WaitForExit(10000)) { try { $helper.Kill() } catch { }; return $false }
            return ($helper.ExitCode -eq 0)
        } finally { try { $helper.Dispose() } catch { } }
    }

    # Ctrl+C first, up to GraceMs for the process to close itself, then the hard stop.
    # Returns 'exited' (was already gone), 'clean', or 'forced'.
    function Stop-ProsProcess {
        param($Proc, [string]$ScriptPath, [int]$GraceMs = 3000)
        if ($Proc.HasExited) { return 'exited' }
        $sent = Send-ProsCtrlC -TargetPid $Proc.Id -ScriptPath $ScriptPath
        if ($sent -and $Proc.WaitForExit($GraceMs)) { return 'clean' }
        try { $Proc.Kill(); [void]$Proc.WaitForExit(3000) } catch { }
        return 'forced'
    }

    # One run of "pros terminal": copies every SCOURGE line into the open writer.
    # When Stop is requested it sends Ctrl+C, keeps reading for up to 3 s so the
    # terminal is not blocked on a full pipe while it closes, then ends it if it is still there.
    function Read-ProsTerminal {
        param([string]$ProsExe, [string]$WorkDir, $Writer, $Sync, [string]$ScriptPath)
        $out = @{ StartError = ''; ExitCode = -1; Stderr = ''; Lines = 0; Requested = $false; StopMode = '' }
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
        try { [void]$proc.Start() } catch { $out.StartError = $_.Exception.Message; return $out }
        $id = $proc.Id
        $Sync.Procs[$id] = $proc
        $stderrLines = New-Object 'System.Collections.Generic.Queue[string]'
        $began = Get-Date
        $stopAt = $null
        $graceMs = 0
        try {
            $outTask = $proc.StandardOutput.ReadLineAsync()
            $errTask = $proc.StandardError.ReadLineAsync()
            while ($true) {
                if ($Sync.RecordStop -and ($null -eq $stopAt)) {
                    $out.Requested = $true
                    $sent = Send-ProsCtrlC -TargetPid $id -ScriptPath $ScriptPath
                    $stopAt = Get-Date
                    if ($sent) {
                        $graceMs = 3000
                        Add-SharedLog $Sync 'Recording: sent Ctrl+C to the PROS terminal.'
                    } else {
                        Add-SharedLog $Sync 'Recording: could not send Ctrl+C to the PROS terminal.'
                    }
                }
                if (($null -ne $stopAt) -and (((Get-Date) - $stopAt).TotalMilliseconds -ge $graceMs)) { break }
                # A terminal that has stayed up this long has linked; stop saying we are waiting.
                if (((Get-Date) - $began).TotalSeconds -ge 5) { $Sync.RecordNote = '' }
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
                                $Writer.WriteLine($clean)
                                $Writer.Flush()
                                $out.Lines = $out.Lines + 1
                                $Sync.RecordNote = ''
                                Add-RecordLine $Sync.Rec $clean
                            }
                        }
                        $didRead = $true
                    }
                }
                if ((-not $didRead) -and $proc.HasExited -and ($null -eq $outTask) -and ($null -eq $errTask)) { break }
            }
        } finally {
            if (-not $proc.HasExited) {
                $out.StopMode = 'forced'
                try { $proc.Kill(); [void]$proc.WaitForExit(3000) } catch { }
            } elseif ($out.Requested) {
                $out.StopMode = 'clean'
            }
            try { if ($proc.HasExited) { $out.ExitCode = $proc.ExitCode } } catch { }
            $Sync.Procs.Remove($id)
            try { $proc.Dispose() } catch { }
        }
        $out.Stderr = ($stderrLines.ToArray() -join "`n")
        return $out
    }

    # Records tester and autopath results into a CSV. Retry is for a controller: its
    # terminal can take several seconds to attach while the radio switches channel, and
    # may quit early, so launch again for up to RetrySec while nothing has arrived.
    function Invoke-ProsRecording {
        param([string]$ProsExe, [string]$WorkDir, [string]$FilePath, $Sync, [bool]$Retry = $false, [string]$ScriptPath = '', [int]$RetrySec = 30)
        $writer = $null
        $res = $null
        $attempts = 0
        try {
            $parent = Split-Path $FilePath -Parent
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            $writer = New-Object System.IO.StreamWriter($FilePath, $false, (New-Object System.Text.UTF8Encoding($false)))
            $writer.WriteLine('kind,test,key,value,unit')
            $writer.Flush()
            $started = Get-Date
            while ($true) {
                $attempts++
                $one = Read-ProsTerminal -ProsExe $ProsExe -WorkDir $WorkDir -Writer $writer -Sync $Sync -ScriptPath $ScriptPath
                if ($one.StartError) { return @{ Status = 'error'; Error = $one.StartError } }
                $res = $one
                if (-not $Retry) { break }
                if ($Sync.RecordStop -or $one.Requested -or ($one.Lines -gt 0)) { break }
                if (((Get-Date) - $started).TotalSeconds -ge $RetrySec) { break }
                $Sync.RecordNote = "Waiting for the robot's radio..."
                Add-SharedLog $Sync ('Recording: the PROS terminal ended early, trying again (attempt ' + ($attempts + 1) + ').')
                for ($w = 0; ($w -lt 10) -and (-not $Sync.RecordStop); $w++) { Start-Sleep -Milliseconds 100 }
            }
        } finally {
            Close-RecordState $Sync.Rec
            $Sync.RecordNote = ''
            if ($null -ne $writer) { try { $writer.Close() } catch { } }
        }
        $requestedStop = $res.Requested -or [bool]$Sync.RecordStop
        $stderr = [string]$res.Stderr
        if ((-not $requestedStop) -and ($res.ExitCode -ne 0)) {
            if (-not $stderr) { $stderr = 'pros terminal exited with code ' + $res.ExitCode + '.' }
            return @{ Status = 'error'; ExitCode = $res.ExitCode; Error = $stderr; FilePath = $FilePath; StopMode = $res.StopMode; Attempts = $attempts }
        }
        return @{ Status = 'stopped'; ExitCode = $res.ExitCode; Error = $stderr; FilePath = $FilePath; StopMode = $res.StopMode; Attempts = $attempts }
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
            return @{ Ok = $false; Kind = 'NoBrain'; Message = 'No brain found. Plug USB into the controller, or the brain as a backup, turn the brain on, and close VEXcode. Still failing? Try another cable, since some only charge.'; Detail = '' }
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
    # Returns 'brain', 'controller', 'both' (one brain and one controller), 'multiple', or 'none'.
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
        if ($ports.Count -gt 1) {
            $controllers = @($ports | Where-Object { $_ -match 'Controller' }).Count
            if (($ports.Count -eq 2) -and ($controllers -eq 1)) { return 'both' }
            return 'multiple'
        }
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
        $resultsUrl = ''
        if ($null -ne $m.PSObject.Properties['results_url']) {
            $candidateUrl = [string]$m.results_url
            if ($candidateUrl -match '^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$') { $resultsUrl = $candidateUrl }
        }
        if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { return @{ Status = 'error'; Error = 'The uploader manifest has an invalid version.' } }
        if ($hash -notmatch '^[0-9a-f]{64}$') { return @{ Status = 'error'; Error = 'The uploader manifest has an invalid SHA-256 fingerprint.' } }
        return @{ Status = 'ok'; Version = $version; Sha256 = $hash; ResultsUrl = $resultsUrl }
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

        # Test-mode hot files are optional the same way: older releases do not
        # list them, and a bad one only turns that mode off.
        $modeNames = @('auton-test-hot.package.bin', 'drive-test-hot.package.bin', 'autopath-hot.package.bin')
        $listedModes = @()
        if ($null -ne $rel.Sha256) { $listedModes = @($modeNames | Where-Object { $rel.Sha256.ContainsKey($_) }) }

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
        foreach ($n in $listedModes) {
            # A test-mode copy counts only if it still matches this release's
            # fingerprint; otherwise the whole build downloads again and is checked.
            $p = Get-ReleaseAssetPath -Root $projectDir -AssetName $n
            if (-not (Test-Path $p)) { $haveAll = $false; continue }
            $actual = (Get-FileHash -Path $p -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne ([string]$rel.Sha256[$n]).ToLowerInvariant()) { $haveAll = $false }
        }
        function Write-VersionMetadata {
            param($Release, [string]$DownloadedAt)
            $ver = @{
                tag           = $Release.Tag
                name          = $Release.Name
                notes         = $Release.Notes
                built_at      = $Release.BuiltAt
                downloaded_at = $DownloadedAt
            }
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText((Join-Path $InstallDir 'version.json'), ($ver | ConvertTo-Json), $utf8NoBom)
        }
        if ($haveAll -and ($rel.Tag -eq $InstalledTag)) {
            $downloadedAt = (Get-Date).ToUniversalTime().ToString('o')
            $existingVersionPath = Join-Path $InstallDir 'version.json'
            if (Test-Path $existingVersionPath) {
                try {
                    $existingVersion = [System.IO.File]::ReadAllText($existingVersionPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                    if ($null -ne $existingVersion.PSObject.Properties['downloaded_at']) {
                        $existingDownloadedAt = [string]$existingVersion.downloaded_at
                        if ($existingDownloadedAt) { $downloadedAt = $existingDownloadedAt }
                    }
                } catch { }
            }
            Write-VersionMetadata -Release $rel -DownloadedAt $downloadedAt
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

        foreach ($n in $listedModes) {
            $dest = Get-ReleaseAssetPath -Root $stage -AssetName $n
            try {
                New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
                Invoke-WebRequest -Uri ($ReleasesUrl + '/download/' + $rel.Tag + '/' + $n) -OutFile $dest -UseBasicParsing -TimeoutSec 120
                if ((-not (Test-Path $dest)) -or ((Get-Item $dest).Length -eq 0)) { throw ('Downloaded file ' + $n + ' is empty.') }
                $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actual -ne $rel.Sha256[$n]) { throw ('Download was damaged (' + $n + ' failed its SHA-256 check).') }
            } catch {
                Remove-Item -Path $dest -Force -ErrorAction SilentlyContinue
                Add-SharedLog $Sync ('Test mode download unavailable (' + $n + '): ' + $_.Exception.Message)
            }
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

        Write-VersionMetadata -Release $rel -DownloadedAt ((Get-Date).ToUniversalTime().ToString('o'))
        return @{ Status = 'downloaded'; Release = $rel; TesterAvailable = $testerReady }
    }

    # ------------------------------------------------------------------
    # Route Map: reading recordings and measuring misses. Plain data in,
    # plain data out, so the window, a background thread, and -SelfTest can
    # all use it. Field frame: origin at the field center, inches, +Y away
    # from our station, +X to our right, heading 0 = +Y, clockwise positive.
    # ------------------------------------------------------------------

    # Reads a text file that another program may still be writing to. A plain
    # ReadAllText would fail while Record results has the file open.
    function Read-SharedText {
        param([string]$Path)
        # A results file is a few hundred KB. Anything this big is not one, so do not read it.
        if ((New-Object System.IO.FileInfo($Path)).Length -gt 50MB) { throw 'The file is over 50 MB.' }
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
            try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
        } finally { $fs.Dispose() }
    }

    # Parses the payload of one AP, AM, or AS row. Returns $null when it is not a
    # valid row of that kind. V holds the numbers (the type word's slot stays 0).
    function ConvertFrom-WireRow {
        param([string]$Tag, [string]$Payload)
        $count = 0
        $wordAt = -1
        if ($Tag -eq 'AP') { $count = 9 }
        elseif ($Tag -eq 'AM') { $count = 8; $wordAt = 1 }
        elseif ($Tag -eq 'AS') { $count = 10; $wordAt = 2 }
        else { return $null }
        $p = $Payload.Split(';')
        if ($p.Length -ne $count) { return $null }
        $inv = [System.Globalization.CultureInfo]::InvariantCulture
        $ns = [System.Globalization.NumberStyles]::AllowLeadingSign
        $v = New-Object 'int[]' $count
        $word = ''
        for ($i = 0; $i -lt $count; $i++) {
            if ($i -eq $wordAt) {
                if ($p[$i].Length -eq 0) { return $null }
                $word = $p[$i]
                continue
            }
            $n = 0
            if (-not [int]::TryParse($p[$i], $ns, $inv, [ref]$n)) { return $null }
            $v[$i] = $n
        }
        return @{ V = $v; Word = $word }
    }

    # BEGIN payload: v=1;kind;side;rows;build
    function ConvertFrom-WireBegin {
        param([string]$Payload)
        $p = $Payload.Split(';')
        if ($p.Length -lt 5) { return $null }
        $inv = [System.Globalization.CultureInfo]::InvariantCulture
        $ns = [System.Globalization.NumberStyles]::AllowLeadingSign
        $ver = $p[0].Trim()
        if ($ver.StartsWith('v=', [System.StringComparison]::Ordinal)) { $ver = $ver.Substring(2) }
        $version = 0
        $rows = 0
        if (-not [int]::TryParse($ver, $ns, $inv, [ref]$version)) { return $null }
        if (-not [int]::TryParse($p[3], $ns, $inv, [ref]$rows)) { return $null }
        $side = $p[2].Trim()
        if (($side -cne 'L') -and ($side -cne 'R')) { return $null }
        return @{ Version = $version; Kind = $p[1].Trim(); Side = $side; Expected = $rows; Build = ($p[4..($p.Length - 1)] -join ';') }
    }

    # Closes one open recording: it becomes a session, or a rejection that says why.
    function Complete-WireSession {
        param($Op, $EndRows, $Sessions, $Rejected)
        $got = $Op.Rows.Count
        $expected = [int]$Op.Expected
        $top = $expected
        foreach ($k in $Op.Rows.Keys) { if (($k + 1) -gt $top) { $top = $k + 1 } }
        $missing = New-Object System.Collections.Generic.List[int]
        for ($i = 0; ($i -lt $top) -and ($missing.Count -lt 8); $i++) {
            if (-not $Op.Rows.ContainsKey($i)) { [void]$missing.Add($i) }
        }
        $missingCount = $top - $got
        $fail = ''
        if ($Op.Conflict) { $fail = [string]$Op.Conflict }
        elseif ($Op.Version -ne 1) { $fail = 'unknown wire version ' + $Op.Version + ' (this reader knows version 1).' }
        elseif ($null -eq $EndRows) { $fail = 'no END line (the send was cut off) after ' + $got + ' of ' + $expected + ' rows.' }
        elseif ($EndRows -ne $expected) { $fail = 'BEGIN says ' + $expected + ' rows but END says ' + $EndRows + ' (received ' + $got + ').' }
        elseif ($missingCount -gt 0) { $fail = 'received ' + $got + ' of ' + $expected + ' rows with gaps.' }
        elseif ($got -ne $expected) { $fail = 'received ' + $got + ' rows but BEGIN says ' + $expected + '.' }
        if ($fail) {
            $text = 'Rejected ' + $Op.Kind + ' recording: ' + $fail
            if ($missing.Count -gt 0) {
                $text += ' Missing row numbers: ' + ($missing.ToArray() -join ', ')
                if ($missingCount -gt $missing.Count) { $text += ' and ' + ($missingCount - $missing.Count) + ' more' }
                $text += '.'
            }
            [void]$Rejected.Add(@{ Kind = $Op.Kind; Reason = $fail; Got = $got; Expected = $expected; MissingCount = $missingCount; Missing = $missing.ToArray(); Text = $text; Source = '' })
            return
        }
        $t = New-Object 'System.Collections.Generic.List[double]'
        $xs = New-Object 'System.Collections.Generic.List[double]'
        $ys = New-Object 'System.Collections.Generic.List[double]'
        $hs = New-Object 'System.Collections.Generic.List[double]'
        $marks = New-Object System.Collections.ArrayList
        $events = New-Object System.Collections.ArrayList
        $sb = New-Object System.Text.StringBuilder
        for ($i = 0; $i -lt $expected; $i++) {
            $r = $Op.Rows[$i]
            $v = $r.Row.V
            [void]$sb.Append($r.Tag).Append('|').Append($r.Payload).Append("`n")
            # Values on the wire are hundredths (x, y, heading) and milliseconds.
            if ($r.Tag -eq 'AP') {
                $t.Add($v[0] / 1000.0); $xs.Add($v[1] / 100.0); $ys.Add($v[2] / 100.0); $hs.Add($v[3] / 100.0)
            } elseif ($r.Tag -eq 'AM') {
                [void]$marks.Add(@{ T = $v[0] / 1000.0; Type = $r.Row.Word; X = $v[2] / 100.0; Y = $v[3] / 100.0; H = $v[4] / 100.0; Lift = $v[5]; Tilt = $v[6]; Claw = $v[7] })
            } else {
                [void]$events.Add(@{ T = $v[0] / 1000.0; Step = $v[1]; Type = $r.Row.Word; Tx = $v[3] / 100.0; Ty = $v[4] / 100.0; Th = $v[5] / 100.0; X = $v[6] / 100.0; Y = $v[7] / 100.0; H = $v[8] / 100.0; Ok = $v[9] })
            }
        }
        $tArr = $t.ToArray(); $xArr = $xs.ToArray(); $yArr = $ys.ToArray(); $hArr = $hs.ToArray()
        # Samples are drawn as a line, so they must be in time order. They nearly always are.
        $n = $tArr.Length
        $inOrder = $true
        for ($i = 1; $i -lt $n; $i++) { if ($tArr[$i] -lt $tArr[$i - 1]) { $inOrder = $false; break } }
        if (-not $inOrder) {
            $keys = [double[]]$tArr.Clone()
            $idx = New-Object 'int[]' $n
            for ($i = 0; $i -lt $n; $i++) { $idx[$i] = $i }
            [Array]::Sort([Array]$keys, [Array]$idx)
            $nx = New-Object 'double[]' $n; $ny = New-Object 'double[]' $n; $nh = New-Object 'double[]' $n
            for ($i = 0; $i -lt $n; $i++) { $nx[$i] = $xArr[$idx[$i]]; $ny[$i] = $yArr[$idx[$i]]; $nh[$i] = $hArr[$idx[$i]] }
            $tArr = $keys; $xArr = $nx; $yArr = $ny; $hArr = $nh
        }
        $markArr = @($marks.ToArray())
        $eventArr = @($events.ToArray())
        $markSorted = $true
        for ($i = 1; $i -lt $markArr.Count; $i++) { if ($markArr[$i].T -lt $markArr[$i - 1].T) { $markSorted = $false } }
        if (-not $markSorted) { $markArr = @($markArr | Sort-Object -Property T) }
        $eventSorted = $true
        for ($i = 1; $i -lt $eventArr.Count; $i++) { if ($eventArr[$i].T -lt $eventArr[$i - 1].T) { $eventSorted = $false } }
        if (-not $eventSorted) { $eventArr = @($eventArr | Sort-Object -Property T) }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Op.Kind + '|' + $Op.Side + '|' + $sb.ToString())))).Replace('-', '')
        } finally { $sha.Dispose() }
        [void]$Sessions.Add(@{
            Kind = $Op.Kind; Side = $Op.Side; WasSide = $Op.Side; Rows = $expected; Build = $Op.Build
            Fingerprint = $hash; T = $tArr; X = $xArr; Y = $yArr; H = $hArr
            Marks = $markArr; Events = $eventArr; Source = ''; When = ''; Order = ''
        })
    }

    # Reads recording text (a results file, or anything with SCOURGE lines in it).
    # Text before "SCOURGE," on a line is dropped. A recording counts only when it
    # has BEGIN, every row number from 0 with no gap, and a matching END. A repeat
    # of a whole recording is kept once (the last copy). Returns
    # @{ Sessions = complete recordings as sent; Rejected = why the others failed }.
    function ConvertFrom-ScourgeWire {
        param([string]$Text)
        $inv = [System.Globalization.CultureInfo]::InvariantCulture
        $ns = [System.Globalization.NumberStyles]::AllowLeadingSign
        $sessions = New-Object System.Collections.ArrayList
        $rejected = New-Object System.Collections.ArrayList
        $orphans = 0
        $op = $null
        foreach ($raw in ($Text -split '[\r\n]+')) {
            $line = $raw
            if ($line.IndexOf([char]27) -ge 0) { $line = [regex]::Replace($line, '\x1b\[[0-9;?]*[ -/]*[@-~]', '') }
            $at = $line.IndexOf('SCOURGE,', [System.StringComparison]::Ordinal)
            if ($at -lt 0) { continue }
            if ($at -gt 0) { $line = $line.Substring($at) }
            $pieces = @($line)
            if ($line.IndexOf('SCOURGE,', 1, [System.StringComparison]::Ordinal) -ge 0) { $pieces = [regex]::Split($line, '(?=SCOURGE,)') }
            foreach ($rawPiece in $pieces) {
                $piece = $rawPiece.Trim()
                if (-not $piece.StartsWith('SCOURGE,', [System.StringComparison]::Ordinal)) { continue }
                $f = $piece.Split(',')
                # A real record ends with a comma, so its last field is empty. A line
                # that got cut short loses that comma, which is how it is caught.
                if (($f.Length -ne 5) -or ($f[4].Length -ne 0)) { continue }
                $tag = $f[1]
                if (($tag -eq 'BEGIN') -and ($f[2] -eq 'autopath')) {
                    $b = ConvertFrom-WireBegin $f[3]
                    if ($null -eq $b) { continue }
                    if ($null -ne $op) { Complete-WireSession $op $null $sessions $rejected }
                    $op = @{
                        Expected = $b.Expected; Kind = $b.Kind; Side = $b.Side; Build = $b.Build; Version = $b.Version
                        Rows = (New-Object 'System.Collections.Generic.Dictionary[int,object]'); Conflict = $null
                    }
                } elseif (($tag -eq 'END') -and ($f[2] -eq 'autopath')) {
                    $endRows = 0
                    if (-not [int]::TryParse($f[3], $ns, $inv, [ref]$endRows)) { continue }
                    if ($null -eq $op) { $orphans++; continue }
                    Complete-WireSession $op $endRows $sessions $rejected
                    $op = $null
                } elseif (($tag -eq 'AP') -or ($tag -eq 'AM') -or ($tag -eq 'AS')) {
                    $seq = 0
                    if (-not [int]::TryParse($f[2], $ns, $inv, [ref]$seq)) { continue }
                    if ($seq -lt 0) { continue }
                    $row = ConvertFrom-WireRow $tag $f[3]
                    if ($null -eq $row) { continue }
                    if ($null -eq $op) { $orphans++; continue }
                    if ($op.Rows.ContainsKey($seq)) {
                        $old = $op.Rows[$seq]
                        if (($old.Tag -ne $tag) -or ($old.Payload -ne $f[3])) { $op.Conflict = 'row ' + $seq + ' arrived twice with different contents.' }
                        continue
                    }
                    $op.Rows[$seq] = @{ Tag = $tag; Payload = $f[3]; Row = $row }
                }
            }
        }
        if ($null -ne $op) { Complete-WireSession $op $null $sessions $rejected }
        if ($orphans -gt 0) {
            [void]$rejected.Add(@{ Kind = '?'; Reason = 'rows with no BEGIN before them'; Got = $orphans; Expected = 0; MissingCount = 0; Missing = @(); Text = 'Some rows had no BEGIN line before them (the capture started in the middle of a send).'; Source = '' })
        }
        $unique = New-Object System.Collections.Specialized.OrderedDictionary
        foreach ($s in $sessions) {
            if ($unique.Contains($s.Fingerprint)) { $unique.Remove($s.Fingerprint) }
            $unique.Add($s.Fingerprint, $s)
        }
        $kept = New-Object System.Collections.ArrayList
        foreach ($s in $unique.Values) { [void]$kept.Add($s) }
        return @{ Sessions = @($kept.ToArray()); Rejected = @($rejected.ToArray()) }
    }

    # A recording made on the RIGHT side is shown in the LEFT frame (the field is
    # symmetric about the line y = -x): (x, y) -> (-y, -x), heading -> 270 - heading.
    # "0.0 - y" instead of "-y" so zero stays zero and never prints as -0.
    function ConvertTo-LeftFrame {
        param($S)
        if ($S.Side -ne 'R') { return $S }
        $out = Get-MirroredSession $S
        $out.Side = 'L'
        $out.WasSide = 'R'
        return $out
    }

    # The same recording reflected across the line y = -x, whatever side it is on.
    # The reflection undoes itself, so mirroring twice gives the original back.
    function Get-MirroredSession {
        param($S)
        $n = $S.X.Length
        $nx = New-Object 'double[]' $n; $ny = New-Object 'double[]' $n; $nh = New-Object 'double[]' $n
        for ($i = 0; $i -lt $n; $i++) {
            $nx[$i] = 0.0 - $S.Y[$i]
            $ny[$i] = 0.0 - $S.X[$i]
            $nh[$i] = 270.0 - $S.H[$i]
        }
        $out = @{}
        foreach ($k in $S.Keys) { $out[$k] = $S[$k] }
        $out.X = $nx; $out.Y = $ny; $out.H = $nh
        $marks = New-Object System.Collections.ArrayList
        foreach ($m in $S.Marks) {
            $c = @{}
            foreach ($k in $m.Keys) { $c[$k] = $m[$k] }
            $c.X = 0.0 - $m.Y; $c.Y = 0.0 - $m.X; $c.H = 270.0 - $m.H
            [void]$marks.Add($c)
        }
        $events = New-Object System.Collections.ArrayList
        foreach ($e in $S.Events) {
            $c = @{}
            foreach ($k in $e.Keys) { $c[$k] = $e[$k] }
            $c.Tx = 0.0 - $e.Ty; $c.Ty = 0.0 - $e.Tx; $c.Th = 270.0 - $e.Th
            $c.X = 0.0 - $e.Y; $c.Y = 0.0 - $e.X; $c.H = 270.0 - $e.H
            [void]$events.Add($c)
        }
        $out.Marks = @($marks.ToArray())
        $out.Events = @($events.ToArray())
        return $out
    }

    # Which numbers a step's AS row can be judged on. Same rule as the desktop
    # report tool: drives and grabs and drops have a target spot, turns and grabs
    # and drops have a target heading, the opening and toggles have neither.
    function Get-StepTargets {
        param([string]$Type)
        if (($Type -eq 'drive') -or ($Type -eq 'grab_stack') -or ($Type -eq 'grab_pin') -or ($Type -eq 'drop')) {
            return @{ Pos = $true; Head = ($Type -ne 'drive') }
        }
        if ($Type -eq 'turn') { return @{ Pos = $false; Head = $true } }
        return @{ Pos = $false; Head = $false }
    }

    # Under 1 in is good, under 3 in is close, anything more is a miss.
    function Get-MissBand {
        param($Miss)
        if ($null -eq $Miss) { return 'none' }
        if ($Miss -lt 1.0) { return 'good' }
        if ($Miss -lt 3.0) { return 'warn' }
        return 'bad'
    }

    # One row per AS step event: how far the robot ended from where the step aimed.
    # Miss = straight-line inches between target spot and final spot (null when the
    # step has no target spot). HMiss = heading error in degrees, 0 to 180.
    function Get-MissRows {
        param($S)
        $rows = New-Object System.Collections.ArrayList
        foreach ($e in $S.Events) {
            $want = Get-StepTargets ([string]$e.Type)
            $miss = $null
            $hmiss = $null
            if ($want.Pos) {
                $dx = $e.X - $e.Tx
                $dy = $e.Y - $e.Ty
                $miss = [math]::Sqrt($dx * $dx + $dy * $dy)
            }
            if ($want.Head) {
                $d = ($e.H - $e.Th) % 360.0
                if ($d -gt 180.0) { $d -= 360.0 } elseif ($d -le -180.0) { $d += 360.0 }
                $hmiss = [math]::Abs($d)
            }
            [void]$rows.Add(@{ Step = $e.Step; Type = [string]$e.Type; Ok = $e.Ok; Miss = $miss; HMiss = $hmiss; Band = (Get-MissBand $miss) })
        }
        return $rows.ToArray()
    }

    function Get-KindLabel {
        param([string]$Kind, [string]$Side = 'L')
        $label = $Kind
        if ($Kind -eq 'teach_open') { $label = 'Teach after open' }
        elseif ($Kind -eq 'teach_start') { $label = 'Teach from start' }
        elseif ($Kind -eq 'push') { $label = 'Push test' }
        elseif ($Kind -eq 'run') { $label = 'Run' }
        if ($Side -eq 'R') { $label += ' (R)' }
        return $label
    }

    # "2026-10-30 10:15" to "Oct 30, 10:15 AM".
    function Format-MapWhen {
        param([string]$When)
        $inv = [System.Globalization.CultureInfo]::InvariantCulture
        try { return [datetime]::ParseExact($When, 'yyyy-MM-dd HH:mm', $inv).ToString('MMM d, h:mm tt', $inv) } catch { return $When }
    }

    function Get-FileWhen {
        param($File)
        $inv = [System.Globalization.CultureInfo]::InvariantCulture
        $m = [regex]::Match($File.Name, '^results-(\d{8})-(\d{6})')
        if ($m.Success) {
            try { return [datetime]::ParseExact($m.Groups[1].Value + $m.Groups[2].Value, 'yyyyMMddHHmmss', $inv).ToString('yyyy-MM-dd HH:mm', $inv) } catch { }
        }
        return $File.LastWriteTime.ToString('yyyy-MM-dd HH:mm', $inv)
    }

    # The box around everything a recording touched, or $null if it has no points.
    function Get-SessionBounds {
        param($S)
        $minX = [double]::MaxValue; $minY = [double]::MaxValue
        $maxX = [double]::MinValue; $maxY = [double]::MinValue
        $any = $false
        $n = $S.X.Length
        for ($i = 0; $i -lt $n; $i++) {
            $any = $true
            if ($S.X[$i] -lt $minX) { $minX = $S.X[$i] }
            if ($S.X[$i] -gt $maxX) { $maxX = $S.X[$i] }
            if ($S.Y[$i] -lt $minY) { $minY = $S.Y[$i] }
            if ($S.Y[$i] -gt $maxY) { $maxY = $S.Y[$i] }
        }
        $pts = New-Object System.Collections.ArrayList
        foreach ($m in $S.Marks) { [void]$pts.Add(@($m.X, $m.Y)) }
        foreach ($e in $S.Events) {
            [void]$pts.Add(@($e.X, $e.Y))
            if ((Get-StepTargets ([string]$e.Type)).Pos) { [void]$pts.Add(@($e.Tx, $e.Ty)) }
        }
        foreach ($p in $pts) {
            $any = $true
            if ($p[0] -lt $minX) { $minX = $p[0] }
            if ($p[0] -gt $maxX) { $maxX = $p[0] }
            if ($p[1] -lt $minY) { $minY = $p[1] }
            if ($p[1] -gt $maxY) { $maxY = $p[1] }
        }
        if (-not $any) { return $null }
        return @{ MinX = $minX; MaxX = $maxX; MinY = $minY; MaxY = $maxY }
    }

    # Picks how many screen pixels one inch gets, and which field point sits in
    # the middle of the drawing area. Whole field: the full wall-to-wall square.
    # Fit to path: the path's box, at least MinSpan inches across (so a short path
    # does not zoom in absurdly) plus Margin inches on every side.
    function Get-MapViewport {
        param([double]$Width, [double]$Height, [double]$Pad, [bool]$Whole, $Bounds, [double]$Wall = 70.1, [double]$MinSpan = 36.0, [double]$Margin = 12.0)
        $cx = 0.0; $cy = 0.0
        $spanW = 2.0 * $Wall; $spanH = 2.0 * $Wall
        if ((-not $Whole) -and ($null -ne $Bounds)) {
            $spanW = [math]::Max($Bounds.MaxX - $Bounds.MinX, $MinSpan) + 2.0 * $Margin
            $spanH = [math]::Max($Bounds.MaxY - $Bounds.MinY, $MinSpan) + 2.0 * $Margin
            $cx = ($Bounds.MinX + $Bounds.MaxX) / 2.0
            $cy = ($Bounds.MinY + $Bounds.MaxY) / 2.0
        }
        $scale = [math]::Min(($Width - 2.0 * $Pad) / $spanW, ($Height - 2.0 * $Pad) / $spanH)
        if ($scale -lt 0.01) { $scale = 0.01 }
        return @{ Scale = $scale; Cx = $cx; Cy = $cy }
    }

    # Reads every results-*.csv in a folder. Sessions come back in file-name order
    # (the names carry the date), already in the LEFT frame. A recording sent twice,
    # even in two files, appears once. Skip = files to leave alone (the one being
    # recorded right now). Cache (optional hashtable) remembers files that did not
    # change, so reopening the tab does not read them again.
    function Read-ScourgeResults {
        param([string]$Folder, [string[]]$Skip = @(), $Cache = $null)
        $result = @{ Status = 'ok'; Sessions = @(); Rejected = @(); Files = 0; Unreadable = 0; Error = '' }
        if ((-not $Folder) -or (-not (Test-Path -LiteralPath $Folder))) { return $result }
        $files = @()
        try {
            $files = @(Get-ChildItem -LiteralPath $Folder -Filter 'results-*.csv' -File -ErrorAction Stop | Sort-Object -Property Name)
        } catch {
            $result.Status = 'error'
            $result.Error = 'Could not read the results folder: ' + $_.Exception.Message
            return $result
        }
        $unique = New-Object System.Collections.Specialized.OrderedDictionary
        $allRejected = New-Object System.Collections.ArrayList
        foreach ($file in $files) {
            $skipThis = $false
            foreach ($s in $Skip) { if ($s -and ($s -ieq $file.FullName)) { $skipThis = $true } }
            if ($skipThis) { continue }
            $result.Files++
            if ($file.Length -gt 50MB) {
                $result.Unreadable++
                [void]$allRejected.Add(@{ Kind = '?'; Reason = 'file over 50 MB'; Got = 0; Expected = 0; MissingCount = 0; Missing = @(); Text = ($file.Name + ': skipped, the file is over 50 MB.'); Source = $file.Name })
                continue
            }
            $stamp = [string]$file.Length + '|' + [string]$file.LastWriteTimeUtc.Ticks
            $entry = $null
            if (($null -ne $Cache) -and $Cache.ContainsKey($file.FullName) -and ($Cache[$file.FullName].Stamp -eq $stamp)) { $entry = $Cache[$file.FullName] }
            if ($null -eq $entry) {
                $text = ''
                try { $text = Read-SharedText $file.FullName } catch {
                    $result.Unreadable++
                    [void]$allRejected.Add(@{ Kind = '?'; Reason = 'unreadable'; Got = 0; Expected = 0; MissingCount = 0; Missing = @(); Text = ($file.Name + ': could not be read.'); Source = $file.Name })
                    continue
                }
                $parsed = ConvertFrom-ScourgeWire $text
                $when = Get-FileWhen $file
                $mine = New-Object System.Collections.ArrayList
                $k = 0
                foreach ($s in $parsed.Sessions) {
                    $left = ConvertTo-LeftFrame $s
                    $left.Source = $file.Name
                    $left.When = $when
                    $left.Order = $file.Name + '#' + $k.ToString('000')
                    $k++
                    [void]$mine.Add($left)
                }
                foreach ($r in $parsed.Rejected) {
                    $r.Source = $file.Name
                    $r.Text = $file.Name + ': ' + $r.Text
                }
                $entry = @{ Stamp = $stamp; Sessions = @($mine.ToArray()); Rejected = @($parsed.Rejected) }
                if ($null -ne $Cache) { $Cache[$file.FullName] = $entry }
            }
            foreach ($s in $entry.Sessions) {
                if ($unique.Contains($s.Fingerprint)) { $unique.Remove($s.Fingerprint) }
                $unique.Add($s.Fingerprint, $s)
            }
            foreach ($r in $entry.Rejected) { [void]$allRejected.Add($r) }
        }
        $kept = New-Object System.Collections.ArrayList
        foreach ($s in $unique.Values) { [void]$kept.Add($s) }
        # A rejected copy is not worth a warning once the same recording arrived
        # complete in that file or a later one.
        $shown = New-Object System.Collections.ArrayList
        foreach ($r in $allRejected) {
            $replaced = $false
            foreach ($s in $kept) {
                if (($s.Kind -eq $r.Kind) -and ($s.Rows -eq $r.Expected) -and ([string]::CompareOrdinal([string]$s.Source, [string]$r.Source) -ge 0)) { $replaced = $true }
            }
            if (-not $replaced) { [void]$shown.Add($r) }
        }
        $result.Sessions = @($kept.ToArray())
        $result.Rejected = @($shown.ToArray())
        return $result
    }

    # ------------------------------------------------------------------
    # Route Map cloud data: what GET <relay>/map answers. "sim" is the predicted
    # route of one build, one entry per routine and side, all in the LEFT frame
    # (the Right entry has the same samples as the Left one). "recorded" is the programmer's hand recordings: routes (cleaned
    # waypoints) and sessions (raw samples, already in the LEFT frame). Times
    # are milliseconds. Parsed with JavaScriptSerializer because
    # ConvertFrom-Json on Windows PowerShell 5.1 refuses large documents.
    # ------------------------------------------------------------------

    # A value from a parsed JSON object, or $null. The comma keeps an array in one piece.
    function Get-JsonValue {
        param($Obj, [string]$Name)
        # ContainsKey exists on both a Hashtable and the Dictionary the serializer returns (whose Contains is hidden).
        if (($Obj -is [System.Collections.IDictionary]) -and $Obj.ContainsKey($Name)) { return ,$Obj[$Name] }
        return $null
    }

    function Get-JsonNumber {
        param($V, [double]$Default = 0.0)
        if (($null -eq $V) -or ($V -is [bool])) { return $Default }
        try { return [double]$V } catch { return $Default }
    }

    # Points with t, x, y, h as parallel arrays. Scale turns the time into seconds.
    # Points missing t, x, or y are skipped. Out-of-order times are put in order.
    function ConvertFrom-CloudSamples {
        param($List, [double]$Scale)
        $t = New-Object 'System.Collections.Generic.List[double]'
        $xs = New-Object 'System.Collections.Generic.List[double]'
        $ys = New-Object 'System.Collections.Generic.List[double]'
        $hs = New-Object 'System.Collections.Generic.List[double]'
        if ($List -is [System.Collections.IList]) {
            foreach ($p in $List) {
                if (-not ($p -is [System.Collections.IDictionary])) { continue }
                $pt = Get-JsonValue $p 't'
                $px = Get-JsonValue $p 'x'
                $py = Get-JsonValue $p 'y'
                if (($null -eq $pt) -or ($null -eq $px) -or ($null -eq $py)) { continue }
                $t.Add((Get-JsonNumber $pt) * $Scale)
                $xs.Add((Get-JsonNumber $px))
                $ys.Add((Get-JsonNumber $py))
                $hs.Add((Get-JsonNumber (Get-JsonValue $p 'h')))
            }
        }
        $tArr = $t.ToArray(); $xArr = $xs.ToArray(); $yArr = $ys.ToArray(); $hArr = $hs.ToArray()
        $n = $tArr.Length
        $inOrder = $true
        for ($i = 1; $i -lt $n; $i++) { if ($tArr[$i] -lt $tArr[$i - 1]) { $inOrder = $false; break } }
        if (-not $inOrder) {
            $keys = [double[]]$tArr.Clone()
            $idx = New-Object 'int[]' $n
            for ($i = 0; $i -lt $n; $i++) { $idx[$i] = $i }
            [Array]::Sort([Array]$keys, [Array]$idx)
            $nx = New-Object 'double[]' $n; $ny = New-Object 'double[]' $n; $nh = New-Object 'double[]' $n
            for ($i = 0; $i -lt $n; $i++) { $nx[$i] = $xArr[$idx[$i]]; $ny[$i] = $yArr[$idx[$i]]; $nh[$i] = $hArr[$idx[$i]] }
            $tArr = $keys; $xArr = $nx; $yArr = $ny; $hArr = $nh
        }
        return @{ T = $tArr; X = $xArr; Y = $yArr; H = $hArr }
    }

    # Seconds per time unit: the file says "s" or "ms", otherwise a session whose
    # times reach 1000 or more is taken to be milliseconds.
    function Get-CloudTimeScale {
        param($Sess, [string]$Unit)
        if ($Unit -eq 's') { return 1.0 }
        if ($Unit -eq 'ms') { return 0.001 }
        $mx = 0.0
        foreach ($k in @('samples', 'marks', 'events')) {
            $l = Get-JsonValue $Sess $k
            if ($l -is [System.Collections.IList]) {
                foreach ($o in $l) {
                    $tv = Get-JsonValue $o 't'
                    if ($null -ne $tv) { $a = [math]::Abs((Get-JsonNumber $tv)); if ($a -gt $mx) { $mx = $a } }
                }
            }
        }
        if ($mx -ge 1000.0) { return 0.001 }
        return 1.0
    }

    # One recorded session in the same shape Read-ScourgeResults gives (LEFT frame),
    # marked Source = 'cloud'. WasSide is the side it was recorded on.
    function ConvertFrom-CloudSession {
        param($Sess, [string]$Unit, [string]$Id)
        $scale = Get-CloudTimeScale $Sess $Unit
        $pts = ConvertFrom-CloudSamples (Get-JsonValue $Sess 'samples') $scale
        $marks = New-Object System.Collections.ArrayList
        $ml = Get-JsonValue $Sess 'marks'
        if ($ml -is [System.Collections.IList]) {
            foreach ($m in $ml) {
                if (-not ($m -is [System.Collections.IDictionary])) { continue }
                $mt = Get-JsonValue $m 't'
                if ($null -eq $mt) { continue }
                [void]$marks.Add(@{
                    T = (Get-JsonNumber $mt) * $scale; Type = [string](Get-JsonValue $m 'type')
                    X = (Get-JsonNumber (Get-JsonValue $m 'x')); Y = (Get-JsonNumber (Get-JsonValue $m 'y')); H = (Get-JsonNumber (Get-JsonValue $m 'h'))
                    Lift = [int](Get-JsonNumber (Get-JsonValue $m 'lift')); Tilt = 0; Claw = 0
                })
            }
        }
        $events = New-Object System.Collections.ArrayList
        $el = Get-JsonValue $Sess 'events'
        if ($el -is [System.Collections.IList]) {
            foreach ($e in $el) {
                if (-not ($e -is [System.Collections.IDictionary])) { continue }
                $et = Get-JsonValue $e 't'
                if ($null -eq $et) { continue }
                $step = -1
                $sv = Get-JsonValue $e 'step'
                if ($null -ne $sv) { $step = [int](Get-JsonNumber $sv (-1.0)) }
                # ok may be true/false or 1/0; a missing value counts as fine.
                $ok = 1
                $ov = Get-JsonValue $e 'ok'
                if (($null -ne $ov) -and ((Get-JsonNumber $ov 1.0) -eq 0.0) -and (-not ($ov -is [bool]))) { $ok = 0 }
                if (($ov -is [bool]) -and (-not $ov)) { $ok = 0 }
                [void]$events.Add(@{
                    T = (Get-JsonNumber $et) * $scale; Step = $step; Type = [string](Get-JsonValue $e 'type')
                    Tx = (Get-JsonNumber (Get-JsonValue $e 'tx')); Ty = (Get-JsonNumber (Get-JsonValue $e 'ty')); Th = (Get-JsonNumber (Get-JsonValue $e 'th'))
                    X = (Get-JsonNumber (Get-JsonValue $e 'x')); Y = (Get-JsonNumber (Get-JsonValue $e 'y')); H = (Get-JsonNumber (Get-JsonValue $e 'h'))
                    Ok = $ok
                })
            }
        }
        $markArr = @($marks.ToArray())
        $eventArr = @($events.ToArray())
        $sorted = $true
        for ($i = 1; $i -lt $markArr.Count; $i++) { if ($markArr[$i].T -lt $markArr[$i - 1].T) { $sorted = $false } }
        if (-not $sorted) { $markArr = @($markArr | Sort-Object -Property T) }
        $sorted = $true
        for ($i = 1; $i -lt $eventArr.Count; $i++) { if ($eventArr[$i].T -lt $eventArr[$i - 1].T) { $sorted = $false } }
        if (-not $sorted) { $eventArr = @($eventArr | Sort-Object -Property T) }
        $side = 'L'
        if ([string](Get-JsonValue $Sess 'side') -ceq 'R') { $side = 'R' }
        $slot = ''
        $slotV = Get-JsonValue $Sess 'for_slot'
        if ($null -ne $slotV) { $slot = ([string]$slotV).Trim() }
        return @{
            Kind = [string](Get-JsonValue $Sess 'kind'); Side = 'L'; WasSide = $side
            Rows = ($pts.T.Length + $markArr.Count + $eventArr.Count); Build = [string](Get-JsonValue $Sess 'build')
            Fingerprint = ('cloud|' + $Id + '|' + $side)
            T = $pts.T; X = $pts.X; Y = $pts.Y; H = $pts.H
            Marks = $markArr; Events = $eventArr
            Source = 'cloud'; When = [string](Get-JsonValue $Sess 'when'); Order = ('cloud#' + $Id); ForSlot = $slot
        }
    }

    # Turns the text of a GET /map answer into plain data.
    # Returns @{ Status = 'ok'; Sim; SimIsLatest; Recorded; RecordedUpdated; Note } or
    # @{ Status = 'error'; Error }. Sim and Recorded are $null when the service had none.
    #   Sim      = @{ Tag; Build; Routes = @( @{ Key; Side; Id; TotalMs; T; X; Y; H; Marks; Events } ) }
    #              Key is the route slot ('A') or 'AWP' for the built-in routine.
    #   Recorded = @{ Routes = @( @{ Slot; HasStart; StartX; StartY; Wp = @( @{ X; Y; H; Step } ) } ); Sessions }
    function ConvertFrom-CloudMap {
        param([string]$Text)
        $root = $null
        try {
            Add-Type -AssemblyName System.Web.Extensions
            $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
            $ser.MaxJsonLength = [int]::MaxValue
            $ser.RecursionLimit = 200
            $root = $ser.DeserializeObject($Text)
        } catch { return @{ Status = 'error'; Error = 'The route data was not valid JSON.' } }
        if (-not ($root -is [System.Collections.IDictionary])) { return @{ Status = 'error'; Error = 'The route data was not an object.' } }
        $okV = Get-JsonValue $root 'ok'
        if (($okV -isnot [bool]) -or (-not $okV)) { return @{ Status = 'error'; Error = 'The service did not return route data.' } }
        try {
            $simOut = $null
            $sim = Get-JsonValue $root 'sim'
            if ($sim -is [System.Collections.IDictionary]) {
                $routes = New-Object System.Collections.ArrayList
                $rl = Get-JsonValue $sim 'routes'
                if ($rl -is [System.Collections.IList]) {
                    foreach ($r in $rl) {
                        if (-not ($r -is [System.Collections.IDictionary])) { continue }
                        $side = [string](Get-JsonValue $r 'side')
                        if (($side -cne 'L') -and ($side -cne 'R')) { continue }
                        $key = 'AWP'
                        $slotV = Get-JsonValue $r 'slot'
                        if (($null -ne $slotV) -and ([string]$slotV).Trim()) { $key = ([string]$slotV).Trim() }
                        $pts = ConvertFrom-CloudSamples (Get-JsonValue $r 'samples') 0.001
                        [void]$routes.Add(@{
                            Key = $key; Side = $side; Id = [string](Get-JsonValue $r 'id'); TotalMs = (Get-JsonNumber (Get-JsonValue $r 'total_ms'))
                            T = $pts.T; X = $pts.X; Y = $pts.Y; H = $pts.H; Marks = @(); Events = @()
                        })
                    }
                }
                $simOut = @{
                    Tag = [string](Get-JsonValue $sim 'tag'); Build = [int](Get-JsonNumber (Get-JsonValue $sim 'build'))
                    Routes = @($routes.ToArray())
                }
            }
            $recOut = $null
            $rec = Get-JsonValue $root 'recorded'
            if ($rec -is [System.Collections.IDictionary]) {
                $unit = [string](Get-JsonValue $rec 'time_unit')
                $routes = New-Object System.Collections.ArrayList
                $rl = Get-JsonValue $rec 'routes'
                if ($rl -is [System.Collections.IList]) {
                    foreach ($r in $rl) {
                        if (-not ($r -is [System.Collections.IDictionary])) { continue }
                        $slot = ''
                        $slotV = Get-JsonValue $r 'slot'
                        if ($null -ne $slotV) { $slot = ([string]$slotV).Trim() }
                        if (-not $slot) { continue }
                        $wps = New-Object System.Collections.ArrayList
                        $wl = Get-JsonValue $r 'waypoints'
                        if ($wl -is [System.Collections.IList]) {
                            foreach ($w in $wl) {
                                $wx = Get-JsonValue $w 'x'
                                $wy = Get-JsonValue $w 'y'
                                if (($null -eq $wx) -or ($null -eq $wy)) { continue }
                                [void]$wps.Add(@{ X = (Get-JsonNumber $wx); Y = (Get-JsonNumber $wy); H = (Get-JsonNumber (Get-JsonValue $w 'heading')); Step = [int](Get-JsonNumber (Get-JsonValue $w 'step') (-1.0)) })
                            }
                        }
                        $hasStart = $false; $sx = 0.0; $sy = 0.0
                        $st = Get-JsonValue $r 'start'
                        if (($st -is [System.Collections.IDictionary]) -and ([string](Get-JsonValue $st 'kind') -eq 'pose') -and ($null -ne (Get-JsonValue $st 'x')) -and ($null -ne (Get-JsonValue $st 'y'))) {
                            $hasStart = $true; $sx = Get-JsonNumber (Get-JsonValue $st 'x'); $sy = Get-JsonNumber (Get-JsonValue $st 'y')
                        }
                        [void]$routes.Add(@{ Slot = $slot; HasStart = $hasStart; StartX = $sx; StartY = $sy; Wp = @($wps.ToArray()) })
                    }
                }
                $sessions = New-Object System.Collections.ArrayList
                $sl = Get-JsonValue $rec 'sessions'
                if ($sl -is [System.Collections.IList]) {
                    $seen = @{}
                    $k = 0
                    foreach ($sess in $sl) {
                        $k++
                        if (-not ($sess -is [System.Collections.IDictionary])) { continue }
                        $id = [string](Get-JsonValue $sess 'id')
                        if (-not $id) { $id = 'session-' + $k }
                        if ($seen.ContainsKey($id)) { $seen[$id] = $seen[$id] + 1; $id = $id + '-' + $seen[$id] } else { $seen[$id] = 1 }
                        [void]$sessions.Add((ConvertFrom-CloudSession $sess $unit $id))
                    }
                }
                $recOut = @{ Routes = @($routes.ToArray()); Sessions = @($sessions.ToArray()) }
            }
            $note = ''
            if ($rec -is [System.Collections.IDictionary]) { $note = [string](Get-JsonValue $rec 'note') }
            $latest = $false
            $latestV = Get-JsonValue $root 'sim_is_latest'
            if (($latestV -is [bool]) -and $latestV) { $latest = $true }
            return @{
                Status = 'ok'; Sim = $simOut; SimIsLatest = $latest; Recorded = $recOut
                RecordedUpdated = [string](Get-JsonValue $root 'recorded_updated'); Note = $note
            }
        } catch {
            return @{ Status = 'error'; Error = ('The route data had an unexpected shape: ' + $_.Exception.Message) }
        }
    }

    # Cache file: the answer exactly as received, written whole and then moved into place.
    function Write-CloudCache {
        param([string]$Path, [string]$Text)
        $dir = Split-Path $Path -Parent
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $tmp = $Path + '.tmp'
        [System.IO.File]::WriteAllText($tmp, $Text, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    }

    function Read-CloudCache {
        param([string]$Path)
        if ((-not $Path) -or (-not (Test-Path -LiteralPath $Path))) { return @{ Status = 'none' } }
        $text = ''
        try { $text = Read-SharedText $Path } catch { return @{ Status = 'none' } }
        $parsed = ConvertFrom-CloudMap $text
        if ($parsed.Status -ne 'ok') { return @{ Status = 'none' } }
        return @{ Status = 'ok'; Data = $parsed; Fetched = (Get-Item -LiteralPath $Path).LastWriteTimeUtc.ToString('o') }
    }

    # Asks the relay for the map. The team code goes only in the X-Team-Code header of
    # this one request, is never logged, and redirects are not followed so it can
    # never be sent anywhere else. Status: ok, unauthorized (HTTP 401), offline (no
    # answer at all), or error.
    function Get-CloudMap {
        param([string]$MapUrl, [string]$Build, [string]$Code, [string]$CachePath)
        # Only https, except this computer's own loopback address (used by -SelfTest).
        if (($MapUrl -notlike 'https://*') -and ($MapUrl -notlike 'http://127.0.0.1:*')) { return @{ Status = 'error'; Error = 'The route service address is not secure, so it was not used.' } }
        $url = $MapUrl
        if ($Build) { $url += '?build=' + [uri]::EscapeDataString($Build) }
        $text = ''
        try {
            $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($url)
            $req.Method = 'GET'
            $req.Timeout = 20000
            $req.ReadWriteTimeout = 30000
            $req.AllowAutoRedirect = $false
            $req.UserAgent = 'ScourgeUploader'
            $req.Accept = 'application/json'
            $req.Headers.Add('X-Team-Code', $Code)
            $resp = $req.GetResponse()
            try {
                if ([int]$resp.StatusCode -ne 200) { return @{ Status = 'error'; Error = ('The route service answered with HTTP ' + [int]$resp.StatusCode + '.') } }
                if ($resp.ContentLength -gt 20MB) { return @{ Status = 'error'; Error = 'The route data is over 20 MB, so it was not read.' } }
                $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
                try { $text = $sr.ReadToEnd() } finally { $sr.Dispose() }
            } finally { $resp.Close() }
        } catch [System.Net.WebException] {
            $er = $_.Exception.Response
            if ($null -eq $er) { return @{ Status = 'offline'; Error = $_.Exception.Message } }
            $status = 0
            try { $status = [int]$er.StatusCode } catch { }
            try { $er.Close() } catch { }
            if ($status -eq 401) { return @{ Status = 'unauthorized'; Error = '' } }
            return @{ Status = 'error'; Error = ('The route service answered with HTTP ' + $status + '.') }
        } catch {
            return @{ Status = 'error'; Error = $_.Exception.Message }
        }
        $parsed = ConvertFrom-CloudMap $text
        if ($parsed.Status -ne 'ok') { return $parsed }
        $cacheError = ''
        try { Write-CloudCache -Path $CachePath -Text $text } catch { $cacheError = $_.Exception.Message }
        return @{ Status = 'ok'; Data = $parsed; Fetched = [DateTime]::UtcNow.ToString('o'); CacheError = $cacheError }
    }
}

# Make the shared functions available on this (main) thread too.
. $SharedCode

# Background job bodies. Each runs on a background thread with two inputs:
# $Sync (shared log queue) and $A (a hashtable of arguments). The last value a
# body outputs is its result.
$UploadBody   = { Invoke-RobotUpload -ProsExe $A.ProsExe -ProjectDir $A.ProjectDir -Slot $A.Slot -Name $A.Name -TimeoutSec $A.Timeout -Sync $Sync }
$RecordBody  = { Invoke-ProsRecording -ProsExe $A.ProsExe -WorkDir $A.WorkDir -FilePath $A.FilePath -Sync $Sync -Retry $A.Retry -ScriptPath $A.ScriptPath }
$LsusbBody    = { Invoke-Pros -ProsExe $A.ProsExe -Arguments 'lsusb --target v5 --no-analytics --no-sentry' -WorkDir $A.WorkDir -TimeoutSec 20 -Sync $Sync -Quiet }
$CheckBody    = { Get-LatestRelease -ReleasesUrl $A.ReleasesUrl }
$SendBody = {
    $result = @{ Status = 'error'; Error = '' }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $json = @{ title = [string]$A.Title; body = [string]$A.Body } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        # Content-Type goes through -ContentType: PowerShell 5.1 refuses it inside -Headers.
        $headers = @{ 'X-Scourge-Client' = 'windows-uploader ' + [string]$A.Version }
        # The team code lets the service put a route recording on the map. It is optional and never logged.
        if ($A.Code) { $headers['X-Team-Code'] = [string]$A.Code }
        try {
            $response = Invoke-WebRequest -Uri $A.ResultsUrl -UseBasicParsing -TimeoutSec 60 -Method Post -Body $bytes -Headers $headers -ContentType 'application/json; charset=utf-8'
            $statusCode = [int]$response.StatusCode
            $responseText = [string]$response.Content
        } catch {
            $response = $_.Exception.Response
            $statusCode = 0
            if ($null -ne $response) { try { $statusCode = [int]$response.StatusCode } catch { } }
            if ($statusCode -eq 0) { $result.Error = $_.Exception.Message } else { $result.Error = 'Relay returned HTTP ' + $statusCode + '.' }
            return $result
        }
        if ($statusCode -ne 201) { $result.Error = 'Relay returned HTTP ' + $statusCode + '.'; return $result }
        try { $payload = $responseText | ConvertFrom-Json } catch { $result.Error = 'Relay returned invalid JSON.'; return $result }
        if (($null -eq $payload.PSObject.Properties['ok']) -or ($payload.ok -ne $true)) { $result.Error = 'Relay response was not successful.'; return $result }
        if ($null -eq $payload.PSObject.Properties['issues']) { $result.Error = 'Relay response had no issues.'; return $result }
        $numbers = New-Object System.Collections.Generic.List[string]
        foreach ($n in @($payload.issues)) {
            if (-not (([string]$n) -match '^\d+$')) { $result.Error = 'Relay response had an invalid issue number.'; return $result }
            [void]$numbers.Add([string]$n)
        }
        if ($numbers.Count -eq 0) { $result.Error = 'Relay response had no issue numbers.'; return $result }
        $result.Status = 'success'
        $result.Issues = @($numbers.ToArray())
        # on_map says whether the service could put the recording on the map; absent on an older service.
        $result.OnMap = $null
        if (($null -ne $payload.PSObject.Properties['on_map']) -and ($payload.on_map -is [bool])) { $result.OnMap = [bool]$payload.on_map }
        return $result
    } catch { $result.Error = $_.Exception.Message; return $result }
}
# The result carries ForClick so a startup check that finishes after a click
# never acts on the click.
$UploaderCheckBody = {
    $m = $null
    try { $m = Get-RemoteUploaderManifest -ManifestUrl $A.ManifestUrl } catch { $m = @{ Status = 'error'; Error = $_.Exception.Message } }
    $m.ForClick = [bool]$A.ForClick
    $m
}
$DownloadBody = { Save-LatestRelease -ReleasesUrl $A.ReleasesUrl -InstallDir $A.InstallDir -AssetNames $A.AssetNames -InstalledTag $A.InstalledTag -Sync $Sync }
$MapBody = { Read-ScourgeResults -Folder $A.Folder -Skip $A.Skip -Cache $A.Cache }
$CloudBody = { Get-CloudMap -MapUrl $A.MapUrl -Build $A.Build -Code $A.Code -CachePath $A.CachePath }
$CloudCacheBody = { Read-CloudCache -Path $A.Path }

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

# True when the downloaded build can be uploaded in this mode. Older releases
# have no test-mode hot files, so those modes are simply unavailable.
function Test-HaveMode {
    param($Mode)
    if (-not (Test-HaveCode)) { return $false }
    return (Test-Path (Get-ReleaseAssetPath -Root $script:ProjectDir -AssetName $Mode.Asset))
}

# The name to show after a mode change: a default name follows the mode, a
# name someone typed themselves is left alone.
function Get-NameForMode {
    param([string]$CurrentName, $Mode)
    $isDefault = (-not $CurrentName.Trim())
    foreach ($m in $script:Modes) { if ($CurrentName.Trim() -ceq $m.Name) { $isDefault = $true } }
    if ($isDefault) { return $Mode.Name }
    return $CurrentName
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
    if ($first -match '^Built from robot code commit ([0-9a-fA-F]{7,40})$') {
        $sha = $Matches[1]
        if ($sha.Length -gt 7) { $sha = $sha.Substring(0, 7) }
        return @{ Sha = $sha; Subject = '' }
    }
    return @{ Sha = ''; Subject = '' }
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
$script:LatestUploaderVersion = ''
$script:TesterBuildTag = ''
$script:Recording = $false
$script:ResultsPath = ''
# The file Send uses: the newest recording worth sending (see Get-RecordOutcome). Empty after a good send.
$script:SendPath = ''
$script:RecordedViaController = $false
# A file that was sent without a team code and so is not on the map; Send is offered for it again once a code is saved.
$script:NeedsCodeFile = ''
$script:LastRecordNote = ''
# What the connection check last saw: brain, controller, multiple, none, or unknown.
$script:ConnState = 'unknown'
# Which view is showing: 'upload' (the original window) or 'map' (Route Map).
$script:View = 'upload'
# Route Map data and view state. Sessions come from Read-ScourgeResults.
$script:Map = @{
    Sessions = @(); Local = @(); Rejected = @(); Selected = -1; SelectedFp = ''
    Whole = $false; Loaded = $false; Loading = $false; Error = ''
}
# Route Map data from the team relay. Sessions are the cloud recordings, merged with the local
# ones into $script:Map.Sessions. Route is 'AWP' or a taught slot letter; Side is L or R.
$script:Cloud = @{
    Inited = $false; Code = ''; Fetching = $false; Again = $false; Pending = $false
    CacheLoaded = $false; Fresh = $false; Offline = $false; Unauthorized = $false; Error = ''
    Data = $null; Sessions = @(); Fetched = ''; Route = 'AWP'; Side = 'L'; Keys = ''
}
$script:CloudFilling = $false
$script:MirrorCache = @{}
$script:MapFieldR = $null
# Where the team code is kept: encrypted for this Windows user, never in the repo or the log.
$script:SettingsPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'ScourgeUploader\settings.json'
$script:MapCache = [hashtable]::Synchronized(@{})
$script:MapLoading = $false
$script:MapReload = $false
$script:MapFilling = $false
$script:MapPaintError = $false
$script:MapNoteLogged = ''
$script:MapField = $null

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
    # View switch, right side of the header: Upload and Route Map.
    $ui.SegUpload = New-FlatButton 'Upload' 0 0 10 10 $false
    $ui.SegMap = New-FlatButton 'Route Map' 0 0 10 10 $false
    $ui.SegUpload.Tag = 'segment'
    $ui.SegMap.Tag = 'segment'
    $ui.Header.Controls.AddRange(@($ui.SegUpload, $ui.SegMap))
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
    $ui.ModeLabel = New-Label 'Mode' 0 0 10 10 $f.Base $c.Muted
    $ui.SlotLabel = New-Label 'Slot' 0 0 10 10 $f.Base $c.Muted
    $ui.NameLabel = New-Label 'Program name' 0 0 10 10 $f.Base $c.Muted
    $ui.ModeBox = New-Object System.Windows.Forms.ComboBox
    $ui.ModeBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    foreach ($m in $script:Modes) { [void]$ui.ModeBox.Items.Add($m.Label) }
    $ui.ModeBox.SelectedIndex = 0
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
    $form.Controls.AddRange(@($ui.UploadLabel, $ui.ModeLabel, $ui.SlotLabel, $ui.NameLabel, $ui.ModeBox, $ui.SlotBox, $ui.NameBox, $ui.NameError, $ui.UploadButton))

    # Robot tests section
    $ui.TestsLine = New-Line 0 0 10
    $ui.TestsLabel = New-Label 'ROBOT TESTS' 0 0 10 10 $f.Section $c.Muted
    $ui.TestsHelper = New-Label 'Measure the robot with the Scourge Tester program, then send the results. Plug USB into the controller, or the brain as a backup.' 0 0 10 10 $f.Small $c.Muted
    $ui.TesterButton = New-FlatButton 'Put tester on robot' 0 0 10 10 $false
    $ui.RecordButton = New-FlatButton 'Record results' 0 0 10 10 $false
    $ui.ResultsStatus = New-Label 'No results yet' 0 0 10 10 $f.Base $c.Muted
    # Autopath messages are a full sentence, so this label wraps instead of cutting them off.
    $ui.ResultsStatus.AutoEllipsis = $false
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

    # Everything above except the header belongs to the Upload view. The Route Map
    # view has its own controls and hides these.
    $ui.UploadControls = @($ui.CodeLabel, $ui.BuildTitle, $ui.BuildMeta, $ui.GetButton, $ui.Notice, $ui.MidLine,
        $ui.UploadLabel, $ui.ModeLabel, $ui.SlotLabel, $ui.NameLabel, $ui.ModeBox, $ui.SlotBox, $ui.NameBox, $ui.NameError, $ui.UploadButton,
        $ui.TestsLine, $ui.TestsLabel, $ui.TestsHelper, $ui.TesterButton, $ui.RecordButton, $ui.ResultsStatus, $ui.SendButton, $ui.OpenFolderLink,
        $ui.Dot, $ui.ConnLabel, $ui.Status, $ui.DetailsLink, $ui.Log)
    New-RouteMapControls $form
    Update-ViewButtons

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
    $ui.ModeBox.Add_SelectedIndexChanged({ Invoke-Safe { Set-ModeDefaults } })
    $ui.DetailsLink.Add_LinkClicked({ Invoke-Safe { Set-DetailsVisible (-not $script:DetailsShown) } })
    $ui.SegUpload.Add_Click({ Invoke-Safe { Set-View 'upload' } })
    $ui.SegMap.Add_Click({ Invoke-Safe { Set-View 'map' } })
    $ui.MapWholeButton.Add_Click({ Invoke-Safe { Switch-MapWhole } })
    $ui.MapRefresh.Add_LinkClicked({ Invoke-Safe { Start-MapRefresh } })
    $ui.MapRouteBox.Add_SelectedIndexChanged({ Invoke-Safe { Select-CloudRoute } })
    $ui.MapSideL.Add_Click({ Invoke-Safe { Set-CloudSide 'L' } })
    $ui.MapSideR.Add_Click({ Invoke-Safe { Set-CloudSide 'R' } })
    $ui.MapCodeButton.Add_Click({ Invoke-Safe { Submit-TeamCode } })
    $ui.MapCodeBox.Add_KeyDown({
        param($s, $e)
        if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
            $e.SuppressKeyPress = $true
            Invoke-Safe { Submit-TeamCode }
        }
    })
    $ui.MapList.Add_SelectedIndexChanged({ Invoke-Safe { Select-MapSession } })
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
    if ($script:View -eq 'map') { Update-MapLayout; return }
    $W = Px 480
    $M = Px 24
    $inner = $W - 2 * $M

    $form.SuspendLayout()

    # Header
    $ui.Header.SetBounds(0, 0, $W, (Px 72))
    $ui.HeaderTitle.SetBounds($M, (Px 12), $inner, (Px 30))
    $ui.HeaderSub.SetBounds($M, (Px 42), $inner, (Px 20))
    $ui.HeaderLine.SetBounds(0, (Px 72), $W, 1)
    Set-ViewButtonBounds $W $M

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
    $modeW = Px 132
    $slotW = Px 72
    $slotX = $M + $modeW + (Px 16)
    $nameX = $slotX + $slotW + (Px 16)
    $nameW = $M + $inner - $nameX
    $ui.ModeLabel.SetBounds($M, $y, $modeW, (Px 18))
    $ui.SlotLabel.SetBounds($slotX, $y, $slotW, (Px 18))
    $ui.NameLabel.SetBounds($nameX, $y, $nameW, (Px 18))
    $y += Px 22
    # A drop-down list sets its own height from the font; match the text box to it.
    $ui.ModeBox.SetBounds($M, $y, $modeW, $ui.ModeBox.Height)
    $ui.SlotBox.SetBounds($slotX, $y, $slotW, $ui.SlotBox.Height)
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
    Set-WrappedLabel $ui.ResultsStatus $M $y ($inner - $sendW - (Px 12))
    $y += [math]::Max($ui.ResultsStatus.Height, (Px 22)) + (Px 2)
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
    # What this layout wants, before Windows trims a window that is taller than the screen.
    $script:UploadLayoutSize = $size
    if ($form.ClientSize -ne $size) { $form.ClientSize = $size }
    $form.ResumeLayout($false)
}

# ---------------------------------------------------------------------------
# Route Map view. Two views share one window: Upload (the original layout) and
# Route Map (a field drawing on the left, session list and last-run misses on
# the right). The drawing is plain System.Drawing, no web view and no extra files.
# ---------------------------------------------------------------------------

# Panels and list views flicker when they repaint unless double buffering is on.
# WinForms keeps that switch protected, so it is reached through reflection.
function Set-DoubleBuffered {
    param($Control)
    $prop = $Control.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
    if ($null -ne $prop) { $prop.SetValue($Control, $true, $null) }
}

function New-MapListView {
    param([string[]]$Columns, [int[]]$Widths)
    $c = $script:Colors
    $lv = New-Object System.Windows.Forms.ListView
    $lv.View = [System.Windows.Forms.View]::Details
    $lv.FullRowSelect = $true
    $lv.MultiSelect = $false
    $lv.HideSelection = $false
    $lv.HeaderStyle = [System.Windows.Forms.ColumnHeaderStyle]::Nonclickable
    $lv.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $lv.Font = $script:Fonts.Base
    $lv.BackColor = $c.Back
    $lv.ForeColor = $c.Text
    for ($i = 0; $i -lt $Columns.Length; $i++) { [void]$lv.Columns.Add($Columns[$i], $Widths[$i]) }
    Set-DoubleBuffered $lv
    return $lv
}

function New-RouteMapControls {
    param($Form)
    $c = $script:Colors
    $f = $script:Fonts
    $ui = $script:Ui

    $ui.MapCanvas = New-Object System.Windows.Forms.Panel
    $ui.MapCanvas.BackColor = $c.HeaderBack
    Set-DoubleBuffered $ui.MapCanvas
    $ui.MapCanvas.Add_Paint({
        param($s, $e)
        try {
            Show-RouteMapCanvas $e.Graphics $s.ClientSize
        } catch {
            # Say it once in Details instead of on every repaint.
            if (-not $script:MapPaintError) {
                $script:MapPaintError = $true
                try { Add-LogText ('Route Map drawing: ' + ($_ | Out-String)) } catch { }
            }
        }
    })

    $ui.MapWholeButton = New-FlatButton 'Whole field' 0 0 10 10 $false
    $ui.MapWholeButton.Tag = 'segment'
    # Route picker and side: AWP or a taught route, Left or Right.
    $ui.MapRouteBox = New-Object System.Windows.Forms.ComboBox
    $ui.MapRouteBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    $ui.MapSideL = New-FlatButton 'Left' 0 0 10 10 $false
    $ui.MapSideL.Tag = 'segment'
    $ui.MapSideR = New-FlatButton 'Right' 0 0 10 10 $false
    $ui.MapSideR.Tag = 'segment'
    # One line about where the route data came from, plus the team code field (only until a code is saved).
    $ui.MapCloudNote = New-Label '' 0 0 10 10 $f.Small $c.Muted
    $ui.MapCloudNote.AutoEllipsis = $false
    $ui.MapCodeBox = New-Object System.Windows.Forms.TextBox
    $ui.MapCodeBox.AutoSize = $false
    $ui.MapCodeBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $ui.MapCodeBox.MaxLength = 128
    $ui.MapCodeBox.UseSystemPasswordChar = $true
    $ui.MapCodeButton = New-FlatButton 'Use code' 0 0 10 10 $false
    $ui.MapSessionsLabel = New-Label 'SESSIONS' 0 0 10 10 $f.Section $c.Muted
    $ui.MapRefresh = New-Object System.Windows.Forms.LinkLabel
    $ui.MapRefresh.Text = 'Refresh'
    $ui.MapRefresh.AutoSize = $true
    $ui.MapRefresh.LinkColor = $c.Accent
    $ui.MapRefresh.ActiveLinkColor = $c.AccentDown
    $ui.MapRefresh.LinkBehavior = [System.Windows.Forms.LinkBehavior]::HoverUnderline
    $ui.MapList = New-MapListView @('Kind', 'When', 'Rows') @((Px 124), (Px 136), (Px 48))
    $ui.MapList.Columns[2].TextAlign = [System.Windows.Forms.HorizontalAlignment]::Right
    $ui.MapRejected = New-Label '' 0 0 10 10 $f.Small $c.Bad
    $ui.MapRejected.AutoEllipsis = $false
    $ui.MapLine = New-Line 0 0 10
    $ui.MapRunLabel = New-Label 'LAST RUN' 0 0 10 10 $f.Section $c.Muted
    $ui.MapRunSummary = New-Label '' 0 0 10 10 $f.Small $c.Muted
    $ui.MapRunSummary.AutoEllipsis = $false
    $ui.MapTable = New-MapListView @('Step', 'Miss (in)', 'Turn (deg)') @((Px 136), (Px 86), (Px 86))
    $ui.MapTable.Columns[1].TextAlign = [System.Windows.Forms.HorizontalAlignment]::Right
    $ui.MapTable.Columns[2].TextAlign = [System.Windows.Forms.HorizontalAlignment]::Right
    $ui.MapKeyGood = New-Label 'Under 1 in' 0 0 10 10 $f.Small $c.Good
    $ui.MapKeyWarn = New-Label 'Under 3 in' 0 0 10 10 $f.Small $c.Warn
    $ui.MapKeyBad = New-Label '3 in or more' 0 0 10 10 $f.Small $c.Bad

    $ui.MapControls = @($ui.MapCanvas, $ui.MapWholeButton, $ui.MapRouteBox, $ui.MapSideL, $ui.MapSideR, $ui.MapCloudNote, $ui.MapCodeBox, $ui.MapCodeButton, $ui.MapSessionsLabel, $ui.MapRefresh, $ui.MapList, $ui.MapRejected,
        $ui.MapLine, $ui.MapRunLabel, $ui.MapRunSummary, $ui.MapTable, $ui.MapKeyGood, $ui.MapKeyWarn, $ui.MapKeyBad)
    foreach ($ctl in $ui.MapControls) { $ctl.Visible = $false }
    $Form.Controls.AddRange($ui.MapControls)
}

# A segment looks selected (accent fill) or plain (white with a border), the
# same flat style as the other buttons.
function Set-SegmentStyle {
    param($Button, [bool]$On)
    $c = $script:Colors
    if ($On) {
        $Button.BackColor = $c.Accent
        $Button.ForeColor = [System.Drawing.Color]::White
        $Button.Font = $script:Fonts.Strong
        $Button.FlatAppearance.BorderColor = $c.Accent
        $Button.FlatAppearance.MouseOverBackColor = $c.AccentHover
        $Button.FlatAppearance.MouseDownBackColor = $c.AccentDown
    } else {
        $Button.BackColor = $c.Back
        $Button.ForeColor = $c.Text
        $Button.Font = $script:Fonts.Base
        $Button.FlatAppearance.BorderColor = $c.Border
        $Button.FlatAppearance.MouseOverBackColor = $c.SecHover
        $Button.FlatAppearance.MouseDownBackColor = $c.SecDown
    }
}

function Update-ViewButtons {
    $ui = $script:Ui
    Set-SegmentStyle $ui.SegUpload ($script:View -eq 'upload')
    Set-SegmentStyle $ui.SegMap ($script:View -eq 'map')
    Set-SegmentStyle $ui.MapWholeButton ([bool]$script:Map.Whole)
    Set-SegmentStyle $ui.MapSideL ($script:Cloud.Side -eq 'L')
    Set-SegmentStyle $ui.MapSideR ($script:Cloud.Side -eq 'R')
}

# The two view buttons sit at the right end of the header, joined edge to edge.
function Set-ViewButtonBounds {
    param([int]$W, [int]$M)
    $ui = $script:Ui
    $segW = Px 88
    $segH = Px 30
    $segY = Px 21
    $ui.SegMap.SetBounds(($W - $M - $segW), $segY, $segW, $segH)
    $ui.SegUpload.SetBounds(($W - $M - 2 * $segW + 1), $segY, $segW, $segH)
}

# Lays out the Route Map view and sizes the window to about 880 x 640. On a
# short screen the height shrinks so the window still fits.
function Update-MapLayout {
    $ui = $script:Ui
    $form = $ui.Form
    $W = Px 880
    $H = Px 640
    try {
        $wa = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
        $maxH = $wa.Height - (Px 48)
        if (($H -gt $maxH) -and ($maxH -gt (Px 440))) { $H = $maxH }
    } catch { }
    $M = Px 24
    $form.SuspendLayout()

    $ui.Header.SetBounds(0, 0, $W, (Px 72))
    $ui.HeaderTitle.SetBounds($M, (Px 12), ($W - 2 * $M), (Px 30))
    $ui.HeaderSub.SetBounds($M, (Px 42), ($W - 2 * $M), (Px 20))
    $ui.HeaderLine.SetBounds(0, (Px 72), $W, 1)
    Set-ViewButtonBounds $W $M

    $top = Px 88
    $canvasW = Px 480
    $ui.MapCanvas.SetBounds($M, $top, $canvasW, ($H - $top - $M))

    $x = $M + $canvasW + (Px 16)
    $colW = $W - $M - $x
    $y = $top
    # Route picker, with Left and Right joined edge to edge at its right end.
    $sideW = Px 60
    $ui.MapSideR.SetBounds(($x + $colW - $sideW), $y, $sideW, (Px 30))
    $ui.MapSideL.SetBounds(($x + $colW - 2 * $sideW + 1), $y, $sideW, (Px 30))
    $routeW = $colW - 2 * $sideW - (Px 8)
    $ui.MapRouteBox.SetBounds($x, ($y + [int]((Px 30) - $ui.MapRouteBox.Height) / 2), $routeW, $ui.MapRouteBox.Height)
    $y += (Px 30) + (Px 8)
    $ui.MapWholeButton.SetBounds($x, $y, $colW, (Px 30))
    $y += (Px 30) + (Px 12)
    $cloudTop = $y
    $hasNote = [bool]$ui.MapCloudNote.Text
    $ui.MapCloudNote.Visible = $hasNote
    if ($hasNote) {
        Set-WrappedLabel $ui.MapCloudNote $x $y $colW
        if ($ui.MapCloudNote.Height -gt (Px 48)) { $ui.MapCloudNote.Height = Px 48 }
        $y += $ui.MapCloudNote.Height + (Px 6)
    }
    # The team code is asked for once, here and nowhere else.
    $showCode = -not [bool]$script:Cloud.Code
    $ui.MapCodeBox.Visible = $showCode
    $ui.MapCodeButton.Visible = $showCode
    if ($showCode) {
        $codeBtnW = Px 80
        $ui.MapCodeBox.SetBounds($x, $y, ($colW - $codeBtnW - (Px 8)), (Px 26))
        $ui.MapCodeButton.SetBounds(($x + $colW - $codeBtnW), $y, $codeBtnW, (Px 26))
        $y += (Px 26) + (Px 6)
    }
    $y += Px 10
    $cloudExtra = $y - $cloudTop - (Px 4)
    $ui.MapSessionsLabel.SetBounds($x, $y, ($colW - (Px 72)), (Px 16))
    $ui.MapRefresh.Location = New-Object System.Drawing.Point(($x + $colW - $ui.MapRefresh.PreferredSize.Width), ($y - (Px 1)))
    $y += Px 24
    # The list gives up height on a short screen so the miss table keeps room.
    $listH = [math]::Min((Px 152), [math]::Max((Px 72), ($H - (Px 488) - (Px 38) - $cloudExtra)))
    $ui.MapList.SetBounds($x, $y, $colW, $listH)
    $y += $listH
    $hasRejected = [bool]$ui.MapRejected.Text
    $ui.MapRejected.Visible = $hasRejected
    if ($hasRejected) {
        $y += Px 8
        Set-WrappedLabel $ui.MapRejected $x $y $colW
        # A long note is cut at about four lines. The full text is in Details.
        if ($ui.MapRejected.Height -gt (Px 56)) { $ui.MapRejected.Height = Px 56 }
        $y += $ui.MapRejected.Height
    }
    $y += Px 16
    $ui.MapLine.SetBounds($x, $y, $colW, 1)
    $y += Px 16
    $ui.MapRunLabel.SetBounds($x, $y, $colW, (Px 16))
    $y += Px 24
    Set-WrappedLabel $ui.MapRunSummary $x $y $colW
    $y += $ui.MapRunSummary.Height + (Px 8)
    $keyH = Px 18
    $keyY = $H - $M - $keyH
    $tableH = [math]::Max(($keyY - (Px 8) - $y), (Px 60))
    $ui.MapTable.SetBounds($x, $y, $colW, $tableH)
    $third = [int]($colW / 3)
    $ui.MapKeyGood.SetBounds($x, $keyY, $third, $keyH)
    $ui.MapKeyWarn.SetBounds(($x + $third), $keyY, $third, $keyH)
    $ui.MapKeyBad.SetBounds(($x + 2 * $third), $keyY, ($colW - 2 * $third), $keyH)

    $size = New-Object System.Drawing.Size($W, $H)
    if ($form.ClientSize -ne $size) { $form.ClientSize = $size }
    $form.ResumeLayout($false)
}

# Switches between the Upload and Route Map views. NoLoad is for -SelfTest, which
# fills the data itself.
function Set-View {
    param([string]$View, [switch]$NoLoad)
    $ui = $script:Ui
    if ($script:View -eq $View) { return }
    $script:View = $View
    $isMap = ($View -eq 'map')
    foreach ($ctl in $ui.UploadControls) { $ctl.Visible = (-not $isMap) }
    foreach ($ctl in $ui.MapControls) { $ctl.Visible = $isMap }
    Update-ViewButtons
    Update-Layout
    # The window changed size, so keep it on the screen in either view.
    Move-FormOnScreen
    if ($isMap -and (-not $NoLoad)) { Start-MapRefresh }
}

function Move-FormOnScreen {
    try {
        $form = $script:Ui.Form
        $wa = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
        $left = [math]::Max($wa.Left, [math]::Min($form.Left, ($wa.Right - $form.Width)))
        $topPos = [math]::Max($wa.Top, [math]::Min($form.Top, ($wa.Bottom - $form.Height)))
        if (($left -ne $form.Left) -or ($topPos -ne $form.Top)) { $form.Location = New-Object System.Drawing.Point($left, $topPos) }
    } catch { }
}

function Switch-MapWhole {
    $script:Map.Whole = -not $script:Map.Whole
    Update-ViewButtons
    $script:Ui.MapCanvas.Invalidate()
}

function Select-MapSession {
    if ($script:MapFilling) { return }
    $lv = $script:Ui.MapList
    if ($lv.SelectedItems.Count -eq 0) { return }
    $i = [int]$lv.SelectedItems[0].Tag
    $script:Map.Selected = $i
    $script:Map.SelectedFp = [string]$script:Map.Sessions[$i].Fingerprint
    # A recording of a taught route brings that route's prediction up with it.
    $s = $script:Map.Sessions[$i]
    if (($s.Source -eq 'cloud') -and $s.ForSlot -and ($s.ForSlot -ine $script:Cloud.Route) -and (Test-CloudRouteKnown ([string]$s.ForSlot))) {
        $script:Cloud.Route = [string]$s.ForSlot
        Update-CloudControls
    }
    $script:Ui.MapCanvas.Invalidate()
}

# The same folder Record results saves into.
function Get-ResultsFolder {
    return (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scourge Robot Data')
}

# Reads the results folder on a background thread, so a big folder never freezes
# the window. The file being recorded right now is left out until it is finished.
function Start-MapLoad {
    if ($script:MapLoading) { $script:MapReload = $true; return }
    $script:MapLoading = $true
    $script:MapReload = $false
    $script:Map.Loading = $true
    $script:Ui.MapCanvas.Invalidate()
    try {
        $skip = @()
        if ($script:Recording -and $script:ResultsPath) { $skip = @($script:ResultsPath) }
        Start-BgJob $MapBody @{ Folder = (Get-ResultsFolder); Skip = $skip; Cache = $script:MapCache } {
            param($r)
            $script:MapLoading = $false
            $script:Map.Loading = $false
            Set-MapData $r
            if ($script:MapReload) { Start-MapLoad }
        }
    } catch {
        # Could not even start: say so, instead of leaving "Reading recordings..." up.
        $script:MapLoading = $false
        $script:Map.Loading = $false
        Set-MapData @{ Status = 'error'; Error = ('Could not start reading the recordings: ' + $_.Exception.Message) }
    }
}

# Takes what Read-ScourgeResults returned (the local results files) and shows it
# together with the cloud recordings.
function Set-MapData {
    param($R)
    $m = $script:Map
    $m.Loaded = $true
    $m.Error = ''
    if ($R.Status -eq 'ok') {
        $m.Local = @($R.Sessions)
        $m.Rejected = @($R.Rejected)
    } else {
        $m.Local = @()
        $m.Rejected = @()
        $m.Error = [string]$R.Error
        if (-not $m.Error) { $m.Error = 'Could not read the recordings.' }
    }
    Update-MapSessions
}

# Local recordings plus cloud recordings (a recording that is in both shows once). Keeps
# the selection if that recording is still there, otherwise picks the last run, or the
# newest recording, and redraws everything that depends on it.
function Update-MapSessions {
    $m = $script:Map
    $m.Sessions = @(Merge-MapSessions $m.Local $script:Cloud.Sessions)
    $script:MirrorCache.Clear()
    $prevFp = [string]$m.SelectedFp
    $sel = -1
    if ($m.SelectedFp) {
        for ($i = 0; $i -lt $m.Sessions.Count; $i++) { if ($m.Sessions[$i].Fingerprint -eq $m.SelectedFp) { $sel = $i } }
    }
    if ($sel -lt 0) {
        for ($i = $m.Sessions.Count - 1; $i -ge 0; $i--) { if ($m.Sessions[$i].Kind -eq 'run') { $sel = $i; break } }
    }
    if (($sel -lt 0) -and ($m.Sessions.Count -gt 0)) { $sel = $m.Sessions.Count - 1 }
    $m.Selected = $sel
    if ($sel -ge 0) { $m.SelectedFp = [string]$m.Sessions[$sel].Fingerprint } else { $m.SelectedFp = '' }
    # A newly chosen cloud recording of a taught route brings that route up with it.
    if (($sel -ge 0) -and ($m.SelectedFp -ne $prevFp)) {
        $s = $m.Sessions[$sel]
        if (($s.Source -eq 'cloud') -and $s.ForSlot -and (Test-CloudRouteKnown ([string]$s.ForSlot))) { $script:Cloud.Route = [string]$s.ForSlot }
    }
    Update-MapPanel
}

# Two recordings are the same one when kind, side, sample count, and first and last
# sample time agree. The local file reader and the cloud copy can both hold one.
function Get-SessionDedupeKey {
    param($S)
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $n = $S.X.Length
    $first = 0.0
    $last = 0.0
    if ($n -gt 0) { $first = [math]::Round($S.T[0] * 1000.0); $last = [math]::Round($S.T[$n - 1] * 1000.0) }
    return ([string]$S.Kind + '|' + [string]$S.WasSide + '|' + $n + '|' + $first.ToString($inv) + '|' + $last.ToString($inv))
}

# Local recordings first, then any cloud recording that is not already among them,
# oldest to newest. With no cloud recordings the local list is returned untouched.
function Merge-MapSessions {
    param($Local, $Cloud)
    $cloudCount = 0
    if ($null -ne $Cloud) { $cloudCount = @($Cloud).Count }
    if ($cloudCount -eq 0) { return @($Local) }
    $seen = @{}
    $all = New-Object System.Collections.ArrayList
    foreach ($s in @($Local)) { $seen[(Get-SessionDedupeKey $s)] = $true; [void]$all.Add($s) }
    foreach ($s in @($Cloud)) {
        $k = Get-SessionDedupeKey $s
        if ($seen.ContainsKey($k)) { continue }
        $seen[$k] = $true
        [void]$all.Add($s)
    }
    return @($all.ToArray() | Sort-Object { $_.When }, { $_.Order })
}

# Fills the session list, the rejection note, and the last-run table.
function Update-MapPanel {
    $ui = $script:Ui
    $m = $script:Map
    $c = $script:Colors
    $f = $script:Fonts
    $inv = [System.Globalization.CultureInfo]::InvariantCulture

    $script:MapFilling = $true
    try {
        $lv = $ui.MapList
        $lv.BeginUpdate()
        $lv.Items.Clear()
        # Newest first. The item remembers its place in the session list.
        for ($i = $m.Sessions.Count - 1; $i -ge 0; $i--) {
            $s = $m.Sessions[$i]
            $item = New-Object System.Windows.Forms.ListViewItem((Get-KindLabel ([string]$s.Kind) ([string]$s.WasSide)))
            [void]$item.SubItems.Add((Format-MapWhen ([string]$s.When)))
            [void]$item.SubItems.Add([string]$s.Rows)
            $item.Tag = $i
            [void]$lv.Items.Add($item)
            if ($i -eq $m.Selected) { $item.Selected = $true; $item.EnsureVisible() }
        }
        $lv.EndUpdate()
    } finally { $script:MapFilling = $false }

    # Rejected recordings: say so plainly. Newest three, then a count.
    $lines = New-Object System.Collections.Generic.List[string]
    if ($m.Error) { [void]$lines.Add($m.Error) }
    $n = $m.Rejected.Count
    for ($i = $n - 1; ($i -ge 0) -and ($i -ge ($n - 3)); $i--) { [void]$lines.Add([string]$m.Rejected[$i].Text) }
    if ($n -gt 3) { [void]$lines.Add('and ' + ($n - 3) + ' more rejected recordings.') }
    $ui.MapRejected.Text = ($lines.ToArray() -join "`n")
    # The note on screen is cut short when long, so the whole text also goes to Details (once per change).
    $fullNote = (@($m.Rejected | ForEach-Object { [string]$_.Text }) -join ' ')
    if ($fullNote -ne $script:MapNoteLogged) {
        $script:MapNoteLogged = $fullNote
        if ($fullNote) { Add-LogText ('Route Map: ' + $fullNote) }
    }

    # Last run: the newest recording of kind run.
    $run = $null
    for ($i = $m.Sessions.Count - 1; $i -ge 0; $i--) { if ($m.Sessions[$i].Kind -eq 'run') { $run = $m.Sessions[$i]; break } }
    $tbl = $ui.MapTable
    $tbl.BeginUpdate()
    $tbl.Items.Clear()
    $ui.MapRunSummary.ForeColor = $c.Muted
    if ($null -eq $run) {
        $ui.MapRunSummary.Text = 'No run recorded yet.'
    } else {
        $rows = @(Get-MissRows $run)
        $worst = $null
        $worstStep = 0
        $failed = 0
        foreach ($r in $rows) {
            if (($null -ne $r.Miss) -and (($null -eq $worst) -or ($r.Miss -gt $worst))) { $worst = $r.Miss; $worstStep = $r.Step }
            if ($r.Ok -eq 0) { $failed++ }
            $label = [string]$r.Type
            if ($r.Step -ge 0) { $label = ([string]$r.Step) + ' ' + $label }
            if ($r.Ok -eq 0) { $label += ' (failed)' }
            $item = New-Object System.Windows.Forms.ListViewItem($label)
            $item.UseItemStyleForSubItems = $false
            $missText = '-'
            if ($null -ne $r.Miss) { $missText = $r.Miss.ToString('0.0', $inv) }
            $missCell = $item.SubItems.Add($missText)
            $missCell.Font = $f.Strong
            $missCell.ForeColor = $c.Muted
            if ($r.Band -eq 'good') { $missCell.ForeColor = $c.Good }
            elseif ($r.Band -eq 'warn') { $missCell.ForeColor = $c.Warn }
            elseif ($r.Band -eq 'bad') { $missCell.ForeColor = $c.Bad }
            $turnText = '-'
            if ($null -ne $r.HMiss) { $turnText = $r.HMiss.ToString('0.0', $inv) }
            $turnCell = $item.SubItems.Add($turnText)
            $turnCell.ForeColor = $c.Muted
            [void]$tbl.Items.Add($item)
        }
        $summary = Format-MapWhen ([string]$run.When)
        if ($rows.Count -eq 0) {
            $summary += '. This run has no step results.'
        } else {
            $summary += '. ' + $rows.Count + ' steps.'
            if ($null -ne $worst) {
                $summary += ' Worst miss ' + $worst.ToString('0.0', $inv) + ' in at step ' + $worstStep + '.'
                $band = Get-MissBand $worst
                if ($band -eq 'good') { $ui.MapRunSummary.ForeColor = $c.Good }
                elseif ($band -eq 'bad') { $ui.MapRunSummary.ForeColor = $c.Bad }
                else { $ui.MapRunSummary.ForeColor = $c.Text }
            }
            if ($failed -gt 0) { $summary += ' ' + $failed + ' did not finish.' }
        }
        $ui.MapRunSummary.Text = $summary
    }
    $tbl.EndUpdate()
    Update-CloudControls
    if ($script:View -eq 'map') { Update-MapLayout }
    $ui.MapCanvas.Invalidate()
}

# ---------------------------------------------------------------------------
# Route Map from the team relay. The relay base comes from results_url in
# uploader.json. Opening the tab, Refresh, and a good Send each fetch; the last good
# answer is kept in Documents\Scourge Robot Data\map-cloud.json and drawn when there is
# no network. Nothing waits on the network: the cache and the fetch are background jobs.
# ---------------------------------------------------------------------------

# results_url ends in /results; the map lives next to it at /map.
function Get-MapCloudUrl {
    param([string]$ResultsUrl)
    if (-not $ResultsUrl) { return '' }
    $u = $ResultsUrl.TrimEnd('/')
    if ($u -match '^(.*)/results$') { return $Matches[1] + '/map' }
    return $u + '/map'
}

function Get-CloudCachePath {
    return (Join-Path (Get-ResultsFolder) 'map-cloud.json')
}

# The team code, kept encrypted for this Windows user (DPAPI) in %APPDATA%.
function Read-TeamCode {
    try {
        if (-not (Test-Path -LiteralPath $script:SettingsPath)) { return '' }
        $d = [System.IO.File]::ReadAllText($script:SettingsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($null -eq $d.PSObject.Properties['team_code']) { return '' }
        $enc = [string]$d.team_code
        if (-not $enc) { return '' }
        $sec = ConvertTo-SecureString -String $enc
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    } catch { return '' }
}

function Save-TeamCode {
    param([string]$Code)
    New-Item -ItemType Directory -Path (Split-Path $script:SettingsPath -Parent) -Force | Out-Null
    $enc = ConvertTo-SecureString -String $Code -AsPlainText -Force | ConvertFrom-SecureString
    $json = @{ team_code = $enc } | ConvertTo-Json
    [System.IO.File]::WriteAllText($script:SettingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# The settings file holds only the code, so clearing it removes the file.
function Clear-TeamCode {
    Remove-Item -LiteralPath $script:SettingsPath -Force -ErrorAction SilentlyContinue
}

function Initialize-Cloud {
    $cl = $script:Cloud
    if ($cl.Inited) { return }
    $cl.Inited = $true
    $cl.Code = Read-TeamCode
}

function Format-CloudWhen {
    param([string]$Iso)
    if (-not $Iso) { return 'an earlier visit' }
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    try {
        $styles = [System.Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal'
        return [datetime]::Parse($Iso, $inv, $styles).ToLocalTime().ToString('MMM d, h:mm tt', $inv)
    } catch { return $Iso }
}

# "build-70-abc1234" reads as "build 70".
function Get-BuildTagLabel {
    param([string]$Tag)
    if ($Tag -match '^build-(\d+)-') { return 'build ' + $Matches[1] }
    return $Tag
}

# AWP first, then each taught route found in the prediction or the recordings.
function Get-CloudRoutes {
    $cl = $script:Cloud
    $list = New-Object System.Collections.ArrayList
    [void]$list.Add(@{ Key = 'AWP'; Label = 'AWP' })
    $keys = @{}
    if ($null -ne $cl.Data) {
        if ($null -ne $cl.Data.Sim) { foreach ($r in $cl.Data.Sim.Routes) { if ([string]$r.Key -ine 'AWP') { $keys[[string]$r.Key] = $true } } }
        if ($null -ne $cl.Data.Recorded) { foreach ($r in $cl.Data.Recorded.Routes) { if ([string]$r.Slot -ine 'AWP') { $keys[[string]$r.Slot] = $true } } }
    }
    foreach ($k in @($keys.Keys | Sort-Object)) { [void]$list.Add(@{ Key = [string]$k; Label = ('Taught ' + $k) }) }
    return $list
}

function Test-CloudRouteKnown {
    param([string]$Key)
    foreach ($r in @(Get-CloudRoutes)) { if ([string]$r.Key -ieq $Key) { return $true } }
    return $false
}

# The predicted route for the picked route and side, or $null.
function Get-CloudPredicted {
    $cl = $script:Cloud
    if (($null -eq $cl.Data) -or ($null -eq $cl.Data.Sim)) { return $null }
    foreach ($r in $cl.Data.Sim.Routes) {
        if (([string]$r.Key -ieq [string]$cl.Route) -and ([string]$r.Side -ceq [string]$cl.Side)) {
            # The service sends every route in the LEFT frame, the Right entry equal to the Left one.
            # Recordings are drawn on the Right by mirroring them, so the prediction is mirrored the same way.
            if ([string]$cl.Side -eq 'R') { return (Get-MirroredSession $r) }
            return $r
        }
    }
    return $null
}

# The cleaned route of a recorded (taught) route, as points in the picked side's frame, or $null.
function Get-CloudClean {
    $cl = $script:Cloud
    if (($null -eq $cl.Data) -or ($null -eq $cl.Data.Recorded)) { return $null }
    foreach ($r in $cl.Data.Recorded.Routes) {
        if ([string]$r.Slot -ine [string]$cl.Route) { continue }
        $xs = New-Object 'System.Collections.Generic.List[double]'
        $ys = New-Object 'System.Collections.Generic.List[double]'
        if ($r.HasStart) { $xs.Add([double]$r.StartX); $ys.Add([double]$r.StartY) }
        foreach ($w in $r.Wp) { $xs.Add([double]$w.X); $ys.Add([double]$w.Y) }
        if ($xs.Count -lt 1) { return $null }
        $x = $xs.ToArray()
        $y = $ys.ToArray()
        if ($cl.Side -eq 'R') {
            $nx = New-Object 'double[]' $x.Length
            $ny = New-Object 'double[]' $x.Length
            for ($i = 0; $i -lt $x.Length; $i++) { $nx[$i] = 0.0 - $y[$i]; $ny[$i] = 0.0 - $x[$i] }
            $x = $nx; $y = $ny
        }
        return @{ X = $x; Y = $y; Marks = @(); Events = @() }
    }
    return $null
}

# Index in Map.Sessions of the newest cloud teach recording for the picked route, or -1.
function Get-CloudRawIndex {
    $m = $script:Map
    for ($i = $m.Sessions.Count - 1; $i -ge 0; $i--) {
        $s = $m.Sessions[$i]
        if (($s.Source -eq 'cloud') -and ([string]$s.Kind -like 'teach*') -and $s.ForSlot -and ([string]$s.ForSlot -ieq [string]$script:Cloud.Route)) { return $i }
    }
    return -1
}

function Get-PredictedLabel {
    $sim = $script:Cloud.Data.Sim
    if ([int]$sim.Build -gt 0) { return ('Build ' + $sim.Build + ', predicted from the code, not a real run') }
    return 'Predicted from the code, not a real run'
}

# The line under the route picker: where the data came from, or what is missing.
function Get-CloudNote {
    $cl = $script:Cloud
    $have = ($null -ne $cl.Data)
    if (-not $cl.Code) {
        if ($cl.Unauthorized) { return 'That team code did not work. Enter it again.' }
        return 'Enter the team code to load the predicted route.'
    }
    $lines = New-Object System.Collections.Generic.List[string]
    if ((-not $have) -and $cl.Pending) { $lines.Add('Looking for the route service...') }
    elseif ((-not $have) -and $cl.Fetching) { $lines.Add('Loading the predicted route...') }
    if ($cl.Offline) {
        if ($have) { $lines.Add('Offline, showing data from ' + (Format-CloudWhen $cl.Fetched)) }
        else { $lines.Add('Offline. No saved route data on this device yet.') }
    } elseif ($cl.Error) {
        $t = 'Could not load routes. ' + $cl.Error
        if ($have) { $t += ' Showing data from ' + (Format-CloudWhen $cl.Fetched) + '.' }
        $lines.Add($t)
    }
    if ($have -and ($null -ne $cl.Data.Sim) -and $cl.Data.Sim.Tag -and $script:InstalledTag -and ([string]$cl.Data.Sim.Tag -ne [string]$script:InstalledTag)) {
        $lines.Add('The prediction is for ' + (Get-BuildTagLabel ([string]$cl.Data.Sim.Tag)) + ', this computer has ' + (Get-BuildTagLabel ([string]$script:InstalledTag)) + '.')
    }
    if ($have -and $cl.Data.Note) { $lines.Add([string]$cl.Data.Note) }
    return ($lines.ToArray() -join "`n")
}

# What the card on an empty field says.
function Get-MapEmptyText {
    $cl = $script:Cloud
    if (-not $cl.Code) { return 'Enter the team code on the right to load the predicted route.' }
    if (($null -eq $cl.Data) -and ($cl.Fetching -or $cl.Pending)) { return 'Loading the predicted route...' }
    return ('No prediction for this build yet.' + "`n" + 'Get the latest build, then Refresh.')
}

# Route list, side buttons, and the note, from the current cloud state.
function Update-CloudControls {
    $ui = $script:Ui
    $cl = $script:Cloud
    if (-not (Test-CloudRouteKnown ([string]$cl.Route))) { $cl.Route = 'AWP' }
    $routes = @(Get-CloudRoutes)
    $keyText = (@($routes | ForEach-Object { [string]$_.Key }) -join '|')
    $script:CloudFilling = $true
    try {
        if ($keyText -ne $cl.Keys) {
            $cl.Keys = $keyText
            $ui.MapRouteBox.BeginUpdate()
            $ui.MapRouteBox.Items.Clear()
            foreach ($r in $routes) { [void]$ui.MapRouteBox.Items.Add([string]$r.Label) }
            $ui.MapRouteBox.EndUpdate()
        }
        $want = 0
        for ($i = 0; $i -lt $routes.Count; $i++) { if ([string]$routes[$i].Key -ieq [string]$cl.Route) { $want = $i } }
        if ($ui.MapRouteBox.SelectedIndex -ne $want) { $ui.MapRouteBox.SelectedIndex = $want }
    } finally { $script:CloudFilling = $false }
    $note = Get-CloudNote
    $ui.MapCloudNote.Text = $note
    if ($cl.Unauthorized -or $cl.Error) { $ui.MapCloudNote.ForeColor = $script:Colors.Bad } else { $ui.MapCloudNote.ForeColor = $script:Colors.Muted }
    Update-ViewButtons
}

# Redraw after a change that is not a new session list.
function Update-CloudView {
    Update-CloudControls
    if ($script:View -eq 'map') { Update-MapLayout }
    $script:Ui.MapCanvas.Invalidate()
}

function Set-CloudData {
    param($Data, [string]$Fetched)
    $cl = $script:Cloud
    $cl.Data = $Data
    $cl.Fetched = $Fetched
    if (($null -ne $Data) -and ($null -ne $Data.Recorded)) { $cl.Sessions = @($Data.Recorded.Sessions) } else { $cl.Sessions = @() }
}

function Set-CloudResult {
    param($R)
    $cl = $script:Cloud
    $cl.Fetching = $false
    $status = [string]$R.Status
    if ($status -eq 'ok') {
        Set-CloudData $R.Data ([string]$R.Fetched)
        $cl.Fresh = $true; $cl.Offline = $false; $cl.Error = ''; $cl.Unauthorized = $false
        if ($R.CacheError) { Add-LogText ('Route Map: could not save the offline copy: ' + [string]$R.CacheError) }
    } elseif ($status -eq 'unauthorized') {
        # A wrong code is forgotten, so the field comes back and asks again.
        try { Clear-TeamCode } catch { }
        $cl.Code = ''; $cl.Unauthorized = $true; $cl.Offline = $false; $cl.Error = ''
    } elseif ($status -eq 'offline') {
        $cl.Offline = $true; $cl.Error = ''
        Add-LogText 'Route Map: no network, showing the saved copy.'
    } else {
        $cl.Offline = $false
        $cl.Error = [string]$R.Error
        if (-not $cl.Error) { $cl.Error = 'The route service did not answer properly.' }
        Add-LogText ('Route Map: ' + $cl.Error)
    }
    if ($cl.Again -and $cl.Code) { $cl.Again = $false; Start-CloudFetch }
    Update-MapSessions
}

# Shows the saved copy right away, once, without waiting for the network.
function Start-CloudCacheLoad {
    $cl = $script:Cloud
    if ($cl.CacheLoaded) { return }
    $cl.CacheLoaded = $true
    try {
        Start-BgJob $CloudCacheBody @{ Path = (Get-CloudCachePath) } {
            param($r)
            if (($r.Status -eq 'ok') -and (-not $script:Cloud.Fresh)) {
                Set-CloudData $r.Data ([string]$r.Fetched)
                Update-MapSessions
            }
        }
    } catch { }
}

function Start-CloudFetch {
    Initialize-Cloud
    $cl = $script:Cloud
    Start-CloudCacheLoad
    if (-not $cl.Code) { Update-CloudView; return }
    if ($cl.Fetching) { $cl.Again = $true; return }
    if (-not $script:ResultsUrl) {
        # The address comes with the uploader check, which may still be running.
        $cl.Pending = $true
        Update-CloudView
        return
    }
    $cl.Pending = $false
    $cl.Fetching = $true
    $cl.Again = $false
    Update-CloudView
    try {
        Start-BgJob $CloudBody @{ MapUrl = (Get-MapCloudUrl $script:ResultsUrl); Build = [string]$script:InstalledTag; Code = [string]$cl.Code; CachePath = (Get-CloudCachePath) } {
            param($r)
            Set-CloudResult $r
        }
    } catch {
        Set-CloudResult @{ Status = 'error'; Error = ('Could not start loading routes: ' + $_.Exception.Message) }
    }
}

# Called when the uploader check finishes: carry on with a fetch that was waiting for the address.
function Resume-CloudAfterManifest {
    param([bool]$Ok)
    $cl = $script:Cloud
    if (-not $cl.Pending) { return }
    $cl.Pending = $false
    if ($Ok -and $script:ResultsUrl) { Start-CloudFetch; return }
    $cl.Offline = $true
    Update-CloudView
}

function Start-MapRefresh {
    Start-MapLoad
    Start-CloudFetch
}

# Picking a route selects its raw recording when it has one. A recording from another
# taught route is let go, so only this route's lines are drawn.
function Set-CloudRoute {
    param([string]$Key)
    $cl = $script:Cloud
    $m = $script:Map
    $cl.Route = $Key
    $idx = Get-CloudRawIndex
    if ($idx -ge 0) {
        $m.Selected = $idx
        $m.SelectedFp = [string]$m.Sessions[$idx].Fingerprint
    } elseif (($m.Selected -ge 0) -and ($m.Selected -lt $m.Sessions.Count)) {
        $cur = $m.Sessions[$m.Selected]
        if (($cur.Source -eq 'cloud') -and $cur.ForSlot -and ([string]$cur.ForSlot -ine $Key)) { $m.Selected = -1; $m.SelectedFp = '' }
    }
    Update-MapPanel
}

function Select-CloudRoute {
    if ($script:CloudFilling) { return }
    $i = $script:Ui.MapRouteBox.SelectedIndex
    $routes = @(Get-CloudRoutes)
    if (($i -lt 0) -or ($i -ge $routes.Count)) { return }
    Set-CloudRoute ([string]$routes[$i].Key)
}

function Set-CloudSide {
    param([string]$Side)
    $script:Cloud.Side = $Side
    Update-ViewButtons
    $script:Ui.MapCanvas.Invalidate()
}

# The Use code button. The code is saved encrypted and is never written to the log.
function Submit-TeamCode {
    $ui = $script:Ui
    $text = $ui.MapCodeBox.Text.Trim()
    if (-not $text) { return }
    if ($text -notmatch '^[\x21-\x7e]{1,128}$') {
        $ui.MapCloudNote.Text = 'Type the code exactly as the programmer gave it, with no spaces.'
        $ui.MapCloudNote.ForeColor = $script:Colors.Bad
        Update-MapLayout
        return
    }
    Initialize-Cloud
    $cl = $script:Cloud
    $cl.Code = $text
    $cl.Unauthorized = $false
    try { Save-TeamCode $text } catch { Add-LogText 'Route Map: the team code could not be saved on this computer, so it will be asked for again next time.' }
    $ui.MapCodeBox.Clear()
    # A recording that went out without a code can be sent again now.
    if ($script:NeedsCodeFile -and (-not $script:SendPath) -and (Test-Path -LiteralPath $script:NeedsCodeFile)) {
        $script:SendPath = $script:NeedsCodeFile
        $script:NeedsCodeFile = ''
        $ui.SendButton.Enabled = (-not $script:Recording) -and (-not $script:Busy) -and (Test-HaveResults)
    }
    Start-CloudFetch
}

# The field with every point reflected for the Right side (the same y = -x reflection
# recordings use). Goals, toggles, and loose objects all map onto the field.
function Get-ViewField {
    param([string]$Side)
    $f = Get-MapField
    if ($Side -ne 'R') { return $f }
    if ($null -ne $script:MapFieldR) { return $script:MapFieldR }
    $goals = New-Object System.Collections.ArrayList
    foreach ($g in $f.Goals) { [void]$goals.Add(@($g[0], (0.0 - $g[2]), (0.0 - $g[1]))) }
    $toggles = New-Object System.Collections.ArrayList
    foreach ($t in $f.Toggles) { [void]$toggles.Add(@((0.0 - $t[1]), (0.0 - $t[0]))) }
    $objects = New-Object System.Collections.ArrayList
    foreach ($o in $f.Objects) { [void]$objects.Add(@((0.0 - $o[1]), (0.0 - $o[0]))) }
    $script:MapFieldR = @{
        Wall = $f.Wall; RobotLength = $f.RobotLength; RobotWidth = $f.RobotWidth
        Goals = @($goals.ToArray()); Toggles = @($toggles.ToArray()); Objects = @($objects.ToArray())
    }
    return $script:MapFieldR
}

# A recording (always stored in the LEFT frame) as it is drawn on the picked side.
function Get-ViewSession {
    param($S, [string]$Side)
    if ($Side -ne 'R') { return $S }
    $key = [string]$S.Fingerprint
    if ($script:MirrorCache.ContainsKey($key)) { return $script:MirrorCache[$key] }
    $out = Get-MirroredSession $S
    $out.Side = 'R'
    $script:MirrorCache[$key] = $out
    return $out
}

# One box around several boxes (nulls are skipped), or $null.
function Merge-Bounds {
    param($List)
    $out = $null
    foreach ($b in $List) {
        if ($null -eq $b) { continue }
        if ($null -eq $out) {
            $out = @{ MinX = $b.MinX; MaxX = $b.MaxX; MinY = $b.MinY; MaxY = $b.MaxY }
        } else {
            if ($b.MinX -lt $out.MinX) { $out.MinX = $b.MinX }
            if ($b.MaxX -gt $out.MaxX) { $out.MaxX = $b.MaxX }
            if ($b.MinY -lt $out.MinY) { $out.MinY = $b.MinY }
            if ($b.MaxY -gt $out.MaxY) { $out.MaxY = $b.MaxY }
        }
    }
    return $out
}

# Where things are on the field, in the LEFT frame (see include/field.hpp in the
# robot code). Goal spots, toggle spots, and the loose Cup and Pin spots are
# measured from the field kit's drawings, not from a real field, so they are
# approximate. The opponent's Goals are ours turned 180 degrees about the center.
function Get-MapField {
    if ($null -ne $script:MapField) { return $script:MapField }
    $script:MapField = @{
        Wall = 70.1
        RobotLength = 17.0
        RobotWidth = 16.0
        Goals = @(
            @('alliance', 23.6, -47.2), @('alliance', 47.2, -23.6),
            @('neutral', -23.6, -47.2), @('neutral', 47.2, 23.6), @('neutral', 0.0, 0.0),
            @('opponent', -23.6, 47.2), @('opponent', -47.2, 23.6),
            @('neutral', 23.6, 47.2), @('neutral', -47.2, -23.6)
        )
        Toggles = @(@(0.0, -70.1), @(70.1, 0.0), @(-70.1, 0.0), @(0.0, 70.1))
        Objects = @(@(-23.6, -68.7), @(23.6, -68.7), @(68.7, -23.6), @(0.0, -23.6), @(23.6, 0.0), @(47.2, -47.2), @(23.6, -23.6))
    }
    return $script:MapField
}

# One small symbol, centered on (X, Y), R pixels from center to edge. Goals use
# alliance, neutral, opponent. Marks use drop, pin, stack, toggle, push.
function Show-MapShape {
    param($G, $Pal, [string]$Kind, [double]$X, [double]$Y, [double]$R)
    $x0 = [single]($X - $R)
    $y0 = [single]($Y - $R)
    $d = [single](2.0 * $R)
    if ($Kind -eq 'alliance') {
        $G.FillEllipse($Pal.AccentTint, $x0, $y0, $d, $d)
        $G.DrawEllipse($Pal.AccentPen, $x0, $y0, $d, $d)
    } elseif ($Kind -eq 'neutral') {
        $G.FillEllipse($Pal.BackBrush, $x0, $y0, $d, $d)
        $G.DrawEllipse($Pal.MutedPen, $x0, $y0, $d, $d)
    } elseif ($Kind -eq 'opponent') {
        $G.FillRectangle($Pal.BadTint, $x0, $y0, $d, $d)
        $G.DrawRectangle($Pal.BadPen, $x0, $y0, $d, $d)
    } elseif ($Kind -eq 'drop') {
        $pts = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new([single]($X - $R), [single]($Y - 0.8 * $R)),
            [System.Drawing.PointF]::new([single]($X + $R), [single]($Y - 0.8 * $R)),
            [System.Drawing.PointF]::new([single]$X, [single]($Y + $R)))
        $G.FillPolygon($Pal.AccentBrush, $pts)
        $G.DrawPolygon($Pal.WhitePen, $pts)
    } elseif ($Kind -eq 'stack') {
        $G.FillRectangle($Pal.AccentBrush, $x0, $y0, $d, $d)
        $G.DrawRectangle($Pal.WhitePen, $x0, $y0, $d, $d)
    } elseif ($Kind -eq 'toggle') {
        $pts = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new([single]$X, [single]($Y - $R)),
            [System.Drawing.PointF]::new([single]($X + $R), [single]$Y),
            [System.Drawing.PointF]::new([single]$X, [single]($Y + $R)),
            [System.Drawing.PointF]::new([single]($X - $R), [single]$Y))
        $G.FillPolygon($Pal.AccentBrush, $pts)
        $G.DrawPolygon($Pal.WhitePen, $pts)
    } elseif ($Kind -eq 'push') {
        $G.DrawLine($Pal.CrossPen, [single]($X - $R), [single]$Y, [single]($X + $R), [single]$Y)
        $G.DrawLine($Pal.CrossPen, [single]$X, [single]($Y - $R), [single]$X, [single]($Y + $R))
    } else {
        # pin, and any mark type this version does not know
        $G.FillEllipse($Pal.AccentBrush, $x0, $y0, $d, $d)
        $G.DrawEllipse($Pal.WhitePen, $x0, $y0, $d, $d)
    }
}

# A recording's path as screen points. Long recordings are thinned to at most
# Max points: the line looks the same and a repaint stays quick.
function Get-ScreenPath {
    param($S, [int]$Max, [double]$Ox, [double]$Oy, [double]$Scale, [bool]$Mirror = $false)
    $n = $S.X.Length
    $list = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    if ($n -lt 1) { return ,$list.ToArray() }
    $stride = 1
    if ($n -gt $Max) { $stride = [int][math]::Ceiling($n / $Max) }
    # Mirror reflects each point across y = -x, so a Left-frame recording can be drawn on the Right side.
    for ($i = 0; $i -lt $n; $i += $stride) {
        $px = $S.X[$i]; $py = $S.Y[$i]
        if ($Mirror) { $px = 0.0 - $S.Y[$i]; $py = 0.0 - $S.X[$i] }
        [void]$list.Add([System.Drawing.PointF]::new([single]($Ox + $px * $Scale), [single]($Oy - $py * $Scale)))
    }
    $last = $n - 1
    if (($last % $stride) -ne 0) {
        $px = $S.X[$last]; $py = $S.Y[$last]
        if ($Mirror) { $px = 0.0 - $S.Y[$last]; $py = 0.0 - $S.X[$last] }
        [void]$list.Add([System.Drawing.PointF]::new([single]($Ox + $px * $Scale), [single]($Oy - $py * $Scale)))
    }
    return ,$list.ToArray()
}

# Paints the field and the selected recording. Field to scale: 1 inch = Scale
# pixels, screen x = Ox + x * Scale, screen y = Oy - y * Scale (field +Y is up).
function Show-RouteMapCanvas {
    param($G, $Size)
    $c = $script:Colors
    $f = $script:Fonts
    $m = $script:Map
    $vside = [string]$script:Cloud.Side
    $field = Get-ViewField $vside
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $G.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $G.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $G.Clear($c.HeaderBack)
    $W = [double]$Size.Width
    $H = [double]$Size.Height
    if (($W -lt 100) -or ($H -lt 160)) { return }

    $thin = [double][math]::Max(1, (Px 1))
    $mkPen = { param($col, $w) New-Object System.Drawing.Pen($col, [single]$w) }
    $pal = @{}
    try {
        $pal.BackBrush = New-Object System.Drawing.SolidBrush($c.Back)
        $pal.TintBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(16, $c.Accent))
        $pal.AccentBrush = New-Object System.Drawing.SolidBrush($c.Accent)
        $pal.AccentTint = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(64, $c.Accent))
        $pal.TextBrush = New-Object System.Drawing.SolidBrush($c.Text)
        $pal.MutedBrush = New-Object System.Drawing.SolidBrush($c.Muted)
        $pal.IdleBrush = New-Object System.Drawing.SolidBrush($c.Idle)
        $pal.ObjBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, $c.Idle))
        $pal.BadTint = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, $c.Bad))
        $pal.GoodBrush = New-Object System.Drawing.SolidBrush($c.Good)
        $pal.WarnBrush = New-Object System.Drawing.SolidBrush($c.Warn)
        $pal.BadBrush = New-Object System.Drawing.SolidBrush($c.Bad)
        $pal.GridPen = & $mkPen $c.Line $thin
        $pal.BorderPen = & $mkPen $c.Border ($thin * 1.5)
        $pal.AutoPen = & $mkPen $c.Warn ($thin * 1.5)
        $pal.AutoPen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
        $pal.TogglePen = & $mkPen $c.Idle (Px 4)
        $pal.AccentPen = & $mkPen $c.Accent ($thin * 1.5)
        $pal.MutedPen = & $mkPen $c.Muted ($thin * 1.5)
        $pal.BadPen = & $mkPen $c.Bad ($thin * 1.5)
        $pal.WhitePen = & $mkPen ([System.Drawing.Color]::White) ($thin * 1.5)
        $pal.CrossPen = & $mkPen $c.Accent (Px 3)
        $pal.PathPen = & $mkPen $c.Accent (Px 3)
        $pal.PathPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $pal.PathPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pal.PathPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pal.OtherPen = & $mkPen ([System.Drawing.Color]::FromArgb(150, $c.Idle)) (Px 2)
        $pal.OtherPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        # Predicted from the code: dashed gray. Clean route: dark solid.
        $pal.PredPen = & $mkPen $c.Muted (Px 3)
        $pal.PredPen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
        $pal.PredPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $pal.CleanPen = & $mkPen $c.Text (Px 2)
        $pal.CleanPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $pal.RobotPen = & $mkPen $c.Accent (Px 2)
        $pal.RobotFill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(48, $c.Accent))
        $pal.GoodPen = & $mkPen $c.Good (Px 2)
        $pal.WarnPen = & $mkPen $c.Warn (Px 2)
        $pal.BadLine = & $mkPen $c.Bad (Px 2)
        $pal.LinePen = & $mkPen $c.Line $thin

        # What to draw: the selected recording, framed to its path unless Whole field is on.
        $sel = $null
        if (($m.Selected -ge 0) -and ($m.Selected -lt $m.Sessions.Count)) { $sel = Get-ViewSession $m.Sessions[$m.Selected] $vside }
        $pred = Get-CloudPredicted
        $clean = Get-CloudClean
        $boxes = New-Object System.Collections.ArrayList
        if ($null -ne $sel) { [void]$boxes.Add((Get-SessionBounds $sel)) }
        if ($null -ne $pred) { [void]$boxes.Add((Get-SessionBounds $pred)) }
        if ($null -ne $clean) { [void]$boxes.Add((Get-SessionBounds $clean)) }
        $bounds = Merge-Bounds $boxes.ToArray()
        # Legend entries for the lines that are on the drawing.
        $lineItems = New-Object System.Collections.ArrayList
        $predLabel = ''
        if ($null -ne $pred) {
            $predLabel = Get-PredictedLabel
            $predText = 'Predicted'
            if ($null -ne $sel) { $predText = $predLabel }
            [void]$lineItems.Add(@('predline', $predText))
        }
        if ($null -ne $sel) {
            $rawText = 'Recorded'
            if ([string]$sel.Kind -like 'teach*') { $rawText = 'Raw' }
            [void]$lineItems.Add(@('rawline', $rawText))
        }
        if ($null -ne $clean) { [void]$lineItems.Add(@('cleanline', 'Clean')) }
        $legendExtra = 0.0
        if ($lineItems.Count -gt 0) { $legendExtra = [double](Px 20) }
        $areaTop = [double](Px 36)
        $areaBottom = $H - (Px 52) - $legendExtra
        $areaH = $areaBottom - $areaTop
        $vp = Get-MapViewport -Width $W -Height $areaH -Pad (Px 22) -Whole ([bool]$m.Whole) -Bounds $bounds -Wall $field.Wall
        $sc = [double]$vp.Scale
        $ox = $W / 2.0 - $vp.Cx * $sc
        $oy = $areaTop + $areaH / 2.0 + $vp.Cy * $sc

        $wall = [double]$field.Wall
        $left = $ox - $wall * $sc
        $top = $oy - $wall * $sc
        $side = 2.0 * $wall * $sc
        $G.SetClip([System.Drawing.RectangleF]::new(0, [single]$areaTop, [single]$W, [single]$areaH))

        # Floor, our side of the Autonomous Line (below y = x), tile seams, wall.
        $G.FillRectangle($pal.BackBrush, [single]$left, [single]$top, [single]$side, [single]$side)
        $tint = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new([single]$left, [single]($top + $side)),
            [System.Drawing.PointF]::new([single]($left + $side), [single]($top + $side)),
            [System.Drawing.PointF]::new([single]($left + $side), [single]$top))
        $G.FillPolygon($pal.TintBrush, $tint)
        # Tiles are about 23.6 in, the spacing of the Goals.
        foreach ($k in -2..2) {
            $gx = $ox + 23.6 * $k * $sc
            $gy = $oy - 23.6 * $k * $sc
            $G.DrawLine($pal.GridPen, [single]$gx, [single]$top, [single]$gx, [single]($top + $side))
            $G.DrawLine($pal.GridPen, [single]$left, [single]$gy, [single]($left + $side), [single]$gy)
        }
        $G.DrawRectangle($pal.BorderPen, [single]$left, [single]$top, [single]$side, [single]$side)
        # Autonomous Line, y = x, from the left back corner to the far right corner.
        $G.DrawLine($pal.AutoPen, [single]$left, [single]($top + $side), [single]($left + $side), [single]$top)

        # Toggle bars sit on the walls, about 25.8 in long.
        foreach ($t in $field.Toggles) {
            $tx = $ox + $t[0] * $sc
            $ty = $oy - $t[1] * $sc
            $half = 12.9 * $sc
            if ([math]::Abs($t[1]) -gt [math]::Abs($t[0])) {
                $G.DrawLine($pal.TogglePen, [single]($tx - $half), [single]$ty, [single]($tx + $half), [single]$ty)
            } else {
                $G.DrawLine($pal.TogglePen, [single]$tx, [single]($ty - $half), [single]$tx, [single]($ty + $half))
            }
        }
        # Loose Cups and Pins on our side, as small dots.
        $dot = [math]::Max((Px 2), 0.9 * $sc)
        foreach ($o in $field.Objects) {
            $G.FillEllipse($pal.ObjBrush, [single]($ox + $o[0] * $sc - $dot), [single]($oy - $o[1] * $sc - $dot), [single](2.0 * $dot), [single](2.0 * $dot))
        }
        # Goals: alliance filled circle, neutral open circle, opponent square.
        $goalR = [math]::Max((Px 5), 2.4 * $sc)
        foreach ($gl in $field.Goals) {
            Show-MapShape $G $pal ([string]$gl[0]) ($ox + $gl[1] * $sc) ($oy - $gl[2] * $sc) $goalR
        }

        # Recordings: the others faint, the selected one strong.
        $drawn = 0
        for ($i = $m.Sessions.Count - 1; ($i -ge 0) -and ($drawn -lt 30); $i--) {
            if ($i -eq $m.Selected) { continue }
            $pts = Get-ScreenPath $m.Sessions[$i] 160 $ox $oy $sc ($vside -eq 'R')
            if ($pts.Length -ge 2) { $G.DrawLines($pal.OtherPen, $pts); $drawn++ }
        }
        # The prediction, dashed, in the picked side's own frame.
        if ($null -ne $pred) {
            $pts = Get-ScreenPath $pred 500 $ox $oy $sc
            if ($pts.Length -ge 2) { $G.DrawLines($pal.PredPen, $pts) }
            if ($pts.Length -ge 1) {
                $sr = [double](Px 4)
                $G.FillEllipse($pal.BackBrush, [single]($pts[0].X - $sr), [single]($pts[0].Y - $sr), [single](2 * $sr), [single](2 * $sr))
                $G.DrawEllipse($pal.MutedPen, [single]($pts[0].X - $sr), [single]($pts[0].Y - $sr), [single](2 * $sr), [single](2 * $sr))
            }
        }
        # The cleaned route of a taught route: a line through its steps, a dot at each.
        if ($null -ne $clean) {
            $pts = Get-ScreenPath $clean 200 $ox $oy $sc
            if ($pts.Length -ge 2) { $G.DrawLines($pal.CleanPen, $pts) }
            $cr = [double](Px 3)
            foreach ($pt in $pts) { $G.FillEllipse($pal.TextBrush, [single]($pt.X - $cr), [single]($pt.Y - $cr), [single](2 * $cr), [single](2 * $cr)) }
        }
        if ($null -ne $sel) {
            $pts = Get-ScreenPath $sel 500 $ox $oy $sc
            if ($pts.Length -ge 2) { $G.DrawLines($pal.PathPen, $pts) }
            if ($pts.Length -ge 1) {
                $sr = [double](Px 4)
                $G.FillEllipse($pal.BackBrush, [single]($pts[0].X - $sr), [single]($pts[0].Y - $sr), [single](2 * $sr), [single](2 * $sr))
                $G.DrawEllipse($pal.AccentPen, [single]($pts[0].X - $sr), [single]($pts[0].Y - $sr), [single](2 * $sr), [single](2 * $sr))
            }
            # Step results: a line from where the step aimed to where the robot ended, colored by the miss.
            $er = [double](Px 4)
            foreach ($e in $sel.Events) {
                $want = Get-StepTargets ([string]$e.Type)
                if (-not $want.Pos) { continue }
                $ax = $ox + $e.X * $sc; $ay = $oy - $e.Y * $sc
                $bx = $ox + $e.Tx * $sc; $by = $oy - $e.Ty * $sc
                $band = Get-MissBand ([math]::Sqrt(($e.X - $e.Tx) * ($e.X - $e.Tx) + ($e.Y - $e.Ty) * ($e.Y - $e.Ty)))
                $linePen = $pal.GoodPen; $dotBrush = $pal.GoodBrush
                if ($band -eq 'warn') { $linePen = $pal.WarnPen; $dotBrush = $pal.WarnBrush }
                elseif ($band -eq 'bad') { $linePen = $pal.BadLine; $dotBrush = $pal.BadBrush }
                $G.DrawLine($linePen, [single]$bx, [single]$by, [single]$ax, [single]$ay)
                $G.DrawEllipse($pal.MutedPen, [single]($bx - $er), [single]($by - $er), [single](2 * $er), [single](2 * $er))
                $G.FillEllipse($dotBrush, [single]($ax - $er), [single]($ay - $er), [single](2 * $er), [single](2 * $er))
            }
            foreach ($mk in $sel.Marks) {
                Show-MapShape $G $pal ([string]$mk.Type) ($ox + $mk.X * $sc) ($oy - $mk.Y * $sc) (Px 6)
            }
            # Robot box at the last pose. Heading 0 faces +Y and turns clockwise.
            $has = $false
            $rx = 0.0; $ry = 0.0; $rh = 0.0
            $cnt = $sel.X.Length
            if ($cnt -gt 0) { $rx = $sel.X[$cnt - 1]; $ry = $sel.Y[$cnt - 1]; $rh = $sel.H[$cnt - 1]; $has = $true }
            elseif ($sel.Events.Count -gt 0) { $le = $sel.Events[$sel.Events.Count - 1]; $rx = $le.X; $ry = $le.Y; $rh = $le.H; $has = $true }
            if ($has) {
                $rad = $rh * [math]::PI / 180.0
                $fx = [math]::Sin($rad); $fy = [math]::Cos($rad)
                $sx = [math]::Cos($rad); $sy = -[math]::Sin($rad)
                $hl = $field.RobotLength / 2.0
                $hw = $field.RobotWidth / 2.0
                $corner = {
                    param($a, $b)
                    [System.Drawing.PointF]::new([single]($ox + ($rx + $fx * $a + $sx * $b) * $sc), [single]($oy - ($ry + $fy * $a + $sy * $b) * $sc))
                }
                $fr = & $corner $hl $hw
                $fl = & $corner $hl (-$hw)
                $bl = & $corner (-$hl) (-$hw)
                $br = & $corner (-$hl) $hw
                $box = [System.Drawing.PointF[]]@($fr, $fl, $bl, $br)
                $G.FillPolygon($pal.RobotFill, $box)
                $G.DrawPolygon($pal.RobotPen, $box)
                $G.DrawLine($pal.PathPen, $fr, $fl)
            }
        }
        # Which way is the station? Under the bottom wall when there is room.
        $below = $top + $side + (Px 2)
        if ((($below + (Px 15)) -le $areaBottom) -and ($vside -ne 'R')) {
            $lw = $G.MeasureString('Our station', $f.Small).Width
            $G.DrawString('Our station', $f.Small, $pal.MutedBrush, [single]($ox - $lw / 2.0), [single]$below)
        }
        $G.ResetClip()

        # Caption (top) and legend (bottom).
        $caption = ''
        $note = ''
        if ($null -ne $sel) {
            $caption = (Get-KindLabel ([string]$sel.Kind) 'L') + '   ' + (Format-MapWhen ([string]$sel.When)) + '   ' + $sel.Rows + ' rows'
            if ([string]$sel.WasSide -ne $vside) {
                if ($sel.WasSide -eq 'R') { $note = 'Recorded on the right side, shown mirrored' } else { $note = 'Recorded on the left side, shown mirrored' }
            }
        } elseif ($null -ne $pred) {
            $caption = $predLabel
        } elseif ($m.Loading) {
            $caption = 'Reading recordings...'
        } elseif ($m.Error) {
            $caption = 'Could not read the recordings'
        } elseif ($m.Loaded) {
            $caption = 'No recordings yet'
        }
        if ($caption) { $G.DrawString($caption, $f.Strong, $pal.TextBrush, [single](Px 14), [single](Px 8)) }
        if ($note) {
            $nw = $G.MeasureString($note, $f.Small).Width
            $G.DrawString($note, $f.Small, $pal.MutedBrush, [single]($W - $nw - (Px 14)), [single](Px 11))
        }
        if (($m.Sessions.Count -eq 0) -and $m.Loaded -and (-not $m.Loading) -and ($null -eq $pred)) {
            $cardW = [double](Px 300)
            $cardH = [double](Px 64)
            $card = [System.Drawing.RectangleF]::new([single]($W / 2.0 - $cardW / 2.0), [single]($areaTop + $areaH / 2.0 - $cardH / 2.0), [single]$cardW, [single]$cardH)
            $G.FillRectangle($pal.BackBrush, $card)
            $G.DrawRectangle($pal.LinePen, $card.X, $card.Y, $card.Width, $card.Height)
            $fmt = New-Object System.Drawing.StringFormat
            try {
                $fmt.Alignment = [System.Drawing.StringAlignment]::Center
                $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
                $inner = [System.Drawing.RectangleF]::new($card.X + (Px 12), $card.Y + (Px 6), $card.Width - (Px 24), $card.Height - (Px 12))
                $G.DrawString((Get-MapEmptyText), $f.Small, $pal.MutedBrush, $inner, $fmt)
            } finally { $fmt.Dispose() }
        }
        $r = [double](Px 5)
        $rows = New-Object System.Collections.ArrayList
        if ($lineItems.Count -gt 0) { [void]$rows.Add($lineItems.ToArray()) }
        [void]$rows.Add(@(@('drop', 'Drop'), @('pin', 'Pin'), @('stack', 'Stack'), @('toggle', 'Toggle'), @('push', 'Push')))
        [void]$rows.Add(@(@('alliance', 'Alliance goal'), @('neutral', 'Neutral goal'), @('opponent', 'Opponent goal'), @('line', 'Autonomous Line')))
        $linePens = @{ line = $pal.AutoPen; predline = $pal.PredPen; rawline = $pal.PathPen; cleanline = $pal.CleanPen }
        $rowY = $H - (Px 44) - $legendExtra
        foreach ($row in $rows) {
            $lx = [double](Px 14)
            foreach ($item in $row) {
                $cy = $rowY + (Px 8)
                if ($linePens.ContainsKey([string]$item[0])) {
                    $lineW = 2.0 * $r + (Px 6)
                    if ($item[0] -ne 'line') { $lineW = [double](Px 24) }
                    $G.DrawLine($linePens[[string]$item[0]], [single]$lx, [single]$cy, [single]($lx + $lineW), [single]$cy)
                    $lx += $lineW
                } else {
                    Show-MapShape $G $pal $item[0] ($lx + $r) $cy $r
                    $lx += 2.0 * $r
                }
                $lx += Px 5
                $G.DrawString($item[1], $f.Small, $pal.MutedBrush, [single]$lx, [single]$rowY)
                $lx += $G.MeasureString($item[1], $f.Small).Width + (Px 8)
            }
            $rowY += Px 20
        }
    } finally {
        foreach ($o in @($pal.Values)) { try { $o.Dispose() } catch { } }
    }
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
$script:UploadMode = 'Competition'
$script:ProsExe = $null
$script:Jobs = New-Object System.Collections.ArrayList
$script:Pool = $null
# Shared with background threads: Log = lines for the Details box,
# Procs = every pros.exe that is running right now (process id -> Process).
$script:Sync = [hashtable]::Synchronized(@{
    Log   = (New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]')
    Procs = [hashtable]::Synchronized(@{})
    RecordStop = $false
    RecordNote = ''
    Rec = $null
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

# The line under the Record button. Tester results keep their wording; an autopath
# recording shows its row count, then whether it arrived whole.
function Get-RecordStatusText {
    param($Rec)
    if ($null -eq $Rec) { return 'Recorded 0 values from 0 tests' }
    if (($Rec.Begun -gt 0) -or $Rec.Orphan) {
        if ($Rec.Open) { return ('Recording: ' + $Rec.Seen + ' of ' + $Rec.Expected + ' rows') }
        if ($Rec.Last -eq 'full') { return 'Got the full recording. Click Send Results.' }
        if ($Rec.Last -eq 'cut') { return 'That recording was cut off. Press X on the controller again.' }
    }
    return ('Recorded ' + $Rec.Values + ' values from ' + $Rec.Tests.Count + ' tests')
}

function Update-RecordingStatus {
    if ($script:ResultsPath) {
        $rec = $script:Sync.Rec
        # A whole autopath recording has arrived: stop by ourselves, so Send can be clicked.
        if ($script:Recording -and ($null -ne $rec) -and ($rec.Last -eq 'full') -and (-not $rec.Open) -and (-not $script:Sync.RecordStop)) { Stop-Recording }
        $newText = Get-RecordStatusText $script:Sync.Rec
        $textChanged = $script:Ui.ResultsStatus.Text -ne $newText
        $script:Ui.ResultsStatus.Text = $newText
        $script:Ui.OpenFolderLink.Visible = $true
        if ($textChanged) { Update-Layout }
        # Over a controller the terminal may need a few tries while the radio switches channel.
        $note = [string]$script:Sync.RecordNote
        if (($note -ne $script:LastRecordNote) -and $script:Recording) {
            $script:LastRecordNote = $note
            if ($note) { Set-Status $note 'working' } else { Set-Status 'Recording. On the controller, press X to send.' 'working' }
        }
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

# Picking a mode sets that mode's slot and name, and says so if this build
# does not have the mode.
function Set-ModeDefaults {
    $ui = $script:Ui
    $mode = $script:Modes[$ui.ModeBox.SelectedIndex]
    $ui.SlotBox.SelectedIndex = $mode.Slot - 1
    $ui.NameBox.Text = Get-NameForMode $ui.NameBox.Text $mode
    if (-not (Test-HaveMode $mode)) {
        if (Test-HaveCode) {
            Set-Status ('The downloaded build has no ' + $mode.Label + ' version. Click Get latest code, or ask the programmer.') 'error'
        } else {
            Set-Status 'No robot code downloaded yet. Click Get latest code first.' 'error'
        }
    }
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
    foreach ($ctl in @($ui.GetButton, $ui.UploadButton, $ui.TesterButton, $ui.RecordButton, $ui.SendButton, $ui.ModeBox, $ui.SlotBox, $ui.NameBox)) { $ctl.Enabled = -not $On }
    if ($script:Recording) { $ui.RecordButton.Enabled = $true }
    if (-not $On) {
        $ui.TesterButton.Enabled = Test-HaveTester
        $ui.SendButton.Enabled = (-not $script:Recording) -and (Test-HaveResults)
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
    elseif ($State -eq 'both') { $color = $c.Warn; $text = 'A brain and a controller are both plugged in' }
    elseif ($State -eq 'multiple') { $color = $c.Warn; $text = 'More than one VEX device plugged in' }
    elseif ($State -eq 'unknown') { $text = 'Connection status unavailable' }
    $script:ConnState = $State
    $ui.Dot.Tag = $color
    $ui.Dot.Invalidate()
    $ui.ConnLabel.Text = $text
    if ($State -eq 'brain') { $ui.ConnLabel.ForeColor = $c.Text } else { $ui.ConnLabel.ForeColor = $c.Muted }
}

# Shows what is downloaded, from version.json.
function Update-BuildInfo {
    $ui = $script:Ui
    $ui.TesterButton.Enabled = (Test-HaveTester) -and (-not $script:Busy)
    $ui.SendButton.Enabled = (-not $script:Recording) -and $script:SendPath -and (Test-Path $script:SendPath)
    $b = Get-InstalledBuild
    if (($null -eq $b) -or (-not (Test-HaveCode))) {
        $script:InstalledTag = ''
        $ui.BuildTitle.Text = 'No robot code downloaded yet'
        $ui.BuildMeta.Text = 'Click Get latest code to download it.'
    } else {
        $script:InstalledTag = [string]$b.tag
        $script:TesterBuildTag = if (Test-HaveTester) { $script:InstalledTag } else { '' }
        $parts = Split-ReleaseNotes ([string]$b.notes)
        $tag = [string]$b.tag
        $isCiBuildTag = $tag -match '^build-(\d+)-[0-9a-fA-F]+$'
        $title = ''
        if ($isCiBuildTag) { $title = 'Build ' + $Matches[1] }
        if (-not $title) { $title = $parts.Subject }
        if (-not $title) { $title = [string]$b.name }
        if (-not $title) { $title = 'Build ' + $tag }
        $ui.BuildTitle.Text = $title
        $sha = [string]$parts.Sha
        if (-not $sha -and ($tag -match '^build-\d+-([0-9a-fA-F]+)$')) {
            $sha = $Matches[1]
            if ($sha.Length -gt 7) { $sha = $sha.Substring(0, 7) }
        }
        $meta = ''
        if ($sha) { $meta = 'Commit ' + $sha }
        if (-not $isCiBuildTag) {
            if ($meta) { $meta += "`n" }
            $meta += 'Build ' + $tag
        }
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
    Start-BgJob $UploaderCheckBody @{ ManifestUrl = $script:UploaderManifestUrl; ForClick = [bool]$ForClick } {
        param($r)
        if ($r.Status -eq 'ok') {
            $script:ResultsUrl = [string]$r.ResultsUrl
            Resume-CloudAfterManifest $true
            try { $newer = ([version]$r.Version -gt [version]$script:UploaderVersion) } catch { $newer = $false }
            $script:LatestUploaderVersion = [string]$r.Version
            $script:UploaderUpdateReady = $newer
            Update-Notice
            if ($r.ForClick -and $newer) {
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
            } elseif ($r.ForClick) { Set-Busy $false; Start-Download -SkipUploaderUpdate }
        } elseif ($r.ForClick) { Set-Busy $false; Start-Download -SkipUploaderUpdate }
        if ($r.Status -ne 'ok') { Resume-CloudAfterManifest $false }
    }
}

function Start-Download {
    param([switch]$SkipUploaderUpdate)
    if ($script:Busy) { return }
    if (-not $SkipUploaderUpdate) {
        # Busy right away so a second click can't start a second check.
        Set-Busy $true 'download' 'Checking for updates...'
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
    $mode = $script:Modes[$script:Ui.ModeBox.SelectedIndex]
    if (-not (Test-HaveMode $mode)) {
        Set-Status ('The downloaded build has no ' + $mode.Label + ' version. Click Get latest code, or ask the programmer.') 'error'
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
    $script:UploadMode = $mode.Label

    # Competition uploads the downloaded folder as is. A test mode uploads a
    # staging copy with its own hot file swapped in.
    $uploadDir = $script:ProjectDir
    if ($mode.Asset -ne 'hot.package.bin') {
        try {
            $uploadDir = New-ModeProject -ProjectDir $script:ProjectDir -ModeAsset $mode.Asset -StageDir (Join-Path $InstallDir 'project.mode')
        } catch {
            Set-Status ('Could not prepare the ' + $mode.Label + ' files. ' + $_.Exception.Message) 'error'
            return
        }
    }

    Set-Busy $true 'upload' ('Uploading ' + $mode.Label + ' to slot ' + $script:UploadSlot + '. Keep the cable plugged in.')
    Add-LogText ('[' + (Get-Date).ToString('HH:mm:ss') + '] Uploading ' + $script:InstalledTag + ' (' + $mode.Label + ') to slot ' + $script:UploadSlot)
    $jobArgs = @{
        ProsExe    = $script:ProsExe
        ProjectDir = $uploadDir
        Slot       = $script:UploadSlot
        Name       = $name
        Timeout    = $script:UploadTimeoutSec
    }
    Start-BgJob $UploadBody $jobArgs {
        param($r)
        Set-Busy $false
        $outcome = Get-UploadOutcome -Run $r -Slot $script:UploadSlot
        $message = $outcome.Message -replace '^Uploaded to slot', ('Uploaded ' + $script:UploadMode + ' to slot')
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
    # A brain and a controller on two cables fight over the same radio and port.
    if ($script:ConnState -eq 'both') { Set-Status 'Unplug one cable: use the controller or the brain, not both.' 'error'; return }
    $folder = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scourge Robot Data'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $script:ResultsPath = Join-Path $folder ('results-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.csv')
    $script:Sync.RecordStop = $false
    $script:Sync.RecordNote = ''
    $script:Sync.Rec = New-RecordState
    $script:LastRecordNote = ''
    $script:Recording = $true
    $script:Ui.RecordButton.Text = 'Stop recording'
    $script:Ui.SendButton.Enabled = $false
    Set-Status 'Recording. On the controller, press X to send.' 'working'
    # Over a controller the PROS terminal can take several seconds to attach, so it is launched again for up to 30 s.
    $viaController = ($script:ConnState -eq 'controller')
    $script:RecordedViaController = $viaController
    Start-BgJob $RecordBody @{ ProsExe = $script:ProsExe; WorkDir = $InstallDir; FilePath = $script:ResultsPath; Retry = $viaController; ScriptPath = $script:UploaderScriptPath } {
        param($r)
        $script:Recording = $false
        $script:Ui.RecordButton.Text = 'Record results'
        # Decide which file Send uses before anything reads the Send button.
        $newHas = Test-HaveResults $script:ResultsPath
        $outcome = Get-RecordOutcome -Rec $script:Sync.Rec -PrevSendPath $script:SendPath -NewPath $script:ResultsPath -NewHasContent $newHas
        if ($outcome.UseNew) { $script:SendPath = $script:ResultsPath; $script:NeedsCodeFile = '' }
        $script:Ui.SendButton.Enabled = Test-HaveResults
        Update-RecordingStatus
        # The new file is complete now, so the Route Map can read it.
        if ($script:View -eq 'map') { Start-MapLoad }
        if ($r.Status -eq 'error') {
            Add-LogText ('Recording stderr: ' + [string]$r.Error)
            Set-DetailsVisible $true
            $errText = 'Recording stopped: ' + [string]$r.Error
            if ((-not $outcome.UseNew) -and $script:SendPath) { $errText += ' Send will use the earlier file (' + (Split-Path $script:SendPath -Leaf) + ').' }
            Set-Status $errText 'error'
        } else {
            $saved = $outcome.Message
            if ([string]$r.StopMode -eq 'clean') {
                Add-LogText 'Recording: the PROS terminal closed after Ctrl+C.'
            } elseif ([string]$r.StopMode -eq 'forced') {
                Add-LogText 'Recording: the PROS terminal did not close in 3 s and was ended.'
            }
            # Ctrl+C does not put a controller's radio back, so say what to do about it.
            if ($script:RecordedViaController) { $saved += ' If driving feels laggy, turn the controller off and on.' }
            Set-Status $saved $outcome.Kind
        }
    }
}

function Stop-Recording {
    $script:Sync.RecordStop = $true
    Set-Status 'Stopping recording...' 'working'
}

# True when the results file has at least one line after the CSV header.
function Test-HaveResults {
    param([string]$Path = $script:SendPath)
    if (-not $Path -or -not (Test-Path $Path)) { return $false }
    $lines = @(Get-Content -Path $Path -TotalCount 2 -ErrorAction SilentlyContinue)
    return $lines.Count -gt 1
}

# What a finished recording means for Send, and what to tell the person. A recording is
# worth sending when it holds a whole autopath recording or any tester values. Anything
# else (empty, or only a cut-off copy) does not replace an earlier file that Send can still use.
# Returns @{ UseNew; Message; Kind } where Kind is success or error.
function Get-RecordOutcome {
    param($Rec, [string]$PrevSendPath, [string]$NewPath, [bool]$NewHasContent)
    $good = ($null -ne $Rec) -and (($Rec.Full -gt 0) -or ($Rec.Values -gt 0))
    $cut = ($null -ne $Rec) -and (($Rec.Begun -gt 0) -or $Rec.Orphan) -and ($Rec.Last -eq 'cut')
    $hasPrev = [bool]$PrevSendPath -and (Test-Path -LiteralPath $PrevSendPath)
    $useNew = $good -or ($NewHasContent -and (-not $hasPrev))
    $kind = 'success'
    if ($cut) {
        $kind = 'error'
        $msg = 'That recording was cut off. Press X on the controller again.'
    } elseif (($null -ne $Rec) -and ($Rec.Last -eq 'full')) {
        $msg = 'Got the full recording. Click Send Results. Saved to ' + $NewPath
    } elseif (-not $NewHasContent) {
        $kind = 'error'
        $msg = 'Nothing was recorded.'
    } else {
        $msg = 'Results saved to ' + $NewPath
    }
    if ((-not $useNew) -and $hasPrev) { $msg += ' Send will use the earlier file (' + (Split-Path $PrevSendPath -Leaf) + ').' }
    return @{ UseNew = $useNew; Message = $msg; Kind = $kind }
}

# The status line after a good send. AutoState is from Get-AutopathFileState; OnMap is $true,
# $false, or $null (the service did not say). Returns @{ Text; Kind }.
function Get-SendDoneMessage {
    param([string]$AutoState, $OnMap, [string]$Issues)
    if ($AutoState -eq 'complete') {
        if ($OnMap -eq $false) { return @{ Text = "Sent, but it won't show on the Route Map without the team code. Enter it in Route Map, then send again."; Kind = 'error' } }
        return @{ Text = 'Sent. It shows on the Route Map in about a minute.'; Kind = 'success' }
    }
    if ($AutoState -eq 'cutoff') {
        return @{ Text = 'Sent, but that recording was cut off. Press X on the controller and record again.'; Kind = 'error' }
    }
    return @{ Text = ('Results sent to the programmer (issue ' + $Issues + ').'); Kind = 'success' }
}

# Reads the text of a results file: 'none' (no autopath recording in it), 'complete' (at
# least one whole recording), or 'cutoff' (an autopath recording started but none arrived whole).
function Get-AutopathFileState {
    param([string]$Text)
    if ($Text.IndexOf('SCOURGE,BEGIN,autopath,', [System.StringComparison]::Ordinal) -lt 0) { return 'none' }
    if ((ConvertFrom-ScourgeWire $Text).Sessions.Count -gt 0) { return 'complete' }
    return 'cutoff'
}

function Open-ResultsFolder {
    $folder = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scourge Robot Data'
    if ($script:ResultsPath) { $folder = Split-Path $script:ResultsPath -Parent }
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    Start-Process explorer.exe -ArgumentList ('"' + $folder + '"')
}

# The old way: open a new-issue page in the browser (needs a GitHub login with access to the repo).
function Open-ResultsIssuePage {
    param([string]$Title, [string]$Body, [string]$Prefix)
    $newIssue = 'https://github.com/Whyater/40217S-Robot-Data/issues/new?title=' + [uri]::EscapeDataString($Title)
    # GitHub cuts an issue body at 65536 characters, so a longer paste would silently lose rows.
    if ($Body.Length -gt 60000) {
        Set-Status ('Could not send the results, and they are too long for the issue page, so nothing was opened. They are saved at ' + $script:SendPath + '. Ask the programmer.') 'error'
        return
    }
    # EscapeDataString throws on very long text, so check the raw length first.
    $url = ''
    if ($Body.Length -le 5000) { $url = $newIssue + '&body=' + [uri]::EscapeDataString($Body) }
    if ((-not $url) -or ($url.Length -gt 7000)) {
        Set-Clipboard -Value $Body
        Start-Process $newIssue
        Set-Status ($Prefix + 'Paste the results into the box (Ctrl+V), then click Submit new issue. Saved at ' + $script:SendPath) 'info'
    } else {
        Start-Process $url
        Set-Status ($Prefix + 'New issue page opened. Saved at ' + $script:SendPath) 'info'
    }
}

# Sends the results through the relay (results_url in uploader.json), which files them as an issue
# with no GitHub login. Falls back to the browser page if there is no relay or it fails.
function Send-Results {
    if ($script:Busy) { return }
    if ($script:Recording) { Set-Status 'Stop recording before sending results.' 'error'; return }
    if (-not $script:SendPath -or -not (Test-Path $script:SendPath)) { Set-Status 'No results yet.' 'error'; return }
    $lines = Get-Content -Path $script:SendPath -ErrorAction SilentlyContinue
    if ($lines.Count -le 1) { Set-Status 'No results yet.' 'error'; return }
    $date = (Get-Date).ToString('yyyy-MM-dd')
    $tag = if ($script:TesterBuildTag) { $script:TesterBuildTag } else { 'unknown' }
    $body = 'Uploader ' + $script:UploaderVersion + ', tester build ' + $tag + ', UTC ' + [DateTime]::UtcNow.ToString('o') + "`r`n`r`n" + (($lines | Select-Object -Skip 1) -join "`r`n")
    $title = 'Robot data ' + $date
    if (-not $script:ResultsUrl) {
        Open-ResultsIssuePage -Title $title -Body $body -Prefix ''
        return
    }
    # The job finishes later on the UI timer, outside this function, so keep what the fallback needs.
    # A route recording counts as sent only if a whole one is in the file.
    $autoState = Get-AutopathFileState (($lines | Select-Object -Skip 1) -join "`n")
    $script:PendingResults = @{ Title = $title; Body = $body; AutoState = $autoState; Path = $script:SendPath }
    Initialize-Cloud
    # The relay takes up to 600000 characters (it splits them into issues itself). A longer
    # file is never cut: it is kept on disk and the person is told.
    if ($body.Length -gt 600000) {
        $script:PendingResults = $null
        Set-Status ('This file is too long to send in one go (' + $body.Length + ' characters, the limit is 600000). It is saved at ' + $script:SendPath + '. Ask the programmer.') 'error'
        return
    }
    Set-Busy $true 'send' 'Sending results...'
    Start-BgJob $SendBody @{ ResultsUrl = $script:ResultsUrl; Title = $title; Body = $body; Version = $script:UploaderVersion; Code = [string]$script:Cloud.Code } {
        param($r)
        $pending = $script:PendingResults
        $script:PendingResults = $null
        # A good send uses the file up: Send stays off until there is a new recording.
        if ($r.Status -eq 'success') { $script:SendPath = '' }
        Set-Busy $false
        if ($r.Status -eq 'success') {
            $issues = '#' + (@($r.Issues) -join ', #')
            Add-LogText ('Results sent as issue ' + $issues + '.')
            $done = Get-SendDoneMessage -AutoState ([string]$pending.AutoState) -OnMap $r.OnMap -Issues $issues
            Set-Status $done.Text $done.Kind
            # Not on the map for want of a team code: remember the file so entering the code can offer it again.
            if (($pending.AutoState -eq 'complete') -and ($r.OnMap -eq $false)) { $script:NeedsCodeFile = [string]$pending.Path }
            # Ask for the map now; the new recording appears once the service has filed it.
            Start-CloudFetch
        } else {
            Add-LogText ('Could not send results directly: ' + [string]$r.Error)
            Open-ResultsIssuePage -Title $pending.Title -Body $pending.Body -Prefix 'Could not send directly, so the issue page opened instead. '
        }
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

    # Builds recording text the way the robot sends it: BEGIN, rows numbered from 0,
    # END. Path = points in inches, 10 samples between points at 20 Hz. Marks and
    # Steps carry At = the path point they happen at. Used for the Route Map checks.
    function New-SampleWire {
        param([string]$Kind, [string]$Side, $Path, $Marks, $Steps)
        $q = { param($v) [string][int][math]::Round([double]$v * 100.0) }
        $rows = New-Object System.Collections.Generic.List[string]
        $t = 0
        $heading = 0.0
        $last = $Path[0]
        for ($k = 0; $k -lt $Path.Count; $k++) {
            $p = $Path[$k]
            if ($k -eq 0) {
                $rows.Add('SCOURGE,AP,' + $rows.Count + ',0;' + (& $q $p[0]) + ';' + (& $q $p[1]) + ';0;0;0;0;0;0,')
            } else {
                $dx = $p[0] - $last[0]
                $dy = $p[1] - $last[1]
                $heading = [math]::Atan2($dx, $dy) * 180.0 / [math]::PI
                for ($i = 1; $i -le 10; $i++) {
                    $t += 50
                    $rows.Add('SCOURGE,AP,' + $rows.Count + ',' + $t + ';' + (& $q ($last[0] + $dx * $i / 10.0)) + ';' + (& $q ($last[1] + $dy * $i / 10.0)) + ';' + (& $q $heading) + ';0;0;0;0;0,')
                }
            }
            $last = $p
            foreach ($mk in $Marks) {
                if ($mk.At -eq $k) { $rows.Add('SCOURGE,AM,' + $rows.Count + ',' + $t + ';' + $mk.Type + ';' + (& $q $mk.X) + ';' + (& $q $mk.Y) + ';' + (& $q $heading) + ';300;0;0,') }
            }
            foreach ($st in $Steps) {
                if ($st.At -eq $k) {
                    $rows.Add('SCOURGE,AS,' + $rows.Count + ',' + $t + ';' + $st.Step + ';' + $st.Type + ';' + (& $q $st.Target[0]) + ';' + (& $q $st.Target[1]) + ';' + (& $q $st.Target[2]) + ';' + (& $q $st.Actual[0]) + ';' + (& $q $st.Actual[1]) + ';' + (& $q $st.Actual[2]) + ';' + $st.Ok + ',')
                }
            }
        }
        $n = $rows.Count
        return ('SCOURGE,BEGIN,autopath,1;' + $Kind + ';' + $Side + ';' + $n + ';selftest,' + "`n" + ($rows.ToArray() -join "`n") + "`n" + 'SCOURGE,END,autopath,' + $n + ',' + "`n")
    }

    # 0. Route Map reader and math, against numbers worked out by hand.
    $mapFails = New-Object System.Collections.Generic.List[string]
    $near = { param($a, $b) ([math]::Abs([double]$a - [double]$b) -lt 0.000001) }
    $expect = { param($ok, $what) if (-not $ok) { [void]$mapFails.Add($what) } }
    try {
        $header = 'kind,test,key,value,unit'
        $fixA = (@($header,
            'SCOURGE,BEGIN,autopath,1;teach_open;L;4;build-1,',
            'SCOURGE,AP,0,0;800;-6160;0;0;0;0;0;0,',
            'SCOURGE,AP,1,50;900;-5500;1000;0;0;0;0;0,',
            'SCOURGE,AM,2,100;drop;1000;-5000;4500;300;0;0,',
            'SCOURGE,AP,3,150;1100;-4800;4500;0;0;0;0;0,',
            'SCOURGE,END,autopath,4,') -join "`n") + "`n"
        # Rows 0 and 2 arrive, row 1 never does.
        $fixGap = (@('SCOURGE,BEGIN,autopath,1;run;L;3;build-1,',
            'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,',
            'SCOURGE,AP,2,100;100;100;0;0;0;0;0;0,',
            'SCOURGE,END,autopath,3,') -join "`n") + "`n"
        $fixCut = (@('SCOURGE,BEGIN,autopath,1;push;L;2;build-1,',
            'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,',
            'SCOURGE,AP,1,50;0;100;0;0;0;0;0;0,') -join "`n") + "`n"
        # Right side. Raw (x 10, y 20, heading 30) must become (-20, -10, 240).
        $fixR = (@('SCOURGE,BEGIN,autopath,1;run;R;4;build-1,',
            'SCOURGE,AP,0,0;1000;2000;3000;0;0;0;0;0,',
            'SCOURGE,AP,1,100;-500;0;30000;0;0;0;0;0,',
            'SCOURGE,AS,2,200;3;drive;1000;2000;0;1300;2400;0;1,',
            'SCOURGE,AS,3,300;4;turn;0;0;1000;0;0;35000;1,',
            'SCOURGE,END,autopath,4,') -join "`n") + "`n"

        # Complete recording: hundredths become inches and degrees, text before SCOURGE is dropped.
        $noisy = (($fixA -split "`n" | ForEach-Object { if ($_ -like 'SCOURGE,*') { '[12:00:01] pros: ' + $_ } else { $_ } }) -join "`r`n")
        foreach ($variant in @($fixA, $noisy)) {
            $p = ConvertFrom-ScourgeWire $variant
            & $expect ($p.Sessions.Count -eq 1) 'complete recording was not accepted'
            if ($p.Sessions.Count -eq 1) {
                $s = $p.Sessions[0]
                & $expect ($s.Kind -eq 'teach_open' -and $s.Side -eq 'L' -and $s.Rows -eq 4) 'BEGIN fields wrong'
                & $expect ($s.X.Length -eq 3 -and $s.Marks.Count -eq 1 -and $s.Events.Count -eq 0) 'row counts wrong'
                & $expect ((& $near $s.X[0] 8.0) -and (& $near $s.Y[0] -61.6) -and (& $near $s.H[1] 10.0) -and (& $near $s.X[2] 11.0) -and (& $near $s.T[2] 0.15)) 'hundredths and milliseconds wrong'
                & $expect ($s.Marks[0].Type -eq 'drop' -and (& $near $s.Marks[0].X 10.0) -and (& $near $s.Marks[0].Y -50.0) -and (& $near $s.Marks[0].H 45.0) -and $s.Marks[0].Lift -eq 300) 'mark fields wrong'
            }
        }
        # A gap is rejected, with the missing row named. A cut-off send is rejected too.
        $p = ConvertFrom-ScourgeWire $fixGap
        & $expect (($p.Sessions.Count -eq 0) -and ($p.Rejected.Count -eq 1)) 'gap was not rejected'
        if ($p.Rejected.Count -eq 1) {
            $rj = $p.Rejected[0]
            & $expect ($rj.Got -eq 2 -and $rj.Expected -eq 3 -and $rj.MissingCount -eq 1 -and $rj.Missing[0] -eq 1) 'gap numbers wrong'
            & $expect ($rj.Text -like '*received 2 of 3 rows with gaps*' -and $rj.Text -like '*Missing row numbers: 1.*') 'gap message wrong'
        }
        $p = ConvertFrom-ScourgeWire $fixCut
        & $expect (($p.Sessions.Count -eq 0) -and ($p.Rejected.Count -eq 1) -and ($p.Rejected[0].Text -like '*no END*')) 'cut-off send was not rejected'
        # A whole recording sent twice is kept once. A bad copy before a good one still shows as rejected.
        $p = ConvertFrom-ScourgeWire ($fixA + $fixA)
        & $expect ($p.Sessions.Count -eq 1) 'repeat was not kept once'
        $p = ConvertFrom-ScourgeWire ($fixGap + $fixA)
        & $expect (($p.Sessions.Count -eq 1) -and ($p.Rejected.Count -eq 1)) 'bad copy then good copy wrong'

        # Right side to left frame: (x, y) -> (-y, -x), heading -> 270 - heading.
        $p = ConvertFrom-ScourgeWire $fixR
        $raw = $p.Sessions[0]
        & $expect ($raw.Side -eq 'R' -and (& $near $raw.X[0] 10.0) -and (& $near $raw.Y[0] 20.0) -and (& $near $raw.H[0] 30.0)) 'right-side raw values wrong'
        $left = ConvertTo-LeftFrame $raw
        & $expect ($left.Side -eq 'L' -and $left.WasSide -eq 'R') 'mirror did not set the side'
        & $expect ((& $near $left.X[0] -20.0) -and (& $near $left.Y[0] -10.0) -and (& $near $left.H[0] 240.0)) 'mirror of (10, 20, 30) should be (-20, -10, 240)'
        & $expect ((& $near $left.X[1] 0.0) -and (& $near $left.Y[1] 5.0) -and (& $near $left.H[1] -30.0)) 'mirror of (-5, 0, 300) should be (0, 5, -30)'
        & $expect ((& $near $left.Events[0].Tx -20.0) -and (& $near $left.Events[0].Ty -10.0) -and (& $near $left.Events[0].Th 270.0) -and (& $near $left.Events[0].X -24.0) -and (& $near $left.Events[0].Y -13.0)) 'mirror of step target and actual wrong'
        $zero = ConvertTo-LeftFrame (ConvertFrom-ScourgeWire ((@('SCOURGE,BEGIN,autopath,1;run;R;1;b,', 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,', 'SCOURGE,END,autopath,1,') -join "`n") + "`n")).Sessions[0]
        & $expect (([string]$zero.X[0] -eq '0') -and ([string]$zero.Y[0] -eq '0')) 'a zero must stay 0, not -0'

        # Miss: target (10, 20) to final (13, 24) is a 3-4-5 triangle, so 5.00 in.
        foreach ($sess in @($raw, $left)) {
            $mr = @(Get-MissRows $sess)
            & $expect ($mr.Count -eq 2) 'miss table should have 2 rows'
            if ($mr.Count -eq 2) {
                & $expect ($mr[0].Step -eq 3 -and $mr[0].Type -eq 'drive' -and ([math]::Round($mr[0].Miss, 2) -eq 5.00) -and $mr[0].Band -eq 'bad' -and ($null -eq $mr[0].HMiss)) 'drive miss should be 5.00 in'
                & $expect ($null -eq $mr[1].Miss -and (& $near $mr[1].HMiss 20.0) -and $mr[1].Band -eq 'none') 'turn: heading 350 vs 10 should be 20 deg and no distance'
            }
        }
        $openRow = @(Get-MissRows @{ Events = @(@{ Step = -1; Type = 'opening'; Tx = 0.0; Ty = 0.0; Th = 0.0; X = 5.0; Y = 5.0; H = 0.0; Ok = 1 }) })
        & $expect ($openRow.Count -eq 1 -and $null -eq $openRow[0].Miss -and $null -eq $openRow[0].HMiss) 'the opening has no target to miss'
        & $expect ((Get-MissBand 0.99) -eq 'good' -and (Get-MissBand 1.0) -eq 'warn' -and (Get-MissBand 2.99) -eq 'warn' -and (Get-MissBand 3.0) -eq 'bad') 'miss color bands wrong'

        # Framing: whole field, 701 px for 140.2 in is 5 px per inch. Fit: a 40 x 20 in path plus
        # 12 in each side is 64 x 60 in, so 640 x 600 px gives 10 px per inch around (20, 10).
        $vp = Get-MapViewport -Width 701 -Height 701 -Pad 0 -Whole $true -Bounds $null
        & $expect ((& $near $vp.Scale 5.0) -and (& $near $vp.Cx 0.0) -and (& $near $vp.Cy 0.0)) 'whole field framing wrong'
        $vp = Get-MapViewport -Width 640 -Height 600 -Pad 0 -Whole $false -Bounds @{ MinX = 0.0; MaxX = 40.0; MinY = 0.0; MaxY = 20.0 }
        & $expect ((& $near $vp.Scale 10.0) -and (& $near $vp.Cx 20.0) -and (& $near $vp.Cy 10.0)) 'fit-to-path framing wrong'
        $bx = Get-SessionBounds (ConvertFrom-ScourgeWire $fixA).Sessions[0]
        & $expect ((& $near $bx.MinX 8.0) -and (& $near $bx.MaxX 11.0) -and (& $near $bx.MinY -61.6) -and (& $near $bx.MaxY -48.0)) 'path bounds wrong'
        & $expect ((Format-MapWhen '2026-10-30 10:15') -eq 'Oct 30, 10:15 AM') 'time text wrong'

        # The folder reader, on real files: a repeat across two files, a gap, a file still being written.
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('scourge-map-test-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $writer = $null
        try {
            [System.IO.File]::WriteAllText((Join-Path $tmp 'results-20261030-101500.csv'), ($header + "`n" + $fixA + $fixGap), $utf8)
            [System.IO.File]::WriteAllText((Join-Path $tmp 'results-20261030-103000.csv'), ($header + "`n" + $fixR), $utf8)
            [System.IO.File]::WriteAllText((Join-Path $tmp 'results-20261030-104500.csv'), ($header + "`n" + $fixA), $utf8)
            [System.IO.File]::WriteAllText((Join-Path $tmp 'notes.csv'), 'not a results file', $utf8)
            $cache = [hashtable]::Synchronized(@{})
            $res = Read-ScourgeResults -Folder $tmp -Cache $cache
            & $expect ($res.Status -eq 'ok' -and $res.Files -eq 3 -and $res.Sessions.Count -eq 2) 'folder: expected 3 files and 2 sessions'
            & $expect ($res.Rejected.Count -eq 1 -and $res.Rejected[0].Text -like 'results-20261030-101500.csv: *') 'folder: the gap should show once, with its file name'
            if ($res.Sessions.Count -eq 2) {
                & $expect ($res.Sessions[0].WasSide -eq 'R' -and $res.Sessions[0].Side -eq 'L' -and (& $near $res.Sessions[0].X[0] -20.0)) 'folder: right-side session should arrive mirrored'
                & $expect ($res.Sessions[1].Source -eq 'results-20261030-104500.csv' -and $res.Sessions[1].When -eq '2026-10-30 10:45') 'folder: the last copy of the repeat should win'
            }
            $again = Read-ScourgeResults -Folder $tmp -Cache $cache
            & $expect ($cache.Count -eq 3 -and $again.Sessions.Count -eq 2) 'folder: cached read gave a different answer'
            $skipped = Read-ScourgeResults -Folder $tmp -Skip @((Join-Path $tmp 'results-20261030-103000.csv'))
            & $expect ($skipped.Files -eq 2 -and $skipped.Sessions.Count -eq 1) 'folder: Skip should leave a file out'
            $writer = New-Object System.IO.StreamWriter((Join-Path $tmp 'results-20261030-110000.csv'), $false, $utf8)
            $writer.WriteLine($header)
            $writer.WriteLine('SCOURGE,BEGIN,autopath,1;run;L;5;build-1,')
            $writer.Flush()
            $open = Read-ScourgeResults -Folder $tmp
            & $expect ($open.Unreadable -eq 0 -and $open.Files -eq 4) 'folder: a file that is still open should be readable'
            $bigPath = Join-Path $tmp 'results-20261030-120000.csv'
            $bigStream = [System.IO.File]::Create($bigPath)
            try { $bigStream.SetLength(51MB) } finally { $bigStream.Dispose() }
            $big = Read-ScourgeResults -Folder $tmp
            & $expect ($big.Unreadable -eq 1 -and (@($big.Rejected | Where-Object { $_.Text -like 'results-20261030-120000.csv: skipped*50 MB*' }).Count -eq 1)) 'folder: a file over 50 MB should be skipped and reported'
            $nothing = Read-ScourgeResults -Folder (Join-Path $tmp 'missing')
            & $expect ($nothing.Status -eq 'ok' -and $nothing.Sessions.Count -eq 0) 'folder: a missing folder should read as empty'
        } finally {
            if ($null -ne $writer) { $writer.Dispose() }
            Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {
        [void]$mapFails.Add('route map check threw: ' + $_.Exception.Message)
    }
    if ($mapFails.Count -eq 0) {
        Write-Host '  Route Map reader and math: OK'
    } else {
        foreach ($mf in $mapFails) { $failures.Add('route map: ' + $mf) }
        Write-Host ('  Route Map reader and math: FAIL (' + ($mapFails -join '; ') + ')')
    }

    # 0b. Route Map cloud data, recording counts, and the clean stop. No real network is used:
    #     the round trip talks to a small listener on this computer's loopback address.
    $cloudFails = New-Object System.Collections.Generic.List[string]
    $expectC = { param($ok, $what) if (-not $ok) { [void]$cloudFails.Add($what) } }
    $savedCloud = $script:Cloud.Clone()
    $savedSettings = $script:SettingsPath
    $cloudJson = (@(
        '{"ok":true,',
        '"sim":{"schema":1,"tag":"build-70-abc1234","build":70,"commit":"abc1234","generated":"2026-10-30T23:00:00Z","assumptions":"sample","routes":[',
        '{"id":"awp-L","slot":null,"name":"AWP","side":"L","total_ms":2000,"samples":[{"t":0,"x":8,"y":-61.6,"h":0},{"t":1000,"x":10.5,"y":-35,"h":4.3},{"t":2000,"x":20.4,"y":-38.3,"h":146}],"events":[]},',
        '{"id":"awp-R","slot":null,"name":"AWP","side":"R","total_ms":2000,"samples":[{"t":0,"x":8,"y":-61.6,"h":0},{"t":1000,"x":10.5,"y":-35,"h":4.3},{"t":2000,"x":20.4,"y":-38.3,"h":146}],"events":[]},',
        '{"id":"taught-A-L","slot":"A","name":"Taught A","side":"L","total_ms":1000,"samples":[{"t":0,"x":8,"y":-61.6,"h":0},{"t":1000,"x":30,"y":-52,"h":45}],"events":[]}]},',
        '"sim_is_latest":false,',
        '"recorded":{"time_unit":"ms","field":{},',
        '"routes":[{"slot":"A","start":{"kind":"pose","x":8,"y":-61.6,"theta":0},"steps":[],"checks":{},"waypoints":[{"x":10,"y":-35,"heading":4.3,"step":1},{"x":20.4,"y":-38.3,"heading":146,"step":5}]}],',
        '"sessions":[',
        '{"id":"results-20261029-163000","kind":"teach_open","side":"L","when":"2026-10-29 16:30","build":"build-70","for_slot":"A","samples":[{"t":0,"x":8,"y":-61.6,"h":0},{"t":50,"x":9,"y":-55,"h":10},{"t":150,"x":11,"y":-48,"h":45}],"marks":[{"t":100,"type":"drop","x":10,"y":-50,"h":45,"lift":300}],"events":[]},',
        '{"id":"results-20261030-101500","kind":"run","side":"R","when":"2026-10-30 10:15","build":"build-70-A","for_slot":"A","samples":[{"t":0,"x":0,"y":0,"h":0},{"t":1200,"x":-5,"y":10,"h":90}],"marks":[],"events":[{"t":900,"step":0,"type":"drive","tx":10,"ty":20,"th":0,"x":13,"y":24,"h":5,"ok":true},{"t":1100,"step":1,"type":"turn","tx":0,"ty":0,"th":10,"x":0,"y":0,"h":350,"ok":false}]}]},',
        '"recorded_updated":"2026-10-30T23:01:00Z"}') -join '')
    try {
        # Parsing: numbers, sides, keys, rows, and the ok flag.
        $cp = ConvertFrom-CloudMap $cloudJson
        & $expectC ($cp.Status -eq 'ok') 'cloud: a good answer was not accepted'
        if ($cp.Status -eq 'ok') {
            & $expectC (($null -ne $cp.Sim) -and $cp.Sim.Build -eq 70 -and $cp.Sim.Tag -eq 'build-70-abc1234' -and $cp.Sim.Routes.Count -eq 3 -and (-not $cp.SimIsLatest)) 'cloud: sim header wrong'
            if ($cp.Sim.Routes.Count -eq 3) {
                $r0 = $cp.Sim.Routes[0]
                & $expectC ($r0.Key -eq 'AWP' -and $r0.Side -eq 'L' -and $r0.T.Length -eq 3) 'cloud: AWP left route wrong'
                & $expectC ((& $near $r0.X[0] 8.0) -and (& $near $r0.Y[0] -61.6) -and (& $near $r0.T[1] 1.0) -and (& $near $r0.H[2] 146.0) -and (& $near $r0.Y[1] -35.0)) 'cloud: sim numbers wrong (milliseconds should become seconds)'
                & $expectC ($cp.Sim.Routes[1].Side -eq 'R' -and (& $near $cp.Sim.Routes[1].X[0] 8.0) -and (& $near $cp.Sim.Routes[1].Y[0] -61.6)) 'cloud: AWP right route should arrive in the left frame, equal to the left one'
                & $expectC ($cp.Sim.Routes[2].Key -eq 'A') 'cloud: taught route key should be its slot'
            }
            & $expectC (($null -ne $cp.Recorded) -and $cp.Recorded.Routes.Count -eq 1 -and $cp.Recorded.Sessions.Count -eq 2) 'cloud: recorded counts wrong'
            if ($null -ne $cp.Recorded -and $cp.Recorded.Routes.Count -eq 1) {
                $rr0 = $cp.Recorded.Routes[0]
                & $expectC ($rr0.Slot -eq 'A' -and $rr0.HasStart -and (& $near $rr0.StartX 8.0) -and $rr0.Wp.Count -eq 2 -and $rr0.Wp[1].Step -eq 5 -and (& $near $rr0.Wp[0].H 4.3)) 'cloud: recorded route wrong'
            }
            if ($null -ne $cp.Recorded -and $cp.Recorded.Sessions.Count -eq 2) {
                $c0 = $cp.Recorded.Sessions[0]
                $c1 = $cp.Recorded.Sessions[1]
                & $expectC ($c0.Kind -eq 'teach_open' -and $c0.WasSide -eq 'L' -and $c0.Rows -eq 4 -and $c0.ForSlot -eq 'A' -and $c0.Source -eq 'cloud' -and $c0.T.Length -eq 3) 'cloud: teach session fields wrong'
                & $expectC ((& $near $c0.T[2] 0.15) -and (& $near $c0.X[1] 9.0) -and $c0.Marks.Count -eq 1 -and $c0.Marks[0].Type -eq 'drop' -and $c0.Marks[0].Lift -eq 300 -and (& $near $c0.Marks[0].T 0.1)) 'cloud: teach numbers wrong'
                & $expectC ($c1.WasSide -eq 'R' -and $c1.Side -eq 'L' -and $c1.Events.Count -eq 2 -and $c1.Events[0].Ok -eq 1 -and $c1.Events[1].Ok -eq 0 -and $c1.Events[0].Step -eq 0 -and $c1.Events[1].Step -eq 1) 'cloud: run events wrong (ok true/false should be 1/0)'
                & $expectC ($c0.Fingerprint -ne $c1.Fingerprint) 'cloud: two sessions share a fingerprint'
                $mrow = @(Get-MissRows $c1)
                & $expectC ($mrow.Count -eq 2 -and ([math]::Round($mrow[0].Miss, 2) -eq 5.00)) 'cloud: a cloud run should give the same 3-4-5 miss as a local one'
            }
        }
        $cn = ConvertFrom-CloudMap '{"ok":true,"sim":null,"recorded":null}'
        & $expectC ($cn.Status -eq 'ok' -and $null -eq $cn.Sim -and $null -eq $cn.Recorded) 'cloud: null sim and recorded should read as none'
        & $expectC ((ConvertFrom-CloudMap 'not json').Status -eq 'error') 'cloud: bad JSON should be an error'
        & $expectC ((ConvertFrom-CloudMap '{"ok":false,"error":"wrong team code"}').Status -eq 'error') 'cloud: ok false should be an error'
        & $expectC ((ConvertFrom-CloudMap '[1,2]').Status -eq 'error') 'cloud: a list should be an error'
        $guess = ConvertFrom-CloudMap '{"ok":true,"recorded":{"routes":[],"sessions":[{"id":"a","kind":"run","side":"L","samples":[{"t":0,"x":0,"y":0,"h":0},{"t":1500,"x":1,"y":1,"h":0}]},{"id":"b","kind":"run","side":"L","samples":[{"t":0,"x":0,"y":0,"h":0},{"t":2,"x":1,"y":1,"h":0}]}]}}'
        & $expectC ($guess.Status -eq 'ok' -and (& $near $guess.Recorded.Sessions[0].T[1] 1.5) -and (& $near $guess.Recorded.Sessions[1].T[1] 2.0)) 'cloud: times without a unit: 1500 is ms, 2 is seconds'
        & $expectC ((Get-MapCloudUrl 'https://x.example.workers.dev/results') -eq 'https://x.example.workers.dev/map' -and (Get-MapCloudUrl 'https://x.example.workers.dev/results/') -eq 'https://x.example.workers.dev/map' -and (Get-MapCloudUrl 'https://x.example.workers.dev') -eq 'https://x.example.workers.dev/map' -and (Get-MapCloudUrl '') -eq '') 'cloud: relay base from results_url wrong'

        # The same recording from a results file and from the cloud shows once.
        $loc = ConvertTo-LeftFrame (ConvertFrom-ScourgeWire $fixA).Sessions[0]
        $loc.Source = 'x.csv'; $loc.When = '2026-10-29 16:30'; $loc.Order = 'x.csv#000'
        if ($cp.Status -eq 'ok' -and $cp.Recorded.Sessions.Count -eq 2) {
            & $expectC ((Get-SessionDedupeKey $loc) -eq (Get-SessionDedupeKey $cp.Recorded.Sessions[0])) 'cloud: the same recording should have the same dedupe key'
            & $expectC ((Get-SessionDedupeKey $loc) -ne (Get-SessionDedupeKey $cp.Recorded.Sessions[1])) 'cloud: different recordings should not share a dedupe key'
            $merged = @(Merge-MapSessions @($loc) $cp.Recorded.Sessions)
            & $expectC ($merged.Count -eq 2 -and @($merged | Where-Object { $_.Source -eq 'x.csv' }).Count -eq 1 -and @($merged | Where-Object { $_.Kind -eq 'run' }).Count -eq 1) 'cloud: merge should drop the duplicate and keep the local copy'
            & $expectC (@(Merge-MapSessions @($loc) @()).Count -eq 1) 'cloud: merge with no cloud sessions should return the local ones'
        }

        # Team code: saved encrypted, read back, cleared.
        $codeFile = Join-Path ([System.IO.Path]::GetTempPath()) ('scourge-settings-' + [Guid]::NewGuid().ToString('N') + '\settings.json')
        $script:SettingsPath = $codeFile
        try {
            & $expectC ((Read-TeamCode) -eq '') 'team code: none saved should read as empty'
            Save-TeamCode 'sample-code-123'
            & $expectC ((Read-TeamCode) -eq 'sample-code-123') 'team code: did not read back'
            & $expectC ((Test-Path -LiteralPath $codeFile) -and -not ([System.IO.File]::ReadAllText($codeFile).Contains('sample-code-123'))) 'team code: the file must not hold the code in plain text'
            Clear-TeamCode
            & $expectC ((Read-TeamCode) -eq '') 'team code: clearing did not work'
        } finally {
            $script:SettingsPath = $savedSettings
            Remove-Item -LiteralPath (Split-Path $codeFile -Parent) -Recurse -Force -ErrorAction SilentlyContinue
        }

        # Notes under the picker, for each state.
        $script:Cloud.Code = ''; $script:Cloud.Unauthorized = $false; $script:Cloud.Data = $null
        & $expectC ((Get-CloudNote) -like 'Enter the team code*') 'note: no code should ask for it'
        $script:Cloud.Unauthorized = $true
        & $expectC ((Get-CloudNote) -like 'That team code did not work*') 'note: a refused code should say so'
        $script:Cloud.Unauthorized = $false; $script:Cloud.Code = 'x'; $script:Cloud.Offline = $true
        & $expectC ((Get-CloudNote) -like 'Offline. No saved route data*') 'note: offline with no copy'
        Set-CloudData $cp '2026-10-30T23:05:00Z'
        & $expectC ((Get-CloudNote) -like 'Offline, showing data from *') 'note: offline with a saved copy'
        $script:Cloud.Offline = $false
        & $expectC ((Get-MapEmptyText) -like 'No prediction for this build yet.*Get the latest build, then Refresh.') 'note: empty-field text'
        & $expectC ((Get-PredictedLabel) -eq 'Build 70, predicted from the code, not a real run') 'note: predicted label'

        # Counting while recording: rows are rows, not tests.
        $rec = New-RecordState
        & $expectC ((Get-RecordStatusText $rec) -eq 'Recorded 0 values from 0 tests') 'record: empty status'
        Add-RecordLine $rec 'SCOURGE,BEGIN,autopath,1;teach_open;L;4;b,'
        & $expectC ($rec.Open -and $rec.Expected -eq 4 -and (Get-RecordStatusText $rec) -eq 'Recording: 0 of 4 rows') 'record: BEGIN should open a 4-row recording'
        Add-RecordLine $rec 'SCOURGE,AP,0,0;800;-6160;0;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,AP,1,50;900;-5500;1000;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,AP,1,50;900;-5500;1000;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,AM,2,100;drop;1000;-5000;4500;300;0;0,'
        & $expectC ((Get-RecordStatusText $rec) -eq 'Recording: 3 of 4 rows' -and $rec.Values -eq 0 -and $rec.Tests.Count -eq 0) 'record: a repeated row is not counted twice, and rows are not tests'
        Add-RecordLine $rec 'SCOURGE,AP,3,150;1100;-4800;4500;0;0;0;0;0'
        & $expectC ($rec.Seen -eq 3) 'record: a row cut short (no trailing comma) must not count'
        Add-RecordLine $rec 'SCOURGE,AP,3,150;1100;-4800;4500;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,END,autopath,4,'
        & $expectC ((-not $rec.Open) -and $rec.Full -eq 1 -and (Get-RecordStatusText $rec) -eq 'Got the full recording. Click Send Results.') 'record: a whole recording'
        $rec = New-RecordState
        Add-RecordLine $rec 'SCOURGE,BEGIN,autopath,1;run;L;4;b,'
        Add-RecordLine $rec 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,AP,1,50;0;0;0;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,END,autopath,4,'
        & $expectC ($rec.Cut -eq 1 -and $rec.Full -eq 0 -and (Get-RecordStatusText $rec) -eq 'That recording was cut off. Press X on the controller again.') 'record: END that arrives short is cut off'
        $rec = New-RecordState
        Add-RecordLine $rec 'SCOURGE,BEGIN,autopath,1;run;L;4;b,'
        Add-RecordLine $rec 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,'
        Close-RecordState $rec
        & $expectC ($rec.Cut -eq 1 -and (-not $rec.Open) -and (Get-RecordStatusText $rec) -like 'That recording was cut off*') 'record: Stop between BEGIN and END is cut off'
        $rec = New-RecordState
        Add-RecordLine $rec 'SCOURGE,BEGIN,autopath,1;run;L;2;b,'
        Add-RecordLine $rec 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,BEGIN,autopath,1;run;L;2;b,'
        & $expectC ($rec.Cut -eq 1 -and $rec.Open -and $rec.Seen -eq 0 -and $rec.Begun -eq 2) 'record: a new BEGIN with the last one still open cuts the last one off'
        $rec = New-RecordState
        Add-RecordLine $rec 'SCOURGE,drive,speed,1.5,in,'
        Add-RecordLine $rec 'SCOURGE,drive,accel,2.5,in,'
        Add-RecordLine $rec 'SCOURGE,lift,range,3,in,'
        Add-RecordLine $rec 'SCOURGE,HELLO,x,y,'
        & $expectC ((Get-RecordStatusText $rec) -eq 'Recorded 3 values from 2 tests') 'record: tester wording must not change'

        # Plugged-in devices, from sample "pros lsusb" output.
        $hdr = "VEX EDR V5 System Ports:`n"
        $brainLine = "COM3 - VEX Robotics V5 Brain - 1234 (COM3)`n"
        $ctrlLine = "COM4 - VEX Robotics V5 Controller - 5678 (COM4)`n"
        $tail = 'There are no connected VEX EDR V5 User Ports'
        & $expectC ((Get-BrainState ($hdr + $brainLine + $tail)) -eq 'brain') 'usb: a brain alone'
        & $expectC ((Get-BrainState ($hdr + $ctrlLine + $tail)) -eq 'controller') 'usb: a controller alone'
        & $expectC ((Get-BrainState ($hdr + $brainLine + $ctrlLine + $tail)) -eq 'both') 'usb: a brain and a controller together'
        & $expectC ((Get-BrainState ($hdr + $brainLine + $brainLine + $tail)) -eq 'multiple') 'usb: two brains'
        & $expectC ((Get-BrainState $tail) -eq 'none') 'usb: nothing plugged in'

        # A whole route recording, a cut-off one, and tester text, as they sit in a results file.
        & $expectC ((Get-AutopathFileState $fixA) -eq 'complete') 'file state: a whole recording'
        & $expectC ((Get-AutopathFileState $fixCut) -eq 'cutoff') 'file state: only a cut-off copy'
        & $expectC ((Get-AutopathFileState ($fixCut + $fixA)) -eq 'complete') 'file state: a cut-off copy and a whole one'
        & $expectC ((Get-AutopathFileState "SCOURGE,drive,speed,1.5,in,`n") -eq 'none') 'file state: tester results only'

        # What Send says after a good send, for each answer the service can give.
        & $expectC ((Get-SendDoneMessage 'complete' $true '#5').Text -eq 'Sent. It shows on the Route Map in about a minute.') 'send message: on the map'
        & $expectC ((Get-SendDoneMessage 'complete' $null '#5').Text -eq 'Sent. It shows on the Route Map in about a minute.') 'send message: an older service says nothing about the map'
        $noCode = Get-SendDoneMessage 'complete' $false '#5'
        & $expectC ($noCode.Text -eq "Sent, but it won't show on the Route Map without the team code. Enter it in Route Map, then send again." -and $noCode.Kind -eq 'error') 'send message: a whole recording that is not on the map'
        & $expectC ((Get-SendDoneMessage 'none' $false '#5').Text -eq 'Results sent to the programmer (issue #5).') 'send message: tester results do not mention the map'
        & $expectC ((Get-SendDoneMessage 'cutoff' $false '#5').Text -like 'Sent, but that recording was cut off*') 'send message: a cut-off recording'

        # Which file Send uses after a recording finishes.
        $outDir = Join-Path ([System.IO.Path]::GetTempPath()) ('scourge-outcome-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
        try {
            $earlier = Join-Path $outDir 'results-20261030-090000.csv'
            [System.IO.File]::WriteAllText($earlier, "kind,test,key,value,unit`nSCOURGE,drive,speed,1.5,in,`n")
            $newPath = Join-Path $outDir 'results-20261030-100000.csv'
            $goodRec = New-RecordState
            Add-RecordLine $goodRec 'SCOURGE,BEGIN,autopath,1;run;L;1;b,'
            Add-RecordLine $goodRec 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,'
            Add-RecordLine $goodRec 'SCOURGE,END,autopath,1,'
            $cutRec = New-RecordState
            Add-RecordLine $cutRec 'SCOURGE,BEGIN,autopath,1;run;L;3;b,'
            Add-RecordLine $cutRec 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,'
            Close-RecordState $cutRec
            $emptyRec = New-RecordState
            $orphanRec = New-RecordState
            Add-RecordLine $orphanRec 'SCOURGE,AP,3,0;0;0;0;0;0;0;0;0,'
            Add-RecordLine $orphanRec 'SCOURGE,END,autopath,4,'
            $o = Get-RecordOutcome -Rec $orphanRec -PrevSendPath $earlier -NewPath $newPath -NewHasContent $true
            & $expectC ((-not $o.UseNew) -and $o.Kind -eq 'error' -and $o.Message -like 'That recording was cut off.*results-20261030-090000.csv*') 'outcome: a file of rows with no BEGIN must not replace a good earlier file'
            $o = Get-RecordOutcome -Rec $goodRec -PrevSendPath $earlier -NewPath $newPath -NewHasContent $true
            & $expectC ($o.UseNew -and $o.Kind -eq 'success' -and $o.Message -like 'Got the full recording. Click Send Results.*') 'outcome: a whole recording becomes the file Send uses'
            $o = Get-RecordOutcome -Rec $cutRec -PrevSendPath $earlier -NewPath $newPath -NewHasContent $true
            & $expectC ((-not $o.UseNew) -and $o.Kind -eq 'error' -and $o.Message -like 'That recording was cut off. Press X on the controller again.*results-20261030-090000.csv*') 'outcome: a cut-off recording keeps the earlier file and names it'
            $o = Get-RecordOutcome -Rec $emptyRec -PrevSendPath $earlier -NewPath $newPath -NewHasContent $false
            & $expectC ((-not $o.UseNew) -and $o.Kind -eq 'error' -and $o.Message -like 'Nothing was recorded.*results-20261030-090000.csv*') 'outcome: an empty recording keeps the earlier file and names it'
            $o = Get-RecordOutcome -Rec $cutRec -PrevSendPath '' -NewPath $newPath -NewHasContent $true
            & $expectC ($o.UseNew -and $o.Kind -eq 'error' -and $o.Message -eq 'That recording was cut off. Press X on the controller again.') 'outcome: with no earlier file, the cut-off one is all there is'
            $tester = New-RecordState
            Add-RecordLine $tester 'SCOURGE,drive,speed,1.5,in,'
            $o = Get-RecordOutcome -Rec $tester -PrevSendPath $earlier -NewPath $newPath -NewHasContent $true
            & $expectC ($o.UseNew -and $o.Kind -eq 'success' -and $o.Message -eq ('Results saved to ' + $newPath)) 'outcome: tester results are saved and used'
        } finally {
            Remove-Item -LiteralPath $outDir -Recurse -Force -ErrorAction SilentlyContinue
        }

        # Rows or an END with no BEGIN (the radio attached late) are a cut-off recording.
        $rec = New-RecordState
        Add-RecordLine $rec 'SCOURGE,AP,5,0;0;0;0;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,AP,6,50;0;0;0;0;0;0;0;0,'
        & $expectC ($rec.Orphan -and $rec.Last -eq 'cut' -and $rec.Seen -eq 0 -and (Get-RecordStatusText $rec) -eq 'That recording was cut off. Press X on the controller again.') 'record: rows with no BEGIN are a cut-off recording'
        $rec = New-RecordState
        Add-RecordLine $rec 'SCOURGE,END,autopath,4,'
        & $expectC ($rec.Orphan -and $rec.Last -eq 'cut' -and (Get-RecordStatusText $rec) -like 'That recording was cut off*') 'record: an END with no BEGIN is a cut-off recording'
        $rec = New-RecordState
        Add-RecordLine $rec 'SCOURGE,AP,5,0;0;0;0;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,BEGIN,autopath,1;run;L;1;b,'
        Add-RecordLine $rec 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,'
        Add-RecordLine $rec 'SCOURGE,END,autopath,1,'
        Add-RecordLine $rec 'SCOURGE,AP,9,0;0;0;0;0;0;0;0;0,'
        & $expectC ($rec.Full -eq 1 -and $rec.Last -eq 'full') 'record: a whole recording stays whole when a stray row comes before or after it'

        # Recording through a stand-in for pros.exe (a .cmd file that prints lines), no robot needed.
        $fake = Join-Path ([System.IO.Path]::GetTempPath()) ('scourge-fake-pros-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $fake -Force | Out-Null
        try {
            $dataLines = @('pros starting up', 'SCOURGE,BEGIN,autopath,1;teach_open;L;2;b,', 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,', 'SCOURGE,AP,1,50;100;0;0;0;0;0;0;0,', 'SCOURGE,END,autopath,2,')
            [System.IO.File]::WriteAllLines((Join-Path $fake 'data.txt'), $dataLines)
            [System.IO.File]::WriteAllLines((Join-Path $fake 'ok.cmd'), @('@echo off', 'type "%~dp0data.txt"', 'exit /b 0'))
            [System.IO.File]::WriteAllLines((Join-Path $fake 'late.cmd'), @('@echo off', 'if exist "%~dp0ran.flag" goto second', 'echo x> "%~dp0ran.flag"', 'exit /b 1', ':second', 'type "%~dp0data.txt"', 'exit /b 0'))
            [System.IO.File]::WriteAllLines((Join-Path $fake 'bad.cmd'), @('@echo off', 'echo no brain 1>&2', 'exit /b 1'))
            $newSync = { [hashtable]::Synchronized(@{ Log = (New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'); Procs = [hashtable]::Synchronized(@{}); RecordStop = $false; RecordNote = ''; Rec = (New-RecordState) }) }
            $ts = & $newSync
            $out1 = Join-Path $fake 'out1.csv'
            $rr = Invoke-ProsRecording -ProsExe (Join-Path $fake 'ok.cmd') -WorkDir $fake -FilePath $out1 -Sync $ts -ScriptPath $PSCommandPath
            $got = @([System.IO.File]::ReadAllLines($out1))
            & $expectC ($rr.Status -eq 'stopped' -and $got.Count -eq 5 -and $got[0] -eq 'kind,test,key,value,unit' -and $got[1] -like 'SCOURGE,BEGIN,autopath*' -and $got[4] -eq 'SCOURGE,END,autopath,2,') 'recording: lines were not written to the file as expected'
            & $expectC ($ts.Rec.Full -eq 1 -and $ts.Rec.Last -eq 'full') 'recording: the stand-in terminal sent a whole recording'
            $ts = & $newSync
            $out2 = Join-Path $fake 'out2.csv'
            $rr = Invoke-ProsRecording -ProsExe (Join-Path $fake 'late.cmd') -WorkDir $fake -FilePath $out2 -Sync $ts -Retry $true -RetrySec 20 -ScriptPath $PSCommandPath
            & $expectC ($rr.Status -eq 'stopped' -and $rr.Attempts -eq 2 -and $ts.Rec.Full -eq 1 -and $ts.RecordNote -eq '') 'recording: a controller terminal that quits early should be launched again once'
            $ts = & $newSync
            $rr = Invoke-ProsRecording -ProsExe (Join-Path $fake 'bad.cmd') -WorkDir $fake -FilePath (Join-Path $fake 'out3.csv') -Sync $ts
            & $expectC ($rr.Status -eq 'error' -and $rr.Attempts -eq 1 -and $rr.Error -like '*no brain*') 'recording: without Retry a failing terminal is reported once'
        } finally {
            Remove-Item -LiteralPath $fake -Recurse -Force -ErrorAction SilentlyContinue
        }

        # The real network code, against a listener on this computer.
        $listener = $null
        $netDir = Join-Path ([System.IO.Path]::GetTempPath()) ('scourge-net-' + [Guid]::NewGuid().ToString('N'))
        try {
            $port = Get-Random -Minimum 49200 -Maximum 64900
            $prefix = 'http://127.0.0.1:' + $port + '/'
            try {
                $listener = New-Object System.Net.HttpListener
                $listener.Prefixes.Add($prefix)
                $listener.Start()
            } catch { $listener = $null }
            if ($null -eq $listener) {
                Write-Host '  (map round trip skipped: a listener could not start here)'
            } else {
                $cachePath = Join-Path $netDir 'map-cloud.json'
                $oneCall = {
                    param([string]$Build, [string]$Code, [int]$Status, [string]$Body)
                    $ps = [powershell]::Create()
                    [void]$ps.AddScript('param($U, $B, $C, $P)' + "`n" + $SharedCode.ToString() + "`n" + 'Get-CloudMap -MapUrl $U -Build $B -Code $C -CachePath $P').AddArgument($prefix + 'map').AddArgument($Build).AddArgument($Code).AddArgument($cachePath)
                    $h = $ps.BeginInvoke()
                    $seen = @{ Code = ''; Query = ''; Got = $false }
                    $ar = $listener.BeginGetContext($null, $null)
                    if ($ar.AsyncWaitHandle.WaitOne(30000)) {
                        $ctx = $listener.EndGetContext($ar)
                        $seen.Got = $true
                        $seen.Code = [string]$ctx.Request.Headers['X-Team-Code']
                        $seen.Query = [string]$ctx.Request.Url.Query
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
                        $ctx.Response.StatusCode = $Status
                        $ctx.Response.ContentType = 'application/json'
                        $ctx.Response.ContentLength64 = $bytes.Length
                        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                        $ctx.Response.Close()
                    }
                    $res = $null
                    if ($h.AsyncWaitHandle.WaitOne(30000)) { $o = $ps.EndInvoke($h); if ($o.Count -gt 0) { $res = $o[$o.Count - 1] } } else { $ps.Stop() }
                    $ps.Dispose()
                    return @{ Result = $res; Seen = $seen }
                }
                $c1 = & $oneCall 'build-70-abc1234' 'sample-code-123' 200 $cloudJson
                & $expectC ($c1.Seen.Got -and $c1.Seen.Code -eq 'sample-code-123' -and $c1.Seen.Query -eq '?build=build-70-abc1234') 'network: the team code header and build query were not sent'
                & $expectC (($null -ne $c1.Result) -and $c1.Result.Status -eq 'ok' -and $c1.Result.Data.Sim.Build -eq 70 -and $c1.Result.Data.Recorded.Sessions.Count -eq 2) 'network: a good answer did not parse'
                $fromCache = Read-CloudCache -Path $cachePath
                & $expectC ($fromCache.Status -eq 'ok' -and $fromCache.Data.Sim.Build -eq 70 -and $fromCache.Fetched) 'network: the answer was not cached for offline use'
                $c2 = & $oneCall '' 'wrong' 401 '{"ok":false,"error":"wrong team code"}'
                & $expectC (($null -ne $c2.Result) -and $c2.Result.Status -eq 'unauthorized' -and $c2.Seen.Query -eq '') 'network: HTTP 401 should be reported as unauthorized (and no build query when none)'
                & $expectC ((Read-CloudCache -Path $cachePath).Status -eq 'ok') 'network: a refused code must not erase the saved copy'
                $c3 = & $oneCall 'b' 'x' 500 '{"ok":false}'
                & $expectC (($null -ne $c3.Result) -and $c3.Result.Status -eq 'error' -and $c3.Result.Error -like '*HTTP 500*') 'network: HTTP 500 should be an error'
                # Send: the team code goes in X-Team-Code when there is one, and on_map comes back.
                $sendCall = {
                    param([string]$Code)
                    $ps = [powershell]::Create()
                    [void]$ps.AddScript('param($Sync, $A)' + "`n" + $SharedCode.ToString() + "`n" + $SendBody.ToString()).AddArgument($null).AddArgument(@{ ResultsUrl = ($prefix + 'results'); Title = 'Robot data 2026-10-30'; Body = "Uploader x`r`n`r`nSCOURGE,drive,speed,1.5,in,"; Version = 'selftest'; Code = $Code })
                    $h = $ps.BeginInvoke()
                    $seen = @{ Code = ''; Got = $false }
                    $ar = $listener.BeginGetContext($null, $null)
                    if ($ar.AsyncWaitHandle.WaitOne(30000)) {
                        $ctx = $listener.EndGetContext($ar)
                        $seen.Got = $true
                        $seen.Code = [string]$ctx.Request.Headers['X-Team-Code']
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"ok":true,"issues":[7],"on_map":false}')
                        $ctx.Response.StatusCode = 201
                        $ctx.Response.ContentType = 'application/json'
                        $ctx.Response.ContentLength64 = $bytes.Length
                        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                        $ctx.Response.Close()
                    }
                    $res = $null
                    if ($h.AsyncWaitHandle.WaitOne(30000)) { $o = $ps.EndInvoke($h); if ($o.Count -gt 0) { $res = $o[$o.Count - 1] } } else { $ps.Stop() }
                    $ps.Dispose()
                    return @{ Result = $res; Seen = $seen }
                }
                $sw = & $sendCall 'sample-code-123'
                & $expectC ($sw.Seen.Got -and $sw.Seen.Code -eq 'sample-code-123') 'send: the team code was not sent in X-Team-Code'
                & $expectC (($null -ne $sw.Result) -and $sw.Result.Status -eq 'success' -and $sw.Result.OnMap -eq $false -and $sw.Result.Issues[0] -eq '7') 'send: on_map false was not read from the answer'
                $sn = & $sendCall ''
                & $expectC ($sn.Seen.Got -and $sn.Seen.Code -eq '') 'send: with no code the header must be left out'
                $listener.Stop()
                $listener = $null
                $off = Get-CloudMap -MapUrl ($prefix + 'map') -Build 'b' -Code 'x' -CachePath $cachePath
                & $expectC ($off.Status -eq 'offline') 'network: nothing listening should read as offline'
            }
        } finally {
            if ($null -ne $listener) { try { $listener.Stop() } catch { } }
            Remove-Item -LiteralPath $netDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        & $expectC ((Get-CloudMap -MapUrl 'http://example.com/map' -Build '' -Code 'x' -CachePath '').Status -eq 'error') 'network: a plain http address must be refused'

        # Clean stop. Information only: a console child that is sent Ctrl+C should close itself. The
        # real PROS terminal has not been tried; this shows whether the method works on this machine.
        $stopNote = 'not run'
        $child = $null
        try {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $psi.Arguments = '-NoProfile -Command "Write-Output ready; Start-Sleep -Seconds 60"'
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardOutput = $true
            $child = [System.Diagnostics.Process]::Start($psi)
            $ready = $child.StandardOutput.ReadLineAsync()
            if ($ready.Wait(30000) -and ($ready.Result -eq 'ready')) {
                $clock = [System.Diagnostics.Stopwatch]::StartNew()
                $mode = Stop-ProsProcess -Proc $child -ScriptPath $PSCommandPath
                $stopNote = $mode + ' in ' + [math]::Round($clock.Elapsed.TotalSeconds, 1) + ' s'
            } else {
                $stopNote = 'the test process did not start'
            }
        } catch {
            $stopNote = 'could not run: ' + $_.Exception.Message
        } finally {
            if (($null -ne $child) -and (-not $child.HasExited)) { try { $child.Kill() } catch { } }
        }
        Write-Host ('  Clean stop (Ctrl+C to a hidden console child): ' + $stopNote)
    } catch {
        [void]$cloudFails.Add('cloud check threw: ' + $_.Exception.Message)
    }
    $script:Cloud = $savedCloud
    $script:SettingsPath = $savedSettings
    if ($cloudFails.Count -eq 0) {
        Write-Host '  Route Map cloud data: OK'
    } else {
        foreach ($cf in $cloudFails) { $failures.Add('route map cloud: ' + $cf) }
        Write-Host ('  Route Map cloud data: FAIL (' + ($cloudFails -join '; ') + ')')
    }

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
        # If starting the read throws, the tab must not stay on "Reading recordings...".
        $realFolderFn = ${function:Get-ResultsFolder}
        try {
            ${function:Get-ResultsFolder} = { throw 'no folder' }
            Start-MapLoad
        } finally { ${function:Get-ResultsFolder} = $realFolderFn }
        if ($script:MapLoading -or $script:Map.Loading -or (-not $script:Map.Error)) { $failures.Add('Route Map stayed on Reading recordings after a failed start') }
        # Route Map tab: sample recordings go through the same file reader the app uses.
        # Compare the size the layout asks for. The window itself is cut to the screen by Windows
        # (the CI screen is shorter than the Upload view with Details open), and only while shown.
        $uploadSize = $script:UploadLayoutSize
        $uploadActual = $testForm.ClientSize
        $mapDir = Join-Path ([System.IO.Path]::GetTempPath()) ('scourge-map-shot-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $mapDir -Force | Out-Null
        try {
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            $sampleMarks = @(
                @{ At = 0; Type = 'toggle'; X = 10.0; Y = -60.0 },
                @{ At = 1; Type = 'drop'; X = 30.0; Y = -52.0 },
                @{ At = 2; Type = 'pin'; X = 42.0; Y = -30.0 },
                @{ At = 3; Type = 'stack'; X = 20.0; Y = -18.0 },
                @{ At = 4; Type = 'push'; X = -8.0; Y = -30.0 })
            $samplePath = @(@(10, -60), @(30, -52), @(42, -30), @(20, -18), @(-8, -30))
            $sampleSteps = @(
                @{ At = 0; Step = -1; Type = 'opening'; Target = @(10, -60, 0); Actual = @(10, -60, 0); Ok = 1 },
                @{ At = 1; Step = 0; Type = 'drive'; Target = @(30, -52, 45); Actual = @(30.3, -52.4, 44); Ok = 1 },
                @{ At = 2; Step = 1; Type = 'grab_stack'; Target = @(42, -30, 30); Actual = @(43.4, -28.6, 34); Ok = 1 },
                @{ At = 3; Step = 2; Type = 'drop'; Target = @(20, -18, 300); Actual = @(22.5, -16.3, 296); Ok = 1 },
                @{ At = 4; Step = 3; Type = 'drive'; Target = @(-8, -30, 240); Actual = @(-8.4, -30.3, 241); Ok = 1 })
            [System.IO.File]::WriteAllText((Join-Path $mapDir 'results-20261029-163000.csv'), ('kind,test,key,value,unit' + "`n" + (New-SampleWire 'teach_open' 'L' $samplePath $sampleMarks @())), $utf8)
            [System.IO.File]::WriteAllText((Join-Path $mapDir 'results-20261030-091500.csv'), ('kind,test,key,value,unit' + "`n" + (New-SampleWire 'push' 'R' @(@(58, -16), @(46, -36), @(24, -46)) @() @())), $utf8)
            [System.IO.File]::WriteAllText((Join-Path $mapDir 'results-20261030-101500.csv'), ('kind,test,key,value,unit' + "`n" + (New-SampleWire 'run' 'L' $samplePath @() $sampleSteps)), $utf8)
            $res = Read-ScourgeResults -Folder $mapDir
            if (($res.Sessions.Count -ne 3) -or ($res.Rejected.Count -ne 0)) { throw ('sample recordings: expected 3 sessions and no rejections, got ' + $res.Sessions.Count + ' and ' + $res.Rejected.Count) }
            Set-MapData $res
            Set-View 'map' -NoLoad
            if ($testForm.ClientSize.Width -ne (Px 880)) { $failures.Add('Route Map width is ' + $testForm.ClientSize.Width + ', expected ' + (Px 880)) }
            if ($script:Ui.MapList.Items.Count -ne 3) { $failures.Add('Route Map session list has ' + $script:Ui.MapList.Items.Count + ' rows, expected 3') }
            if ($script:Ui.MapTable.Items.Count -ne 5) { $failures.Add('Route Map miss table has ' + $script:Ui.MapTable.Items.Count + ' rows, expected 5') }
            if ($env:SCOURGE_SCREENSHOT) {
                $mapShot = Join-Path (Split-Path $env:SCOURGE_SCREENSHOT -Parent) 'uploader-route-map.png'
                $testForm.Show()
                [System.Windows.Forms.Application]::DoEvents()
                $testForm.Refresh()
                $bmp = New-Object System.Drawing.Bitmap $testForm.Width, $testForm.Height
                $testForm.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle 0, 0, $testForm.Width, $testForm.Height))
                $bmp.Save($mapShot, [System.Drawing.Imaging.ImageFormat]::Png)
                $bmp.Dispose()
                Write-Host ('  Route Map screenshot saved: ' + $mapShot)
                $testForm.Hide()
            }
            # Cloud data on the tab. First only the prediction (no recordings anywhere), then the
            # programmer's recordings together with the local ones. The canvas is painted into a
            # bitmap too, so a drawing error fails here even when no window is shown.
            $shotDir = ''
            if ($env:SCOURGE_SCREENSHOT) { $shotDir = Split-Path $env:SCOURGE_SCREENSHOT -Parent }
            $paintCanvas = {
                param([string]$ShotName)
                $cv = New-Object System.Drawing.Bitmap 480, 520
                $cg = [System.Drawing.Graphics]::FromImage($cv)
                try { Show-RouteMapCanvas $cg (New-Object System.Drawing.Size 480, 520) } finally { $cg.Dispose() }
                if ($shotDir -and $ShotName) { $cv.Save((Join-Path $shotDir $ShotName), [System.Drawing.Imaging.ImageFormat]::Png) }
                $cv.Dispose()
            }
            $script:Cloud.Inited = $true
            $script:Cloud.Code = ''
            $script:Cloud.Route = 'AWP'
            $script:Cloud.Side = 'L'
            $simOnly = ConvertFrom-CloudMap $cloudJson
            $simOnly.Recorded = $null
            Set-MapData @{ Status = 'ok'; Sessions = @(); Rejected = @() }
            Set-CloudData $simOnly '2026-10-30T23:05:00Z'
            Update-MapSessions
            $predL = Get-CloudPredicted
            if (($null -eq $predL) -or ($predL.X.Length -ne 3)) { $failures.Add('Route Map cloud: no predicted route for AWP on the left') }
            if ($script:Ui.MapRouteBox.Items.Count -ne 2) { $failures.Add('Route Map cloud: route picker has ' + $script:Ui.MapRouteBox.Items.Count + ' entries, expected 2 (AWP and Taught A)') }
            if ($script:Ui.MapList.Items.Count -ne 0) { $failures.Add('Route Map cloud: with no recordings the session list should be empty') }
            if ($null -ne (Get-CloudClean)) { $failures.Add('Route Map cloud: a clean line appeared with no recording') }
            if ($script:Ui.MapCloudNote.Text -notlike 'Enter the team code*') { $failures.Add('Route Map cloud: no code should ask for it, got: ' + $script:Ui.MapCloudNote.Text) }
            & $paintCanvas 'uploader-route-map-predicted.png'
            Set-CloudSide 'R'
            $predR = Get-CloudPredicted
            if (($null -eq $predR) -or ($predR.Side -ne 'R') -or (-not (& $near $predR.X[0] 61.6)) -or (-not (& $near $predR.Y[0] -8.0)) -or (-not (& $near $predR.H[0] 270.0)) -or (-not (& $near $predR.Y[2] -20.4))) { $failures.Add('Route Map cloud: the Right prediction should start at (61.6, -8) heading 270, the Left one mirrored') }
            & $paintCanvas ''
            Set-CloudSide 'L'
            $predBack = Get-CloudPredicted
            if (($null -eq $predBack) -or (-not (& $near $predBack.X[0] 8.0)) -or (-not (& $near $predBack.Y[0] -61.6))) { $failures.Add('Route Map cloud: the Left prediction changed after viewing the Right') }

            $script:Cloud.Code = 'sample'
            $script:Cloud.Offline = $true
            $full = ConvertFrom-CloudMap $cloudJson
            Set-MapData $res
            Set-CloudData $full '2026-10-30T23:05:00Z'
            Update-MapSessions
            if ($script:Map.Sessions.Count -ne 5) { $failures.Add('Route Map cloud: expected 3 local and 2 cloud sessions, got ' + $script:Map.Sessions.Count) }
            if ($script:Ui.MapList.Items.Count -ne 5) { $failures.Add('Route Map cloud: session list has ' + $script:Ui.MapList.Items.Count + ' rows, expected 5') }
            Set-CloudRoute 'A'
            $pickedIdx = $script:Map.Selected
            if (($pickedIdx -lt 0) -or ($script:Map.Sessions[$pickedIdx].Source -ne 'cloud') -or ($script:Map.Sessions[$pickedIdx].ForSlot -ne 'A') -or ($script:Map.Sessions[$pickedIdx].Kind -ne 'teach_open')) { $failures.Add('Route Map cloud: picking Taught A should select its raw recording') }
            $cleanA = Get-CloudClean
            if (($null -eq $cleanA) -or ($cleanA.X.Length -ne 3)) { $failures.Add('Route Map cloud: Taught A should have a clean line of 3 points (start and 2 steps)') }
            if ($script:Ui.MapCloudNote.Text -notlike 'Offline, showing data from *') { $failures.Add('Route Map cloud: offline note missing, got: ' + $script:Ui.MapCloudNote.Text) }
            & $paintCanvas ''
            if ($env:SCOURGE_SCREENSHOT) {
                $cloudShot = Join-Path $shotDir 'uploader-route-map-cloud.png'
                $testForm.Show()
                [System.Windows.Forms.Application]::DoEvents()
                $testForm.Refresh()
                $bmp = New-Object System.Drawing.Bitmap $testForm.Width, $testForm.Height
                $testForm.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle 0, 0, $testForm.Width, $testForm.Height))
                $bmp.Save($cloudShot, [System.Drawing.Imaging.ImageFormat]::Png)
                $bmp.Dispose()
                Write-Host ('  Route Map cloud screenshot saved: ' + $cloudShot)
                $testForm.Hide()
            }
            Set-CloudSide 'R'
            & $paintCanvas ''
            Set-CloudSide 'L'
            Set-CloudRoute 'AWP'
            if ($script:Map.Selected -ne -1) { $failures.Add('Route Map cloud: switching to AWP should let go of the Taught A recording') }
            & $paintCanvas ''
            if ($script:MapPaintError) { $failures.Add('Route Map drawing failed: ' + $script:Ui.Log.Text) }
            Set-View 'upload'
            Write-Host ('  Upload view size: layout ' + $uploadSize + ' before and ' + $script:UploadLayoutSize + ' after, window ' + $uploadActual + ' before and ' + $testForm.ClientSize + ' after')
            if ($script:UploadLayoutSize -ne $uploadSize) { $failures.Add('Upload view size changed after visiting Route Map: ' + $uploadSize + ' became ' + $script:UploadLayoutSize) }
            Write-Host '  Route Map tab: OK'
        } finally {
            Remove-Item -Path $mapDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        # A whole route recording stops the recording by itself; two cables are refused before anything starts.
        $savedRec = $script:Recording; $savedPath = $script:ResultsPath; $savedStop = $script:Sync.RecordStop; $savedRecState = $script:Sync.Rec
        try {
            $autoRec = New-RecordState
            Add-RecordLine $autoRec 'SCOURGE,BEGIN,autopath,1;run;L;1;b,'
            Add-RecordLine $autoRec 'SCOURGE,AP,0,0;0;0;0;0;0;0;0;0,'
            $script:Recording = $true; $script:ResultsPath = 'selftest.csv'; $script:Sync.RecordStop = $false; $script:Sync.Rec = $autoRec
            Update-RecordingStatus
            if ($script:Sync.RecordStop) { $failures.Add('recording stopped before the recording was whole') }
            Add-RecordLine $autoRec 'SCOURGE,END,autopath,1,'
            Update-RecordingStatus
            if (-not $script:Sync.RecordStop) { $failures.Add('a whole route recording did not stop the recording') }
            if ($script:Ui.ResultsStatus.Text -ne 'Got the full recording. Click Send Results.') { $failures.Add('whole recording text was: ' + $script:Ui.ResultsStatus.Text) }
        } finally {
            $script:Recording = $savedRec; $script:ResultsPath = $savedPath; $script:Sync.RecordStop = $savedStop; $script:Sync.Rec = $savedRecState
        }
        $savedProsExe = $script:ProsExe; $savedConn = $script:ConnState
        try {
            $script:ProsExe = 'selftest-pros.exe'; $script:ConnState = 'both'
            Start-Recording
            if ($script:Recording) { $failures.Add('recording started with a brain and a controller both plugged in') }
            if ($script:Ui.Status.Text -ne 'Unplug one cable: use the controller or the brain, not both.') { $failures.Add('two-cable text was: ' + $script:Ui.Status.Text) }
        } finally {
            $script:ProsExe = $savedProsExe; $script:ConnState = $savedConn; $script:Recording = $false
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
