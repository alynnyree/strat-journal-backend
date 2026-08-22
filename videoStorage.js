const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Cloudflare R2 speaks the same S3 protocol as Amazon's own storage, so the
// standard AWS SDK works against it unmodified — just pointed at R2's own
// address instead of Amazon's, with R2's own key pair. Videos live here
// instead of in the same fast key-value store screenshots use (Redis via
// @upstash/redis): a multi-minute screen recording is easily 50-100x the
// size of a screenshot, which that store isn't built to hold economically.
function getClient() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: 'auto', // R2 doesn't use AWS regions; this is the literal value R2 expects
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getBucket() {
  return process.env.R2_BUCKET_NAME || 'strat-journal-videos';
}

function isConfigured() {
  return !!getClient();
}

// key: the object's path inside the bucket, e.g. "videos/<id>.mov" — chosen
// by the caller, not generated here, so callers can pick something they can
// find again later (the pending-match id, a trade id, etc).
async function uploadVideo(key, buffer, contentType) {
  const client = getClient();
  if (!client) throw new Error('R2 storage is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing).');
  await client.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: buffer,
    ContentType: contentType || 'video/quicktime',
  }));
}

// R2 objects in this bucket are private (not publicly reachable by a plain
// URL) — this hands out a temporary, signed link that expires on its own,
// so the video can be watched without making the whole bucket public.
async function getPlaybackUrl(key, expiresInSeconds = 3600) {
  const client = getClient();
  if (!client) throw new Error('R2 storage is not configured.');
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

module.exports = { uploadVideo, getPlaybackUrl, isConfigured };
