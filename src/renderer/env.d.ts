declare module '*.png' {
  const url: string
  export default url
}

declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.jpg' {
  const url: string
  export default url
}

declare module '*.webp' {
  const url: string
  export default url
}

declare module '*.css'

interface ImportMeta {
  glob(pattern: string, options: { eager: true; query: '?url'; import: 'default' }): Record<string, string>
}
