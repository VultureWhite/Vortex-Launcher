# Vortex Launcher

An unofficial Minecraft launcher built with Electron. Offline-mode only — no Microsoft account integration.

![Vortex Launcher](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Version](https://img.shields.io/badge/version-0.1.0--alpha-orange) ![Electron](https://img.shields.io/badge/Electron-35+-purple)

## Download

Grab the latest release from the [Releases](../../releases) page.

## Features

### Home Page
- Welcome screen with player name and random gameplay tips
- Quick launch recent instances with one click
- Live stats: total instances, mods, worlds, launches, and playtime
- Quick action shortcuts to Instances, Modpacks, Skins, and Settings

### Instance System
- Create and manage multiple named instances, each with its own Minecraft version, loader, and mods
- Per-instance icons (built-in presets or custom uploaded images)
- Per-instance memory and resolution overrides
- Instance-level downloads: mods, resource packs, shader packs, and data packs
- Delete instances with automatic filesystem cleanup
- Track launch count and total playtime per instance

### Modpacks
- Install modpacks from [Modrinth](https://modrinth.com/) with one click
- Automatic instance creation from `.mrpack` files
- Version range parsing for correct Minecraft version resolution
- Auto-downloads all required mods from the modpack manifest

### Mod Loaders
- **Vanilla** — stock Minecraft, no mods
- **Fabric** — lightweight, fast-updating mod loader
- **NeoForge** — community fork of Forge for modern MC versions
- **Forge** — classic mod loader with processor-based installation
- **Quilt** — Fabric-compatible mod loader with extra features

All loaders resolve, download, and install automatically at launch time.

### Mod & Content Installation
- Install mods directly from [Modrinth](https://modrinth.com/) into any instance
- Download mods, resource packs, shader packs, and data packs per-instance
- Remove installed content with one click

### Java Management
- Auto-detects installed Java runtimes (Zulu, Adoptium, Oracle, system)
- MC-version-aware selection: Java 17 for <1.20.5, Java 21 for >=1.20.5
- One-click download of Adoptium JDK from Settings
- Manual Java path override via Settings

### Skins
- 9 built-in skin presets (Alex, Ari, Efe, Kai, Makena, Noor, Steve, Sunny, Zuri)
- Upload custom skin PNGs (64×64 or 64×32)
- Front-facing paper-doll preview
- Skins persist across sessions in the user data folder

### Accounts
- Offline profiles stored on this device only
- Add, remove, and switch between multiple profiles
- Active profile shown in the sidebar

### Settings
- Light / dark theme toggle
- Memory allocation slider
- Resolution selector
- Custom game directory (with native folder picker)
- Keep launcher open after game exits (toggle)
- JVM arguments (extra flags passed to Java)
- Java path override and auto-download
- Snapshot version toggle for the version list

### UI
- Dark-themed interface with optional light mode
- Pinned play bar at the bottom across all views
- Responsive layout with mobile slide-in menu
- What's New changelog view

## How It Works

1. **Create an instance** — pick a name, Minecraft version, loader, and icon
2. **Install content** — browse Modrinth mods, install a modpack, or upload files directly
3. **Hit PLAY** — the launcher downloads everything needed (client JAR, libraries, assets, loader) and starts the game
4. All paths, classpath construction, and JVM arguments are handled automatically per loader

## Supported Versions

Any version available in the official Minecraft version manifest. Loader support varies by MC version:
- **Fabric/Quilt**: most modern versions
- **NeoForge**: 1.20.5+
- **Forge**: most versions (legacy installer + processor-based for newer)

## Disclaimer

This is a fan-made, unofficial launcher. It is not affiliated with, endorsed by, or connected to Mojang Studios or Microsoft. All Minecraft game content, trademarks, and the Minecraft name belong to Mojang Studios / Microsoft.

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [npm](https://www.npmjs.com/)
- Java 17 or 21 (the launcher can download one for you)

### Install & Run

```bash
git clone https://github.com/VultureWhite/Vortex-Launcher.git
cd Vortex-Launcher
npm install
npm start
```

For development with DevTools:

```bash
npm run dev
```

### Building Distributables

```bash
npm run build:win     # Windows NSIS installer + portable .exe
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux AppImage + .deb (run on a Linux machine)
```

Output goes to `dist/`.

## Project Structure

```
vortex-launcher/
├── launcher.html          # Single-file UI (HTML + CSS + JS)
├── package.json
├── .gitignore
├── LICENSE
├── assets/
│   ├── icon.ico           # App icon (Windows)
│   ├── icon.png           # App icon (PNG)
│   ├── icon.svg           # App icon (source)
│   └── skins/             # Built-in skin PNGs
├── src/
│   ├── main.js            # Electron main process, IPC handlers
│   ├── preload.js         # Context bridge (renderer ↔ main)
│   └── backend/
│       ├── launcher.js    # Core: version resolve, install, launch, Java detection
│       ├── instances.js   # Instance CRUD, content tracking, playtime
│       ├── accounts.js    # Offline account management
│       ├── settings.js    # Global settings persistence
│       └── store.js       # JSON file-backed storage
└── dist/                  # Build output (gitignored)
```

### Data Locations
- **Launcher config**: `AppData/Roaming/vortex-launcher/data/` (settings.json, accounts.json, instances.json)
- **Skins**: `AppData/Roaming/vortex-launcher/skins/`
- **Game files**: `~/vortex-launcher/` (versions, libraries, assets, instances, java)

## License

MIT
