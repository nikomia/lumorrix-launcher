import { resolve } from 'node:path'
import preact from '@preact/preset-vite'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {
    // Окно работает в песочнице, а там preload должен быть в формате CommonJS.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } },
  },
  renderer: {
    plugins: [preact()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          console: resolve(__dirname, 'src/renderer/console.html'),
        },
      },
    },
  },
})
