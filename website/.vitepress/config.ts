import { defineConfig } from 'vitepress'

// Base path is configurable for GitHub Pages (https://<user>.github.io/ecsia/). Override at build
// time with DOCS_BASE='/' for a root-hosted deploy or a local preview at the domain root.
const base = process.env.DOCS_BASE ?? '/ecsia/'

export default defineConfig({
  base,
  lang: 'en-US',
  title: 'ecsia',
  description:
    'A batteries-included, TypeScript-native Entity Component System — archetype/SoA storage, first-class relations, and auto-parallel worker execution that is bit-identical to the serial path.',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  // The generated API reference (typedoc) and any stray scratch files are not VitePress pages.
  srcExclude: ['**/_snippets/**'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/reference/' },
      {
        text: '0.x · unpublished',
        items: [
          { text: 'Status', link: '/#status' },
          { text: 'Performance', link: '/guide/performance' },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Core concepts', link: '/guide/core-concepts' },
          ],
        },
        {
          text: 'Subsystems',
          items: [
            { text: 'Parallelism', link: '/guide/parallelism' },
            { text: 'Relations', link: '/guide/relations' },
            { text: 'Reactivity', link: '/guide/reactivity' },
            { text: 'Serialization', link: '/guide/serialization' },
          ],
        },
        {
          text: 'Integrations',
          items: [
            { text: 'THREE.js bridge', link: '/guide/three-bridge' },
            { text: 'Devtools', link: '/guide/devtools' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Performance', link: '/guide/performance' },
            { text: 'API reference', link: '/reference/' },
          ],
        },
      ],
      '/reference/': [{ text: 'API Reference', link: '/reference/' }],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/andymai/ecsia' }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: {
      message: 'MIT licensed · 0.x, unpublished, experimental.',
      copyright: 'ecsia',
    },
  },
})
