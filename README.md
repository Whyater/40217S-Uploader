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

The installer downloads the official PROS uploader and the Scourge Uploader app. It then adds a **Scourge Uploader** shortcut to your Desktop and Start menu and opens the app. Run the same line again any time to update the app.

## Upload (every time)

1. Plug a USB data cable into the **brain** (not the controller) and turn the brain on.
2. Open **Scourge Uploader**.
3. If it says newer code is available, click **Get latest code**. On the very first launch it downloads the code for you.
4. Pick a slot (1 to 8).
5. Check the **Program name** box. This is the name the brain shows for the program. It starts as `Scourge`. Names can use letters, numbers, spaces, `_`, `.`, and `-`, up to 20 characters, and must start with a letter or number.
6. Click **Upload to robot** and keep the cable plugged in until it finishes.

When it is done, the program shows on the brain. Run it from the brain screen.

## Check the drive (first time, and after any rewiring)

Do this before driving, so a wrongly wired motor shows up on a screen instead of on the field.

1. Put the robot flat on the floor, not on a stand, with about 2 feet of open space on every side.
2. Turn on the controller and run the program from the brain. Do not touch the robot for 3 seconds while its sensors calibrate.
3. Tap the left or right button at the bottom of the brain screen until the selected auton reads **Check: drive + sensors**.
4. Press **D-pad Left** on the controller. The robot turns a little one way, then the other, rolls forward a few inches, and backs up. Press **D-pad Down** at any time to stop it.
5. Take a photo of the brain screen and the controller screen and send it to the programmer.

Each line reads OK, REVERSED, NO TURN, or NOT TURNING. Only drive with the sticks once both **Left** and **Right** say OK.

**D-pad Left** and **D-pad Down** only start and stop tests when the robot is not plugged into a field or competition switch.

## Controls

| Control | What it does |
| --- | --- |
| Left stick | Drives forward and back. Pushing it forward drives the robot backwards, on purpose |
| Right stick | Turns. With it centered the robot holds straight on its own |
| R1 (hold) | Intake in |
| R2 (hold) | Intake out |
| L1 (hold) | Roller |
| L2 (hold) | Lift down |
| X | Lift up one Pin level (alliance goals) |
| D-pad Right | Lift up one Pin level (neutral goals) |
| B | Lift down one level |
| A | Reset: open the claw and lower the lift to the bottom |
| D-pad Up | Tilt the claw down (only with the lift at the bottom) |
| Y | Open the claw |

If the claw is tilted down when you press a lift up button, the robot closes the claw and lifts it off the floor. Then it tilts the claw up and goes to the first level.

The lift heights are not set yet. Until the programmer measures them, the lift buttons only go a short way. Start the program with the lift all the way down.

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

The robot source code is private. Each time the programmer pushes to the main branch of the private repository, GitHub Actions builds it and publishes the compiled program to this repository's [Releases](https://github.com/Whyater/40217S-Uploader/releases). A release has four files: `hot.package.bin`, `cold.package.bin`, `project.pros`, and `release.json` (the build's tag, title, notes, and time, plus SHA-256 hashes of the other three files in newer builds).

**Get latest code** downloads the newest release and, when the release lists SHA-256 hashes, checks each file before using it. Nothing is built on your laptop. **Upload to robot** hands those files to the official PROS command line tool, pros-cli 3.5.6.

The installer downloads pros-cli from [github.com/purduesigbots/pros-cli](https://github.com/purduesigbots/pros-cli) and checks its SHA-256 hash before using it. The app and its files go into `%LOCALAPPDATA%\ScourgeUploader`. pros-cli also writes a small settings folder at `%APPDATA%\PROS`. Apart from those two folders and the two shortcuts, nothing else on your system changes.

## Status

The installer and app are tested on Windows in CI up to the USB step. A first real upload to a brain has not happened yet.

## Limitations

- Windows only.
- Each upload needs a data USB cable straight to the brain.
- The program in the releases has not been run on the robot yet.

## License

All rights reserved. See [LICENSE](LICENSE). Third-party components bundled in the compiled program are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
