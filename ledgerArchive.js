// The INDEPENDENT ARCHIVE for the broker ledger (Blocker 2, auditor I).
//
// Redis/Upstash is the operational ledger; it may never be the only copy.
// This copy lives in Cloudflare's storage (R2) -- a different company, a
// different failure domain, private (nothing here is reachable by a plain
// web address), and inside its free allowance (10 GB against about 1.4 MB).
// It uses the storage the service already has for trade recordings, under
// its own folder, "broker-ledger-archive/v1/".
//
// What it holds:
//   imports/<importId>/responses/<window>.json  Schwab's answer, BYTE FOR BYTE
//   imports/<importId>/manifest.json            what that import did, record by record
//   records/<identity>/<fingerprint>.json       each record with its provenance
// A record file is named by its content's fingerprint, so a given name can
// only ever hold one content; every file is written "only if it does not
// already exist". Nothing here is ever deleted or rewritten.
//
// It is an evidence and recovery layer, not a second pairing engine: it
// never reads the journal and never pairs anything.
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const BASE = 'broker-ledger-archive/v1/';

function client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}
const bucket = () => process.env.R2_BUCKET_NAME || 'strat-journal-videos';
const ready = () => !!client();
const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

const recordKey = (identity, fp) => `${BASE}records/${safe(identity)}/${safe(fp)}.json`;

// Create-only. Returns 'written', or 'exists' when the storage says the name
// is already taken (412 Precondition Failed).
async function putCreateOnly(key, body, contentType) {
  const c = client();
  if (!c) throw new Error('the archive storage is not set up');
  try {
    await c.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType || 'application/json', IfNoneMatch: '*' }));
    return 'written';
  } catch (e) {
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    if (status === 412 || (e && e.name === 'PreconditionFailed')) return 'exists';
    throw e;
  }
}

async function putResponse(importId, w, text) {
  const key = `${BASE}imports/${safe(importId)}/responses/${safe(w.from)}_${safe(w.to)}.json`;
  await putCreateOnly(key, text, 'application/json');
  return key;
}

async function putRecord(key, obj) {
  return putCreateOnly(key, JSON.stringify(obj), 'application/json');
}

async function putManifest(importId, obj) {
  const key = `${BASE}imports/${safe(importId)}/manifest.json`;
  await putCreateOnly(key, JSON.stringify(obj), 'application/json');
  return key;
}

async function listRecordKeys() {
  const c = client();
  if (!c) throw new Error('the archive storage is not set up');
  const keys = new Set();
  let token;
  let rounds = 0;
  do {
    const out = await c.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${BASE}records/`, ContinuationToken: token }));
    for (const o of out.Contents || []) keys.add(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
    if (++rounds > 1000) throw new Error('listing the archive did not finish');
  } while (token);
  return keys;
}

module.exports = { ready, recordKey, putResponse, putRecord, putManifest, listRecordKeys, BASE };
