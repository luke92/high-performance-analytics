#!/usr/bin/env node
/**
 * Builds the WebAssembly module with Emscripten and copies it into the web app.
 *
 *   npm run wasm:build          build the module and copy it into apps/web/src/wasm/generated
 *   npm run wasm:test:cpp       build the C++ GoogleTest suite as WebAssembly and run it under Node.js
 *
 * Requires an activated Emscripten SDK (the version in cpp/wasm/EMSCRIPTEN_VERSION), CMake and Ninja
 * (or Make). It never pretends to build: if a prerequisite is missing it prints how to get it and
 * exits with a non-zero status.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cppDir = join(repoRoot, "cpp");
const buildDir = join(cppDir, "build", "wasm");
const outputDir = join(repoRoot, "apps", "web", "src", "wasm", "generated");
const pinned = readFileSync(join(here, "EMSCRIPTEN_VERSION"), "utf8").trim();
const isWindows = process.platform === "win32";
const cppTests = process.argv.includes("--cpp-tests");

const SETUP = `
Emscripten ${pinned} is required (not found or not activated). Minimal setup:

  git clone https://github.com/emscripten-core/emsdk.git
  cd emsdk
  ./emsdk install ${pinned}
  ./emsdk activate ${pinned}
  source ./emsdk_env.sh        # Windows PowerShell: .\\emsdk_env.ps1   (or set EMSDK and rerun)

You also need CMake (>= 3.24) and Ninja on PATH. Then run \`npm run wasm:build\` again.
Details: cpp/README.md ("WebAssembly").`;

function fail(message) {
  console.error(`wasm:build failed: ${message}`);
  process.exit(1);
}

/** Runs a command (through a shell on Windows so .bat shims such as emcmake resolve). */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: isWindows, ...options });
  return result;
}

function onPath(name) {
  const probe = run(isWindows ? "where" : "which", [name]);
  return probe.status === 0;
}

// ---- 1. locate Emscripten (PATH first, then $EMSDK) ----
if (!onPath("emcmake")) {
  const sdk = process.env.EMSDK;
  const candidate = sdk ? join(sdk, "upstream", "emscripten") : undefined;
  if (candidate && existsSync(join(candidate, isWindows ? "emcmake.bat" : "emcmake"))) {
    process.env.PATH = `${candidate}${isWindows ? ";" : ":"}${process.env.PATH}`;
  } else {
    console.error(SETUP);
    process.exit(2);
  }
}

// ---- 2. check the exact version ----
const version = run("emcc", ["--version"]);
const match = /\)\s+(\d+\.\d+\.\d+)/.exec(`${version.stdout}${version.stderr}`);
if (version.status !== 0 || !match) fail(`could not run emcc --version\n${version.stderr}`);
if (match[1] !== pinned && process.env.HPA_ALLOW_EMSCRIPTEN_MISMATCH !== "1") {
  fail(
    `found Emscripten ${match[1]} but ${pinned} is pinned in cpp/wasm/EMSCRIPTEN_VERSION. ` +
      "Install the pinned version, or set HPA_ALLOW_EMSCRIPTEN_MISMATCH=1 to build anyway (results are then unverified).",
  );
}
console.log(`Emscripten ${match[1]}`);

// ---- 3. CMake and a generator ----
if (!onPath("cmake")) fail("cmake not found on PATH (need >= 3.24)");
const generator = onPath("ninja") ? "Ninja" : !isWindows && onPath("make") ? "Unix Makefiles" : undefined;
if (!generator) fail("neither ninja nor make found on PATH; install Ninja (https://ninja-build.org)");

// ---- 4. configure and build ----
const common = { cwd: repoRoot, stdio: "inherit" };
const emcmake = (args) => run("emcmake", ["cmake", ...args], common);

if (cppTests) {
  // Runs every core test (including the bit-exact TypeScript parity fixtures) inside WebAssembly.
  // The Emscripten toolchain sets CMAKE_CROSSCOMPILING_EMULATOR to Node.js, so ctest executes the .js output.
  const testDir = "cpp/build/wasm-tests";
  if (emcmake(["-S", "cpp", "-B", testDir, "-G", `"${generator}"`, "-DCMAKE_BUILD_TYPE=Release", "-DHPA_BUILD_TESTS=ON"]).status !== 0) fail("emcmake configure failed");
  if (run("cmake", ["--build", testDir], common).status !== 0) fail("cmake --build failed");
  const tests = run("ctest", ["--test-dir", testDir, "--output-on-failure"], common);
  if (tests.status !== 0) fail("the C++ tests failed under WebAssembly");
  process.exit(0);
}

if (emcmake(["-S", "cpp", "-B", "cpp/build/wasm", "-G", `"${generator}"`, "-DCMAKE_BUILD_TYPE=Release", "-DHPA_BUILD_WASM=ON", "-DHPA_BUILD_TESTS=OFF"]).status !== 0) {
  fail("emcmake configure failed");
}
if (run("cmake", ["--build", "cpp/build/wasm"], common).status !== 0) fail("cmake --build failed");

// ---- 5. copy into the web app ----
mkdirSync(outputDir, { recursive: true });
for (const file of ["hpa_core.js", "hpa_core.wasm"]) {
  const source = join(buildDir, "wasm", file);
  if (!existsSync(source)) fail(`expected build output missing: ${source}`);
  copyFileSync(source, join(outputDir, file));
}
// Vitest caches transformed modules on disk, including the result of loadModule.ts's import.meta.glob.
// A cache written while the module did not exist would keep reporting "not built", so drop it.
rmSync(join(repoRoot, "node_modules", ".vitest-cache"), { recursive: true, force: true });
writeFileSync(join(outputDir, "BUILD_INFO.json"), JSON.stringify({ emscripten: match[1], buildType: "Release" }, null, 2) + "\n");
console.log(`WebAssembly module copied to ${outputDir}`);
