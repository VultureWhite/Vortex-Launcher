/**
 * launcher.js — Minecraft installation and launch orchestrator.
 *
 * Responsibilities:
 *  - Resolve version manifest → version JSON
 *  - Download client JAR, libraries, assets
 *  - Detect or manage Java
 *  - Build classpath and JVM arguments
 *  - Spawn the game process
 *  - Push progress / log / state events to the renderer
 *
 * Future: mod loader installation (Fabric, Forge, NeoForge, Quilt),
 *         Microsoft auth token injection, custom JVM args, native libs.
 */

const { BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const yauzl = require('yauzl');
const instancesModule = require('./instances');
const settings = require('./settings');

// ── Constants ─────────────────────────────────────────────────────────────────

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const LAUNCHER_NAME = 'VortexLauncher';
const LAUNCHER_VERSION = '1.0.0';

// ── State ─────────────────────────────────────────────────────────────────────

const runningProcesses = new Map(); // instanceId → ChildProcess

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBaseDir() {
  const s = settings.get();
  if (s.gameDir) return s.gameDir;
  // Default: ~/vortex-launcher
  const home = require('os').homedir();
  return path.join(home, 'vortex-launcher');
}

function getInstancesDir() {
  return path.join(getBaseDir(), 'instances');
}

function getInstanceDir(instanceId) {
  const inst = instancesModule.getById(instanceId);
  if (!inst) return null;
  const slug = slugify(inst.name);
  return path.join(getInstancesDir(), slug);
}

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'instance';
}

/** HTTPS/HTTP GET returning a Buffer. */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'VortexLauncher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Download a file to disk, skipping if it exists and size matches. */
async function downloadFile(url, dest, expectedSha1) {
  try {
    const stat = await fs.stat(dest);
    if (stat.size > 0 && !expectedSha1) return; // exists, skip
    if (expectedSha1) {
      const buf = await fs.readFile(dest);
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (hash === expectedSha1) return;
    }
  } catch { /* file doesn't exist, proceed */ }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const buf = await httpGet(url);
  await fs.writeFile(dest, buf);
}

function httpDownloadWithProgress(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const follow = (u) => {
      mod.get(u, { headers: { 'User-Agent': 'VortexLauncher/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const ws = require('fs').createWriteStream(dest);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          ws.write(chunk);
          if (onProgress && total > 0) onProgress(downloaded, total);
        });
        res.on('end', () => { ws.end(() => resolve()); });
        res.on('error', (err) => { ws.destroy(); reject(err); });
        ws.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

// ── Fabric Loader ─────────────────────────────────────────────────────────────

const FABRIC_META_BASE = 'https://meta.fabricmc.net/v2';

/**
 * Resolve the Fabric version JSON for a given Minecraft version and loader.
 * Fabric profiles use "inheritsFrom" to extend the vanilla version JSON.
 * This merges the two: vanilla provides downloads/assets/base args,
 * Fabric overlays its libraries, mainClass, and additional args.
 * Caches the result on disk so subsequent launches are instant.
 */
async function getFabricVersionJSON(mcVersion, loaderVersion) {
  const baseDir = getBaseDir();
  const versionId = `fabric-loader-${loaderVersion || 'latest'}-${mcVersion}`;
  const versionDir = path.join(baseDir, 'versions', versionId);

  // Check cache first
  const cachedJsonPath = path.join(versionDir, `${versionId}.json`);
  try {
    const cached = await fs.readFile(cachedJsonPath, 'utf-8');
    return JSON.parse(cached);
  } catch { /* not cached, fetch */ }

  // If no specific loader version requested, get the latest stable
  if (!loaderVersion) {
    const buf = await httpGet(`${FABRIC_META_BASE}/versions/loader/${mcVersion}`);
    const loaders = JSON.parse(buf.toString());
    const stable = loaders.find(l => l.loader && l.loader.stable);
    if (!stable) throw new Error(`No stable Fabric loader found for Minecraft ${mcVersion}`);
    loaderVersion = stable.loader.version;
  }

  // Fetch the Fabric profile JSON
  const profileUrl = `${FABRIC_META_BASE}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const buf = await httpGet(profileUrl);
  const fabricProfile = JSON.parse(buf.toString());

  // Resolve inheritsFrom — merge with the vanilla version JSON
  const inheritsFrom = fabricProfile.inheritsFrom || mcVersion;
  const vanillaJSON = await getVersionJSON(inheritsFrom);

  // Deep merge: start with vanilla, overlay Fabric additions
  const merged = { ...vanillaJSON };

  // Use Fabric's ID
  merged.id = `fabric-loader-${loaderVersion}-${mcVersion}`;

  // Use Fabric's mainClass
  if (fabricProfile.mainClass) {
    merged.mainClass = fabricProfile.mainClass;
  }

  // Merge arguments (Fabric's additional args go AFTER vanilla's)
  if (fabricProfile.arguments) {
    const vanillaArgs = merged.arguments || {};
    const fabricArgs = fabricProfile.arguments;
    merged.arguments = {
      game: [...(vanillaArgs.game || []), ...(fabricArgs.game || [])],
      jvm: [...(vanillaArgs.jvm || []), ...(fabricArgs.jvm || [])]
    };
  }

  // Merge libraries — Fabric's libraries are appended after vanilla's
  const vanillaLibs = merged.libraries || [];
  const fabricLibs = (fabricProfile.libraries || []).map(lib => {
    // Convert Maven coordinates to download URL/path
    // e.g. "net.fabricmc:fabric-loader:0.19.3" → "net/fabricmc/fabric-loader/0.19.3/fabric-loader-0.19.3.jar"
    const parts = lib.name.split(':');
    const group = parts[0];
    const artifact = parts[1];
    const version = parts[2];
    const mavenPath = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
    const baseUrl = lib.url || 'https://repo1.maven.org/maven2/';

    return {
      name: lib.name,
      downloads: {
        artifact: {
          path: mavenPath,
          url: baseUrl + mavenPath,
          sha1: lib.sha1 || undefined,
          size: lib.size || undefined
        }
      }
    };
  });

  // Deduplicate by name (Fabric's version wins if there's a conflict)
  const libMap = new Map();
  for (const lib of vanillaLibs) {
    if (lib.name) libMap.set(lib.name, lib);
  }
  for (const lib of fabricLibs) {
    if (lib.name) libMap.set(lib.name, lib);
  }
  merged.libraries = Array.from(libMap.values());

  // Cache to disk
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(cachedJsonPath, JSON.stringify(merged, null, 2));

  return merged;
}

/**
 * Returns true if the given version JSON is a Fabric profile (has Fabric-specific libraries).
 */
function isFabricVersion(versionJSON) {
  return !!(versionJSON.libraries || []).find(lib =>
    lib.name && lib.name.includes('net.fabricmc')
  );
}

// ── Quilt Loader ─────────────────────────────────────────────────────────────

const QUILT_META_BASE = 'https://meta.quiltmc.org/v3';

/**
 * Resolve the Quilt version JSON for a given Minecraft version and loader.
 * Quilt profiles use "inheritsFrom" to extend the vanilla version JSON,
 * same pattern as Fabric.
 */
async function getQuiltVersionJSON(mcVersion, loaderVersion) {
  const baseDir = getBaseDir();
  const versionId = `quilt-loader-${loaderVersion || 'latest'}-${mcVersion}`;
  const versionDir = path.join(baseDir, 'versions', versionId);

  // Check cache first
  const cachedJsonPath = path.join(versionDir, `${versionId}.json`);
  try {
    const cached = await fs.readFile(cachedJsonPath, 'utf-8');
    return JSON.parse(cached);
  } catch { /* not cached, fetch */ }

  // If no specific loader version requested, get the latest stable
  if (!loaderVersion) {
    const buf = await httpGet(`${QUILT_META_BASE}/versions/loader/${mcVersion}`);
    const loaders = JSON.parse(buf.toString());
    const stable = loaders.find(l => l.loader && l.loader.stable);
    const chosen = stable || loaders[0];
    if (!chosen) throw new Error(`No Quilt loader found for Minecraft ${mcVersion}`);
    loaderVersion = chosen.loader.version;
  }

  // Fetch the Quilt profile JSON
  const profileUrl = `${QUILT_META_BASE}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const buf = await httpGet(profileUrl);
  const quiltProfile = JSON.parse(buf.toString());

  // Resolve inheritsFrom — merge with the vanilla version JSON
  const inheritsFrom = quiltProfile.inheritsFrom || mcVersion;
  const vanillaJSON = await getVersionJSON(inheritsFrom);

  // Deep merge: start with vanilla, overlay Quilt additions
  const merged = { ...vanillaJSON };

  // Use Quilt's ID
  merged.id = `quilt-loader-${loaderVersion}-${mcVersion}`;

  // Use Quilt's mainClass
  if (quiltProfile.mainClass) {
    merged.mainClass = quiltProfile.mainClass;
  }

  // Merge arguments (Quilt's additional args go AFTER vanilla's)
  if (quiltProfile.arguments) {
    const vanillaArgs = merged.arguments || {};
    const quiltArgs = quiltProfile.arguments;
    merged.arguments = {
      game: [...(vanillaArgs.game || []), ...(quiltArgs.game || [])],
      jvm: [...(vanillaArgs.jvm || []), ...(quiltArgs.jvm || [])]
    };
  }

  // Merge libraries — Quilt's libraries are appended after vanilla's
  const vanillaLibs = merged.libraries || [];
  const quiltLibs = (quiltProfile.libraries || []).map(lib => {
    // Convert Maven coordinates to download URL/path
    const parts = lib.name.split(':');
    const group = parts[0];
    const artifact = parts[1];
    const version = parts[2];
    const mavenPath = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
    const baseUrl = lib.url || 'https://repo1.maven.org/maven2/';

    return {
      name: lib.name,
      downloads: {
        artifact: {
          path: mavenPath,
          url: baseUrl + mavenPath,
          sha1: lib.sha1 || undefined,
          size: lib.size || undefined
        }
      }
    };
  });

  // Deduplicate by name (Quilt's version wins if there's a conflict)
  const libMap = new Map();
  for (const lib of vanillaLibs) {
    if (lib.name) libMap.set(lib.name, lib);
  }
  for (const lib of quiltLibs) {
    if (lib.name) libMap.set(lib.name, lib);
  }
  merged.libraries = Array.from(libMap.values());

  // Cache to disk
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(cachedJsonPath, JSON.stringify(merged, null, 2));

  return merged;
}

/**
 * Returns true if the given version JSON is a Quilt profile.
 */
function isQuiltVersion(versionJSON) {
  return !!(versionJSON.libraries || []).find(lib =>
    lib.name && lib.name.includes('org.quiltmc')
  );
}

/**
 * Extract a JSON file from a JAR/ZIP archive using yauzl.
 * Looks for exact filename match (e.g. 'version.json').
 */
function extractJsonFromJar(installerPath, fileName) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(installerPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName === fileName) {
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);
            const chunks = [];
            readStream.on('data', (chunk) => chunks.push(chunk));
            readStream.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch (e) { reject(e); }
            });
            readStream.on('error', reject);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => reject(new Error(`${fileName} not found in ${installerPath}`)));
    });
  });
}

/**
 * Merge a loader profile (Fabric/NeoForge/Forge/Quilt) with vanilla via inheritsFrom.
 * The profile provides mainClass, arguments, and libraries.
 * Vanilla provides downloads/assets/base args.
 */
async function mergeLoaderProfile(loaderProfile, fallbackMavenUrl) {
  const inheritsFrom = loaderProfile.inheritsFrom;
  const vanillaJSON = await getVersionJSON(inheritsFrom);
  const merged = { ...vanillaJSON };

  if (loaderProfile.id) merged.id = loaderProfile.id;
  if (loaderProfile.mainClass) merged.mainClass = loaderProfile.mainClass;
  if (loaderProfile.type) merged.type = loaderProfile.type;

  if (loaderProfile.arguments) {
    const vanillaArgs = merged.arguments || {};
    const loaderArgs = loaderProfile.arguments;
    merged.arguments = {
      game: [...(vanillaArgs.game || []), ...(loaderArgs.game || [])],
      jvm: [...(vanillaArgs.jvm || []), ...(loaderArgs.jvm || [])]
    };
  }

  const vanillaLibs = merged.libraries || [];
  const loaderLibs = (loaderProfile.libraries || []).map(lib => {
    if (lib.downloads && lib.downloads.artifact) return lib;
    const parts = lib.name.split(':');
    const group = parts[0]; const artifact = parts[1]; const version = parts[2];
    const mavenPath = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
    const baseUrl = lib.url || fallbackMavenUrl || 'https://repo1.maven.org/maven2/';
    return { name: lib.name, downloads: { artifact: { path: mavenPath, url: baseUrl + mavenPath, sha1: lib.sha1, size: lib.size } } };
  });

  const libMap = new Map();
  for (const lib of vanillaLibs) { if (lib.name) libMap.set(lib.name, lib); }
  for (const lib of loaderLibs) { if (lib.name) libMap.set(lib.name, lib); }
  merged.libraries = Array.from(libMap.values());
  return merged;
}

// ── NeoForge/Forge Processor Runner ──────────────────────────────────────────
// NeoForge and Forge require running install processors to patch the vanilla MC JAR.
// Without this, BootstrapLauncher can't find vanilla classes (e.g. LoadingOverlay).

function getJarMainClass(jarPath) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName.toUpperCase() === 'META-INF/MANIFEST.MF') {
          zipfile.openReadStream(entry, (err, rs) => {
            if (err) return reject(err);
            const chunks = [];
            rs.on('data', (c) => chunks.push(c));
            rs.on('end', () => {
              const text = Buffer.concat(chunks).toString();
              const m = text.match(/Main-Class:\s*(.+)/i);
              resolve(m ? m[1].trim().replace(/\r/g, '') : null);
            });
            rs.on('error', reject);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => resolve(null));
    });
  });
}

function extractFileFromJar(jarPath, entryName, outputPath) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName === entryName) {
          zipfile.openReadStream(entry, (err, rs) => {
            if (err) return reject(err);
            const ws = fsSync.createWriteStream(outputPath);
            rs.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => reject(new Error(`${entryName} not found in ${jarPath}`)));
    });
  });
}

function extractFilesFromJar(jarPath, dirPrefix, outputDir) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      const extracted = [];
      zipfile.on('entry', (entry) => {
        if (entry.fileName.startsWith(dirPrefix) && !entry.fileName.endsWith('/')) {
          const relative = entry.fileName.slice(dirPrefix.length);
          const outPath = path.join(outputDir, relative);
          fsSync.mkdirSync(path.dirname(outPath), { recursive: true });
          zipfile.openReadStream(entry, (err, rs) => {
            if (err) return reject(err);
            const ws = fsSync.createWriteStream(outPath);
            rs.pipe(ws);
            ws.on('finish', () => { extracted.push(outPath); zipfile.readEntry(); });
            ws.on('error', reject);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => resolve(extracted));
    });
  });
}

function resolveMaven(name, libDir) {
  const clean = name.split('@')[0]; // strip @zip, @txt, etc.
  const parts = clean.split(':');
  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts.length > 3 ? parts[3] : null;
  const ext = name.includes('@') ? name.split('@')[1] : 'jar';
  const fileName = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  const mavenPath = `${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
  return path.join(libDir, mavenPath);
}

async function downloadMavenArtifact(name, libDir) {
  const clean = name.split('@')[0];
  const parts = clean.split(':');
  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts.length > 3 ? parts[3] : null;
  const ext = name.includes('@') ? name.split('@')[1] : 'jar';
  const fileName = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  const mavenPath = `${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
  const dest = path.join(libDir, mavenPath);

  // Determine base URL from group
  let baseUrl = 'https://repo1.maven.org/maven2/';
  if (group.startsWith('net.neoforged')) baseUrl = 'https://maven.neoforged.net/releases/';
  else if (group.startsWith('net.minecraftforge')) baseUrl = 'https://maven.minecraftforge.net/';
  else if (group.startsWith('net.minecraft')) baseUrl = 'https://libraries.minecraft.net/';
  else if (group.startsWith('cpw.mods') || group.startsWith('net.fabricmc') || group.startsWith('org.spongepowered') || group.startsWith('de.oceanlabs')) baseUrl = 'https://maven.neoforged.net/releases/';

  await downloadFile(baseUrl + mavenPath, dest);
  return dest;
}

async function runNeoForgeProcessors(installProfile, mcVersion, neoForgeVersion, baseDir, installerPath, sendLog) {
  const libDir = path.join(baseDir, 'libraries');
  const mcVersionDir = path.join(baseDir, 'versions', mcVersion);
  const mcJarPath = path.join(mcVersionDir, `${mcVersion}.jar`);
  const patchedJarDir = path.join(libDir, `net/neoforged/neoforge/${neoForgeVersion}`);

  // Check if already patched AND the universal JAR exists (defines the neoforge module)
  const patchedJarPath = path.join(patchedJarDir, `neoforge-${neoForgeVersion}-client.jar`);
  const universalJarPath = path.join(patchedJarDir, `neoforge-${neoForgeVersion}-universal.jar`);
  const clientExists = await fs.access(patchedJarPath).then(() => true).catch(() => false);
  const universalExists = await fs.access(universalJarPath).then(() => true).catch(() => false);
  if (clientExists && universalExists) {
    sendLog('NeoForge already patched, skipping processors.');
    return patchedJarPath;
  }

  // Ensure vanilla MC JAR is downloaded (processors need it as input)
  const vanillaJSON = await getVersionJSON(mcVersion);
  if (vanillaJSON.downloads && vanillaJSON.downloads.client) {
    await fs.mkdir(mcVersionDir, { recursive: true });
    await downloadFile(vanillaJSON.downloads.client.url, mcJarPath, vanillaJSON.downloads.client.sha1);
  }

  // Working directory for intermediate files
  const workDir = path.join(baseDir, 'versions', `neoforge-${neoForgeVersion || mcVersion}`, 'processors');
  await fs.mkdir(workDir, { recursive: true });

  // Extract binary patches from installer JAR
  const patchDir = path.join(workDir, 'patches');
  await fs.mkdir(patchDir, { recursive: true });
  sendLog('Extracting binary patches from installer…');
  try {
    await extractFilesFromJar(installerPath, 'data/', patchDir);
  } catch (e) {
    sendLog(`Warning: could not extract patches: ${e.message}`);
  }

  // Download all processor dependency libraries
  sendLog('Downloading processor dependencies…');
  for (const lib of installProfile.libraries) {
    const jarPath = resolveMaven(lib.name, libDir);
    try { await fs.access(jarPath); } catch {
      if (lib.downloads && lib.downloads.artifact) {
        const art = lib.downloads.artifact;
        await fs.mkdir(path.dirname(jarPath), { recursive: true });
        await downloadFile(art.url, jarPath, art.sha1);
      } else {
        await downloadMavenArtifact(lib.name, libDir);
      }
    }
  }

  // Build template variable map
  const vars = {
    '{ROOT}': baseDir,
    '{MINECRAFT_JAR}': mcJarPath,
    '{SIDE}': 'client',
    '{INSTALLER}': installerPath,
  };

  // Resolve data section variables.
  // Data entries define WHERE processors write their outputs.
  // [dep] = output path derived from Maven coordinate (not a download)
  // /path = file inside installer JAR (extract it)
  const data = installProfile.data || {};
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'object' && val.client) {
      const ref = val.client;
      if (ref.startsWith('[')) {
        // Maven-style reference — this defines the OUTPUT path, not an input download
        const dep = ref.slice(1, -1).split('@')[0];
        vars[`{${key}}`] = resolveMaven(dep, libDir);
      } else if (ref.startsWith('/')) {
        // Path within installer JAR — extract it (used for BINPATCH)
        // ref is "/data/client.lzma", extracted to patchDir/client.lzma
        const relativePath = ref.startsWith('/data/') ? ref.slice(6) : ref.slice(1);
        vars[`{${key}}`] = path.join(patchDir, relativePath);
      } else {
        vars[`{${key}}`] = ref;
      }
    }
  }

  // Pre-download mojmaps via Node.js if DOWNLOAD_MOJMAPS processor is needed.
  // Java's DNS can't resolve piston-data.mojang.com on some systems, so we fetch
  // the mappings ourselves and place them at the output path. The processor will
  // then see the file already exists and we skip running it.
  const mojmapsPath = vars['{MOJMAPS}'];
  if (mojmapsPath) {
    try { await fs.access(mojmapsPath); sendLog('Mojmaps already present.'); } catch {
      sendLog('Pre-downloading mojmaps via Node.js…');
      try {
        const manifestBuf = await httpGet('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
        const manifest = JSON.parse(manifestBuf.toString());
        const versionEntry = manifest.versions.find(v => v.id === mcVersion);
        if (versionEntry) {
          const versionBuf = await httpGet(versionEntry.url);
          const versionData = JSON.parse(versionBuf.toString());
          const dl = versionData.downloads.client_mappings;
          await fs.mkdir(path.dirname(mojmapsPath), { recursive: true });
          await downloadFile(dl.url, mojmapsPath, dl.sha1);
          sendLog(`Mojmaps downloaded (${(dl.size / 1024).toFixed(0)} KB).`);
        }
      } catch (e) {
        sendLog(`Warning: pre-download mojmaps failed: ${e.message}`);
      }
    }
  }

  // Run each processor
  const processors = installProfile.processors || [];
  for (let i = 0; i < processors.length; i++) {
    const proc = processors[i];
    if (proc.sides && !proc.sides.includes('client')) continue;

    const taskName = proc.args[1] || proc.args[0] || `processor-${i}`;
    sendLog(`Running processor ${i}: ${taskName}…`);

    // Skip DOWNLOAD_MOJMAPS if we already pre-downloaded the output
    if (taskName === 'DOWNLOAD_MOJMAPS' && vars['{MOJMAPS}']) {
      try { await fs.access(vars['{MOJMAPS}']); sendLog(`Skipping ${taskName} — already fetched.`); continue; } catch {}
    }

    // Download processor JAR
    const procJarPath = resolveMaven(proc.jar, libDir);

    // Download classpath JARs
    const cpJarPaths = [];
    for (const cpName of (proc.classpath || [])) {
      cpJarPaths.push(resolveMaven(cpName, libDir));
    }

    // Get main class from JAR manifest
    const mainClass = await getJarMainClass(procJarPath);
    if (!mainClass) throw new Error(`Could not determine main class for ${proc.jar}`);

    // Build classpath
    const classpath = [procJarPath, ...cpJarPaths].join(process.platform === 'win32' ? ';' : ':');

    // Resolve template variables in args
    const resolvedArgs = proc.args.map(a => {
      let result = a;
      for (const [key, val] of Object.entries(vars)) {
        result = result.split(key).join(val);
      }
      // Resolve [dep] references in args
      result = result.replace(/\[([^\]]+)\]/g, (match, dep) => {
        return resolveMaven(dep, libDir);
      });
      // Strip @ext suffixes from paths
      result = result.replace(/@(\w+)(?=\s|$)/g, '');
      return result;
    });

    // Execute processor
    try {
      execFileSync('java', ['-cp', classpath, mainClass, ...resolvedArgs], {
        cwd: workDir,
        stdio: 'pipe',
        timeout: 120000
      });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      throw new Error(`Processor ${taskName} failed: ${stderr || err.message}`);
    }
  }

  // Inject META-INF/MANIFEST.MF into the patched JAR.
  // The binary patcher produces a bare JAR without META-INF.
  // A minimal manifest prevents FML's ImmediateWindowHandler from NPEing
  // when it tries to read JAR metadata. We do NOT set Automatic-Module-Name
  // here because the patched client JAR is loaded by the "production client
  // provider" as the `minecraft` module — setting it to "neoforge" would
  // conflict with the universal JAR's module-info.class.
  sendLog('Injecting MANIFEST.MF into patched JAR…');
  const manifestDir = path.join(workDir, '_manifest_inject');
  const metaInfDir = path.join(manifestDir, 'META-INF');
  await fs.mkdir(metaInfDir, { recursive: true });
  await fs.writeFile(path.join(metaInfDir, 'MANIFEST.MF'),
    'Manifest-Version: 1.0\n');
  try {
    execFileSync('jar', ['uf', patchedJarPath, '-C', manifestDir, 'META-INF/MANIFEST.MF'], {
      cwd: workDir, stdio: 'pipe', timeout: 30000
    });
    sendLog('MANIFEST.MF injected successfully.');
  } catch (e) {
    sendLog(`Warning: could not inject manifest via jar command: ${e.message}`);
  }
  try { await fs.rm(manifestDir, { recursive: true, force: true }); } catch {}

  sendLog('All processors completed successfully.');
  return patchedJarPath;
}

// ── NeoForge Loader ──────────────────────────────────────────────────────────

const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

async function getNeoForgeVersionForMC(mcVersion) {
  const metadataUrl = `${NEOFORGE_MAVEN_BASE}/maven-metadata.xml`;
  const buf = await httpGet(metadataUrl);
  const xml = buf.toString();
  const mcMajorMinor = mcVersion.replace('1.', '');
  const versionRegex = new RegExp('<version>(' + mcMajorMinor.replace('.', '\\.') + '\\.\\d+(?:-beta)?)</version>', 'g');
  const versions = [];
  let match;
  while ((match = versionRegex.exec(xml)) !== null) versions.push(match[1]);
  if (versions.length === 0) throw new Error(`No NeoForge version found for Minecraft ${mcVersion}`);
  return versions.sort((a, b) => {
    const pa = a.replace(/-beta$/, '').split('.').map(Number);
    const pb = b.replace(/-beta$/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0; const nb = pb[i] || 0;
      if (na !== nb) return nb - na;
    }
    return 0;
  })[0];
}

async function getNeoForgeVersionJSON(mcVersion, neoForgeVersion, sendLog) {
  const log = sendLog || (() => {});
  const baseDir = getBaseDir();
  const versionId = `neoforge-${neoForgeVersion || 'latest'}-${mcVersion}`;
  const versionDir = path.join(baseDir, 'versions', versionId);
  const cachedJsonPath = path.join(versionDir, `${versionId}.json`);

  // Always resolve neoForgeVersion
  if (!neoForgeVersion) neoForgeVersion = await getNeoForgeVersionForMC(mcVersion);

  try { const c = await fs.readFile(cachedJsonPath, 'utf-8'); return JSON.parse(c); } catch {}

  const installerUrl = `${NEOFORGE_MAVEN_BASE}/${neoForgeVersion}/neoforge-${neoForgeVersion}-installer.jar`;
  const installerDir = path.join(baseDir, 'installers');
  await fs.mkdir(installerDir, { recursive: true });
  const installerPath = path.join(installerDir, `neoforge-${neoForgeVersion}-installer.jar`);
  await downloadFile(installerUrl, installerPath);

  const versionJSON = await extractJsonFromJar(installerPath, 'version.json');
  const merged = await mergeLoaderProfile(versionJSON, 'https://maven.neoforged.net/releases/');

  // Run install processors to patch the vanilla MC JAR
  // Without this, BootstrapLauncher cannot find vanilla classes
  const installProfile = await extractJsonFromJar(installerPath, 'install_profile.json');
  const patchedJarPath = await runNeoForgeProcessors(installProfile, mcVersion, neoForgeVersion, baseDir, installerPath, log);

  // Add the patched client JAR to libraries so BootstrapLauncher discovers it
  // via the "production client provider" (looks for neoforge:VERSION:client on classpath).
  // Also add the client JAR filename to -DignoreList so PathBasedLocator doesn't
  // ALSO create a "neoforge" module from it (the filename would derive "neoforge").
  // The universal JAR stays — it has the proper module-info.class declaring module neoforge.
  const clientJarName = `neoforge-${neoForgeVersion}-client.jar`;
  merged.libraries = (merged.libraries || []).filter(lib => {
    if (!lib.name) return true;
    // Remove the unclassified neoforge JAR (no :client or :universal classifier)
    // to avoid a third module name collision.
    if (lib.name === `net.neoforged:neoforge:${neoForgeVersion}`) return false;
    return true;
  });
  merged.libraries.push({
    name: `net.neoforged:neoforge:${neoForgeVersion}:client`,
    downloads: {
      artifact: {
        path: `net/neoforged/neoforge/${neoForgeVersion}/${clientJarName}`,
        url: `file://${patchedJarPath}`,
      }
    }
  });

  // Patch -DignoreList to also ignore the client JAR (PathBasedLocator would
  // otherwise derive module name "neoforge" from its filename, conflicting with
  // the universal JAR's module-info.class).
  if (merged.arguments && merged.arguments.jvm) {
    for (const jvmArg of merged.arguments.jvm) {
      if (typeof jvmArg === 'string' && jvmArg.startsWith('-DignoreList=')) {
        merged.arguments.jvm[merged.arguments.jvm.indexOf(jvmArg)] =
          jvmArg + ',' + clientJarName;
        break;
      }
    }
  }

  // Remove vanilla client JAR download — the patched JAR replaces it.
  // Without this, BootstrapLauncher loads both vanilla (minecraft module)
  // and patched (neoforge module), causing package export conflicts.
  delete merged.downloads;

  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(cachedJsonPath, JSON.stringify(merged, null, 2));
  return merged;
}

function isNeoForgeVersion(versionJSON) {
  return !!(versionJSON.libraries || []).find(lib => lib.name && lib.name.includes('net.neoforged'));
}

// ── Forge Loader ─────────────────────────────────────────────────────────────

const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

async function getForgeVersionForMC(mcVersion) {
  const metadataUrl = `${FORGE_MAVEN_BASE}/maven-metadata.xml`;
  const buf = await httpGet(metadataUrl);
  const xml = buf.toString();
  const versionRegex = new RegExp(`<version>(${mcVersion.replace('.', '\\.')}-\\d+[^<]*)</version>`, 'g');
  const versions = [];
  let match;
  while ((match = versionRegex.exec(xml)) !== null) versions.push(match[1]);
  if (versions.length === 0) throw new Error(`No Forge version found for Minecraft ${mcVersion}`);
  return versions.sort((a, b) => (parseInt(b.split('-').pop()) || 0) - (parseInt(a.split('-').pop()) || 0))[0];
}

async function getForgeVersionJSON(mcVersion, forgeVersion, sendLog) {
  const log = sendLog || (() => {});
  const baseDir = getBaseDir();
  const versionId = `forge-${forgeVersion || 'latest'}-${mcVersion}`;
  const versionDir = path.join(baseDir, 'versions', versionId);
  const cachedJsonPath = path.join(versionDir, `${versionId}.json`);

  if (!forgeVersion) forgeVersion = await getForgeVersionForMC(mcVersion);

  // Delete forge JARs that conflict with the patched client
  const forgeLibDir = path.join(baseDir, 'libraries');
  for (const suffix of ['', '-universal', '-installer']) {
    const p = path.join(forgeLibDir, `net/minecraftforge/forge/${forgeVersion}/forge-${forgeVersion}${suffix}.jar`);
    try { await fs.unlink(p); } catch {}
  }

  try { const c = await fs.readFile(cachedJsonPath, 'utf-8'); return JSON.parse(c); } catch {}

  const installerUrl = `${FORGE_MAVEN_BASE}/${forgeVersion}/forge-${forgeVersion}-installer.jar`;
  const installerDir = path.join(baseDir, 'installers');
  await fs.mkdir(installerDir, { recursive: true });
  const installerPath = path.join(installerDir, `forge-${forgeVersion}-installer.jar`);
  await downloadFile(installerUrl, installerPath);

  const versionJSON = await extractJsonFromJar(installerPath, 'version.json');
  const merged = await mergeLoaderProfile(versionJSON, 'https://maven.minecraftforge.net/');

  // Run install processors to patch the vanilla MC JAR
  const installProfile = await extractJsonFromJar(installerPath, 'install_profile.json');
  const patchedJarPath = await runNeoForgeProcessors(installProfile, mcVersion, forgeVersion, baseDir, installerPath, log);

  // Add the patched client JAR and remove the plain forge JAR to avoid module conflict
  const forgeBaseName = `net.minecraftforge:forge:${forgeVersion}`;
  merged.libraries = (merged.libraries || []).filter(lib => {
    if (!lib.name) return true;
    if (lib.name === forgeBaseName) return false;
    if (lib.name.includes('client-extra')) return false;
    return true;
  });
  merged.libraries.push({
    name: `${forgeBaseName}:client`,
    downloads: {
      artifact: {
        path: `net/minecraftforge/forge/${forgeVersion}/forge-${forgeVersion}-client.jar`,
        url: `file://${patchedJarPath}`,
      }
    }
  });

  // Remove vanilla client JAR download — same reason as NeoForge
  delete merged.downloads;

  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(cachedJsonPath, JSON.stringify(merged, null, 2));
  return merged;
}

function isForgeVersion(versionJSON) {
  return !!(versionJSON.libraries || []).find(lib => lib.name && lib.name.includes('net.minecraftforge'));
}

// ── Version Manifest ──────────────────────────────────────────────────────────

let cachedManifest = null;

async function getVersionManifest() {
  if (cachedManifest) return cachedManifest;
  const buf = await httpGet(VERSION_MANIFEST_URL);
  cachedManifest = JSON.parse(buf.toString());
  return cachedManifest;
}

async function getVersionJSON(versionId) {
  const manifest = await getVersionManifest();
  const entry = manifest.versions.find(v => v.id === versionId);
  if (!entry) throw new Error(`Version ${versionId} not found in manifest`);
  const buf = await httpGet(entry.url);
  return JSON.parse(buf.toString());
}

// ── Java Detection ────────────────────────────────────────────────────────────

async function findJava(mcVersion) {
  const s = settings.get();
  if (s.javaPath) {
    try {
      await fs.access(s.javaPath);
      return s.javaPath;
    } catch { /* fall through to auto-detect */ }
  }

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const exe = isWin ? 'java.exe' : 'java';

  // Determine preferred Java major version based on MC version.
  // MC < 1.20.5 needs Java 17; MC >= 1.20.5 works with Java 21.
  const needsJava17 = mcVersion && /^1\.(1[0-9]|20\.[0-4])/.test(mcVersion);
  const preferredMajor = needsJava17 ? 17 : 21;
  const altMajor = needsJava17 ? 21 : 17;

  // Build candidate lists: preferred version first, then alternate
  const preferred = [];
  const alternate = [];

  if (isWin) {
    if (process.env.JAVA_HOME) {
      const jh = path.join(process.env.JAVA_HOME, 'bin', exe);
      preferred.push(jh);
    }
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const pf of roots) {
      // Minecraft bundled runtimes
      preferred.push(path.join(pf, 'Minecraft', 'runtime', 'java-runtime-gamma', 'windows-x64', 'java-runtime-gamma', 'bin', 'javaw.exe'));
      preferred.push(path.join(pf, 'Minecraft', 'runtime', 'java-runtime-beta', 'windows-x64', 'java-runtime-beta', 'bin', 'javaw.exe'));
      preferred.push(path.join(pf, 'Minecraft', 'runtime', 'java-runtime-alpha', 'windows-x64', 'java-runtime-alpha', 'bin', 'javaw.exe'));
      // Oracle / Adoptium / Temurin / Zulu — prefer matching version
      preferred.push(path.join(pf, 'Java', `jdk-${preferredMajor}`, 'bin', exe));
      alternate.push(path.join(pf, 'Java', `jdk-${altMajor}`, 'bin', exe));
      preferred.push(path.join(pf, 'Java', `jre-${preferredMajor}`, 'bin', exe));
      alternate.push(path.join(pf, 'Java', `jre-${altMajor}`, 'bin', exe));
      // Dynamically scan Eclipse Adoptium / Temurin directory
      try {
        const adoptiumDir = path.join(pf, 'Eclipse Adoptium');
        const adoptiumEntries = await fs.readdir(adoptiumDir);
        for (const entry of adoptiumEntries) {
          if (entry.startsWith(`jdk-${preferredMajor}`) || entry.startsWith(`jre-${preferredMajor}`)) {
            preferred.push(path.join(adoptiumDir, entry, 'bin', exe));
          } else if (entry.startsWith('jdk-') || entry.startsWith('jre-')) {
            alternate.push(path.join(adoptiumDir, entry, 'bin', exe));
          }
        }
      } catch { /* dir doesn't exist */ }
    }
    // PrismLauncher / AstralRinthApp managed Java — sort by version
    const appData = process.env.APPDATA;
    if (appData) {
      const jreRoot = path.join(appData, 'AstralRinthApp', 'meta', 'java_versions');
      try {
        const dirs = await fs.readdir(jreRoot);
        for (const d of dirs) {
          if (d.includes('zulu') || d.includes('jdk') || d.includes('jre')) {
            const full = path.join(jreRoot, d, 'bin', 'javaw.exe');
            if (d.includes(`${preferredMajor}`)) {
              preferred.push(full);
            } else {
              alternate.push(full);
            }
          }
        }
      } catch { /* dir doesn't exist */ }
    }
  } else if (isMac) {
    if (process.env.JAVA_HOME) {
      preferred.unshift(path.join(process.env.JAVA_HOME, 'bin', 'java'));
    }
    preferred.push(`/Library/Java/JavaVirtualMachines/jdk-${preferredMajor}.jdk/Contents/Home/bin/java`);
    alternate.push(`/Library/Java/JavaVirtualMachines/jdk-${altMajor}.jdk/Contents/Home/bin/java`);
    preferred.push('/opt/homebrew/bin/java');
    preferred.push('/usr/local/bin/java');
  } else {
    if (process.env.JAVA_HOME) {
      preferred.unshift(path.join(process.env.JAVA_HOME, 'bin', 'java'));
    }
    preferred.push(`/usr/bin/java`);
    preferred.push(`/usr/lib/jvm/java-${preferredMajor}-openjdk/bin/java`);
    alternate.push(`/usr/lib/jvm/java-${altMajor}-openjdk/bin/java`);
    preferred.push(`/usr/lib/jvm/java-${preferredMajor}/bin/java`);
    alternate.push(`/usr/lib/jvm/java-${altMajor}/bin/java`);
  }

  // Try preferred version first, then alternate, then bare exe
  for (const candidate of [...preferred, ...alternate, exe]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* try next */ }
  }

  return exe;
}

// ── Installation Steps ────────────────────────────────────────────────────────

/**
 * Download and verify all assets for a version.
 * Emits progress events via sendToRenderer.
 */
async function installVersion(versionJSON, instanceDir, sendToRenderer, instanceId) {
  const baseDir = getBaseDir();

  // 1. Download version JSON (already have it, but save a copy)
  const versionDir = path.join(baseDir, 'versions', versionJSON.id);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, `${versionJSON.id}.json`), JSON.stringify(versionJSON, null, 2));

  // 2. Download client JAR
  sendToRenderer({ instanceId, label: 'Downloading game client…', progress: 0, total: 100 });
  const clientInfo = versionJSON.downloads?.client;
  if (clientInfo) {
    const jarPath = path.join(versionDir, `${versionJSON.id}.jar`);
    await downloadFile(clientInfo.url, jarPath, clientInfo.sha1);
  }
  sendToRenderer({ instanceId, label: 'Game client downloaded', progress: 10, total: 100 });

  // 3. Download libraries (parallel batches)
  const libraries = versionJSON.libraries || [];
  const libDir = path.join(baseDir, 'libraries');
  const LIB_CONCURRENCY = 8;

  async function downloadLibTask(lib) {
    if (lib.downloads?.artifact) {
      const art = lib.downloads.artifact;
      const dest = path.join(libDir, art.path);
      await downloadFile(art.url, dest, art.sha1);
    }
    const nativeKey = lib.natives?.[process.platform === 'win32' ? 'windows'
      : process.platform === 'darwin' ? 'osx' : 'linux'];
    if (nativeKey && lib.downloads?.classifiers?.[nativeKey]) {
      const nat = lib.downloads.classifiers[nativeKey];
      const dest = path.join(libDir, nat.path);
      await downloadFile(nat.url, dest, nat.sha1);
    }
  }

  let libDone = 0;
  const totalLibs = libraries.length || 1;
  for (let i = 0; i < libraries.length; i += LIB_CONCURRENCY) {
    const batch = libraries.slice(i, i + LIB_CONCURRENCY);
    await Promise.all(batch.map(async (lib) => {
      await downloadLibTask(lib);
      libDone++;
    }));
    const progress = 10 + Math.round((libDone / totalLibs) * 40);
    sendToRenderer({ instanceId, label: `Downloading libraries (${libDone}/${totalLibs})…`, progress, total: 100 });
  }

  // 4. Download asset index
  const assetIndex = versionJSON.assetIndex;
  if (assetIndex) {
    sendToRenderer({ instanceId, label: 'Downloading asset index…', progress: 52, total: 100 });
    const indexDir = path.join(baseDir, 'assets', 'indexes');
    await fs.mkdir(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `${assetIndex.id}.json`);
    await downloadFile(assetIndex.url, indexPath, assetIndex.sha1);

    // 5. Download assets (parallel batches)
    const indexData = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    const objects = indexData.objects || {};
    const assetKeys = Object.keys(objects);
    let assetDone = 0;
    const totalAssets = assetKeys.length || 1;
    const objectsDir = path.join(baseDir, 'assets', 'objects');
    const ASSET_CONCURRENCY = 16;

    for (let i = 0; i < assetKeys.length; i += ASSET_CONCURRENCY) {
      const batch = assetKeys.slice(i, i + ASSET_CONCURRENCY);
      await Promise.all(batch.map(async (key) => {
        const obj = objects[key];
        const hash = obj.hash;
        const subDir = path.join(objectsDir, hash.substring(0, 2));
        const dest = path.join(subDir, hash);
        const url = `https://resources.download.minecraft.net/${hash.substring(0, 2)}/${hash}`;
        await downloadFile(url, dest, hash);
      }));
      assetDone += batch.length;
      const progress = 52 + Math.round((assetDone / totalAssets) * 45);
      sendToRenderer({ instanceId, label: `Downloading assets (${assetDone}/${totalAssets})…`, progress, total: 100 });
    }
  }

  sendToRenderer({ instanceId, label: 'Installation complete', progress: 100, total: 100 });
}

// ── Launch ────────────────────────────────────────────────────────────────────

async function launch(instanceId, mainWindow) {
  const inst = instancesModule.getById(instanceId);
  if (!inst) return { error: 'Instance not found' };
  if (runningProcesses.has(instanceId)) return { error: 'Instance already running' };

  const sendState = (state, message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launch:state', { instanceId, state, message });
    }
  };
  const sendProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launch:progress', data);
    }
  };
  const sendLog = (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launch:log', { instanceId, line });
    }
    // Fire-and-forget persistence
    instancesModule.appendLog(instanceId, line);
  };

  try {
    sendState('installing');

    // 1. Get version JSON (Fabric, Quilt, NeoForge, Forge, or Vanilla)
    sendLog(`Resolving version ${inst.version}…`);
    let versionJSON;
    const loader = inst.loader || 'Vanilla';

    if (loader === 'Fabric') {
      sendLog('Fetching Fabric loader profile…');
      versionJSON = await getFabricVersionJSON(inst.version);
      sendLog(`Fabric loader installed: ${versionJSON.id}`);
    } else if (loader === 'Quilt') {
      sendLog('Fetching Quilt loader profile…');
      versionJSON = await getQuiltVersionJSON(inst.version);
      sendLog(`Quilt loader installed: ${versionJSON.id}`);
    } else if (loader === 'NeoForge') {
      sendLog('Fetching NeoForge loader profile…');
      versionJSON = await getNeoForgeVersionJSON(inst.version, null, sendLog);
      sendLog(`NeoForge loader installed: ${versionJSON.id}`);
    } else if (loader === 'Forge') {
      sendLog('Fetching Forge loader profile…');
      versionJSON = await getForgeVersionJSON(inst.version, null, sendLog);
      sendLog(`Forge loader installed: ${versionJSON.id}`);
    } else {
      versionJSON = await getVersionJSON(inst.version);
    }

    // 2. Install (download everything we need)
    const instanceDir = getInstanceDir(instanceId);
    await fs.mkdir(instanceDir, { recursive: true });
    await installVersion(versionJSON, instanceDir, sendProgress, instanceId);

    // 3. Find Java
    const javaPath = await findJava(inst.version);
    sendLog(`Using Java: ${javaPath}`);

    // 4. Build classpath
    const baseDir = getBaseDir();
    const versionDir = path.join(baseDir, 'versions', versionJSON.id);
    const libDir = path.join(baseDir, 'libraries');
    const jarPath = path.join(versionDir, `${versionJSON.id}.jar`);

    const classpathEntries = [];
    for (const lib of versionJSON.libraries || []) {
      if (lib.downloads?.artifact) {
        classpathEntries.push(path.join(libDir, lib.downloads.artifact.path));
      }
    }
    // For NeoForge/Forge, the patched client JAR (in libraries) replaces the
    // vanilla client JAR. Adding the vanilla JAR causes BootstrapLauncher's
    // -DignoreList to load it as the "minecraft" module, which conflicts with
    // the "neoforge" module from the patched JAR (both export overlapping packages).
    const isLoaderVersion = isNeoForgeVersion(versionJSON) || isForgeVersion(versionJSON);
    if (!isLoaderVersion) {
      classpathEntries.push(jarPath);
    }
    const classpath = classpathEntries.join(process.platform === 'win32' ? ';' : ':');

    // 5. Build game arguments
    const s = settings.get();
    const instSettings = inst.settings || {};
    const ram = instSettings.ram || s.defaultRam || 4;

    const mainClass = versionJSON.mainClass || 'net.minecraft.client.main.Main';
    const args = versionJSON.arguments || {};
    const gameArgsList = args.game || [];
    const jvmArgsList = args.jvm || [];

    // Native directory
    const nativesDir = path.join(instanceDir, 'natives');
    await fs.mkdir(nativesDir, { recursive: true });

    // Extract natives
    for (const lib of versionJSON.libraries || []) {
      const nativeKey = lib.natives?.[process.platform === 'win32' ? 'windows'
        : process.platform === 'darwin' ? 'osx' : 'linux'];
      if (nativeKey && lib.downloads?.classifiers?.[nativeKey]) {
        const nat = lib.downloads.classifiers[nativeKey];
        const src = path.join(libDir, nat.path);
        try {
          const unzip = process.platform === 'win32'
            ? `powershell -command "Expand-Archive -Path '${src}' -DestinationPath '${nativesDir}' -Force"`
            : `unzip -o "${src}" -d "${nativesDir}"`;
          require('child_process').execSync(unzip, { stdio: 'ignore' });
        } catch { /* best-effort */ }
      }
    }

    // Template variable resolution
    const authPlayer = inst.name || 'Player';
    const authUuid = '00000000-0000-0000-0000-000000000000';
    const accessToken = '0';
    const userType = 'mojang';
    const versionType = versionJSON.type || 'release';
    const classpathSep = process.platform === 'win32' ? ';' : ':';
    const libraryDir = libDir;

    function resolveArg(arg) {
      return String(arg)
        .replace(/\$\{auth_player_name\}/g, authPlayer)
        .replace(/\$\{auth_session\}/g, accessToken)
        .replace(/\$\{auth_access_token\}/g, accessToken)
        .replace(/\$\{auth_uuid\}/g, authUuid)
        .replace(/\$\{user_type\}/g, userType)
        .replace(/\$\{version_name\}/g, versionJSON.id)
        .replace(/\$\{game_directory\}/g, instanceDir)
        .replace(/\$\{game_assets\}/g, path.join(baseDir, 'assets', 'virtual', 'legacy'))
        .replace(/\$\{assets_root\}/g, path.join(baseDir, 'assets'))
        .replace(/\$\{assets_index_name\}/g, versionJSON.assetIndex?.id || versionJSON.id)
        .replace(/\$\{version_type\}/g, versionType)
        .replace(/\$\{natives_directory\}/g, nativesDir)
        .replace(/\$\{library_directory\}/g, libraryDir)
        .replace(/\$\{classpath_separator\}/g, classpathSep)
        .replace(/\$\{launcher_name\}/g, LAUNCHER_NAME)
        .replace(/\$\{launcher_version\}/g, LAUNCHER_VERSION)
        .replace(/\$\{classpath\}/g, classpath)
        .replace(/\$\{user_properties\}/g, '{}')
        .replace(/\$\{[^}]+\}/g, ''); // clear any remaining unresolved variables
    }

    // Rule evaluation for version JSON arguments
    const osName = process.platform === 'win32' ? 'windows'
      : process.platform === 'darwin' ? 'osx' : 'linux';
    const osVersion = process.version;

    function evaluateRules(rules) {
      if (!rules || !rules.length) return true;
      let allowed = false;
      for (const rule of rules) {
        let matches = true;
        if (rule.os) {
          if (rule.os.name && rule.os.name !== osName) matches = false;
          if (rule.os.version && !(new RegExp(rule.os.version).test(osVersion))) matches = false;
        }
        if (rule.features) {
          // No feature flags in offline mode
          matches = false;
        }
        if (matches) allowed = (rule.action === 'allow');
      }
      return allowed;
    }

    // Collect all arguments
    const fullArgs = [];

    // JVM args from version JSON (respecting rules)
    for (const jvmArg of jvmArgsList) {
      if (typeof jvmArg === 'string') {
        fullArgs.push(resolveArg(jvmArg));
      } else if (jvmArg.rules) {
        if (evaluateRules(jvmArg.rules) && jvmArg.value) {
          const values = Array.isArray(jvmArg.value) ? jvmArg.value : [jvmArg.value];
          for (const v of values) fullArgs.push(resolveArg(v));
        }
      } else if (jvmArg.value) {
        const values = Array.isArray(jvmArg.value) ? jvmArg.value : [jvmArg.value];
        for (const v of values) fullArgs.push(resolveArg(v));
      }
    }

    // Memory args (before main class, after version JSON JVM args)
    fullArgs.push(`-Xmx${ram}G`);
    fullArgs.push(`-Xms${Math.min(ram, 2)}G`);

    // User-specified JVM args from settings
    if (s.jvmArgs) {
      const extra = s.jvmArgs.split(/\s+/).filter(Boolean);
      if (extra.length) fullArgs.push(...extra);
    }

    // Main class
    fullArgs.push(mainClass);

    // Game args from version JSON (respecting rules)
    for (const gameArg of gameArgsList) {
      if (typeof gameArg === 'string') {
        fullArgs.push(resolveArg(gameArg));
      } else if (gameArg.rules) {
        if (evaluateRules(gameArg.rules) && gameArg.value) {
          const values = Array.isArray(gameArg.value) ? gameArg.value : [gameArg.value];
          for (const v of values) fullArgs.push(resolveArg(v));
        }
      } else if (gameArg.value) {
        const values = Array.isArray(gameArg.value) ? gameArg.value : [gameArg.value];
        for (const v of values) fullArgs.push(resolveArg(v));
      }
    }

    // Add required arguments if version JSON doesn't have them
    if (!fullArgs.includes('--username')) {
      fullArgs.push('--username', authPlayer);
      fullArgs.push('--version', versionJSON.id);
      fullArgs.push('--gameDir', instanceDir);
      fullArgs.push('--assetsDir', path.join(baseDir, 'assets'));
      fullArgs.push('--assetIndex', versionJSON.assetIndex?.id || versionJSON.id);
      fullArgs.push('--uuid', authUuid);
      fullArgs.push('--accessToken', accessToken);
      fullArgs.push('--userType', userType);
      fullArgs.push('--versionType', versionType);
    }

    // 6. Spawn the game
    sendState('launching');
    sendLog('Starting game process…');
    sendLog(`Java: ${javaPath}`);
    sendLog(`Working directory: ${instanceDir}`);

    const gameProcess = spawn(javaPath, fullArgs, {
      cwd: instanceDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    runningProcesses.set(instanceId, gameProcess);
    instancesModule.markLaunched(instanceId);

    sendState('running');
    sendLog('Game process started.');

    // Track whether the process died immediately (within 3 seconds)
    let earlyExit = true;
    const earlyExitTimer = setTimeout(() => { earlyExit = false; }, 3000);

    // Capture stdout/stderr
    gameProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) sendLog(line);
    });
    gameProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) sendLog(line);
    });

    gameProcess.on('close', (code) => {
      clearTimeout(earlyExitTimer);
      runningProcesses.delete(instanceId);
      instancesModule.markStopped(instanceId);
      sendLog(`Game exited with code ${code}`);
      if (earlyExit || code !== 0) {
        sendState('error', `Game exited immediately with code ${code}. Check instance logs and verify Java is installed correctly.`);
      } else {
        sendState('closed');
      }
    });

    gameProcess.on('error', (err) => {
      clearTimeout(earlyExitTimer);
      runningProcesses.delete(instanceId);
      sendLog(`Process error: ${err.message}`);
      if (err.message.includes('ENOENT')) {
        sendState('error', `Java not found at "${javaPath}". Please install Java or set the Java path in Settings.`);
      } else {
        sendState('error', `Process error: ${err.message}`);
      }
    });

    return { success: true };
  } catch (err) {
    sendLog(`Launch failed: ${err.message}`);
    sendState('error', err.message);
    return { error: err.message };
  }
}

async function stop(instanceId) {
  const proc = runningProcesses.get(instanceId);
  if (!proc) return { stopped: false };
  proc.kill('SIGTERM');
  return { stopped: true };
}

// ── Modpack Installation (.mrpack) ──────────────────────────────────────────

function extractEntryFromZip(zipPath, entryName) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (entry.fileName === entryName) {
          zip.openReadStream(entry, (err2, stream) => {
            if (err2) return reject(err2);
            const chunks = [];
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('error', reject);
      zip.on('end', () => resolve(null));
    });
  });
}

function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      function next() { zip.readEntry(); }
      zip.on('entry', (entry) => {
        entries.push(entry.fileName);
        if (entry.uncompressedSize === 0) { next(); } else { zip.openReadStream(entry, (e2, s) => { if (s) s.resume(); next(); }); }
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      next();
    });
  });
}

function extractZipEntry(zipPath, entryName, destPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (entry.fileName === entryName) {
          fs.mkdir(path.dirname(destPath), { recursive: true }).then(() => {
            zip.openReadStream(entry, (err2, stream) => {
              if (err2) return reject(err2);
              const ws = fsSync.createWriteStream(destPath);
              stream.pipe(ws);
              ws.on('finish', () => resolve(destPath));
              ws.on('error', reject);
            });
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => resolve(null));
      zip.on('error', reject);
    });
  });
}

function extractZipDirectory(zipPath, entryPrefix, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let count = 0;
      function finish() { if (--count <= 0) resolve(); }
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (!entry.fileName.startsWith(entryPrefix) || entry.fileName === entryPrefix) { zip.readEntry(); return; }
        const rel = entry.fileName.slice(entryPrefix.length);
        const dest = path.join(destDir, rel);
        if (entry.fileName.endsWith('/')) {
          fs.mkdir(dest, { recursive: true }).then(() => zip.readEntry());
        } else {
          count++;
          fs.mkdir(path.dirname(dest), { recursive: true }).then(() => {
            zip.openReadStream(entry, (err2, stream) => {
              if (err2) { finish(); zip.readEntry(); return; }
              const ws = fsSync.createWriteStream(dest);
              stream.pipe(ws);
              ws.on('finish', () => { finish(); zip.readEntry(); });
              ws.on('error', () => { finish(); zip.readEntry(); });
            });
          });
        }
      });
      zip.on('end', () => { if (count <= 0) resolve(); });
      zip.on('error', reject);
    });
  });
}

/**
 * Install a .mrpack modpack from Modrinth.
 * Downloads the mrpack ZIP, extracts the manifest, creates an instance,
 * downloads all mod files, and extracts overrides (configs, etc.).
 *
 * @param {string} mrpackUrl - Download URL of the .mrpack file
 * @param {string} projectId - Modrinth project ID
 * @param {string} title - Human-readable modpack title
 * @param {string} icon - Icon URL (or null)
 * @param {Function} sendLog - Logging callback
 * @returns {{ instance, filesDownloaded }}
 */
async function installModpack(mrpackUrl, projectId, title, icon, apiGameVersion, apiLoaderRaw, sendLog) {
  const log = sendLog || (() => {});
  const baseDir = getBaseDir();
  const tmpDir = path.join(baseDir, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  // 1. Download .mrpack file
  log('Downloading modpack archive…');
  const mrpackPath = path.join(tmpDir, `mrpack-${projectId}.mrpack`);
  await downloadFile(mrpackUrl, mrpackPath);

  // 2. Extract and parse modrinth.index.json
  log('Reading modpack manifest…');
  const manifestBuf = await extractEntryFromZip(mrpackPath, 'modrinth.index.json');
  if (!manifestBuf) throw new Error('Invalid .mrpack: missing modrinth.index.json');
  const manifest = JSON.parse(manifestBuf.toString());

  // 3. Resolve version — prefer manifest dependencies.minecraft (source of truth),
  //    then API value, then manifest game field. Other launchers (Prism, etc.)
  //    read the manifest, not the API game_versions which may be wrong.
  const LOADER_MAP = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };

  let mcVersion = '';
  // Prefer manifest dependencies.minecraft (actual MC version the modpack targets)
  if (manifest.dependencies && manifest.dependencies.minecraft) {
    mcVersion = manifest.dependencies.minecraft;
  }
  // Fall back to API value if manifest doesn't have it
  if (!mcVersion && apiGameVersion && apiGameVersion !== 'Unknown') {
    mcVersion = apiGameVersion;
  }
  // Fall back to manifest game field
  if (!mcVersion && manifest.game && manifest.game !== 'Unknown') {
    mcVersion = manifest.game;
  }
  // Clean up version ranges like "[1.21,1.22)" or "[26.2,26.3)" -> extract the lower bound
  mcVersion = mcVersion.replace(/^[\[\(]/, '').split(',')[0].replace(/[\]\)\+]$/, '');
  // Validate — MC versions are like "1.21.1" or "26.2"
  if (!mcVersion || !/^\d+\.\d+/.test(mcVersion)) {
    mcVersion = '1.21.1';
  }

  let loaderRaw = apiLoaderRaw || '';
  if (!loaderRaw && manifest.loaders && manifest.loaders.length) {
    loaderRaw = manifest.loaders[0];
  }
  const loaderName = LOADER_MAP[(loaderRaw || '').toLowerCase()] || 'Vanilla';
  log(`Modpack: MC ${mcVersion}, loader ${loaderName}`);

  // 4. Create instance
  log('Creating instance…');
  const inst = await instancesModule.create(title.slice(0, 32), mcVersion, loaderName, null, icon);
  const instanceDir = getInstanceDir(inst.id);
  await fs.mkdir(instanceDir, { recursive: true });

  // Record modpack metadata
  await instancesModule.addContent(inst.id, 'mods', {
    projectId, title, icon, version: manifest.version || 'latest', kind: 'modpack'
  });

  // 5. Download all files from manifest
  const files = manifest.files || [];
  let downloaded = 0;
  const TOTAL = files.length || 1;
  log(`Downloading ${files.length} mod files…`);

  for (const file of files) {
    if (!file.downloads || !file.downloads.length) continue;
    const fileUrl = file.downloads[0];
    const destPath = path.join(instanceDir, file.path);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await downloadFile(fileUrl, destPath);
      downloaded++;
      log(`  [${downloaded}/${TOTAL}] ${path.basename(file.path)}`);

      // Record each file in the appropriate content array
      const fileName = path.basename(file.path);
      const filePath = file.path.replace(/\\/g, '/');
      const item = { title: fileName, fileName, version: manifest.version || 'latest' };
      if (filePath.startsWith('mods/')) {
        await instancesModule.addContent(inst.id, 'mods', item);
      } else if (filePath.startsWith('resourcepacks/')) {
        await instancesModule.addContent(inst.id, 'resourcepacks', item);
      } else if (filePath.startsWith('shaderpacks/') || filePath.startsWith('shaders/')) {
        await instancesModule.addContent(inst.id, 'shaderpacks', item);
      }
    } catch (e) {
      log(`  Warning: failed to download ${path.basename(file.path)}: ${e.message}`);
    }
  }

  // 6. Extract overrides directory into instance
  log('Extracting overrides…');
  try {
    await extractZipDirectory(mrpackPath, 'overrides/', instanceDir);
  } catch (e) {
    log(`  Warning: could not extract overrides: ${e.message}`);
  }

  // 7. Clean up temp file
  try { await fs.unlink(mrpackPath); } catch {}

  log(`Modpack installed: ${downloaded}/${files.length} files`);
  return { instance: inst, filesDownloaded: downloaded };
}

// ── Content Download (mods, resource packs, etc.) ────────────────────────────

const CONTENT_DIR_MAP = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  datapacks: 'datapacks'
};

async function downloadContentFile(instanceId, contentKey, fileUrl, fileName) {
  const instanceDir = getInstanceDir(instanceId);
  if (!instanceDir) throw new Error('Instance not found');
  const subDir = CONTENT_DIR_MAP[contentKey];
  if (!subDir) throw new Error(`Unknown content type: ${contentKey}`);
  const destDir = path.join(instanceDir, subDir);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, fileName);
  await downloadFile(fileUrl, dest);
  return dest;
}

async function removeContentFile(instanceId, contentKey, fileName) {
  const instanceDir = getInstanceDir(instanceId);
  if (!instanceDir) throw new Error('Instance not found');
  const subDir = CONTENT_DIR_MAP[contentKey];
  if (!subDir) throw new Error(`Unknown content type: ${contentKey}`);
  const filePath = path.join(instanceDir, subDir, fileName);
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

// ── Java Management ────────────────────────────────────────────────────────────

const { execFile } = require('child_process');

async function getJavaInfo(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { timeout: 10000 }, (err, _stdout, stderr) => {
      if (err) return resolve(null);
      const out = stderr || '';
      const m = out.match(/version "([^"]+)"/);
      if (!m) return resolve(null);
      const ver = m[1];
      const parts = ver.split('.');
      const major = parseInt(parts[0], 10);
      resolve({ path: javaPath, version: ver, major });
    });
  });
}

async function detectJavaInfo(mcVersion) {
  const javaPath = await findJava(mcVersion);
  if (!javaPath) return { path: '', version: '', major: 0, available: false };
  const info = await getJavaInfo(javaPath);
  if (!info) return { path: javaPath, version: '', major: 0, available: false };
  return { ...info, available: true };
}

async function downloadJava(mcVersion) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const platform = isWin ? 'windows' : isMac ? 'mac' : 'linux';
  const needsJava17 = mcVersion && /^1\.(1[0-9]|20\.[0-4])/.test(mcVersion);
  const javaMajor = needsJava17 ? 17 : 21;

  const baseDir = getBaseDir();
  const javaDir = path.join(baseDir, 'java', `jdk-${javaMajor}`);
  const exe = isWin ? path.join(javaDir, 'bin', 'javaw.exe') : path.join(javaDir, 'bin', 'java');

  // Already downloaded?
  try {
    await fs.access(exe);
    const info = await getJavaInfo(exe);
    if (info) return { path: exe, ...info, alreadyExisted: true };
  } catch { /* need to download */ }

  // Fetch latest Adoptium release info from API
  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${javaMajor}/hotspot?architecture=${arch}&image_type=jdk&os=${platform}&vendor=eclipse`;
  let downloadUrl;
  let fileName;
  try {
    const apiBuf = await httpGet(apiUrl);
    const apiData = JSON.parse(apiBuf.toString());
    const binary = apiData[0]?.binary;
    if (!binary) throw new Error('No binary found in Adoptium API response');
    const pkg = isWin ? binary.package : binary.package;
    downloadUrl = pkg.link;
    fileName = pkg.name;
  } catch (err) {
    throw new Error(`Failed to fetch Adoptium release info: ${err.message}`);
  }

  // Download
  const dlDir = path.join(baseDir, 'java', 'downloads');
  await fs.mkdir(dlDir, { recursive: true });
  const dlPath = path.join(dlDir, fileName);

  await httpDownloadWithProgress(downloadUrl, dlPath, (downloaded, total) => {
    sendToRendererMain({ instanceId: 'java-download', label: `Downloading Java ${javaMajor}…`, progress: downloaded, total });
  });

  // Extract
  await fs.mkdir(javaDir, { recursive: true });
  if (isWin && fileName.endsWith('.zip')) {
    const unzipper = require('unzipper');
    await new Promise((resolve, reject) => {
      fs.createReadStream(dlPath).pipe(unzipper.Extract({ path: javaDir })).on('close', resolve).on('error', reject);
    });
    // Adoptium zip extracts into a subfolder — move contents up
    const entries = await fs.readdir(javaDir);
    const subDir = entries.find(e => e.startsWith('jdk-') && !e.endsWith('.zip'));
    if (subDir) {
      const subPath = path.join(javaDir, subDir);
      const tmpPath = path.join(javaDir, '_tmp_move');
      await fs.rename(subPath, tmpPath);
      // Move contents up
      const contents = await fs.readdir(tmpPath);
      for (const c of contents) {
        await fs.rename(path.join(tmpPath, c), path.join(javaDir, c));
      }
      await fs.rm(tmpPath, { recursive: true, force: true });
    }
  } else if (!isWin && fileName.endsWith('.tar.gz')) {
    const { execSync } = require('child_process');
    execSync(`tar -xzf "${dlPath}" -C "${javaDir}" --strip-components=1`);
  }

  // Clean up download
  try { await fs.unlink(dlPath); } catch { /* best effort */ }

  // Verify
  try {
    await fs.access(exe);
  } catch {
    throw new Error('Java downloaded but executable not found at expected path');
  }

  const info = await getJavaInfo(exe);
  return { path: exe, version: info?.version || '', major: info?.major || javaMajor, available: true, alreadyExisted: false };
}

// sendToRendererMain helper for Java download progress
function sendToRendererMain(data) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('launch:progress', data);
  }
}
let mainWindowRef = null;
function setMainWindowRef(win) { mainWindowRef = win; }

module.exports = { launch, stop, getFabricVersionJSON, getQuiltVersionJSON, getNeoForgeVersionJSON, getForgeVersionJSON, getVersionManifest, downloadContentFile, removeContentFile, installModpack, detectJavaInfo, downloadJava, setMainWindowRef, findJava, getJavaInfo };
