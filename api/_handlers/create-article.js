// create-article.js — POST /api/create-article
// Creates an internal-only draft article in the Zendesk Help Center.
// Auto-creates an "Internal Troubleshooting" section if it doesn't exist.

const { zdRequest } = require('../_zendesk');

const INTERNAL_CATEGORY_ID = '4409242627348'; // AutoVitals System Settings and Reports
const INTERNAL_SECTION_NAME = 'Internal Troubleshooting';
const PERMISSION_GROUP_ID = 2684532; // Agent-only permission group

async function findOrCreateSection() {
  // Search existing sections for our internal section
  let url = '/help_center/categories/' + INTERNAL_CATEGORY_ID + '/sections.json?per_page=100';
  const data = await zdRequest(url);
  if (data && data.sections) {
    const existing = data.sections.find(s =>
      s.name.toLowerCase() === INTERNAL_SECTION_NAME.toLowerCase()
    );
    if (existing) return existing.id;
  }

  // Create new section
  const created = await zdRequest('/help_center/categories/' + INTERNAL_CATEGORY_ID + '/sections.json', {
    method: 'POST',
    body: {
      section: {
        name: INTERNAL_SECTION_NAME,
        description: 'Auto-generated troubleshooting articles for internal agent use. Created by Tech Support Command Center.',
        position: 99,
      },
    },
  });

  if (created && created.section) return created.section.id;
  throw new Error('Failed to create Internal Troubleshooting section');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { title, body, labels, sectionId } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    // Use provided sectionId or find/create the internal section
    const targetSection = sectionId || await findOrCreateSection();

    const articleData = {
      article: {
        title,
        body,
        draft: true,
        comments_disabled: true,
        permission_group_id: PERMISSION_GROUP_ID,
        label_names: labels || ['internal', 'troubleshooting', 'auto-generated'],
      },
    };

    const result = await zdRequest('/help_center/sections/' + targetSection + '/articles.json', {
      method: 'POST',
      body: articleData,
    });

    if (!result || !result.article) {
      throw new Error('Zendesk returned unexpected response');
    }

    res.json({
      success: true,
      articleId: result.article.id,
      title: result.article.title,
      url: result.article.html_url,
      draft: result.article.draft,
      sectionId: targetSection,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
