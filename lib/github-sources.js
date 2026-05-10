/**
 * lib/github-sources.js — WatchHub Edition
 * Focused on BeIn Sports, Sky Sports, Spacetoon, Arabic & international sports.
 */

const GITHUB_M3U_SOURCES = [
  // ── PRIMARY: fahadfayi (default playlist — loaded first) ─────────────────
  { repo: 'fahadfayi/iptv', label: 'fahadfayi/misne7ehs6et-plus', raw: 'https://raw.githubusercontent.com/fahadfayi/iptv/main/tv_channels_MIsne7ehs6et_plus.m3u' },

  // ── iptv-org (canonical, filtered by category/country) ───────────────────
  { repo: 'iptv-org/iptv', label: 'iptv-org/sports',       raw: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/ar',           raw: 'https://iptv-org.github.io/iptv/languages/ara.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/news',         raw: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/entertainment',raw: 'https://iptv-org.github.io/iptv/categories/entertainment.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/kids',         raw: 'https://iptv-org.github.io/iptv/categories/kids.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/sa',           raw: 'https://iptv-org.github.io/iptv/countries/sa.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/ae',           raw: 'https://iptv-org.github.io/iptv/countries/ae.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/eg',           raw: 'https://iptv-org.github.io/iptv/countries/eg.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/qa',           raw: 'https://iptv-org.github.io/iptv/countries/qa.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/ma',           raw: 'https://iptv-org.github.io/iptv/countries/ma.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/dz',           raw: 'https://iptv-org.github.io/iptv/countries/dz.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/tn',           raw: 'https://iptv-org.github.io/iptv/countries/tn.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/tr',           raw: 'https://iptv-org.github.io/iptv/countries/tr.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/gb',           raw: 'https://iptv-org.github.io/iptv/countries/gb.m3u' },
  { repo: 'iptv-org/iptv', label: 'iptv-org/fr',           raw: 'https://iptv-org.github.io/iptv/countries/fr.m3u' },

  // ── Free-TV ───────────────────────────────────────────────────────────────
  { repo: 'Free-TV/IPTV', label: 'Free-TV/index', raw: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8' },

  // ── Arabic community repos ────────────────────────────────────────────────
  { repo: 'HelmiDevs/iptv',             label: 'HelmiDevs/ar',        raw: 'https://raw.githubusercontent.com/HelmiDevs/iptv/main/iptv-ar.m3u' },
  { repo: 'azizLIGHT/iptv-ar',         label: 'azizLIGHT/ar',        raw: 'https://raw.githubusercontent.com/azizLIGHT/iptv-ar/master/iptv-ar.m3u' },
  { repo: 'byte-capsule/iptv-channels', label: 'byte-capsule/arabic',  raw: 'https://raw.githubusercontent.com/byte-capsule/iptv-channels/main/channels/Arabic.m3u' },
  { repo: 'byte-capsule/iptv-channels', label: 'byte-capsule/sports',  raw: 'https://raw.githubusercontent.com/byte-capsule/iptv-channels/main/channels/Sports.m3u' },
  { repo: 'byte-capsule/iptv-channels', label: 'byte-capsule/news',    raw: 'https://raw.githubusercontent.com/byte-capsule/iptv-channels/main/channels/News.m3u' },
  { repo: 'byte-capsule/iptv-channels', label: 'byte-capsule/kids',    raw: 'https://raw.githubusercontent.com/byte-capsule/iptv-channels/main/channels/Kids.m3u' },

  // ── Sports / BeIn-focused repos ───────────────────────────────────────────
  { repo: 'iptv-streams/iptv-streams',  label: 'iptv-streams/sports',  raw: 'https://raw.githubusercontent.com/iptv-streams/iptv-streams/main/sports.m3u' },
  { repo: 'iptv-pro/iptv-pro.github.io',label: 'iptv-pro/list',        raw: 'https://raw.githubusercontent.com/iptv-pro/iptv-pro.github.io/master/list.txt' },

  // ── International ────────────────────────────────────────────────────────
  { repo: 'benmoose/traveltv',          label: 'benmoose/travel',      raw: 'https://raw.githubusercontent.com/benmoose/traveltv/master/travel.m3u' },
  { repo: 'Commonshq/m3u-playlists',   label: 'Commonshq/tv',         raw: 'https://raw.githubusercontent.com/Commonshq/m3u-playlists/master/tv.m3u' },
  { repo: 'dp247/FreeviewEdge',         label: 'dp247/uk',             raw: 'https://raw.githubusercontent.com/dp247/FreeviewEdge/master/playlist.m3u' },
];

module.exports = { GITHUB_M3U_SOURCES };
