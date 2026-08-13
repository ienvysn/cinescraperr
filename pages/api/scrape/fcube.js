import { sendAlert } from "../../../lib/utils/alert";
import { supabase } from "../../../lib/supabase";
import { normalizeTitle } from "../../../lib/utils/normalize";
import * as cheerio from "cheerio";

export const dynamic = "force-dynamic";

function getFcubePrice(cubeName, dayOfWeek, hourInt) {
  const isMorning = hourInt >= 6 && hourInt < 11;
  const isCube3 = cubeName.toLowerCase().includes("cube 3");

  if (isMorning) {
    return isCube3 ? 340 : 240;
  }

  // dayOfWeek: 0 = Sun, 1 = Mon, 2 = Tue, 3 = Wed, 4 = Thu, 5 = Fri, 6 = Sat
  if (dayOfWeek === 4) {
    return isCube3 ? 275 : 175;
  } else if (dayOfWeek === 2 || dayOfWeek === 3) {
    return isCube3 ? 340 : 240;
  } else if (dayOfWeek === 1) {
    return isCube3 ? 480 : 380;
  } else {
    // 0, 5, 6
    return isCube3 ? 580 : 480;
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    console.log("🚀 Starting FCube Cinemas Scrape...");

    const targetDates = [];
    const dateObjs = [];
    for (let i = 0; i < 4; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const yyyy = d.getFullYear();
        const mm = (d.getMonth() + 1).toString().padStart(2, "0");
        const dd = d.getDate().toString().padStart(2, "0");

        const isoDate = `${yyyy}-${mm}-${dd}`;
        targetDates.push(isoDate);

        dateObjs.push(new Date(yyyy, d.getMonth(), d.getDate()));
    }

    const { data: allCinemas, error: cineError } = await supabase
      .from("cinemas")
      .select("id, mall_name, chain_name, location_url");

    if (cineError || !allCinemas) {
      throw new Error(`Could not load cinemas from DB: ${cineError?.message}`);
    }

    let totalMoviesProcessed = 0;

    for (let i = 0; i < targetDates.length; i++) {
      const isoDate = targetDates[i];
      const dateObj = dateObjs[i];
      const yyyy = dateObj.getFullYear();
      const mm = (dateObj.getMonth() + 1).toString().padStart(2, "0");
      const dd = dateObj.getDate().toString().padStart(2, "0");
      const fetchDate = `${mm}/${dd}/${yyyy}`;
      console.log(`\n📅 Scraping FCube for date: ${isoDate} (using ${fetchDate})`);

      const fetchUrl = `https://www.fcubecinemas.com/Home/GetNowShowingInfo?movieId=&date=${fetchDate}&count=40`;

      const fetchRes = await fetch(fetchUrl, {
        method: "GET",
        cache: "no-store",
        headers: {
          "Accept": "text/html",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });

      if (!fetchRes.ok) {
        console.error(`❌ Failed to fetch from FCube API: ${fetchRes.status}`);
        await sendAlert(`Failed to fetch from FCube API. Status: ${fetchRes.status}`);
        return res.status(200).json({
            success: false,
            message: `FCube API down (Status: ${fetchRes.status})`,
            error: await fetchRes.text()
        });
      }

      const html = await fetchRes.text();
      const $ = cheerio.load(html);

      const movieElements = $(".posterCard").toArray();
      if (movieElements.length === 0) {
        console.log(`No movies found for ${isoDate}. Skipping.`);
        continue;
      }

      console.log(`🎬 Picked up ${movieElements.length} movies from FCube Cinemas.`);
      totalMoviesProcessed += movieElements.length;

      for (const el of movieElements) {
        const titleRaw = $(el).find(".movie-header span.text-white").text().trim();
        if (!titleRaw) continue;

        let imgUrl = $(el).find(".movie-poster-wrapper img").attr("src");
        if (imgUrl && !imgUrl.startsWith("http")) {
          imgUrl = "https://www.fcubecinemas.com" + imgUrl;
        }

        const genreRow = $(el).find(".fa-comment").next("span").text().trim();
        const genre = genreRow || null;

        const cleanTitle = normalizeTitle(titleRaw);

        // Map to DB Movie
        const { data: movieRecord, error: mError } = await supabase
          .from("movies")
          .upsert(
            {
              title: cleanTitle,
              poster_url: imgUrl || null,
              genre: genre,
            },
            { onConflict: "title" }
          )
          .select()
          .single();

        if (mError || !movieRecord) {
          console.log(`⏩ Skipping movie ${cleanTitle}: ${mError?.message}`);
          continue;
        }

        const locationName = "KL Tower";

        let cinemaMatch = allCinemas.find((dbCine) => {
          const dbNameClean = dbCine.mall_name?.toLowerCase().trim() || "";
          return (
            dbNameClean.includes("kl tower") ||
            dbNameClean.includes("fcube") ||
            dbCine.chain_name === "FCube Cinemas"
          );
        });

        if (!cinemaMatch) {
          console.log(`✨ Creating missing cinema in DB: "${locationName}"`);
          const { data: newCinema, error: createErr } = await supabase
            .from("cinemas")
            .insert({
              mall_name: locationName,
              chain_name: "FCube Cinemas",
            })
            .select()
            .single();

          if (createErr || !newCinema) {
            console.error(`❌ Failed to auto-create cinema "${locationName}":`, createErr?.message);
            continue;
          } else {
            console.log(`✅ Successfully created cinema: "${newCinema.mall_name}"`);
            cinemaMatch = newCinema;
            allCinemas.push(newCinema);
          }
        }

        // Process Showtimes for this movie
        const cubeElements = $(el).find(".cube-details").toArray();
        for (const cubeEl of cubeElements) {
          const cubeName = $(cubeEl).find("span").first().text().trim();

          const timeElements = $(cubeEl).find(".cube-times-wrapper > span.disabled, .cube-times-wrapper > a.show-time").toArray();
          for (const timeEl of timeElements) {
            const timeStrRaw = $(timeEl).text().replace(/SOLD OUT/gi, "").trim();
            const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;
            const match = timeStrRaw.match(timeRegex);

            if (!match) continue; // Unparseable time

            let hours = parseInt(match[1], 10);
            const minutes = match[2];
            const ampm = match[3].toUpperCase();

            let hourInt = hours;
            if (ampm === "PM" && hours < 12) hourInt += 12;
            if (ampm === "AM" && hours === 12) hourInt = 0;

            const formattedStartTime = `${isoDate}T${hourInt.toString().padStart(2, "0")}:${minutes}:00`;
            const price = getFcubePrice(cubeName, dateObj.getDay(), hourInt);

            const dataMovie = $(timeEl).attr("data-movie");
            let bookingUrl = null;
            if (dataMovie && dataMovie.includes("/show/")) {
              bookingUrl = `https://www.fcubecinemas.com${dataMovie}`;
            }

            const { error: sError } = await supabase.from("showtimes").upsert(
              {
                movie_id: movieRecord.id,
                cinema_id: cinemaMatch.id,
                start_time: formattedStartTime,
                price: price,
                booking_url: bookingUrl,
              },
              { onConflict: "movie_id, cinema_id, start_time" }
            );

            if (sError) {
              console.error(`❌ DB Error for ${cleanTitle}:`, sError.message);
            }
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: `Sync Completed. Processed ${totalMoviesProcessed} movies across ${targetDates.length} days.`,
    });
  } catch (error) {
    console.error("💥 Critical Scraper Error:", error.message);
    await sendAlert(`Critical error in fcube.js: ${error.message}`);
    return res.status(200).json({ success: false, error: error.message });
  }
}
