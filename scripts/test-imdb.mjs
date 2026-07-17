import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

chromium.use(stealth());

async function fetchIMDB(title) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // 1. Get IMDB ID from suggestion API
    const suggestRes = await page.evaluate(async (t) => {
      const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(t)}.json`);
      return res.ok ? await res.json() : null;
    }, title);
    
    if (!suggestRes || !suggestRes.d || suggestRes.d.length === 0) {
        console.log("No IMDB suggestion found");
        return null;
    }
    
    const movieObj = suggestRes.d.find(item => item.qid === "movie");
    if (!movieObj) {
        console.log("No movie found in suggestions");
        return null;
    }
    
    const imdbId = movieObj.id;
    console.log(`Found IMDB ID: ${imdbId}`);
    
    // 2. Scrape the IMDb page
    await page.goto(`https://www.imdb.com/title/${imdbId}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const data = await page.evaluate(() => {
        const script = document.querySelector('script[type="application/ld+json"]');
        if (!script) return null;
        try {
            return JSON.parse(script.innerText);
        } catch (e) {
            return null;
        }
    });
    
    if (data) {
        console.log(data);
    } else {
        console.log("No JSON-LD found on page");
    }
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
}

fetchIMDB("Inception");
