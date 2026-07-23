// ═══════════════════════════════════════════════════════════════════
// lib/formatter.js — Reference Intelligence Engine
// citeproc-js wrapper.
//
// Pipeline:
//   CSL-JSON metadata + style ID
//     → fetchStyle() from csl-cache.js
//     → fetchLocale() from csl-cache.js
//     → citeproc-js CSL engine
//     → formatted citation string
//
// This file is the reason we don't need Groq for formatting.
// citeproc-js is the same engine Zotero and Mendeley use internally.
// Output is deterministic — same input always produces same output.
//
// Special styles (_clean_only, _number_only) are handled by rules
// here, not by citeproc, since they are not real citation styles.
// ═══════════════════════════════════════════════════════════════════

import { fetchStyle, fetchLocale, resolveStyleId } from './csl-cache.js';

// ── citeproc-js dynamic import ────────────────────────────────────
// Loaded dynamically to avoid serverless cold-start issues.
let CSL = null;
async function getCiteproc() {
    if (CSL) return CSL;
    const mod = await import('citeproc');
    CSL = mod.default || mod.CSL || mod;
    return CSL;
}

// ── Format a single reference ──────────────────────────────────────
/**
 * Format a single CSL-JSON item into a formatted citation string.
 *
 * @param {Object} cslJsonItem  - CSL-JSON object from metadata.js
 * @param {string} styleInput   - Style name or ID ('Harvard', 'apa', 'vancouver' etc.)
 * @returns {Promise<string>}   - Formatted citation string
 */
export async function formatSingle(cslJsonItem, styleInput) {
    const results = await formatBatch([cslJsonItem], styleInput);
    return results[0] || '';
}

// ── Format multiple references ─────────────────────────────────────
/**
 * Format an array of CSL-JSON items into formatted citation strings.
 * Processes all items in a single citeproc engine instance — efficient
 * for bulk operations.
 *
 * @param {Object[]} cslJsonItems - Array of CSL-JSON objects from metadata.js
 * @param {string}   styleInput   - Style name or ID
 * @returns {Promise<string[]>}   - Array of formatted citation strings,
 *                                  same order and length as input
 */
export async function formatBatch(cslJsonItems, styleInput) {
    if (!cslJsonItems || cslJsonItems.length === 0) return [];

    const styleId = resolveStyleId(styleInput);

    // ── Special styles: handled by rules, not citeproc ──────────────
    if (styleId === '_clean_only') {
        return cslJsonItems.map(item => reconstructFromMetadata(item));
    }

    if (styleId === '_number_only') {
        return cslJsonItems.map((item, i) => `${i + 1}. ${reconstructFromMetadata(item)}`);
    }

    // ── citeproc path ────────────────────────────────────────────────
    try {
        const [cslXml, localeXml, CiteProc] = await Promise.all([
            fetchStyle(styleId),
            fetchLocale(),
            getCiteproc()
        ]);

        // Build the item registry — citeproc needs all items upfront
        const itemRegistry = {};
        for (const item of cslJsonItems) {
            // Ensure every item has an id
            if (!item.id) item.id = `ref_${Math.random().toString(36).substring(2, 9)}`;
            itemRegistry[item.id] = item;
        }

        // citeproc-js sys object — provides items and locale to the engine
        const sys = {
            retrieveLocale: (lang) => localeXml,
            retrieveItem: (id) => itemRegistry[id]
        };

        // Initialise the CSL engine
        const engine = new CiteProc.Engine(sys, cslXml);

        // Register all items
        const ids = cslJsonItems.map(item => item.id);
        engine.updateItems(ids);

        // makeBibliography returns [params, bibliography_array]
        const bibResult = engine.makeBibliography();

        if (!bibResult || !bibResult[1] || bibResult[1].length === 0) {
            // citeproc returned nothing — fall back to reconstruction
            return cslJsonItems.map(item => reconstructFromMetadata(item));
        }

        // bibResult[1] is an array of HTML-ish strings, one per item
        // in the same order as items were registered
        return bibResult[1].map(entry => cleanCiteprocOutput(entry));

    } catch (err) {
        console.error('citeproc formatting error:', err.message);
        // Graceful degradation — return reconstructed plain text
        return cslJsonItems.map(item => reconstructFromMetadata(item));
    }
}

// ── Sort and format a full reference list ─────────────────────────
/**
 * Format an array of CSL-JSON items, sort them (alphabetical for
 * author-date styles, sequential for numbered styles), and return
 * a clean formatted list.
 *
 * @param {Object[]} cslJsonItems
 * @param {string}   styleInput
 * @param {Object}   options
 * @param {boolean}  options.sort         - Whether to alphabetise (default true)
 * @param {boolean}  options.removeDups   - Whether to deduplicate (default true)
 * @returns {Promise<{formatted: string[], sorted: Object[], duplicatesRemoved: number}>}
 */
export async function formatReferenceList(cslJsonItems, styleInput, options = {}) {
    const { sort = true, removeDups = true } = options;
    const styleId = resolveStyleId(styleInput);

    let items = [...cslJsonItems];
    let duplicatesRemoved = 0;

    // Deduplicate by title similarity (simple prefix match on first 40 chars)
    if (removeDups) {
        const seen = new Map();
        const unique = [];
        for (const item of items) {
            const key = (item.title || item.id || '').toLowerCase().replace(/\W/g, '').substring(0, 40);
            if (key && seen.has(key)) {
                duplicatesRemoved++;
            } else {
                if (key) seen.set(key, true);
                unique.push(item);
            }
        }
        items = unique;
    }

    // Sort alphabetically by first author family name for author-date styles
    // Numbered styles (Vancouver, IEEE) keep original order
    const isNumbered = ['vancouver', 'ieee', 'ama10', 'american-chemical-society',
        'acm-sig-proceedings', 'council-of-science-editors'].includes(styleId);

    if (sort && !isNumbered) {
        items.sort((a, b) => {
            const aName = (a.author?.[0]?.family || a.title || '').toLowerCase();
            const bName = (b.author?.[0]?.family || b.title || '').toLowerCase();
            return aName.localeCompare(bName);
        });
    }

    const formatted = await formatBatch(items, styleInput);

    return { formatted, sorted: items, duplicatesRemoved };
}

// ── Clean citeproc HTML output ────────────────────────────────────
// citeproc-js returns strings with HTML spans (for italics, etc.)
// We convert these to plain text markers that the UI can render,
// or strip them entirely for plain text output.
function cleanCiteprocOutput(html) {
    if (!html) return '';
    return html
        // Remove div wrappers citeproc adds around each entry
        .replace(/<div[^>]*>/gi, '')
        .replace(/<\/div>/gi, '')
        // Convert italic spans to unicode italic or just strip for plain text
        // We keep the content, remove the tags
        .replace(/<i>(.*?)<\/i>/gi, '$1')
        .replace(/<em>(.*?)<\/em>/gi, '$1')
        .replace(/<b>(.*?)<\/b>/gi, '$1')
        .replace(/<strong>(.*?)<\/strong>/gi, '$1')
        // Remove any remaining HTML tags
        .replace(/<[^>]+>/g, '')
        // Decode common HTML entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // Normalise whitespace
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Plain text reconstruction from CSL-JSON ───────────────────────
// Used when citeproc fails or for _clean_only/_number_only modes.
// Produces a reasonable plain text reference from available fields.
function reconstructFromMetadata(item) {
    if (!item) return '';

    const parts = [];

    // Authors
    if (item.author && item.author.length > 0) {
        const authorStr = item.author.map((a, i) => {
            const family = a.family || '';
            const given = a.given || '';
            // First author: Lastname, F.
            // Subsequent: Lastname, F.
            return given ? `${family}, ${given}.` : family;
        }).join(', ');
        parts.push(authorStr);
    }

    // Year
    if (item.issued?.['date-parts']?.[0]?.[0]) {
        parts.push(`(${item.issued['date-parts'][0][0]})`);
    }

    // Title
    if (item.title) {
        if (item.type === 'book' || item.type === 'thesis') {
            parts.push(item.title + '.');
        } else {
            parts.push(`'${item.title}'.`);
        }
    }

    // Container (journal/book title)
    if (item['container-title']) {
        let container = item['container-title'];
        if (item.volume) container += `, vol. ${item.volume}`;
        if (item.issue) container += `, no. ${item.issue}`;
        if (item.page) container += `, pp. ${item.page}`;
        parts.push(container + '.');
    }

    // Publisher info (for books)
    if (!item['container-title'] && (item.publisher || item['publisher-place'])) {
        const pub = [item['publisher-place'], item.publisher].filter(Boolean).join(': ');
        if (pub) parts.push(pub + '.');
    }

    // DOI or URL
    if (item.DOI) parts.push(`doi: ${item.DOI}`);
    else if (item.URL) parts.push(`Available at: ${item.URL}`);

    return parts.join(' ');
}
