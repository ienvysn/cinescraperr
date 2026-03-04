import { supabase } from "../../../lib/supabase";
import { normalizeTitle } from "../../../lib/utils/normalize";


export const dynamic = "force-dynamic";

const HEADERS = {
  accept: "*/*",
  authorization:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6IjBmZDc1OWM2LTczMTYtNDdlZi1iZmYyLTg3ZWYwNTYxYWUxMCIsImlhdCI6MTc2MDQ3MDMzMX0.wkfUdwL5dZB3iPf_JeaLNI1GvtzqAXBntuu1AAtkwLk",
  "content-type": "application/json",
  origin: "https://www.qfxcinemas.com",
  referer: "https://www.qfxcinemas.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};

export default async function handler(req, res) {
  try {
    console.log("🚀 Starting QFX Scrape...");


    const { data: allCinemas, error: cineError } = await supabase
      .from("cinemas")
      .select("id, mall_name, chain_name, location_url");

    if (cineError || !allCinemas) {
      throw new Error(`Could not load cinemas from DB: ${cineError?.message}`);
    }


    const listRes = await fetch(
      "https://web-api.qfxcinemas.com/api/external/quick-book",
      {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({}),
      },
    );
    const { movies } = await listRes.json();


    const uniqueMovies = Array.from(
      new Map(movies.map((m) => [m.movie_id, m])).values(),
    );
    console.log(`🎬 Found ${uniqueMovies.length} unique movies.`);

    for (const movie of uniqueMovies) {
      const cleanTitle = normalizeTitle(movie.movie_title);


      const { data: movieRecord, error: mError } = await supabase
        .from("movies")
        .upsert(
          {
            title: cleanTitle,
            poster_url: movie.MovieContent[0]?.artwork || null,
          },
          { onConflict: "title" },
        )
        .select()
        .single();

      if (mError || !movieRecord) {
        console.log(`⏩ Skipping movie ${cleanTitle}: ${mError?.message}`);
        continue;
      }


      const today = new Date().toISOString().split("T")[0];
      const detailUrl = `https://web-api.qfxcinemas.com/api/cinema/admin/movie-confirmed-list/${movie.movie_id}?fromDate=${today}&city_id=29790`;

      const detailRes = await fetch(detailUrl, { headers: HEADERS });
      const detailData = await detailRes.json();
      const showtimeRecords = detailData.Records?.data || [];

      for (const show of showtimeRecords) {
        const apiCineName = show.cine_name.trim();


        const cleanApiName = apiCineName
          .replace(/QFX/gi, "")
          .trim()
          .toLowerCase();


        let cinemaMatch = allCinemas.find((dbCine) => {
          const nameToCompare = dbCine.mall_name;
          if (!nameToCompare) return false;

          const dbNameClean = nameToCompare.toLowerCase().trim();
          const isMatch = cleanApiName.includes(dbNameClean) || dbNameClean.includes(cleanApiName);


          return isMatch;
        });

        if (!cinemaMatch) {
          console.log(`✨ Creating missing cinema in DB: "${show.cine_name}"`);
          const { data: newCinema, error: createErr } = await supabase
            .from("cinemas")
            .insert({
              mall_name: show.cine_name,
              chain_name: "QFX"
            })
            .select()
            .single();

          if (createErr || !newCinema) {
            console.error(`❌ Failed to auto-create cinema "${apiCineName}":`, createErr?.message);
          } else {
            console.log(`✅ Successfully created cinema: "${newCinema.mall_name}"`);
            cinemaMatch = newCinema;
            allCinemas.push(newCinema);
          }
        }

        if (cinemaMatch) {

          let extractedPrices = null;
          try {
            const priceReqPayload = {
              screen_id: show.screen_id,
              ss_id: show.ss_id,
              md_id: show.movie_details_id,
              type_seat_show: 1
            };

            const priceRes = await fetch("https://web-api.qfxcinemas.com/api/external/seat-layout", {
              method: "POST",
              headers: HEADERS,
              body: JSON.stringify(priceReqPayload)
            });

            if (priceRes.ok) {
              const priceData = await priceRes.json();
              if (priceData.status && priceData.Records) {
                const firstValidSeat = priceData.Records.find((seat) => seat.seat_price);

                if (firstValidSeat) {
                  extractedPrices = firstValidSeat.seat_price;
                }
              }
            } else {
               console.log("❌ Seat Layout Request Failed:", priceRes.status, await priceRes.text());
            }
          } catch (e) {
            console.error("Failed to fetch price/seat layout:", e.message);
          }

          const startTime = `${show.ss_start_date}T${show.ss_start_show_time}:00`;

          const { error: sError } = await supabase.from("showtimes").upsert(
            {
              movie_id: movieRecord.id,
              cinema_id: cinemaMatch.id,
              start_time: startTime,
              price: extractedPrices || null,
              booking_url: `https://www.qfxcinemas.com/quick-ticket?showid=${show.schedule_id}`,
            },
            { onConflict: "movie_id, cinema_id, start_time" },
          );

          if (sError) {
            console.error(`❌ DB Error for ${cleanTitle}:`, sError.message);
          }
        }
      }
      // console.log(`✅ Synced schedules for: ${cleanTitle}`);
    }

    return res.status(200).json({ success: true, message: "Sync Completed" });
  } catch (error) {
    console.error("💥 Critical Scraper Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
