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
5. Click **Upload to robot** and keep the cable plugged in until it finishes.

When it is done, the program shows on the brain. Run it from the brain screen.

---

## If something goes wrong

- **"No brain found":** use a cable that carries data (some only charge) and plug it into the brain, not the controller. Make sure the brain is on and VEXcode is closed.
- **"More than one VEX device plugged in":** unplug everything except the brain.
- **"No internet connection":** connect to Wi-Fi and click **Get latest code**. You can still upload the code you already have.
- **SmartScreen or antivirus warning:** the PROS uploader is not code-signed. It is the official release from [purduesigbots/pros-cli](https://github.com/purduesigbots/pros-cli).
- **Scripts blocked:** some school-managed laptops do not allow running scripts. Use a personal laptop or ask the programmer.
- **Uninstall:** delete the `%LOCALAPPDATA%\ScourgeUploader` folder and the two Scourge Uploader shortcuts (Desktop and Start menu).

---

## How it works

The robot source code is private. Each time the programmer pushes to the main branch of the private repository, GitHub Actions builds it and publishes the compiled program to this repository's [Releases](https://github.com/Whyater/40217S-Uploader/releases). A release has three files: `hot.package.bin`, `cold.package.bin`, and `project.pros`.

**Get latest code** downloads the newest release. Nothing is built on your laptop. **Upload to robot** hands those files to the official PROS command line tool, pros-cli 3.5.6.

The installer downloads pros-cli from [github.com/purduesigbots/pros-cli](https://github.com/purduesigbots/pros-cli) and checks its SHA-256 hash before using it. Everything goes into `%LOCALAPPDATA%\ScourgeUploader`. Apart from the two shortcuts, it does not touch the rest of your system.

## Status

The installer and app are tested on Windows in CI up to the USB step. A first real upload to a brain has not happened yet.

## Limitations

- Windows only.
- Each upload needs a data USB cable straight to the brain.
- The program in the releases has not been run on the robot yet.

## License

All rights reserved. See [LICENSE](LICENSE). Third-party components bundled in the compiled program are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
