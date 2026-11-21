const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// Low-memory Chromium flags for Render free tier (512MB RAM)
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-default-browser-check',
  '--safebrowsing-disable-auto-update',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI',
];

// Extract contact data from a rendered page
async function extractContact(page, url) {
  return await page.evaluate((pageUrl) => {
    // Decode HTML entities (handles &#x27; → ' and &amp; → & etc.)
    const htmlDecode = (str) => {
      if (!str) return str;
      const el = document.createElement('div');
      el.innerHTML = str;
      return el.textContent || el.innerText || '';
    };

    const getMeta = (selector) => {
      const el = document.querySelector(selector);
      return el ? htmlDecode((el.getAttribute('content') || el.textContent || '').trim()) : null;
    };

    const host = window.location.hostname;
    const isHiHello = host.includes('hihello');
    const isBlinq = host.includes('blinq');
    const isPopl = host.includes('popl');

    let name = null, title = null, company = null, email = null, phone = null;
    let linkedin = null, website = null, bio = null;
    const links = [];

    // ── Scan all <a> tags for email / phone / social links ──
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = htmlDecode((a.getAttribute('href') || '').trim());
      if (!href) return;
      if (href.startsWith('mailto:') && !email) {
        email = href.replace('mailto:', '').split('?')[0].trim();
      } else if (href.startsWith('tel:') && !phone) {
        phone = href.replace('tel:', '').trim();
      } else if (
        href.startsWith('http') &&
        !href.includes(host) &&
        !links.includes(href)
      ) {
        links.push(href);
      }
    });

    // ── Route links: LinkedIn vs website ──
    for (const href of links) {
      try {
        const u = new URL(href);
        if (!linkedin && (u.hostname.includes('linkedin.com'))) {
          linkedin = href;
        } else if (!website && !u.hostname.includes('linkedin.com')) {
          website = href;
        }
      } catch (_) {}
    }

    // ── Bio: try og:description, then platform-specific bio elements ──
    const ogDesc =
      getMeta('meta[property="og:description"]') ||
      getMeta('meta[name="description"]') ||
      null;
    // Use og:description as bio only if it doesn't look like a "title | company" pattern
    if (ogDesc && ogDesc.length > 40 && !/^.{0,60}[|·\-].{0,60}$/.test(ogDesc)) {
      bio = ogDesc;
    }
    // Platform-specific bio selectors
    if (!bio) {
      const bioEl =
        document.querySelector('[class*="bio"], [class*="Bio"], [class*="about"], [class*="About"], [class*="description"], [class*="tagline"], [class*="Tagline"]');
      if (bioEl) {
        const text = bioEl.textContent?.trim();
        if (text && text.length > 20) bio = text;
      }
    }

    // ── HiHello ──
    if (isHiHello) {
      name =
        document.querySelector('h1')?.textContent?.trim() ||
        document.querySelector('[class*="name"]')?.textContent?.trim();
      title =
        document.querySelector('[class*="title"], [class*="job-title"], [class*="jobTitle"]')
          ?.textContent?.trim();
      company =
        document.querySelector('[class*="company"], [class*="organization"], [class*="org"]')
          ?.textContent?.trim();
    }

    // ── Blinq ──
    if (isBlinq) {
      name =
        document.querySelector('h1, [class*="name"]')?.textContent?.trim();
      title =
        document.querySelector('[class*="title"], [class*="position"]')
          ?.textContent?.trim();
      company =
        document.querySelector('[class*="company"]')?.textContent?.trim();
    }

    // ── Popl ──
    if (isPopl) {
      name =
        document.querySelector('h1, [class*="Name"], [class*="name"]')
          ?.textContent?.trim();
      title =
        document.querySelector('[class*="Title"], [class*="title"]')
          ?.textContent?.trim();
      company =
        document.querySelector('[class*="Company"], [class*="company"]')
          ?.textContent?.trim();
    }

    // ── Fallback: og:title cleanup ──
    if (!name) {
      const ogTitle =
        getMeta('meta[property="og:title"]') ||
        getMeta('meta[name="og:title"]') ||
        document.title ||
        '';
      name = ogTitle
        .replace(/[\u2018\u2019']s\s+(digital\s+)?(business|blinq|hihello|popl)\s+card/gi, '')
        .replace(/[\u2018\u2019']s\s+(digital\s+)?(business|blinq|hihello|popl)\s+card/gi, '')
        .replace(/\s*[-|]\s*(hihello|blinq|popl|dealdeck).*/gi, '')
    }

    // ── Fallback: description for title/company ──
    if (!title && !company) {
      const desc =
        getMeta('meta[property="og:description"]') ||
        getMeta('meta[name="description"]') ||
        '';
      if (desc) {
        const parts = desc.split(/[|·\-]/).map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          title = parts[0];
          company = parts[1];
        } else if (parts.length === 1) {
          title = parts[0];
        }
      }
    }

    return {
      name: name || null,
      title: title || null,
      company: company || null,
      email: email || null,
      phone: phone || null,
      linkedin: linkedin || null,
      website: website || null,
      bio: bio || null,
      links: links.slice(0, 10),
      sourceUrl: pageUrl,
    };
  }, url);
}

// ── POST /scrape ──────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: LAUNCH_ARGS,
      headless: 'new',
      timeout: 60000,
    });

    const page = await browser.newPage();

    // Block images / fonts / media to save RAM
    await page.setRequestInterception(true);
    page.on('request', (intercepted) => {
      const type = intercepted.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        intercepted.abort();
      } else {
        intercepted.continue();
      }
    });

    // Set a realistic user-agent
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Give JS-rendered content extra time to settle
    await new Promise((r) => setTimeout(r, 2500));

    const contact = await extractContact(page, url);

    res.json({ success: true, contact });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'dealdeck-scraper' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`dealdeck-scraper running on port ${PORT}`);
});
