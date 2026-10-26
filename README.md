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
3. Answer the first two questions on the brain screen (see [Before every match](#before-every-match-set-up-the-robot-on-the-brain)), then tap the left or right button until the selected auton reads **Check: drive + sensors**.
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
| L2 (hold) | Lift down, only while held |
| D-pad Left (hold) | Lift up, only while held |
| Y | Lift up one Pin level (alliance goals) |
| D-pad Right | Lift up one Pin level (neutral goals) |
| A | Lift down one level |
| B | Reset: open the claw and lower the lift to the bottom |
| D-pad Up | Tilt the claw down (only with the lift at the bottom). If the claw is closed and empty, it opens first |
| D-pad Down | In a match: lift up to the "one Cup and one Pin" height. Off the field: a short press does the same, and holding it for 1 second starts the selected auton as a test (press it again to stop) |
| X | Open or close the claw (switches each press) |

If the claw is tilted down when you press a lift up button, the robot closes the claw and lifts it off the floor. Then it tilts the claw up and goes to the first level.

The claw also closes on its own when a Pin or Cup is right inside it, and opens on its own if the Pin or Cup it was holding is gone. Press **X** to open or close it yourself. D-pad Up does nothing while there's a Pin in the claw, so it can't drop one by accident.

The robot also handles Toggles for you. When one of its side toggle sensors is right next to a wall Toggle and a color is picked, the roller turns the Toggle to our color by itself and stops. Holding **L1** still spins the roller by hand and overrides it. Line 1 of the brain screen shows a short toggle status. It can read `OURS`, `SPIN`, `THEIRS`, `OTHER`, `NO TGL`, `NO COLOR`, `SENS ERR`, `STALL`, or `TIMEOUT`.

The lift heights are not set yet. Until the programmer measures them, the lift buttons only go a short way. Start the program with the lift all the way down.

## Before every match: set up the robot on the brain

After the program starts, the brain asks three things in order. You answer with the three buttons at the bottom of the brain screen.

1. **1/3 Alliance color?** Left button is RED, right button is BLUE.
2. **2/3 (your color) start side?** Left button is LEFT, right button is RIGHT. Left and right are as seen by the drive team, standing at your own alliance station and looking at the field.
3. **The routine.** Left and right step through the autons. The middle button starts over at step 1, and the routine you chose is kept.

The controller screen also shows your choice, such as "RED LEFT Match".

- **Color** sets which color the Toggle roller spins to. With no color picked, the toggles never spin on their own.
- **Side** picks which version of the match route runs. A match route will not run if no side is picked, and the brain says "NO SIDE PICKED".
- **Routines** are "Do nothing" (the default), "Match: left/right (side)", "Match: solo AWP", "Skills (60 s)", and the check, tune, and demo routines. Use "Match: solo AWP" only when our partner has no auton. It needs the RIGHT side.

## Measure the robot

The uploader has a **Robot tests** section. It puts a separate program on the brain that measures the robot, so the programmer can set real numbers instead of guesses.

1. Click **Put tester on robot**. This puts a program called "Scourge Tester" on slot 8. It does not replace the match program.
2. Turn on the controller and run "Scourge Tester" from the brain. Brain left and right buttons pick a test. The middle button (or **A**) runs it. Every test that moves the robot waits for you to press **A** and says how much space it needs. **B stops a test at once.**
3. When a test needs a number, D-pad Up and Down change it by 0.25, D-pad Left and Right change it by 1.0, and **A** saves it.
4. Plug the USB cable into the brain (or the controller) and click **Record results** before you run tests. The button becomes **Stop recording**, and the app shows how many values it recorded. You can't upload while it is recording.
5. When you are done, click **Send results**. Your browser opens a new issue in the team's private data repository with the results filled in. Check it and click Submit. If the results are too long for that, they are copied instead: paste them (Ctrl+V) into the box, then click Submit. You need to be signed in to GitHub with an account the programmer added to that repository.

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

The robot source code is private. Each time the programmer pushes to the main branch of the private repository, GitHub Actions builds it and publishes the compiled program to this repository's [Releases](https://github.com/Whyater/40217S-Uploader/releases). A release has the robot program (`hot.package.bin`, `cold.package.bin`, `project.pros`), the Scourge Tester (`tester-hot.package.bin`, `tester-cold.package.bin`, `tester-project.pros`, in newer builds), and `release.json` (the build's tag, title, notes, and time, plus SHA-256 hashes of the other files).

**Get latest code** first checks for a newer uploader (see [Update the uploader](#update-the-uploader)). Then it downloads the newest release and, when the release lists SHA-256 hashes, checks each file before using it. Nothing is built on your laptop. **Upload to robot** hands those files to the official PROS command line tool, pros-cli 3.5.6.

The installer downloads pros-cli from [github.com/purduesigbots/pros-cli](https://github.com/purduesigbots/pros-cli) and checks its SHA-256 hash before using it. The app and its files go into `%LOCALAPPDATA%\ScourgeUploader`. pros-cli also writes a small settings folder at `%APPDATA%\PROS`. Apart from those two folders and the two shortcuts, nothing else on your system changes.

## Status

The installer and app are tested on Windows in CI up to the USB step. A first real upload to a brain has not happened yet.

## Limitations

- Windows only.
- Each upload needs a data USB cable straight to the brain.
- The program in the releases has not been run on the robot yet.

## License

All rights reserved. See [LICENSE](LICENSE). Third-party components bundled in the compiled program are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
