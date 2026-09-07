/**
 * Reads tweet ids out of a Twitter/X data archive.
 *
 * The archive is by far the fastest source of ids: it lists every tweet up front, so the
 * deleter never has to discover them by paging a timeline that is changing underneath it.
 * It does not, however, contain retweets or anything posted after the export - that is what
 * the sweep is for.
 *
 * Archives from heavy accounts are large - hundreds of megabytes of tweets.js is normal - and
 * only the ids are ever wanted. So the file is streamed: one top-level array element is buffered
 * at a time, parsed, reduced to an id and a timestamp, and dropped. Reading the whole file into a
 * string and JSON.parsing it would cost roughly 3.3x the file size in heap, and would fail
 * outright past 512 MB, which is V8's hard limit on the length of a single string.
 */
const fs = require("fs");
const path = require("path");
const { UserError } = require("./errors");

const ASSIGNMENT_PREFIX = /^\s*window\.YTD\.[A-Za-z_]+\.part\d+\s*=\s*/;

/** How much the assignment prefix and the opening bracket can possibly need. */
const HEAD_CHARS = 512;

/** Bytes per read. Big enough that syscalls are rare, small enough that peak memory is flat. */
const CHUNK_BYTES = 1 << 20;

const PARSE_HINT =
  "This should be the tweets.js from an unzipped X archive, or a folder containing it. Point at the right file with --archive <path>.";
const SHAPE_HINT =
  "Use the tweets.js from your X archive's data/ folder, or point --archive at it.";

/**
 * Resolve the archive path a user gave us into the list of files to parse.
 * Accepts the `tweets.js` file itself, or a directory containing `tweets*.js` (an unzipped
 * archive's `data/` folder).
 */
function resolveArchiveFiles(archivePath) {
  if (!fs.existsSync(archivePath)) return [];
  const stat = fs.statSync(archivePath);
  if (stat.isFile()) return [archivePath];

  return fs
    .readdirSync(archivePath)
    .filter((name) => /^tweets?(-part\d+)?\.js(on)?$/i.test(name))
    .sort()
    .map((name) => path.join(archivePath, name));
}

/**
 * Stream the top-level elements of a JSON array out of `file`, handing each parsed element to
 * `onEntry` and forgetting it immediately.
 *
 * The scan runs over raw bytes rather than over a decoded string. Every character JSON uses for
 * structure is ASCII, and no byte of a multi-byte UTF-8 sequence is ever below 0x80, so a byte
 * scan can never mistake part of a character for a bracket or a quote - and only the bytes of a
 * complete element are ever decoded. Scanning a string instead is roughly three times slower,
 * because the read buffer keeps being re-sliced and re-joined behind V8's back.
 *
 * Element boundaries are found by tracking bracket depth and string state, then each element is
 * handed to JSON.parse on its own. A scanner that got a boundary wrong would produce a fragment
 * that does not parse, so a mistake here surfaces as a loud error rather than as wrong ids.
 *
 * @returns {boolean} false when the file is not a JSON array literal, so the caller can fall back
 */
function streamArchiveArray(file, onEntry) {
  const fd = fs.openSync(file, "r");
  let buf = Buffer.allocUnsafe(CHUNK_BYTES * 2);
  let len = 0; // bytes of `buf` that hold file content
  let pos = 0; // read cursor within those bytes
  let eof = false;
  // Lowest byte index that must survive making room. -1 while nothing before the cursor matters;
  // while an element is being captured it is that element's first byte, which is still needed to
  // decode the element once its end is found.
  let anchor = -1;

  /**
   * Pull one more read's worth of the file in, making room first: bytes nothing still needs are
   * dropped, and the buffer only grows when a single element is bigger than it is. False means
   * end of file.
   */
  const more = () => {
    if (eof) return false;
    const drop = anchor >= 0 ? anchor : pos;
    if (drop > 0) {
      buf.copyWithin(0, drop, len);
      len -= drop;
      pos -= drop;
      if (anchor >= 0) anchor -= drop;
    }
    if (len + CHUNK_BYTES > buf.length) {
      const bigger = Buffer.allocUnsafe(Math.max(buf.length * 2, len + CHUNK_BYTES));
      buf.copy(bigger, 0, 0, len);
      buf = bigger;
    }
    const bytes = fs.readSync(fd, buf, len, CHUNK_BYTES, null);
    if (bytes === 0) {
      eof = true;
      return false;
    }
    len += bytes;
    return true;
  };

  /** Make sure there is a byte at `pos`. */
  const fill = () => {
    while (pos >= len) {
      if (!more()) return false;
    }
    return true;
  };

  const isSpace = (b) => b === 32 || b === 10 || b === 9 || b === 13;

  const skipSpace = () => {
    while (fill() && isSpace(buf[pos])) pos++;
  };

  /** The byte at `pos` as a character, for error messages. */
  const charAt = (at) => buf.toString("utf8", at, Math.min(at + 1, len));

  /**
   * Capture the raw bytes of one JSON value starting at `pos` and decode them.
   * Objects and arrays are scanned to their matching close; strings to their closing quote;
   * anything else (a number, true, false, null) up to the next separator.
   *
   * `anchor` pins the value's first byte for as long as the capture lasts, so that reading more
   * of the file cannot discard the part of the value already scanned.
   */
  const readValue = () => {
    anchor = pos;
    try {
      const first = buf[pos];

      if (first === 0x7b /* { */ || first === 0x5b /* [ */) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (;;) {
          // Aliased into locals for the scan: `buf` is replaced when the buffer has to grow and
          // `len` changes on every read, so leaving them as closure variables puts a context
          // lookup on every single byte of the archive.
          const view = buf;
          const end = len;
          let i = pos;
          while (i < end) {
            const b = view[i++];
            if (inString) {
              if (escaped) escaped = false;
              else if (b === 0x5c /* \ */) escaped = true;
              else if (b === 0x22 /* " */) inString = false;
              continue;
            }
            if (b === 0x22) inString = true;
            else if (b === 0x7b || b === 0x5b) depth++;
            else if (b === 0x7d /* } */ || b === 0x5d /* ] */) {
              depth--;
              if (depth === 0) {
                pos = i;
                return buf.toString("utf8", anchor, pos);
              }
            }
          }
          pos = i;
          if (!more()) throw new SyntaxError("Unexpected end of JSON input");
        }
      }

      if (first === 0x22 /* " */) {
        let escaped = false;
        pos++;
        for (;;) {
          const view = buf;
          const end = len;
          let i = pos;
          while (i < end) {
            const b = view[i++];
            if (escaped) escaped = false;
            else if (b === 0x5c) escaped = true;
            else if (b === 0x22) {
              pos = i;
              return buf.toString("utf8", anchor, pos);
            }
          }
          pos = i;
          if (!more()) throw new SyntaxError("Unexpected end of JSON input");
        }
      }

      for (;;) {
        let i = pos;
        while (i < len) {
          const b = buf[i];
          if (b === 0x2c /* , */ || b === 0x5d /* ] */ || isSpace(b)) {
            pos = i;
            if (pos === anchor) {
              throw new SyntaxError("Unexpected token " + charAt(anchor) + " in JSON at position " + pos);
            }
            return buf.toString("utf8", anchor, pos);
          }
          i++;
        }
        pos = i;
        if (!more()) {
          if (pos === anchor) {
            throw new SyntaxError("Unexpected token " + charAt(anchor) + " in JSON at position " + pos);
          }
          return buf.toString("utf8", anchor, pos);
        }
      }
    } finally {
      anchor = -1;
    }
  };

  try {
    // Read enough to see past the `window.YTD.tweets.part0 = ` wrapper some archives use, and
    // past a BOM, which would otherwise defeat both the anchored prefix match and JSON.parse.
    // Both are pure ASCII, so a byte count and a character count are the same thing here.
    while (len < HEAD_CHARS && more());
    if (len >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) pos = 3;
    const head = buf.toString("utf8", pos, Math.min(pos + HEAD_CHARS, len));
    const prefix = head.match(ASSIGNMENT_PREFIX);
    if (prefix) pos += prefix[0].length;

    skipSpace();
    if (!fill() || buf[pos] !== 0x5b /* [ */) return false;
    pos++;

    // `needComma` means a value was just read, `pendingComma` that a comma was. Between them
    // they reject the malformed shapes (`[1 2]`, `[,1]`, `[1,]`) that JSON.parse used to catch.
    let needComma = false;
    let pendingComma = false;
    for (;;) {
      skipSpace();
      if (!fill()) throw new SyntaxError("Unexpected end of JSON input");
      const b = buf[pos];
      if (b === 0x5d /* ] */) {
        if (pendingComma) throw new SyntaxError("Unexpected token ] in JSON");
        pos++;
        break;
      }
      if (needComma) {
        if (b !== 0x2c /* , */) {
          throw new SyntaxError("Unexpected token " + charAt(pos) + " in JSON");
        }
        pos++;
        needComma = false;
        pendingComma = true;
        continue;
      }

      onEntry(JSON.parse(readValue()));
      needComma = true;
      pendingComma = false;
    }

    // Anything other than whitespace after the array is malformed, exactly as JSON.parse would
    // have found it before this was streamed.
    skipSpace();
    if (fill()) throw new SyntaxError("Unexpected token " + charAt(pos) + " in JSON after array");
    return true;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {
      // Nothing useful to do about a failed close.
    }
  }
}

/** Hand every record in one archive file to `onEntry`, one at a time. */
function parseArchiveFile(file, onEntry) {
  try {
    if (streamArchiveArray(file, onEntry)) return;
  } catch (e) {
    throw new UserError("Could not read tweet ids from " + file + ": " + e.message, PARSE_HINT);
  }

  // Not a JSON array literal. Whatever it is, it is not an archive, so it is safe to read whole -
  // and doing so gives it the same diagnosis it has always had.
  let parsed;
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(ASSIGNMENT_PREFIX, "");
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UserError("Could not read tweet ids from " + file + ": " + e.message, PARSE_HINT);
  }
  if (!Array.isArray(parsed)) {
    throw new UserError("Expected a JSON array of tweets in " + file + ".", SHAPE_HINT);
  }
  for (const entry of parsed) onEntry(entry);
}

/**
 * @param {string} archivePath file or directory
 * @returns {{ ids: string[], files: string[], total: number }} ids oldest-first
 */
function readArchiveIds(archivePath) {
  const files = resolveArchiveFiles(archivePath);
  if (files.length === 0) return { ids: [], files: [], total: 0 };

  // Deduplicated as we go: an archive split across parts can list the same tweet twice, and
  // holding every duplicate until the end costs memory in proportion to the file rather than to
  // the number of tweets. An id that appears twice keeps the earliest timestamp it was seen with.
  const entries = [];
  const positionById = new Map();

  const collect = (entry) => {
    // Archives wrap each record as { tweet: {...} }; a plain array of ids is also accepted so
    // that a user can feed in their own id list.
    let id;
    let createdAt = 0;
    if (typeof entry === "string") {
      id = entry;
    } else {
      const tweet = entry && (entry.tweet || entry);
      const raw = tweet && (tweet.id_str || tweet.id);
      if (!raw) return;
      id = String(raw);
      createdAt = Date.parse(tweet.created_at || "") || 0;
    }

    const at = positionById.get(id);
    if (at === undefined) {
      positionById.set(id, entries.length);
      entries.push({ id, createdAt });
    } else if (createdAt < entries[at].createdAt) {
      entries[at].createdAt = createdAt;
    }
  };

  for (const file of files) parseArchiveFile(file, collect);

  // Oldest first: if a run is interrupted, the tweets left behind are the recent ones, which
  // are the easiest to check by hand.
  entries.sort((a, b) => a.createdAt - b.createdAt);

  const ids = entries.map((entry) => entry.id);
  return { ids, files, total: ids.length };
}

module.exports = { readArchiveIds, resolveArchiveFiles };
