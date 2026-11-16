import { defineConfig } from 'vite'
import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { excalidrawPatches } from './scripts/excalidraw-patches.mjs'
import { selfHostedFonts } from './scripts/self-hosted-fonts.mjs'

/**
 * React Compiler (HRN-1515) for the whole editor. Much of it reads Excalidraw imperatively while it renders
 * (`api.getSceneElements()`, `api.getAppState()` after a tick or a scene version), and the clock: the compiler caches
 * such a call by the stable `api` (or forever) and the component silently stops following the board — the build, types
 * and tests stay green. Such a component starts with 'use no memo' and says why; refs and the api in effects and
 * handlers are fine.
 */
const COMPILED = [/\/web\/src\/.*\.tsx?$/]
function reactCompiler() {
  const preset = reactCompilerPreset()
  preset.rolldown.filter.id = { include: COMPILED }
  return preset
}

// The editor is built once (into the image) and served by the server as static files under /b/_static.
export default defineConfig({
  // Rendering patches for Excalidraw — see scripts/excalidraw-patches.mjs.
  plugins: [excalidrawPatches(), selfHostedFonts(), react(), babel({ presets: [reactCompiler()] })],
  base: '/b/_static/',
  publicDir: 'web/public',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    manifest: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    // boot.ts is an entry of its own so it runs before the Excalidraw chunk evaluates (see web/src/boot.ts).
    rollupOptions: { input: { boot: 'web/src/boot.ts', main: 'web/src/main.tsx', 'embed-view': 'web/src/embed-view.tsx' } },
  },
  // Below es2022 esbuild breaks exports like `export { x as "en-us" }` in the package's locales.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
})
