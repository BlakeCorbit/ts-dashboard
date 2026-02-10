const { getAuth } = require('./_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { baseUrl, auth } = getAuth();
    const ticketId = req.query.ticket || '134200';
    const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

    // 1. Get Jira links from the services endpoint (legacy)
    const linksUrl = new URL(`${baseUrl}/api/services/jira/links`);
    linksUrl.searchParams.set('ticket_id', ticketId);
    const linksResp = await fetch(linksUrl.toString(), { headers });
    const linksData = linksResp.ok ? await linksResp.json() : { error: linksResp.status };

    // 2. Try to list Jira integrations (to get external_id for v2 API)
    let integrations = null;
    try {
      const intResp = await fetch(`${baseUrl}/api/v2/integrations/jira`, { headers });
      integrations = intResp.ok ? await intResp.json() : { error: intResp.status, body: await intResp.text().catch(() => '') };
    } catch (e) { integrations = { error: e.message }; }

    res.json({
      ticketId,
      linksEndpoint: { status: linksResp.status, data: linksData },
      integrations,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
