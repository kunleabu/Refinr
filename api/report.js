export default async function handler(req, res) {
    // Save a report
    if (req.method === 'POST') {
        const { reportData } = req.body;
        if (!reportData) {
            return res.status(400).json({ error: 'Missing report data' });
        }

        try {
            const response = await fetch('https://api.jsonbin.io/v3/b', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Master-Key': process.env.JSONBIN_API_KEY,
'X-Access-Key': process.env.JSONBIN_API_KEY,
                    'X-Bin-Name': `refinr-report-${Date.now()}`,
                    'X-Bin-Private': 'false'
                },
                body: JSON.stringify({ reportData })
            });

            const data = await response.json();
            console.log('JSONBin response:', JSON.stringify(data));
const binId = data.metadata?.id;

            if (!binId) {
                return res.status(500).json({ error: 'Failed to save report' });
            }

            return res.status(200).json({ binId });

        } catch (error) {
            return res.status(500).json({ error: 'Failed to save report' });
        }
    }

    // Get a report
    if (req.method === 'GET') {
        const { id } = req.query;
        if (!id) {
            return res.status(400).json({ error: 'Missing report ID' });
        }

        try {
            const response = await fetch(`https://api.jsonbin.io/v3/b/${id}/latest`, {
                headers: {
                    'X-Master-Key': process.env.JSONBIN_API_KEY
                }
            });

            const data = await response.json();
            return res.status(200).json({ reportData: data.record?.reportData });

        } catch (error) {
            return res.status(500).json({ error: 'Failed to fetch report' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
