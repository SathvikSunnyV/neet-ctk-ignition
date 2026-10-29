// cdn.js -- single source of truth for the public (Cloudflare R2) URLs this
// app renders: the Seven Hills welcome videos and Prof. Konuri's lectures.
// Nothing else in the codebase should hard-code an r2.dev / custom-domain URL.
//
// Env vars (all optional -- with none set, behaviour is exactly as before):
//   CDN_BASE_URL          public base URL of the bucket holding the videos,
//                         e.g. https://files.example.com or https://pub-xxxx.r2.dev
//                         (no trailing slash needed). When set, seeded lecture
//                         rows are re-pointed at it on every startup.
//   HILL_VIDEOS_BASE_URL  only if the Seven Hills welcome videos live in a
//                         different bucket than the lectures. Defaults to CDN_BASE_URL.
//   LEGACY_CDN_BASES      comma-separated extra OLD base URLs whose lecture rows
//                         should be rewritten to CDN_BASE_URL on startup. The two
//                         previous r2.dev bases are always included.
//
// This file only builds public playback URLs. File UPLOADS by faculty (R2 access
// keys) live in storage.js.

const LEGACY_LECTURE_BASE = 'https://pub-8521d28a1e0d44bb9c7da4e801284a66.r2.dev';
const LEGACY_HILL_BASE    = 'https://pub-f4f030961eab45ada12b3d35525b2379.r2.dev';

const clean = v => (v || '').trim().replace(/\/+$/, '');

const configuredBase = clean(process.env.CDN_BASE_URL);
const lectureBase    = configuredBase || LEGACY_LECTURE_BASE;
const hillBase       = clean(process.env.HILL_VIDEOS_BASE_URL) || configuredBase || LEGACY_HILL_BASE;

// Old bases whose rows get rewritten -- only ever used when CDN_BASE_URL is set.
const legacyBases = [...new Set([
    LEGACY_LECTURE_BASE,
    LEGACY_HILL_BASE,
    ...(process.env.LEGACY_CDN_BASES || '').split(',')
].map(clean).filter(Boolean))].filter(b => b !== lectureBase);

// Labels must match the badges on the Welcome page (frontend/index.html).
//
// The current bucket (connectomicacademy-intermediate) holds the Seven Hills
// videos under their underscored filenames, shared with the Prof. Konuri
// lecture list in db.js. Hills 5 and 6 are ONE combined video there, so both
// badges play it.
const HILL_VIDEOS = [
    { label: '1 \u00b7 Known \u2192 Unknown',                    file: 'The_First_Hill.mp4' },
    { label: '2 \u00b7 Central Point',                           file: 'The_Second_Hill.mp4' },
    { label: '3 \u00b7 Let Student Discover',                    file: 'The_Third_Hill__Discovery.mp4' },
    { label: '4 \u00b7 One Key, Many Doors',                     file: 'One_Key,_Many_Doors.mp4' },
    { label: '5 \u00b7 Recognise Patterns (Hills 5 & 6)',        file: 'The_Fifth_and_Sixth_Hills.mp4' },
    { label: '6 \u00b7 Build Connections (Hills 5 & 6)',         file: 'The_Fifth_and_Sixth_Hills.mp4' },
    { label: '7 \u00b7 Real-World Wisdom',                       file: 'The_Seventh_Hill.mp4' }
];

// Filenames used by the ORIGINAL r2.dev bucket -- only used when no base URL
// is configured at all, so an unconfigured deployment behaves exactly as before.
const LEGACY_HILL_FILES = [
    'The First Hill.mp4', 'The Second Hill.mp4', 'The Third Hill.mp4', 'The Fourth Hill.mp4',
    'The Fifth Hill.mp4', 'The Sixth Hill.mp4', 'The Seventh Hill.mp4'
];
const usingLegacyHillBucket = hillBase === LEGACY_HILL_BASE;

// encodeURIComponent, but keep commas literal so URLs match the ones stored
// for the lecture rows (e.g. One_Key,_Many_Doors.mp4).
const encodeFile = f => encodeURIComponent(f).replace(/%2C/gi, ',');

// Public, non-secret config handed to the browser (GET /api/config).
function getPublicConfig() {
    return {
        cdnBase: lectureBase,
        hillVideos: HILL_VIDEOS.map((h, i) => ({
            label: h.label,
            url: `${hillBase}/${encodeFile(usingLegacyHillBucket ? LEGACY_HILL_FILES[i] : h.file)}`
        }))
    };
}

module.exports = {
    isConfigured: !!configuredBase,
    lectureBase,
    hillBase,
    legacyBases,
    HILL_VIDEOS,
    getPublicConfig
};