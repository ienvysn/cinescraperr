import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { fetchTMDBDetails } from "../lib/tmdb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

// Use stealth plugin
chromium.use(stealth());

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Missing Supabase Environment Variables");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

function normalizeTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/\(.*\)/g, "")
    .replace(/ - .*/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getMovieDetails(page, movieId) {
  const url = `https://www.qfxcinemas.com/now-showing-booking/${movieId}/1/`;
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // Handle City Selection Modal if it appears
    const cityModal = page.locator(".show-details-popup.modal.show", { hasText: /Cities/i });
    if (await cityModal.isVisible()) {
        const kathmanduBtn = page.locator("button.tile", { hasText: /Kathmandu/i });
        if (await kathmanduBtn.isVisible()) {
            await kathmanduBtn.click();
            await page.waitForTimeout(1000);
        }
    }

    // Click "View more details" if it exists.
    const viewMore = page.locator("h6.movie_info_view_more_details", { hasText: /View More/i });
    if (await viewMore.isVisible()) {
        await viewMore.click({ force: true });
        await page.waitForTimeout(1000);
    }

    return await page.evaluate(() => {
      const container = document.querySelector(".movie_info");
      if (!container) return null;

      const duration = container.querySelector(".movie_info_language")?.innerText?.trim();
      const synopsis = container.querySelector(".movie_info_synopsis")?.innerText?.trim();

      const getVal = (label) => {
        const h6 = Array.from(document.querySelectorAll("h6")).find(el => el.innerText.toLowerCase().includes(label.toLowerCase()));
        if (!h6) return null;

        const section = h6.closest("div");
        if (!section) return null;

        const p = section.querySelector("p");
        if (!p) return null;

        const spans = Array.from(p.querySelectorAll("span"));
        if (spans.length > 0) {
          return spans.map(s => s.innerText.trim()).filter(t => t).join(", ");
        }

        return p.innerText.trim();
      };

      const genre = getVal("Genre");
      const cast = getVal("Cast");
      const director = getVal("Director");

      return { duration, synopsis, genre, cast, director };
    });
  } catch (err) {
    console.error(`❌ Error fetching details for movie ${movieId}: ${err.message}`);
    return null;
  }
}

async function scrapeQFX() {
  console.log("🚀 Launching Playwright for QFX Scrape...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    console.log("📡 Intercepting tokens...");
    let authToken = null;
    page.on('request', request => {
        const headers = request.headers();
        if (headers['authorization'] && request.url().includes('qfxcinemas.com')) {
            authToken = headers['authorization'];
        }
    });

    console.log("🌐 Navigating to QFX Cinemas for session...");
    await page.goto("https://www.qfxcinemas.com/", { waitUntil: "networkidle", timeout: 60000 });

    // Handle City Selection Modal
    const cityModal = page.locator(".show-details-popup.modal.show", { hasText: /Cities/i });
    if (await cityModal.isVisible()) {
        const kathmanduBtn = page.locator("button.tile", { hasText: /Kathmandu/i });
        if (await kathmanduBtn.isVisible()) {
            console.log("🏙️ Selecting city: Kathmandu...");
            await kathmanduBtn.click();
            await page.waitForTimeout(2000);
        }
    }

    // Wait for a token to be captured
    let retries = 0;
    while (!authToken && retries < 15) {
        await page.waitForTimeout(1000);
        retries++;
    }

    if (!authToken) {
        console.log("⚠️ No dynamic token captured, falling back to hardcoded one.");
        authToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6IjBmZDc1OWM2LTczMTYtNDdlZi1iZmYyLTg3ZWYwNTYxYWUxMCIsImlhdCI6MTc2MDQ3MDMzMX0.wkfUdwL5dZB3iPf_JeaLNI1GvtzqAXBntuu1AAtkwLk";
    } else {
        console.log("✅ Dynamic token captured successfully!");
    }

    console.log("📡 Extracting API data from browser context...");

    // We execute the API fetch inside the browser to bypass Cloudflare
    const apiData = await page.evaluate(async (token) => {
      const response = await fetch("https://web-api.qfxcinemas.com/api/external/quick-book", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "authorization": token
        },
        body: JSON.stringify({}),
      });
      return response.ok ? await response.json() : null;
    }, authToken);

    if (!apiData || !apiData.movies) {
      console.error("❌ Failed to fetch movies from browser context.");
      return;
    }

    const movies = apiData.movies;
    const uniqueMovies = Array.from(new Map(movies.map((m) => [m.movie_id, m])).values());
    console.log(`🎬 Found ${uniqueMovies.length} unique movies.`);

    // Pre-load cinemas
    const { data: allCinemas } = await supabase.from("cinemas").select("*");

    for (const movie of uniqueMovies) {
      const cleanTitle = normalizeTitle(movie.movie_title);
      console.log(`🔍 Processing: ${cleanTitle}`);

      // Rich metadata extraction from HTML
      console.log(`📡 Fetching rich metadata for ${cleanTitle} (ID: ${movie.movie_id})...`);
      let richDetails = await getMovieDetails(page, movie.movie_id);

      if (richDetails && (richDetails.director || richDetails.cast)) {
        console.log(`📝 Extracted QFX Metadata:`);
        console.log(`   - Duration: ${richDetails.duration}`);
        console.log(`   - Director: ${richDetails.director}`);
        console.log(`   - Cast: ${richDetails.cast}`);
        console.log(`   - Genre: ${richDetails.genre}`);
      } else {
        console.log(`⚠️ Missing QFX metadata, attempting TMDB fallback for ${cleanTitle}...`);
        const tmdbData = await fetchTMDBDetails(cleanTitle);
        if (tmdbData) {
            console.log(`✅ Found TMDB Metadata:`);
            console.log(`   - Duration: ${tmdbData.duration}`);
            console.log(`   - Director: ${tmdbData.director}`);
            console.log(`   - Cast: ${tmdbData.cast}`);

            // Merge metadata
            richDetails = {
                ...richDetails,
                duration: richDetails?.duration || tmdbData.duration,
                genre: richDetails?.genre || tmdbData.genre,
                director: richDetails?.director || tmdbData.director,
                cast: richDetails?.cast || tmdbData.cast,
                synopsis: richDetails?.synopsis || tmdbData.synopsis,
                rating: tmdbData.rating,
                details_source: 'TMDB'
            };
        }
      }

      const { data: movieRecord, error: mError } = await supabase
        .from("movies")
        .upsert(
          {
            title: cleanTitle,
            poster_url: movie.MovieContent?.[0]?.artwork || null,
            synopsis: richDetails?.synopsis || movie.MovieContent?.[0]?.mc_plot || null,
            duration: richDetails?.duration || null,
            genre: richDetails?.genre || null,
            director: richDetails?.director || null,
            cast: richDetails?.cast || null,
            rating: richDetails?.rating || null,
          },
          { onConflict: "title" }
        )
        .select()
        .single();

      if (mError || !movieRecord) {
        console.error(`⏩ Skipping movie ${cleanTitle}:`, mError?.message);
        continue;
      }

      // Sync showtimes for next 4 days
      const targetDates = [];
      for (let i = 0; i < 4; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        targetDates.push(d.toISOString().split("T")[0]);
      }

      for (const targetDate of targetDates) {
        const detailData = await page.evaluate(async ({ movieId, date, token }) => {
            const res = await fetch(`https://web-api.qfxcinemas.com/api/cinema/admin/movie-confirmed-list/${movieId}?fromDate=${date}&city_id=29790`, {
                headers: { "authorization": token }
            });
            return res.ok ? await res.json() : null;
        }, { movieId: movie.movie_id, date: targetDate, token: authToken });

        const records = detailData?.Records || [];
        for (const record of records) {
          for (const cinema of record.CinemaDateArray || []) {
            const apiCineName = cinema.cinema_name.trim();
            const cleanApiName = apiCineName.replace(/QFX/gi, "").trim().toLowerCase();
            
            for (const show of cinema.ShowTimeArray || []) {

          let cinemaMatch = allCinemas.find(c => c.mall_name?.toLowerCase().includes(cleanApiName) || cleanApiName.includes(c.mall_name?.toLowerCase()));

          if (!cinemaMatch) {
            console.log(`✨ Creating missing cinema: ${cinema.cinema_name}`);
            const { data: newCine } = await supabase.from("cinemas").insert({ mall_name: cinema.cinema_name, chain_name: "QFX" }).select().single();
            if (newCine) {
                cinemaMatch = newCine;
                allCinemas.push(newCine);
            }
          }

          if (cinemaMatch) {
            const startTime = `${record.ss_start_date}T${show.ss_start_show_time}:00`;

            // NEW: Fetch Price from Seat Layout
            let extractedPrice = null;
            try {
               extractedPrice = await page.evaluate(async ({ screenId, ssId, mdId, token }) => {
                 const res = await fetch("https://web-api.qfxcinemas.com/api/external/seat-layout", {
                   method: "POST",
                   headers: {
                       "content-type": "application/json",
                       "authorization": token
                   },
                   body: JSON.stringify({
                     screen_id: screenId,
                     ss_id: ssId,
                     md_id: mdId,
                     type_seat_show: 1
                   }),
                 });
                 if (!res.ok) return null;
                 const data = await res.json();
                 if (data.status && data.Records) {
                   const firstSeat = data.Records.find(s => s.seat_price);
                   return firstSeat ? firstSeat.seat_price : null;
                 }
                 return null;
               }, {
                 screenId: show.screen_id,
                 ssId: show.ss_id,
                 mdId: show.movie_details_id,
                 token: authToken
               });
            } catch (pErr) {
               console.error(`⚠️ Failed to fetch price for ${cleanTitle} at ${cinemaMatch.mall_name}: ${pErr.message}`);
            }

            const { error: sError } = await supabase.from("showtimes").upsert({
              movie_id: movieRecord.id,
              cinema_id: cinemaMatch.id,
              start_time: startTime,
              price: extractedPrice,
              booking_url: `https://www.qfxcinemas.com/now-showing-booking/${movie.movie_id}/1`,
            }, { onConflict: "movie_id, cinema_id, start_time" });

            if (sError) {
              console.error(`❌ DB Error for ${cleanTitle} showtime:`, sError.message);
            }
          }
            } // end of ShowTimeArray loop
          } // end of CinemaDateArray loop
        } // end of Records loop
      }
    }

    console.log("✅ QFX Sync via Playwright Completed!");

  } catch (error) {
    console.error("💥 Playwright Scraper Error:", error.message);
  } finally {
    await browser.close();
  }
}

scrapeQFX();
