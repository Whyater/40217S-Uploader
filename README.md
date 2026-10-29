<!-- markdownlint-disable MD013 -->

# 40217S Scourge Uploader

Put the latest robot program on the V5 brain from a Windows laptop. You only need PowerShell and a USB cable. Built for the members of VEX team 40217S "Scourge" (Chapin High School, El Paso TX).

---

## Install (one time)

1. Open the Start menu, type `PowerShell`, and open **Windows PowerShell**.
2. Paste this line and press Enter:

```powershell
irm https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/install.ps1 | iex
```

The installer downloads the official PROS uploader and the Scourge Uploader app. It then adds a **Scourge Uploader** shortcut to your Desktop and Start menu and opens the app.

## Update the uploader

Uploader version 2.0.0 can update itself. To get it, run the install line above one more time. That is the last time you have to do it by hand.

After that, clicking **Get latest code** also updates the uploader whenever a newer one is published. It downloads the new version, checks its fingerprint, restarts, and then gets the code. If the update check fails, the code download still works.

## On a Mac

There is a Mac version with the same features (uploading, Robot tests, and self-update). It needs an Apple silicon Mac on macOS 26 or later, and the PROS extension installed in VS Code.

1. Download `ScourgeUploader-mac.zip` from the [Mac uploader release](https://github.com/Whyater/40217S-Uploader/releases/tag/mac-uploader-1.1.0) and double-click it.
2. Drag **Scourge Uploader** into your Applications folder and open it.
3. The first time, macOS may say it can't check the app. Open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.

After that, clicking **Get Latest** also updates the Mac app when a newer one is published. On a Mac, buttons use title case (**Get Latest**, **Upload to Robot**, **Put Tester on Robot**), and **Robot Tests** is a section you open below the status line.

## On an Android phone (no laptop needed)

There is also a web version for when the laptop has no internet. It runs in Chrome on an Android phone and talks to the brain over USB. It also works in Chrome or Edge on a computer. iPhones and iPads can't do it, because their browsers can't use USB devices.

You need a USB-C OTG adapter (or a USB-C to micro-USB data cable) between the phone and the brain.

1. While you have internet, open [whyater.github.io/40217S-Uploader](https://whyater.github.io/40217S-Uploader/) in Chrome. It downloads the latest code and checks every file's SHA-256 hash.
2. Open Chrome's menu and tap **Add to Home screen** (or **Install app**). The uploader then opens like an app and works offline.
3. At the robot, plug the phone into the brain (not the controller) and turn the brain on.
4. Open the uploader, pick a mode, and tap **Upload to robot**. The first time, Chrome and Android ask you to allow the brain. Keep the cable in until it says it's done.

The web version uploads the same files the same way PROS does, including the same compressed library, so switching between the phone and a laptop doesn't make the brain erase the other modes. It doesn't do Robot tests yet.

## Upload (every time)

1. Plug a USB data cable into the **brain** (not the controller) and turn the brain on.
2. Open **Scourge Uploader**.
3. If it says newer code is available, click **Get latest code**. On the very first launch it downloads the code for you.
4. Pick a **Mode** (see [Modes](#modes)). Most of the time that is **Competition**. The slot and program name change to match the mode, and you can still change them.
5. Check the **Program name** box. This is the name the brain shows for the program. In Competition it starts as `Scourge`. Names can use letters, numbers, spaces, `_`, `.`, and `-`, up to 20 characters, and must start with a letter or number.
6. Click **Upload to robot** and keep the cable plugged in until it finishes.

When it is done, the program shows on the brain. Run it from the brain screen.

## Modes

The same robot code is built three ways. The **Mode** box picks which one goes on the brain. Each mode has its own slot, so all three can be on the brain at once.

| Mode | Slot | What it does |
| --- | --- | --- |
| Competition | 1 | The full match program. This is the one to use at events |
| Auton Test | 2 | Pick the color, side, and routine on the controller (see [Before every match](#before-every-match-set-up-the-robot-on-the-controller)), then press **A** to run the auton and **B** to stop it. No driving |
| Drive Test | 3 | Driving only. Autonomous does nothing |

If a mode says the build does not have it, the newest release is older than the test modes. Click **Get latest code**, or ask the programmer.

## Check the drive (first time, and after any rewiring)

Do this before driving, so a wrongly wired motor shows up on a screen instead of on the field.

1. Put the robot flat on the floor, not on a stand, with about 2 feet of open space on every side.
2. Turn on the controller and run the program from the brain. Do not touch the robot for 3 seconds while its sensors calibrate.
3. Pick Color and Side on the controller (see [Before every match](#before-every-match-set-up-the-robot-on-the-controller)), set Auto to **Check: drive + sensors**, and press **A**.
4. **Hold D-pad Down** on the controller for 1 second to start. The robot turns a little one way, then the other, rolls forward a few inches, and backs up. Press **D-pad Down** again (or hold it) at any time to stop it.
5. Take a photo of the brain screen and the controller screen and send it to the programmer.

Each line reads OK, REVERSED, NO TURN, or NOT TURNING. Only drive with the sticks once both **Left** and **Right** say OK.

Holding **D-pad Down** only starts a test when the robot is not plugged into a field or competition switch.

## Controls

| Control | What it does |
| --- | --- |
| Left stick | Drives forward and back. Pushing it forward drives the robot backwards, on purpose |
| Right stick | Turns. With it centered the robot holds straight on its own |
| R1 (hold) | Intake in |
| R2 (hold) | Intake out |
| L1 (hold) | Roller |
| L2 (hold) | Lift down, only while held. It slows down and stops at the bottom, so holding it longer does nothing. Turn the robot on with the lift all the way down |
| B (hold) | Lift up, only while held, all the way to the top |
| Y | Up to the next alliance goal height. From the bottom, the first press clears an empty alliance goal, and each press after that goes one Pin higher, up to a goal holding 5 |
| D-pad Right | Up to the next neutral goal height. Neutral goals start with a Pin in them, so the first press from the bottom clears that Pin, and each press after that goes one Pin higher, up to 3 of ours on top of it |
| A | Down to the next goal height, and from the lowest one to the bottom |
| D-pad Left | Reset: open the claw and lower the lift to the bottom. The claw can't close until the lift gets there. Hold it for one second and the lift goes limp; let go once it has settled to the very bottom, and that becomes the new bottom |
| D-pad Up | Tilt the claw down (only with the lift at the bottom) or back up. Tilting down: if the claw is closed and empty, it opens first. Tilting up with the claw closed: the lift rises a little first |
| D-pad Down | In a match: lift up to the "one Cup and one Pin" height. Off the field: a short press does the same, and holding it for 1 second starts the selected auton as a test (press it again to stop) |
| X | Open or close the claw (switches each press) |

If the claw is tilted down when you press a lift up button, the robot closes the claw and lifts it off the floor. Then it tilts the claw up and goes to position 1.

The claw starts tilted down and open. With the claw tilted up, it closes on its own when a Pin or Cup comes within about 10 cm, and opens on its own if the Pin or Cup it was holding is gone. With the claw tilted down it never closes or opens on its own. Press **X** to open or close it yourself. D-pad Up won't tilt the claw down while there's a Pin in it, so it can't drop one by accident.

The robot also handles Toggles for you. When one of its side toggle sensors is right next to a wall Toggle and a color is picked, the roller turns the Toggle until it sees our color, then stops. Holding **L1** still spins the roller by hand and overrides it. Line 1 of the brain screen shows a short toggle status. It can read `OURS`, `SPIN`, `THEIRS`, `OTHER`, `UNSURE`, `NO TGL`, `NO COLOR`, `SENS ERR`, `STALL`, `RETRIES`, or `MISSED` (it spun for three seconds without finding our color, so it gave up until the robot leaves that Toggle).

Start the program with the lift all the way down.

## Before every match: set up the robot on the controller

When the program starts, the controller shows three rows (**Color**, **Side**, and **Auto**), and **the robot does not drive until you finish this setup**.

1. **Up / Down** picks a row. The `>` marks the row you are on.
2. **Left / Right** changes the row. Color is RED or BLUE and Side is LEFT or RIGHT. On the Auto row, Left and Right step through the routines.
3. **A** confirms. It only works once Color and Side are both picked. The controller then shows your choice, such as "RED LEFT Match".

Left and right are as seen by the drive team, standing at your own alliance station and looking at the field.

To change it later, hold **L1 + R1** for one second. The setup opens again and the robot stops until you press **A**. The roller and intake run for that second.

The brain buttons still work as a backup. The left button picks RED, then LEFT, and the right button picks BLUE, then RIGHT. After that, the two buttons step through the routines, and the middle one starts over. Picking the side on the brain also finishes the setup.

- **Color** sets which color the Toggle roller spins to. With no color picked, the toggles never spin on their own.
- **Side** picks which version of the match route runs. A match route will not run if no side is picked, and the brain says "NO SIDE PICKED".
- **Routines** are "Do nothing" (the default), "Match: left/right (side)", "Match: solo AWP", "Skills (60 s)", and the check, tune, and demo routines. Use "Match: solo AWP" only when our partner has no auton. It needs the RIGHT side.

## Measure the robot

The uploader has a **Robot tests** section. It puts a separate program on the brain that measures the robot, so the programmer can set real numbers instead of guesses.

1. Click **Put tester on robot**. This puts a program called "Scourge Tester" on slot 8. It does not replace the match program.
2. Plug the USB cable into the brain (or the controller) and click **Record results**. The button becomes **Stop recording**, and the app shows how many values it recorded. You can't upload while it is recording.
3. Turn on the controller and run "Scourge Tester" from the brain. It opens on **Start full test**. Put the lift all the way down, empty the intake, and give the robot room (8 ft in front, 3 ft all around). Then press **A** (or the brain's middle button) once. The 10 tests run one after another. The run pauses whenever a step needs your hands (a Pin or Cup in the claw, a Toggle face to show, a measurement to type, or aiming the robot before it drives). Press **A** to go on. **B stops the whole run at once.**
4. When a test needs a number, D-pad Up and Down change it by 0.25, D-pad Left and Right change it by 1.0, and **A** saves it.
5. When it finishes, click **Stop recording**, then **Send results**. The results go straight to the programmer as an issue in the team's private data repository. You don't need a GitHub account, and the status line shows the issue number. If that can't reach the server, your browser opens a new issue with the results filled in instead (or copied, if they are too long: paste them with Ctrl+V). Then you need to be signed in to GitHub with an account the programmer added to that repository.

To run one test by itself, use the brain's left and right buttons (or D-pad Left and Right) to pick it, then press **A**.

The results are also saved on the laptop in `Documents\Scourge Robot Data`. The **Open folder** link opens it.

The tests:

- **Lift travel and speed:** the lift must start fully down.
- **Lift height map:** you measure the bottom of the claw with a tape and enter the inches.
- **Lift presets:** drive the lift to each goal height with D-pad Up and Down and press **A**. **X** skips one.
- **Drive straight:** needs 8 ft clear in front.
- **Drive turn:** needs 3 ft clear all around.
- **Toggle colors:** put each sensor next to each Toggle face.
- **Roller per face.**
- **Claw distance:** empty, Pin, Cup, wall, and a dropped Pin.
- **IMU drift:** keep the robot still for 30 seconds.
- **Intake speed:** nothing in the intake.

---

## If something goes wrong

- **"No brain found":** use a cable that carries data (some only charge) and plug it into the brain, not the controller. Make sure the brain is on and VEXcode is closed.
- **"More than one VEX device plugged in":** unplug everything except the brain.
- **"No internet connection":** connect to Wi-Fi and click **Get latest code**. You can still upload the code you already have.
- **SmartScreen or antivirus warning:** the PROS uploader is not code-signed. It is the official release from [purduesigbots/pros-cli](https://github.com/purduesigbots/pros-cli).
- **Scripts blocked:** some school-managed laptops do not allow running scripts. Use a personal laptop or ask the programmer.
- **Uninstall:** remove the `%LOCALAPPDATA%\ScourgeUploader` folder along with the Desktop and Start menu shortcuts named Scourge Uploader. Unless you use PROS for other projects, delete the PROS settings folder at `%APPDATA%\PROS` as well.

---

## How it works

The robot source code is private. Each time the programmer pushes to the main branch of the private repository, GitHub Actions builds it and publishes the compiled program to this repository's [Releases](https://github.com/Whyater/40217S-Uploader/releases). A release has the robot program (`hot.package.bin`, `cold.package.bin`, `project.pros`, plus `auton-test-hot.package.bin` and `drive-test-hot.package.bin` for the test modes in newer builds), the Scourge Tester (`tester-hot.package.bin`, `tester-cold.package.bin`, `tester-project.pros`, in newer builds), and `release.json` (the build's tag, title, notes, and time, plus SHA-256 hashes of the other files).

**Get latest code** first checks for a newer uploader (see [Update the uploader](#update-the-uploader)). Then it downloads the newest release and, when the release lists SHA-256 hashes, checks each file before using it. Nothing is built on your laptop. **Upload to robot** hands those files to the official PROS command line tool, pros-cli 3.5.6.

The web version is in `web/` and is published with GitHub Pages. Browsers can't download release files from GitHub directly, so `scripts/publish-web.sh` copies the latest release's files onto the site (the `gh-pages` branch) and checks their hashes. It runs on the programmer's computer after each new build. Until it runs, the web version keeps the previous build. The web app sends them to the brain with its own port of the pros-cli 3.5.6 upload code. Its tests replay real pros-cli uploads and check every byte matches.

The installer downloads pros-cli from [github.com/purduesigbots/pros-cli](https://github.com/purduesigbots/pros-cli) and checks its SHA-256 hash before using it. The app and its files go into `%LOCALAPPDATA%\ScourgeUploader`. pros-cli also writes a small settings folder at `%APPDATA%\PROS`. Apart from those two folders and the two shortcuts, nothing else on your system changes.

## Status

The installer and app are tested on Windows in CI up to the USB step. A first real upload to a brain has not happened yet.

The web version is tested against a simulated brain only. A first upload from a phone to a real brain has not happened yet.

## Limitations

- The Windows app is Windows only. The Mac app needs an Apple silicon Mac, and the web version needs Chrome on Android or Chrome or Edge on a computer.
- Each upload needs a data USB cable straight to the brain.
- The program in the releases has not been run on the robot yet.

## License

All rights reserved. See [LICENSE](LICENSE). Third-party components bundled in the compiled program are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
