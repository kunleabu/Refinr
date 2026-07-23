// ═══════════════════════════════════════════════════════════════════
// lib/csl-cache.js — Reference Intelligence Engine
// On-demand CSL style file fetcher with in-memory caching.
//
// Design:
// - First request for a style fetches the CSL XML from GitHub
// - Subsequent requests within the same function instance hit cache
// - Vercel Edge Cache headers minimise cold-start fetches across instances
// - Never crashes on fetch failure — falls back to a minimal built-in
//   style so formatting always produces something usable
//
// The official CSL style repository:
// https://github.com/citation-style-language/styles
// ═══════════════════════════════════════════════════════════════════

const CSL_BASE_URL = 'https://raw.githubusercontent.com/citation-style-language/styles/master/';
const LOCALE_URL = 'https://raw.githubusercontent.com/citation-style-language/locales/master/locales-en-US.xml';

// ── In-memory cache ───────────────────────────────────────────────
// Survives across requests within the same warm function instance.
// Key: style ID (e.g. 'harvard-cite-them-right')
// Value: CSL XML string
const styleCache = new Map();
let localeCache = null;

// ── Minimal built-in Harvard fallback ─────────────────────────────
// Used when GitHub fetch fails entirely. Produces a basic but usable
// author-date format so the user always gets output even offline.
const FALLBACK_HARVARD_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" demote-non-dropping-particle="sort-only" default-locale="en-GB">
  <info>
    <title>Harvard Cite Them Right (fallback)</title>
    <id>http://www.zotero.org/styles/harvard-cite-them-right</id>
    <updated>2023-01-01T00:00:00+00:00</updated>
  </info>
  <macro name="author">
    <names variable="author">
      <name name-as-sort-order="all" and="text" sort-separator=", " initialize-with="." delimiter=", " delimiter-precedes-last="never"/>
      <label form="short" prefix=" (" suffix=".)" strip-periods="true"/>
      <substitute><names variable="editor"/><text variable="title"/></substitute>
    </names>
  </macro>
  <macro name="author-short">
    <names variable="author">
      <name form="short" and="text" delimiter=", " initialize-with=". " delimiter-precedes-last="never"/>
      <substitute><names variable="editor"/><text variable="title" form="short"/></substitute>
    </names>
  </macro>
  <macro name="issued">
    <choose>
      <if variable="issued"><date variable="issued"><date-part name="year"/></date></if>
      <else><text term="no date" form="short"/></else>
    </choose>
  </macro>
  <macro name="publisher">
    <group delimiter=": ">
      <text variable="publisher-place"/>
      <text variable="publisher"/>
    </group>
  </macro>
  <macro name="title">
    <choose>
      <if type="book thesis" match="any"><text variable="title" font-style="italic"/></if>
      <else><text variable="title" quotes="true"/></else>
    </choose>
  </macro>
  <citation et-al-min="3" et-al-use-first="1" disambiguate-add-year-suffix="true" collapse="year">
    <sort><key macro="author"/><key macro="issued"/></sort>
    <layout prefix="(" suffix=")" delimiter="; ">
      <group delimiter=", ">
        <text macro="author-short"/>
        <text macro="issued"/>
        <group><label variable="locator" form="short"/><text variable="locator"/></group>
      </group>
    </layout>
  </citation>
  <bibliography hanging-indent="true" et-al-min="4" et-al-use-first="1">
    <sort><key macro="author"/><key macro="issued"/></sort>
    <layout suffix=".">
      <group delimiter=" ">
        <text macro="author"/>
        <text macro="issued" prefix="(" suffix=")"/>
        <text macro="title" suffix="."/>
        <choose>
          <if type="article-journal">
            <group delimiter=", ">
              <text variable="container-title" font-style="italic"/>
              <text variable="volume"/>
              <text variable="issue" prefix="(" suffix=")"/>
              <text variable="page"/>
            </group>
          </if>
          <else-if type="book"><text macro="publisher"/></else-if>
          <else>
            <group delimiter=", ">
              <text variable="container-title" font-style="italic"/>
              <text macro="publisher"/>
              <text variable="page"/>
            </group>
          </else>
        </choose>
        <choose>
          <if variable="DOI"><text variable="DOI" prefix="doi:"/></if>
          <else-if variable="URL"><text variable="URL" prefix="Available at: "/></else-if>
        </choose>
      </group>
    </layout>
  </bibliography>
</style>`;

// ── Minimal locale fallback ────────────────────────────────────────
// citeproc-js requires a locale XML. This is a minimal en-US locale
// used only when the GitHub fetch fails.
const FALLBACK_LOCALE = `<?xml version="1.0" encoding="utf-8"?>
<locale xmlns="http://purl.org/net/xbiblio/csl" version="1.0" xml:lang="en-US">
  <style-options punctuation-in-quote="true"/>
  <date form="text"><date-part name="month" suffix=" "/><date-part name="day" suffix=", "/><date-part name="year"/></date>
  <date form="numeric"><date-part name="month" form="numeric" suffix="/"/><date-part name="day" form="numeric" suffix="/"/><date-part name="year"/></date>
  <terms>
    <term name="no date" form="short">n.d.</term>
    <term name="and">and</term>
    <term name="et-al">et al.</term>
    <term name="editor" form="short"><single>ed.</single><multiple>eds.</multiple></term>
    <term name="volume" form="short"><single>vol.</single><multiple>vols.</multiple></term>
    <term name="issue" form="short"><single>no.</single><multiple>nos.</multiple></term>
    <term name="page" form="short"><single>p.</single><multiple>pp.</multiple></term>
    <term name="accessed">accessed</term>
    <term name="available at">available at</term>
    <term name="open-quote">"</term>
    <term name="close-quote">"</term>
    <term name="open-inner-quote">'</term>
    <term name="close-inner-quote">'</term>
  </terms>
</locale>`;

// ── Fetch a CSL style file with caching ───────────────────────────
/**
 * Fetch a CSL style XML by style ID.
 * Returns cached version if available, otherwise fetches from GitHub.
 *
 * @param {string} styleId - CSL style file name without .csl extension
 *                           e.g. 'harvard-cite-them-right', 'apa', 'vancouver'
 * @returns {Promise<string>} CSL XML string
 */
export async function fetchStyle(styleId) {
    // Check in-memory cache first
    if (styleCache.has(styleId)) {
        return styleCache.get(styleId);
    }

    try {
        const url = `${CSL_BASE_URL}${styleId}.csl`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'text/xml, application/xml, */*',
                'User-Agent': 'Refinr/1.0 (academic reference manager)'
            },
            // 8 second timeout — generous enough for GitHub, tight enough not to block
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            throw new Error(`GitHub returned ${response.status} for style: ${styleId}`);
        }

        const xml = await response.text();

        // Basic validation — CSL files always start with <?xml or <style
        if (!xml.includes('<style') && !xml.includes('<?xml')) {
            throw new Error(`Response for ${styleId} does not appear to be a valid CSL file`);
        }

        // Cache it
        styleCache.set(styleId, xml);
        return xml;

    } catch (err) {
        console.warn(`CSL fetch failed for "${styleId}": ${err.message}. Using Harvard fallback.`);

        // Cache the fallback so we don't keep retrying a bad style ID
        styleCache.set(styleId, FALLBACK_HARVARD_CSL);
        return FALLBACK_HARVARD_CSL;
    }
}

// ── Fetch the en-US locale ────────────────────────────────────────
/**
 * Fetch the CSL en-US locale XML.
 * citeproc-js requires this to render formatted citations.
 *
 * @returns {Promise<string>} Locale XML string
 */
export async function fetchLocale() {
    if (localeCache) return localeCache;

    try {
        const response = await fetch(LOCALE_URL, {
            headers: { 'Accept': 'text/xml, application/xml, */*' },
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) throw new Error(`Locale fetch returned ${response.status}`);

        const xml = await response.text();
        if (!xml.includes('<locale')) throw new Error('Response does not appear to be a valid locale file');

        localeCache = xml;
        return xml;

    } catch (err) {
        console.warn(`Locale fetch failed: ${err.message}. Using built-in fallback locale.`);
        localeCache = FALLBACK_LOCALE;
        return FALLBACK_LOCALE;
    }
}

// ── Resolve a style ID from common aliases ────────────────────────
// Users might type "Harvard" or "APA" — map these to the correct CSL file ID.
const STYLE_ALIASES = {
    'harvard':           'harvard-cite-them-right',
    'apa':               'apa',
    'apa7':              'apa',
    'apa 7':             'apa',
    'apa7th':            'apa',
    'apa-7th-edition':   'apa',
    'apa6':              'apa-6th-edition',
    'apa 6':             'apa-6th-edition',
    'mla':               'modern-language-association',
    'mla9':              'modern-language-association',
    'chicago':           'chicago-author-date',
    'chicago-ad':        'chicago-author-date',
    'chicago-nb':        'chicago-note-bibliography',
    'vancouver':         'vancouver',
    'ieee':              'ieee',
    'ama':               'ama10',
    'acs':               'american-chemical-society',
    'cse':               'council-of-science-editors',
    'nature':            'nature',
    'science':           'science',
    'cell':              'cell',
    'plos':              'plos',
    'frontiers':         'frontiers-in',
    'bmj':               'british-medical-journal',
    'lancet':            'the-lancet',
    'nejm':              'new-england-journal-of-medicine',
    'jama':              'jama',
    'oscola':            'oscola',
    'bluebook':          'bluebook-law-review',
    'turabian':          'turabian-author-date',
    'acm':               'acm-sig-proceedings',
    'apa (philosophy)':  'journal-of-the-american-philosophical-association',
    'ajol':              'harvard-cite-them-right' // AJOL accepts Harvard
};

/**
 * Resolve a style name or alias to a canonical CSL file ID.
 *
 * @param {string} styleInput - Style name from the UI dropdown or user input
 * @returns {string} Canonical CSL file ID
 */
export function resolveStyleId(styleInput) {
    if (!styleInput) return 'harvard-cite-them-right';

    const normalised = styleInput.toLowerCase().trim()
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9\s\-]/g, '');

    // Direct alias match
    if (STYLE_ALIASES[normalised]) return STYLE_ALIASES[normalised];

    // Already looks like a CSL file ID (contains hyphens, all lowercase)
    if (/^[a-z][a-z0-9-]+$/.test(styleInput)) return styleInput;

    // Fallback
    return 'harvard-cite-them-right';
}

// ── Cache status (useful for debugging / admin) ───────────────────
export function getCacheStatus() {
    return {
        cachedStyles: Array.from(styleCache.keys()),
        localeLoaded: !!localeCache,
        cacheSize: styleCache.size
    };
}

// ── Clear cache (useful for testing) ─────────────────────────────
export function clearCache() {
    styleCache.clear();
    localeCache = null;
}
