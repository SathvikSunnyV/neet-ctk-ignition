// storage.js — Cloudflare R2 file storage for faculty uploads (study
// materials + lecture videos/audio). R2 is S3-compatible, so this uses the
// standard AWS S3 SDK pointed at R2's endpoint. Same approach as the
// Connectomic Medical Academy project.
//
// Files go into the SAME bucket the Welcome-page / Prof. Konuri videos are
// served from (connectomicacademy-intermediate, public at CDN_BASE_URL), under
// `materials/` and `lectures/` prefixes, so they never collide with the
// seeded videos that live at the bucket root.
//
// Required env vars (backend/.env):
//   R2_ACCOUNT_ID          Cloudflare account ID (the 32-char id in the S3 API URL)
//   R2_ACCESS_KEY_ID       from an R2 API token with "Object Read & Write"
//   R2_SECRET_ACCESS_KEY   from the same R2 API token
//   R2_BUCKET_NAME         connectomicacademy-intermediate
//   R2_PUBLIC_URL_BASE     optional -- defaults to CDN_BASE_URL
//                          (https://files.connectomicacademy.com)
//
// If any are missing, uploads are refused with a clear 503 message instead of
// silently failing; everything else in the app keeps working (link-based
// materials/lectures, Welcome videos, seeded lectures).
const crypto = require('crypto');
const fs = require('fs');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const clean = v => (v || '').trim();
const accountId       = clean(process.env.R2_ACCOUNT_ID);
const accessKeyId     = clean(process.env.R2_ACCESS_KEY_ID);
const secretAccessKey = clean(process.env.R2_SECRET_ACCESS_KEY);
const bucket          = clean(process.env.R2_BUCKET_NAME);
const publicUrlBase   = (clean(process.env.R2_PUBLIC_URL_BASE) || clean(process.env.CDN_BASE_URL)).replace(/\/+$/, '');

// Optional: only needed for buckets created with an EU/FedRAMP jurisdiction
// (e.g. https://<id>.eu.r2.cloudflarestorage.com). Normal buckets don't need it.
const customEndpoint  = clean(process.env.R2_ENDPOINT).replace(/\/+$/, '');

const isConfigured = !!(accountId && accessKeyId && secretAccessKey && bucket && publicUrlBase);

const client = isConfigured
    ? new S3Client({
        region: 'auto',
        endpoint: customEndpoint || `https://${accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: !!customEndpoint,
        credentials: { accessKeyId, secretAccessKey },
        // Newer AWS SDK v3 releases add CRC32 checksum headers/trailers by
        // default, which R2 does not accept on streamed uploads. Only send
        // them when an operation strictly requires it.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED'
    })
    : null;

console.log(isConfigured
    ? `✅  R2 uploads enabled (bucket "${bucket}", public base ${publicUrlBase})`
    : 'ℹ️  R2 uploads disabled -- set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME (and CDN_BASE_URL) to let faculty upload files.');

function safeFilename(originalName) {
    return (originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}

// folder: 'materials' | 'lectures'
function buildKey(folder, originalName) {
    return `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeFilename(originalName)}`;
}

// Upload either an in-memory `buffer` or a temp file on disk (`filePath` +
// `size`). Disk streaming is what the routes use so a few-hundred-MB lecture
// never has to sit in RAM on a small instance.
async function uploadFile({ folder, buffer, filePath, size, originalName, contentType }) {
    if (!isConfigured) {
        const err = new Error(
            'File uploads are not configured yet. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
            'R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME (plus CDN_BASE_URL or R2_PUBLIC_URL_BASE) in the server environment.'
        );
        err.code = 'STORAGE_NOT_CONFIGURED';
        throw err;
    }
    const key = buildKey(folder, originalName);
    const params = {
        Bucket: bucket,
        Key: key,
        ContentType: contentType || 'application/octet-stream',
        // Lets browsers show PDFs/images inline and name downloaded
        // PPT/DOC files properly instead of using the long storage key.
        ContentDisposition: `inline; filename="${safeFilename(originalName)}"`
    };
    let stream = null;
    if (filePath) {
        stream = fs.createReadStream(filePath);
        params.Body = stream;
        params.ContentLength = size;
    } else {
        params.Body = buffer;
    }
    try {
        await client.send(new PutObjectCommand(params));
    } finally {
        if (stream) stream.destroy();
    }
    return { key, url: `${publicUrlBase}/${key}` };
}

// Best-effort delete -- never throws. An orphaned object in the bucket is a
// far smaller problem than a 500 on an otherwise-successful database delete.
async function deleteFile(key) {
    if (!isConfigured || !key) return;
    try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
        console.error('R2 delete failed (continuing anyway):', err?.message || err);
    }
}

module.exports = { uploadFile, deleteFile, isConfigured };