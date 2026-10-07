import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The app is loaded from file:// in Electron. Module scripts with `crossorigin` are CORS-blocked on
 * file:// in Chromium, so emit a single classic IIFE bundle and plain <script defer>/<link> tags.
 */
function classicScripts(): Plugin {
  return {
    name: 'legion-classic-scripts',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin/g, '<script defer')
        .replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), classicScripts()],
  build: {
    outDir: fileURLToPath(new URL('../dist-ui', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome130',
    modulePreload: false,
    rolldownOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
  server: { port: 5173, strictPort: true },
});
