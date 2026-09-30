/**
 * Fetch the local keyword-spotting model.
 *
 *   npm run wake:model
 *
 * Axon's wake word runs on a 3.3M-parameter zipformer keyword spotter that
 * runs entirely on this machine. The model is about eighteen megabytes, which
 * is too much to keep in git, so it is fetched once and lives under
 * `apps/desktop/resources/wake-model/`. This script is the only thing that
 * ever downloads it.
 *
 * WHAT IS VERIFIED, AND WHY EACH CHECK IS HERE.
 *
 *   1. The archive's SHA-256 matches a hash pinned in this file. A model is
 *      code: it decides when a microphone starts uploading. Fetching one over
 *      the network without checking what arrived would put that decision in
 *      the hands of whoever can answer for the host.
 *   2. Every word piece Axon's wake phrase is spelt with exists in the model's
 *      own token table. A model whose tokenizer spells "AXON" differently
 *      would leave Axon permanently deaf with no error anywhere, so that
 *      failure is caught here, at fetch time, rather than by a person saying
 *      the name into a microphone and being ignored.
 *   3. If Python with sentencepiece happens to be installed, the pieces are
 *      RE-DERIVED from the model's own `bpe.model` and compared. This is the
 *      strong version of check 2 and the one that originally produced the
 *      constants. It is optional because it is a build-machine convenience,
 *      not a runtime dependency — Axon never runs Python.
 *
 * NOTHING HERE TOUCHES A MICROPHONE, and the model is data: it is read by the
 * spotter process, which has no network of its own.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  WAKE_KEYWORDS,
  KEYWORD_MODEL_FILE_LIST,
  KEYWORD_MODEL_DIRNAME,
  KEYWORD_MODEL_FILES,
} = require('../out/main/wake-keywords.js');

/**
 * Where the model comes from.
 *
 * The sherpa-onnx project's own release of the gigaspeech keyword-spotting
 * model, Apache-2.0. Pinned by release tag AND by content hash, so the URL
 * moving or its contents changing is a failure rather than a surprise.
 */
const MODEL_NAME = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${MODEL_NAME}.tar.bz2`;
const MODEL_SHA256 = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a';

const RESOURCES = path.resolve(__dirname, '..', 'resources');
const TARGET = path.join(RESOURCES, KEYWORD_MODEL_DIRNAME);

/** Follow redirects by hand so the only thing this file trusts is the hash above. */
function download(url, into, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    https
      .get(url, { headers: { 'user-agent': 'axon-voice-wake-model-fetch' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve(download(new URL(response.headers.location, url).toString(), into, redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`the model host answered ${status}`));
          return;
        }
        const hash = crypto.createHash('sha256');
        const file = fs.createWriteStream(into);
        let bytes = 0;
        response.on('data', (chunk) => {
          hash.update(chunk);
          bytes += chunk.length;
          if (process.stdout.isTTY) process.stdout.write(`\r  ${(bytes / 1e6).toFixed(1)} MB`);
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve({ sha256: hash.digest('hex'), bytes }));
        });
        file.on('error', reject);
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

/** The model's own token table, as a set of pieces. */
function tokenSet(modelDir) {
  const text = fs.readFileSync(path.join(modelDir, KEYWORD_MODEL_FILES.tokens), 'utf8');
  const pieces = new Set();
  for (const line of text.split(/\r?\n/)) {
    // "<piece> <id>"; a piece never contains a space, so the last field is the id.
    const cut = line.lastIndexOf(' ');
    if (cut > 0) pieces.add(line.slice(0, cut));
  }
  return pieces;
}

/**
 * Re-derive the wake phrase's pieces from the model's own tokenizer.
 *
 * Optional: skipped, loudly, when Python with sentencepiece is not installed.
 * Never fatal for its own absence — only for a disagreement.
 */
function reDerivePieces(modelDir) {
  const program = [
    'import sys, sentencepiece as spm',
    `sp = spm.SentencePieceProcessor(); sp.load(${JSON.stringify(path.join(modelDir, 'bpe.model'))})`,
    'for line in sys.argv[1:]:',
    '    sys.stdout.buffer.write((" ".join(sp.encode(line, out_type=str)) + "\\n").encode("utf-8"))',
  ].join('\n');
  const phrases = WAKE_KEYWORDS.map((keyword) => keyword.phrase.toUpperCase());
  for (const exe of ['python', 'python3', 'py']) {
    const result = spawnSync(exe, ['-c', program, ...phrases], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;
    return result.stdout.trim().split(/\r?\n/);
  }
  return null;
}

async function main() {
  console.log(`\nAxon wake model — ${MODEL_NAME}`);

  const alreadyThere = KEYWORD_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(TARGET, name)));
  if (alreadyThere && !process.argv.includes('--force')) {
    console.log(`  already present at resources/${KEYWORD_MODEL_DIRNAME} (pass --force to refetch)`);
  } else {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-wake-model-'));
    const archive = path.join(staging, 'model.tar.bz2');
    try {
      console.log(`  downloading ${MODEL_URL}`);
      const { sha256, bytes } = await download(MODEL_URL, archive);
      if (process.stdout.isTTY) process.stdout.write('\n');
      if (sha256 !== MODEL_SHA256) {
        throw new Error(
          `the downloaded model does not match the pinned hash.\n    expected ${MODEL_SHA256}\n    got      ${sha256}\n` +
            '    Axon will not install a wake-word model it cannot identify.',
        );
      }
      console.log(`  sha256 verified (${(bytes / 1e6).toFixed(1)} MB)`);

      // bsdtar ships with Windows 10 and later, and handles bzip2. The
      // filename is passed RELATIVE, with the staging directory as the working
      // directory: given `C:\...`, bsdtar reads the drive letter as a remote
      // host and tries to open an SSH connection to a machine called "C".
      const extract = spawnSync('tar', ['-xf', path.basename(archive)], {
        cwd: staging,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
      });
      if (extract.status !== 0) {
        throw new Error(`could not extract the archive: ${extract.stderr || extract.error?.message || 'tar failed'}`);
      }

      fs.mkdirSync(RESOURCES, { recursive: true });
      fs.rmSync(TARGET, { recursive: true, force: true });
      fs.renameSync(path.join(staging, MODEL_NAME), TARGET);
      console.log(`  installed to resources/${KEYWORD_MODEL_DIRNAME}`);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  const missing = KEYWORD_MODEL_FILE_LIST.filter((name) => !fs.existsSync(path.join(TARGET, name)));
  if (missing.length > 0) throw new Error(`the model is missing ${missing.join(', ')}`);

  // Check 2: every piece the wake phrase is spelt with is a piece this model knows.
  const known = tokenSet(TARGET);
  const unknown = [];
  for (const keyword of WAKE_KEYWORDS) {
    for (const piece of keyword.pieces) if (!known.has(piece)) unknown.push(`${keyword.phrase}: ${piece}`);
  }
  if (unknown.length > 0) {
    throw new Error(
      `this model does not know the pieces Axon's wake phrase is spelt with:\n    ${unknown.join('\n    ')}`,
    );
  }
  console.log(`  token table knows every piece of ${WAKE_KEYWORDS.map((k) => `"${k.phrase}"`).join(', ')}`);

  // Check 3: the strong version, when the machine can run it.
  const derived = reDerivePieces(TARGET);
  if (derived === null) {
    console.log('  (skipped re-deriving the pieces: Python with sentencepiece is not installed — this is optional)');
  } else {
    const mismatches = WAKE_KEYWORDS.map((keyword, index) => ({ keyword, got: derived[index] ?? '' })).filter(
      ({ keyword, got }) => got !== keyword.pieces.join(' '),
    );
    if (mismatches.length > 0) {
      throw new Error(
        "the model tokenizes Axon's wake phrase differently than wake-keywords.ts says:\n" +
          mismatches
            .map(({ keyword, got }) => `    ${keyword.phrase}\n      source: ${keyword.pieces.join(' ')}\n      model:  ${got}`)
            .join('\n'),
      );
    }
    console.log("  re-derived the pieces from the model's own tokenizer: they agree with wake-keywords.ts");
  }

  console.log('\n  ready — the wake word will use the local keyword spotter.\n');
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
