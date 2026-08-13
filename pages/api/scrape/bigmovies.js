import { sendAlert } from "../../../lib/utils/alert";
import { supabase } from "../../../lib/supabase";
import { normalizeTitle } from "../../../lib/utils/normalize";

export const dynamic = "force-dynamic";

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    console.log("🚀 Starting Big Movies Scrape...");

    const targetDates = [];
    const dateObjs = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const yyyy = d.getFullYear();
      const mm = (d.getMonth() + 1).toString().padStart(2, "0");
      const dd = d.getDate().toString().padStart(2, "0");

      targetDates.push(`${mm}/${dd}/${yyyy}`);
      dateObjs.push(`${yyyy}-${mm}-${dd}`);
    }

    const { data: allCinemas, error: cineError } = await supabase
      .from("cinemas")
      .select("id, mall_name, chain_name, location_url");

    if (cineError || !allCinemas) {
      throw new Error(`Could not load cinemas from DB: ${cineError?.message}`);
    }

    let totalMoviesProcessed = 0;

    for (let i = 0; i < targetDates.length; i++) {
      const showDate = targetDates[i];
      const isoDate = dateObjs[i];
      console.log(`\n📅 Scraping Big Movies for date: ${showDate}`);

      const payload = {
        PortalId: 1,
        ShowDate: showDate,
        AppPath: "/",
        CurrentMovieID: 0,
        username: "",
        locationID: 0,
      };

      const fetchRes = await fetch(
        "https://bigmovies.com.np/Modules/CineSite/Movies/NowShowingWebService.asmx/GetNowShowing",
        {
          method: "POST",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      if (!fetchRes.ok) {
        console.error(`❌ Failed to fetch from Big Movies API: ${fetchRes.status}`);
        await sendAlert(`Failed to fetch from Big Movies API. Status: ${fetchRes.status}`);
        return res.status(200).json({
            success: false,
            message: `Big Movies API down (Status: ${fetchRes.status})`,
            error: await fetchRes.text()
        });
      }

      const jsonResponse = await fetchRes.json();
      const data = jsonResponse.d;

      if (!data || !Array.isArray(data) || data.length === 0) {
        console.log(`No movies found for ${showDate}. Skipping.`);
        continue;
      }

      console.log(`🎬 Picked up ${data.length} movies from Big Movies.`);
      totalMoviesProcessed += data.length;

      for (const movie of data) {
        const cleanTitle = normalizeTitle(movie.Movie);

        const { data: movieRecord, error: mError } = await supabase
          .from("movies")
          .upsert(
            {
              title: cleanTitle,
              poster_url: movie.MediaPath_src
                ? `https://bigmovies.com.np${movie.MediaPath_src}`
                : null,
              genre: movie.Genre || null,
            },
            { onConflict: "title" }
          )
          .select()
          .single();

        if (mError || !movieRecord) {
          console.log(`⏩ Skipping movie ${cleanTitle}: ${mError?.message}`);
          continue;
        }


        const locationName = "Big Movies";

        let cinemaMatch = allCinemas.find((dbCine) => {
          const dbNameClean = dbCine.mall_name?.toLowerCase().trim() || "";
          return (
            dbNameClean.includes("big movies") ||
            dbNameClean.includes("city center") ||
            dbCine.chain_name === "Big Movies"
          );
        });

        if (!cinemaMatch) {
          console.log(`✨ Creating missing cinema in DB: "${locationName}"`);
          const { data: newCinema, error: createErr } = await supabase
            .from("cinemas")
            .insert({
              mall_name: locationName,
              chain_name: "Big Movies",
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

        const showInfo = movie.ShowInfo || [];

        for (const show of showInfo) {
          const timeStr = show.StartTime; // e.g. "10:0", "13:15"
          let [hours, minutes] = timeStr.split(":");
          hours = hours.padStart(2, "0");
          minutes = minutes.padStart(2, "0");
          const hourInt = parseInt(hours, 10);

          const formattedStartTime = `${isoDate}T${hours}:${minutes}:00`;

          // Booking URL
          let bookingUrl = `https://bigmovies.com.np/booking.aspx/movieid/${movie.MovieID}/showid/${show.ShowID}`;
          if (show.ShowTime_href && show.ShowTime_href !== "#") {
            if (show.ShowTime_href.startsWith("//")) {
              bookingUrl = `https://bigmovies.com.np${show.ShowTime_href}`;
            } else if (show.ShowTime_href.startsWith("/")) {
              bookingUrl = `https://bigmovies.com.np${show.ShowTime_href}`;
            }
          }

          // Ticket pricing (Screen 1 & 2 tier)
          const showDateObj = new Date(isoDate);
          const dayOfWeek = showDateObj.getDay(); // 0=Sun,...6=Sat
          const isMorning = hourInt < 11;

          // Knockoff: Wed(3), Thu(4) — all day 185
          // Weekends: Fri(5), Sat(6), Sun(0) — morning 185, regular 350
          // Weekdays: Mon(1), Tue(2) — morning 185, regular 300
          const isKnockoff = dayOfWeek === 3 || dayOfWeek === 4;
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6;

          let ticketPrice = 185; // default morning / knockoff
          if (isKnockoff) {
            ticketPrice = 185;
          } else if (isWeekend) {
            ticketPrice = isMorning ? 185 : 350;
          } else {
            // Weekdays (Mon, Tue)
            ticketPrice = isMorning ? 185 : 300;
          }

          const { error: sError } = await supabase.from("showtimes").upsert(
            {
              movie_id: movieRecord.id,
              cinema_id: cinemaMatch.id,
              start_time: formattedStartTime,
              price: ticketPrice,
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

    return res.status(200).json({
      success: true,
      message: `Sync Completed. Processed ${totalMoviesProcessed} movies across ${targetDates.length} days.`,
    });
  } catch (error) {
    console.error("💥 Critical Scraper Error:", error.message);
    await sendAlert(`Critical error in bigmovies.js: ${error.message}`);
    return res.status(200).json({ success: false, error: error.message });
  }
}
