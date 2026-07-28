import { sendAlert } from "../../../lib/utils/alert.js";
import { supabase } from "../../../lib/supabase.js";
import { normalizeTitle } from "../../../lib/utils/normalize.js";

export const dynamic = "force-dynamic";

const HEADERS = {
  accept: "application/json, text/plain, */*",
  authorization:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6IjBmZDc1OWM2LTczMTYtNDdlZi1iZmYyLTg3ZWYwNTYxYWUxMCIsImlhdCI6MTc2MDQ3MDMzMX0.wkfUdwL5dZB3iPf_JeaLNI1GvtzqAXBntuu1AAtkwLk",
  "content-type": "application/json",
  origin: "https://www.qfxcinemas.com",
  referer: "https://www.qfxcinemas.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    console.log("🚀 Starting QFX Scrape...");

    const { data: allCinemas, error: cineError } = await supabase
      .from("cinemas")
      .select("id, mall_name, chain_name, location_url");

    if (cineError || !allCinemas) {
      throw new Error(`Could not load cinemas from DB: ${cineError?.message}`);
    }

    let movies = [];
    let listRes = await fetch("https://web-api.qfxcinemas.com/api/cinema/admin/quick-book-list", {
      method: "GET",
      headers: HEADERS,
    });

    if (listRes.ok) {
      const data = await listRes.json();
      movies = data.movies || data.data || [];
    }

    if (movies.length === 0) {
      console.log("Trying fallback endpoint: POST /api/external/quick-book...");
      listRes = await fetch("https://web-api.qfxcinemas.com/api/external/quick-book", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({}),
      });

      if (listRes.ok) {
        const data = await listRes.json();
        movies = data.movies || [];
      }
    }

    if (!listRes.ok && movies.length === 0) {
      return res.status(200).json({
        success: false,
        message: `QFX API blocked or down (Status: ${listRes.status}). Cloudflare challenge might be active.`,
        error: await listRes.text()
      });
    }

    const uniqueMovies = Array.from(
      new Map(movies.map((m) => [m.movie_id, m])).values()
    );
    console.log(`🎬 Found ${uniqueMovies.length} unique movies.`);

    for (const movie of uniqueMovies) {
      const cleanTitle = normalizeTitle(movie.movie_title);

      const { data: movieRecord, error: mError } = await supabase
        .from("movies")
        .upsert(
          {
            title: cleanTitle,
            poster_url: movie.MovieContent?.[0]?.artwork || null,
            synopsis: movie.MovieContent?.[0]?.mc_plot || null,
          },
          { onConflict: "title" }
        )
        .select()
        .single();

      if (mError || !movieRecord) {
        console.log(`⏩ Skipping movie ${cleanTitle}: ${mError?.message}`);
        continue;
      }

      const targetDates = [];
      for (let i = 0; i < 4; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        targetDates.push(d.toISOString().split("T")[0]);
      }

      for (const targetDate of targetDates) {
        const detailUrl = `https://web-api.qfxcinemas.com/api/cinema/admin/movie-confirmed-list/${movie.movie_id}?fromDate=${targetDate}&city_id=29790`;

        const detailRes = await fetch(detailUrl, { headers: HEADERS });
        if (!detailRes.ok) continue;
        const detailData = await detailRes.json();
        const showtimeRecords = detailData.Records?.data || [];

        for (const show of showtimeRecords) {
          const apiCineName = show.cine_name.trim();

          const targetMall = allCinemas.find((dbCine) => {
            const dbNameClean = dbCine.mall_name ? dbCine.mall_name.toLowerCase().trim() : "";
            const apiNameClean = apiCineName.toLowerCase().trim();
            return dbNameClean.includes(apiNameClean) || apiNameClean.includes(dbNameClean);
          });

          if (!targetMall) {
            console.log(`⏩ Unknown QFX Cinema: "${apiCineName}"`);
            continue;
          }

          for (const dateObj of show.CinemaDateArray || []) {
            for (const showTime of dateObj.ShowTimeArray || []) {
              const isoStartTime = `${targetDate}T${showTime.showTime}`;

              let price = null;
              try {
                const layoutRes = await fetch("https://web-api.qfxcinemas.com/api/external/seat-layout", {
                  method: "POST",
                  headers: HEADERS,
                  body: JSON.stringify({ showId: showTime.showId }),
                });

                if (layoutRes.ok) {
                  const layoutData = await layoutRes.json();
                  const seatCategories = layoutData.seatLayout?.SeatCategory || [];
                  if (seatCategories.length > 0) {
                    price = seatCategories[0].Rate;
                  }
                }
              } catch (priceErr) {
                console.log(`⚠️ Price fetch failed for showId ${showTime.showId}: ${priceErr.message}`);
              }

              const { error: sError } = await supabase.from("showtimes").upsert(
                {
                  movie_id: movieRecord.id,
                  cinema_id: targetMall.id,
                  start_time: isoStartTime,
                  price: price,
                  booking_url: `https://www.qfxcinemas.com/show-times?showId=${showTime.showId}`,
                },
                { onConflict: "movie_id, cinema_id, start_time" }
              );

              if (sError) {
                console.error(`❌ DB Error for ${cleanTitle} at ${apiCineName}:`, sError.message);
              }
            }
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: `QFX Scrape completed. Processed ${uniqueMovies.length} movies.`,
    });
  } catch (error) {
    console.error("💥 Critical QFX Scraper Error:", error.message);
    await sendAlert(`Critical error in qfx.js: ${error.message}`);
    return res.status(200).json({ success: false, error: error.message });
  }
}
