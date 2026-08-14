import { defineConfig } from 'vitepress'
import { search as zhSearch } from './zh'

console.log('process.env.BASEPATH:', process.env.BASEPATH || '/')

export const shared = defineConfig({
  title: 'h5player',

  head: [
    ['link', { rel: 'icon', href: '/favicon.png' }]
  ],

  lastUpdated: true,
  cleanUrls: true,
  metaChunk: true,

  base: process.env.BASEPATH || '/',

  outDir: '../dist/h5player-docs',
  themeConfig: {
    logo: '/assets/img/logo.png',

    socialLinks: [
      { icon: 'github', link: 'https://github.com/bgzo/h5player' }
    ],

    search: {
      provider: 'local',
      options: {
        locales: {
          ...zhSearch,
        }
      }
    },

    footer: {
      message: 'Released under the GPL License.',
      copyright: 'Copyright © 2025-present Blaze'
    },
  }
})
