// create-article.js — POST /api/create-article
// Creates articles in two destinations:
//   destination: 'confluence' → Internal page in TS space under Common Troubleshooting
//   destination: 'zendesk'   → Customer-facing draft in ZD Help Center

const { zdRequest } = require('../_zendesk');
const { confluenceRequest, isConfluenceConfigured } = require('../_confluence');

// Zendesk Help Center config
const ZD_CATEGORY_ID = '4409242627348'; // AutoVitals System Settings and Reports
const ZD_SECTION_NAME = 'Troubleshooting Guides';

// Confluence config
const CONF_SPACE_KEY = 'TS';
const CONF_PARENT_ID = '2102231233'; // Common Troubleshooting page

// ---- Zendesk: find or create customer-facing section ----
async function findOrCreateZdSection() {
  const url = '/help_center/categories/' + ZD_CATEGORY_ID + '/sections.json?per_page=100';
  const data = await zdRequest(url);
  if (data && data.sections) {
    const existing = data.sections.find(s =>
      s.name.toLowerCase() === ZD_SECTION_NAME.toLowerCase()
    );
    if (existing) return existing.id;
  }

  const created = await zdRequest('/help_center/categories/' + ZD_CATEGORY_ID + '/sections.json', {
    method: 'POST',
    body: {
      section: {
        name: ZD_SECTION_NAME,
        description: 'Troubleshooting guides and how-to articles for common issues.',
        position: 1,
      },
    },
  });

  if (created && created.section) return created.section.id;
  throw new Error('Failed to create Troubleshooting Guides section');
}

// ---- Zendesk: create customer-facing draft article ----
async function createZendeskArticle({ title, body, labels, sectionId }) {
  const targetSection = sectionId || await findOrCreateZdSection();

  const articleData = {
    article: {
      title,
      body,
      draft: true,
      comments_disabled: false,
      label_names: labels || ['troubleshooting', 'auto-generated'],
    },
  };

  const result = await zdRequest('/help_center/sections/' + targetSection + '/articles.json', {
    method: 'POST',
    body: articleData,
  });

  if (!result || !result.article) {
    throw new Error('Zendesk returned unexpected response');
  }

  return {
    success: true,
    destination: 'zendesk',
    articleId: result.article.id,
    title: result.article.title,
    url: result.article.html_url,
    draft: result.article.draft,
    sectionId: targetSection,
  };
}

// ---- Confluence: create internal page ----
async function createConfluencePage({ title, body, labels }) {
  if (!isConfluenceConfigured()) {
    throw new Error('Confluence credentials not configured (JIRA_EMAIL / JIRA_API_TOKEN)');
  }

  const pageData = {
    type: 'page',
    title,
    space: { key: CONF_SPACE_KEY },
    ancestors: [{ id: CONF_PARENT_ID }],
    body: {
      storage: {
        value: body,
        representation: 'storage',
      },
    },
  };

  const result = await confluenceRequest('/content', {
    method: 'POST',
    body: pageData,
  });

  if (!result || !result.id) {
    throw new Error('Confluence returned unexpected response');
  }

  // Add labels if provided
  if (labels && labels.length > 0) {
    try {
      await confluenceRequest(`/content/${result.id}/label`, {
        method: 'POST',
        body: labels.map(l => ({ prefix: 'global', name: l.toLowerCase().replace(/\s+/g, '-') })),
      });
    } catch {
      // Labels are non-critical, don't fail the whole request
    }
  }

  const pageUrl = `https://autovitals.atlassian.net/wiki/spaces/${CONF_SPACE_KEY}/pages/${result.id}`;

  return {
    success: true,
    destination: 'confluence',
    pageId: result.id,
    title: result.title,
    url: result._links && result._links.webui
      ? `https://autovitals.atlassian.net/wiki${result._links.webui}`
      : pageUrl,
    spaceKey: CONF_SPACE_KEY,
  };
}

// ---- Zendesk: update an existing article ----
async function updateZendeskArticle({ articleId, title, body, labels }) {
  const articleData = {
    article: {
      title,
      body,
      label_names: labels || ['troubleshooting', 'auto-generated', 'updated'],
    },
  };

  const result = await zdRequest('/help_center/articles/' + articleId + '.json', {
    method: 'PUT',
    body: articleData,
  });

  if (!result || !result.article) {
    throw new Error('Zendesk update returned unexpected response');
  }

  return {
    success: true,
    destination: 'zendesk',
    action: 'updated',
    articleId: result.article.id,
    title: result.article.title,
    url: result.article.html_url,
    draft: result.article.draft,
    sectionId: result.article.section_id,
  };
}

// ---- Handler ----
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { title, body, labels, sectionId, destination, action, articleId } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    // Update existing ZD article
    if (action === 'update' && articleId) {
      const result = await updateZendeskArticle({ articleId, title, body, labels });
      return res.json(result);
    }

    if (destination === 'confluence') {
      const result = await createConfluencePage({ title, body, labels });
      return res.json(result);
    }

    // Default: Zendesk
    const result = await createZendeskArticle({ title, body, labels, sectionId });
    return res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
