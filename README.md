# Vortex Launcher

An unofficial Minecraft launcher built with Electron. Offline-mode only — no Microsoft account integration.

![Vortex Launcher](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Electron](https://img.shields.io/badge/Electron-35+-purple)

## Download

Grab the latest release from the [Releases](../../releases) page.

## Features

### Instance System
- Create and manage multiple named instances, each with its own Minecraft version, loader, and mods
- Per-instance icons (built-in presets or custom uploaded images)
- Per-instance memory and resolution overrides
- Instance-level downloads: mods, resource packs, shader packs, and data packs

### Mod Loaders
- **Vanilla** — stock Minecraft, no mods
- **Fabric** — lightweight, fast-updating mod loader
- **NeoForge** — community fork of Forge for modern MC versions
- **Forge** — classic mod loader with processor-based installation
- **Quilt** — Fabric-compatible mod loader with extra features

All loaders resolve, download, and install automatically at launch time.

### Mod & Modpack Installation
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
- Selected skins saved to the skins folder automatically


### Settings
- Light / dark theme toggle
- Memory allocation slider
- Resolution selector
- Custom game directory (with native folder picker)
- Keep launcher open after game exits (toggle)
- JVM arguments (extra flags passed to Java)
- Java path override and auto-download

### UI
- Dark-themed interface with optional light mode
- Pinned play bar at the bottom across all views
- Responsive layout with mobile slide-in menu
- What's New changelog view

## How It Works

1. **Create an instance** — pick a name, Minecraft version, loader, and icon
2. **Install content** — browse Modrinth mods or upload files directly
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
git clone https://github.com/your-username/vortex-launcher.git
cd vortex-launcher
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
npm run build:linux   # Linux AppImage + .deb
```

Output goes to `dist/`.

## Project Structure

```
vortex-launcher/
├── launcher.html          # Single-file UI (HTML + CSS + JS)
├── package.json
├── .gitignore
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
│       ├── instances.js   # Instance CRUD and content tracking
│       ├── accounts.js    # Offline account management
│       ├── settings.js    # Global settings persistence
│       └── store.js       # JSON file storage
└── dist/                  # Build output (gitignored)
```

### Data Locations
- **Launcher config**: `src/data/` (settings.json, accounts.json, instances.json)
- **Game files**: `~/vortex-launcher/` (versions, libraries, assets, instances, java)

## License

MIT
