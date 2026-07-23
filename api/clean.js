export default async function handler(req, res) {
    try {
        const { extractMetadata } = await import('../lib/metadata.js');
        return res.status(200).json({ ok: true, message: 'metadata import works' });
    } catch (err) {
        return res.status(500).json({ error: err.message, stage: 'metadata_import' });
    }
}
