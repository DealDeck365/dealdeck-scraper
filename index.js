
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

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

function labelLink(href) {
  try {
    const host = new URL(href).hostname.toLowerCase()
      .replace(/^www\./, '');

    if (host === 'linkedin.com' || host.endsWith('.linkedin.com'))
      return 'LinkedIn';
    if (host === 'facebook.com' || host.endsWith('.facebook.com') ||
        host === 'fb.com') return 'Facebook';
    if (host === 'instagram.com' || host.endsWith('.instagram.com'))
      return 'Instagram';
    if (host === 'youtube.com' || host.endsWith('.youtube.com') ||
        host === 'youtu.be') return 'YouTube';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com'))
      return 'TikTok';
    if (host === 'x.com' || host === 'twitter.com')
      return 'X';
    if (host === 'calendly.com' || host.endsWith('.calendly.com'))
      return 'Calendly';
    if (host === 'typeform.com' || host.endsWith('.typeform.com'))
      return 'Typeform';

    return 'Website';
  } catch {
    return 'Website';
  }
}

async function extractContact(page, url) {
  return await page.evaluate((pageUrl) => {
    const htmlDecode = (str) => {
      if (!str) return str;
      const el = document.createElement('div');
      el.innerHTML = str;
      return el.textContent || el.innerText || '';
    };

    const getMeta = (selector) => {
      const el = document.querySelector(selector);
      return el
        ? htmlDecode((el.getAttribute('content') ||
            el.textContent || '').trim())
        : null;
    };

    const host = window.location.hostname.toLowerCase();
    const isHiHello = host.includes('hihello');
    const isBlinq = host.includes('blinq');
    const isPopl = host.includes('popl');

    let name = null;
    let title = null;
    let company = null;
    let email = null;
    let phone = null;
    let bio = null;

    const links = [];

    document.querySelectorAll('a[href]').forEach((a) => {
      const href = htmlDecode(
        (a.getAttribute('href') || '').trim()
      );

      if (!href) return;

      if (href.startsWith('mailto:') && !email) {
        email = href.slice(7).split('?')[0].trim();
      } else if (href.startsWith('tel:') && !phone) {
        phone = href.slice(4).trim();
      } else if (href.startsWith('http')) {
        try {
          const parsed = new URL(href);
          const targetHost = parsed.hostname.toLowerCase();
          if (targetHost !== host &&
              !links.includes(parsed.href)) {
            links.push(parsed.href);
          }
        } catch (_) {}
      }
    });

    const ogDesc =
      getMeta('meta[property="og:description"]') ||
      getMeta('meta[name="description"]');

    if (ogDesc && ogDesc.length > 40) {
      bio = ogDesc;
    }

    if (!bio) {
      const bioEl = document.querySelector(
        '[class*="bio"], [class*="Bio"], ' +
        '[class*="about"], [class*="About"], ' +
        '[class*="tagline"], [class*="Tagline"]'
      );
      const text = bioEl?.textContent?.trim();
      if (text && text.length > 20) bio = text;
    }

    if (isHiHello) {
      name = document.querySelector(
        'h1, [class*="name"]'
      )?.textContent?.trim();
      title = document.querySelector(
        '[class*="title"], [class*="job-title"], ' +
        '[class*="jobTitle"]'
      )?.textContent?.trim();
      company = document.querySelector(
        '[class*="company"], [class*="organization"], ' +
        '[class*="org"]'
      )?.textContent?.trim();
    }

    if (isBlinq) {
      name = document.querySelector(
        'h1, [class*="name"]'
      )?.textContent?.trim();
      title = document.querySelector(
        '[class*="title"], [class*="position"]'
      )?.textContent?.trim();
      company = document.querySelector(
        '[class*="company"]'
      )?.textContent?.trim();
    }

    if (isPopl) {
      name = document.querySelector(
        'h1, [class*="Name"], [class*="name"]'
      )?.textContent?.trim();
      title = document.querySelector(
        '[class*="Title"], [class*="title"]'
      )?.textContent?.trim();
      company = document.querySelector(
        '[class*="Company"], [class*="company"]'
      )?.textContent?.trim();
    }

    if (!name) {
      const ogTitle =
        getMeta('meta[property="og:title"]') ||
        document.title || '';

      name = ogTitle
        .replace(
          /[\u2018\u2019']s\s+(digital\s+)?(business|blinq|hihello|popl)\s+card/gi,
          ''
        )
        .replace(
          /\s*[-|]\s*(hihello|blinq|popl|dealdeck).*/gi,
          ''
        )
        .trim();
    }

    if (!title && !company) {
      const desc = ogDesc || '';
      const parts = desc.split(/[|·\-]/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (parts.length >= 2) {
        title = parts[0];
        company = parts[1];
      }
    }

    return {
      name: name ? htmlDecode(name) : null,
      title: title ? htmlDecode(title) : null,
      company: company ? htmlDecode(company) : null,
      email: email || null,
      phone: phone || null,
      bio: bio ? htmlDecode(bio) : null,
      links: links.slice(0, 50),
      sourceUrl: pageUrl,
    };
  }, url);
}

app.post('/scrape', async (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({
      error: 'url is required'
    });
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      args: LAUNCH_ARGS,
      headless: 'new',
      timeout: 60000,
    });

    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['image', 'font', 'media'].includes(
        request.resourceType()
      )) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
      'Version/17.0 Mobile/15E148 Safari/604.1'
    );

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await new Promise((resolve) =>
      setTimeout(resolve, 2500)
    );

    const contact = await extractContact(page, url);

    const urls = contact.links.map((value) => ({
      value,
      label: labelLink(value),
    }));

    const linkedin = urls.find(
      (item) => item.label === 'LinkedIn'
    )?.value || null;

    const website = urls.find(
      (item) => item.label === 'Website'
    )?.value || null;

    res.json({
      success: true,
      contact: {
        ...contact,
        linkedin,
        website,
        urls,
      },
    });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({
      error: err.message
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'dealdeck-scraper'
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `dealdeck-scraper running on port ${PORT}`
  );
});
